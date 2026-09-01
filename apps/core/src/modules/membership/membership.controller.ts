import { Body, Controller, Get, HttpException, HttpStatus, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { z } from "zod";
import type { Response } from "express";
import type { Actor, SearchResponse } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { ApprovalError } from "../../kernel/approvals/types";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { recordSearch } from "../../kernel/search/audit";
import { checkSearchRate } from "../../kernel/search/rate-limit";
import { PatientError } from "../patients";
import { MembershipError, membershipHttpStatus } from "./errors";
import { instrumentLookupRefused } from "./events";
import { enrolMember } from "./enrolment";
import { graceHonor, recogniseForActor } from "./recognition";
import { importHolderBook } from "./import/importer";
import { listQuarantine } from "./import/quarantine";
import { dismissMatch, listLapsedRestores, listMatchQueue, resolveMatch } from "./import/match-queue";
import { INSTRUMENT_SEARCH_PROVIDER_KEY, instrumentSearchProvider } from "./search-providers";
import type { GraceHonorResult, RecognitionResult } from "./recognition";
import type { HolderBookImportResult } from "./import/importer";
import type { QuarantineRow } from "./import/quarantine";
import type { LapsedRestoreItem, MatchQueueItem } from "./import/match-queue";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T3 — THE RECOGNITION SURFACE'S WIRE CONTRACT: find a card, read what it grants, and —
 * behind an approval — honour one the holder book has never heard of.
 *
 * ERROR BODY is the OPD/billing convention `{ statusCode, message, code, detail? }`, because the
 * counter screen branches on `code` and two of these refusals have to carry structure (which
 * approval was expected, how long to wait).
 *
 * ═══ THERE IS NO FLAG ON THESE ROUTES, AND THAT IS DD8 ═══
 *
 * Every other Plan 09 lane ships structurally OFF. Recognition does not, because the ORDER is the
 * ruling: recognition is deployed and the holder book imported BEFORE `MEMBER_BENEFITS_ENABLED`
 * arms the counter's discounts. A flag here would make the ordered flip impossible to perform —
 * you cannot clear a reconcile queue through a route that refuses.
 */

/**
 * PLAN 09 CLOSE REMEDIATION — the mapping MOVED to `errors.ts`, beside the union it maps, because
 * `billing.controller.ts` needs the identical answer (a `MembershipError` escapes `issueInvoice`
 * since T4). One copy, imported by both; the alternative was two that drift.
 */
function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/** Unrecognized errors rethrow — a 500 is a genuine bug, loudly (the billing/OPD `toHttp` convention). */
function toHttp(e: unknown): never {
  if (e instanceof MembershipError) throw httpError(membershipHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof PatientError) throw httpError(e.code === "patient_not_found" ? 404 : 400, e.message, e.code);
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  if (e instanceof z.ZodError) throw httpError(400, "request body failed validation", "invalid_request", e.issues);
  throw e;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, "request body failed validation", "invalid_request", r.error.issues);
  return r.data;
}

const lookupQuery = z.object({
  q: z.string(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

/**
 * `codes` is a comma-separated list, because a counter presents a card AND a coupon at once and a
 * repeated query parameter is the shape every proxy on the path treats differently.
 */
/** RC-2 T4. Declared at the boundary, never inherited — RC-1 T1's lesson, one module over. */
const enrolBody = z.object({
  patientId: z.string().min(1),
  planId: z.string().min(1),
  cardCode: z.string().min(1).max(64),
  holderName: z.string().min(1).max(160),
});

const recognitionQuery = z.object({
  patientId: z.string().min(1).optional(),
  codes: z.string().optional(),
});

/**
 * PLAN 09 T5 — the drop arrives as TEXT IN A JSON BODY, the `reconUploadBody` precedent.
 *
 * No multipart, no upload directory, no file on disk anywhere: a holder book is a few hundred
 * kilobytes of CSV and the alternative is a second storage surface to secure, back up and clean
 * up. `csv` is capped so a mis-sent file cannot become a memory incident.
 */
const importHolderBookBody = z.object({
  counterpartyId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  csv: z.string().min(1).max(4_000_000),
  columnMapVersion: z.string().min(1).optional(),
});

const resolveMatchBody = z.object({
  queueItemId: z.string().min(1),
  patientId: z.string().min(1),
  note: z.string().max(1000).optional(),
});

const dismissMatchBody = z.object({
  queueItemId: z.string().min(1),
  note: z.string().min(1).max(1000),
});

const graceHonorBody = z.object({
  cardCode: z.string().min(1),
  patientId: z.string().min(1),
  planId: z.string().min(1),
  approvalId: z.string().min(1),
  reason: z.string().min(1).max(1000),
});

export type InstrumentLookupResponse = {
  hits: SearchResponse["groups"][number]["hits"];
  total: number;
  auditId: string;
};

@Controller("membership")
export class MembershipController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * CARD LOOKUP — the enumeration surface, and therefore the rate-limited one (DD15).
   *
   * ═══ THE LIMITER IS `checkSearchRate`, VERBATIM, AND ITS COUNTED TABLE IS `search_audit` ═══
   *
   * The threat is not a fast typist; it is scripted enumeration of a partner's holder book through
   * a route that is authenticated, permitted, and therefore invisible to every other control. The
   * limiter already exists, already counts `(actor_id, at)` over an index that is already there,
   * and already has the one property a hasty limiter lacks:
   *
   *   **A REFUSAL IS AN EVENT, NEVER AN AUDIT ROW.** Writing refusals into the table the limiter
   *   counts would make every retry EXTEND the block — the harder a busy counter tried, the longer
   *   it stayed locked out. `instrument.lookup_refused` goes on the spine instead, which is where a
   *   rare semantic fact belongs and where volume becomes visible if it stops being rare.
   *
   * The EXECUTED lookup writes its audit row through `recordSearch`, the same writer the palette
   * uses — so the limit counts lookups, and the access log records who looked for whom. A route
   * that read the holder book without writing that row would be both unlimited and unaudited.
   *
   * The provider is invoked DIRECTLY rather than through `searchAll`: this is a single-entity
   * route, and the permission it would have decided is the one on this method — the same string
   * the provider declares.
   */
  @RequirePermission("membership.instrument.read", "hospital")
  @Get("instruments/lookup")
  async lookup(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InstrumentLookupResponse> {
    const { q, limit } = parsed(lookupQuery, query);

    // THE RATE CHECK COMES BEFORE THE QUERY. A refusal that still ran the lookup would already
    // have read the rows it was refusing to return.
    const rate = await checkSearchRate(this.db, actor, {
      limit: this.cfg.searchRateLimit,
      windowSec: this.cfg.searchRateWindowSec,
    });
    if (!rate.allowed) {
      await withTx(this.db, (tx) =>
        appendEvent(tx, instrumentLookupRefused.make({
          actor,
          payload: {
            actorId: actor.id,
            reason: "rate_limited",
            limit: this.cfg.searchRateLimit,
            windowSec: this.cfg.searchRateWindowSec,
          },
        })),
      );
      // The header, not only the body: `Retry-After` is what an HTTP client — a browser, a proxy,
      // a script written by somebody honest — already knows how to obey.
      res.setHeader("Retry-After", String(rate.retryAfterSec));
      throw httpError(
        HttpStatus.TOO_MANY_REQUESTS,
        "too many instrument lookups — wait and try again",
        "lookup_rate_limited",
        { retryAfterSec: rate.retryAfterSec, limit: this.cfg.searchRateLimit, windowSec: this.cfg.searchRateWindowSec },
      );
    }

    const perEntity = Math.min(Math.max(limit ?? 10, 1), 50);
    // A single-entity route parses nothing: the text IS the query. The grammar (`@card:`, date
    // words) belongs to the palette, which reaches this provider through `searchAll` instead.
    const parsedQuery = { raw: q, text: q, chips: [], limit: perEntity };
    const started = Date.now();
    const result = await instrumentSearchProvider.run({
      db: this.db,
      actor,
      query: parsedQuery,
      limit: perEntity,
      signal: new AbortController().signal,
    });
    const response: SearchResponse = {
      groups: [{
        entity: "instrument", provider: INSTRUMENT_SEARCH_PROVIDER_KEY,
        hits: result.hits, total: result.total, timedOut: false, errored: false,
      }],
      tookMs: Date.now() - started,
      skipped: [],
    };
    // AWAITED, never fired and forgotten: it is both the access log and the limiter's own counter,
    // and a best-effort access log is not an access log.
    const { auditId } = await recordSearch(this.db, { actor, query: parsedQuery, response });
    return { hits: result.hits, total: result.total, auditId };
  }

  /**
   * RECOGNITION — what this person holds, and the disclosure that goes with honouring it.
   *
   * The response carries E-32's disclosure line and no money at all. That is the guardrail, not an
   * omission: no counter screen shows a sales figure, so the surface it renders from cannot carry
   * one either.
   */
  /**
   * RC-2 T4 / D5 — ENROL, WHICH IS NOT APPLY.
   *
   * Two gates, and both are proven by execution in `enrolment.test.ts` because either one alone
   * would be a false comfort:
   *
   *   1. `membership.instrument.enrol` — `front_office` does NOT hold it and is refused 403 here.
   *      The clerk who honours a card at the counter cannot mint one. That is the owner's ruling.
   *   2. `MEMBERSHIP_SALES_ENABLED` — off, so even `front_office_supervisor` gets 409
   *      `sales_disabled` while owner ruling O-15 is open. The authority exists; the lane does not.
   *
   * Deliberately minimal: no price, no card-sale line, no cooling-off, no disclosure script. Plan
   * 22 T2 owns the sales lane and fills this in ONE place when O-15 is ruled.
   */
  @RequirePermission("membership.instrument.enrol", "hospital")
  @Post("instruments/enrol")
  async enrol(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ instanceId: string }> {
    const b = parsed(enrolBody, body);
    try {
      const { instanceId } = await enrolMember(this.db, actor, b);
      return { instanceId };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("membership.instrument.recognise", "hospital")
  @Get("recognition")
  async recognition(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<RecognitionResult> {
    const q = parsed(recognitionQuery, query);
    const codes = (q.codes ?? "").split(",").map((c) => c.trim()).filter((c) => c !== "");
    try {
      return await recogniseForActor(this.db, actor, {
        patientId: q.patientId ?? null,
        presentedCodes: codes,
        at: new Date(),
      });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * O-1's named path: honour a card the book does not know, behind a granted approval.
   *
   * The permission is `membership.grace_honor.request` — the DESK's. The authority that actually
   * decides is `membership.grace_honor.approve`, held by the approver, and it is enforced by the
   * approvals engine at decision time rather than by a second check here: a route that also
   * checked the approver's permission would be a second authority on the same question and the two
   * would drift.
   */
  @RequirePermission("membership.grace_honor.request", "hospital")
  @Post("grace-honor")
  async honour(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<GraceHonorResult> {
    const b = parsed(graceHonorBody, body);
    try {
      return await graceHonor(this.db, actor, { ...b, at: new Date() });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * THE HOLDER-BOOK IMPORT — an OPERATOR command, and deliberately not part of any deploy.
   *
   * `docker/prod/deploy.sh` runs the seed scripts on every deploy and this is NOT among them
   * (§6.0 S14): a deploy that imported a holder book would be importing data nobody asked it for.
   * The same reasoning keeps `seed:admin` out. It reaches a real hospital two ways — this route,
   * and `pnpm --filter @hmis/core import:holder-book` at a terminal — and both are guarded by
   * `membership.import.run`, which DD18 leaves ungranted until the owner grants it.
   */
  @RequirePermission("membership.import.run", "hospital")
  @Post("import/holder-book")
  async importDrop(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<HolderBookImportResult> {
    const b = parsed(importHolderBookBody, body);
    try {
      return await importHolderBook(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /** The lines one drop refused, verbatim — the answer to "we sent you that member". */
  @RequirePermission("membership.import.run", "hospital")
  @Get("import/:importId/quarantine")
  async quarantine(@Param("importId") importId: string): Promise<{ rows: QuarantineRow[] }> {
    return { rows: await listQuarantine(this.db, importId) };
  }

  /**
   * THE RECONCILE QUEUE. The candidate gate is inside `listMatchQueue` — `visiblePatientIds`, the
   * patients module's own — rather than here, because a confidentiality check written a second
   * time is a confidentiality check that will drift.
   */
  @RequirePermission("membership.reconcile.operate", "hospital")
  @Get("reconcile/queue")
  async reconcileQueue(
    @CurrentActor() actor: Actor,
  ): Promise<{ items: MatchQueueItem[]; lapsedRestores: LapsedRestoreItem[] }> {
    try {
      return {
        items: await listMatchQueue(this.db, actor),
        lapsedRestores: await listLapsedRestores(this.db),
      };
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * A HUMAN LINKS THE HOLDER. The body names a queue item and one of ITS OWN candidates; there is
   * deliberately no route that takes a card and a patient and links them, because that route would
   * be the auto-link E3 exists to forbid, arriving through a client instead of through the importer.
   */
  @RequirePermission("membership.reconcile.operate", "hospital")
  @Post("reconcile/resolve")
  async reconcileResolve(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ queueItemId: string; instanceId: string; patientId: string }> {
    const b = parsed(resolveMatchBody, body);
    try {
      return await resolveMatch(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /** A note is REQUIRED: deciding a resemblance is a coincidence is as much a decision as linking. */
  @RequirePermission("membership.reconcile.operate", "hospital")
  @Post("reconcile/dismiss")
  async reconcileDismiss(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ queueItemId: string }> {
    const b = parsed(dismissMatchBody, body);
    try {
      return await dismissMatch(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }
}
