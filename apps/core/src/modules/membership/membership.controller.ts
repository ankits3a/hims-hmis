import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Res } from "@nestjs/common";
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
import { MembershipError } from "./errors";
import { instrumentLookupRefused } from "./events";
import { graceHonor, recogniseForActor } from "./recognition";
import { INSTRUMENT_SEARCH_PROVIDER_KEY, instrumentSearchProvider } from "./search-providers";
import type { MembershipErrorCode } from "./errors";
import type { GraceHonorResult, RecognitionResult } from "./recognition";
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

const NOT_FOUND_CODES = new Set<MembershipErrorCode>([
  "unknown_instrument", "unknown_plan", "unknown_member", "unknown_counter", "unknown_coupon",
  "redemption_not_found", "match_candidate_unknown",
]);
const VALIDATION_CODES = new Set<MembershipErrorCode>(["import_columns_unknown", "import_range_inverted"]);

function membershipStatus(code: MembershipErrorCode): number {
  if (code === "lookup_rate_limited") return HttpStatus.TOO_MANY_REQUESTS;
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (VALIDATION_CODES.has(code)) return 400;
  return 409;
}

function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/** Unrecognized errors rethrow — a 500 is a genuine bug, loudly (the billing/OPD `toHttp` convention). */
function toHttp(e: unknown): never {
  if (e instanceof MembershipError) throw httpError(membershipStatus(e.code), e.message, e.code, e.detail);
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
const recognitionQuery = z.object({
  patientId: z.string().min(1).optional(),
  codes: z.string().optional(),
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
}
