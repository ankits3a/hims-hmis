import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { PartnersError } from "./errors";
import {
  expireUnclaimed, findAttributionByCode, issueAttribution, voidAttribution,
} from "./attribution";
import { importStatement, listStatementQuarantine } from "./statements";
import { mapPartnerRef, writeOffExpectation } from "./reconcile";
import { agingReport } from "./aging";
import type { AttributionSlip, ExpirySweepResult, ScannedAttribution, VoidAttributionResult } from "./attribution";
import type { StatementImportResult } from "./statements";
import type { PartnerRefMapping } from "./reconcile";
import type { AgingReport } from "./aging";
import type { PartnersErrorCode } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T7 — THE RECEIVABLE INSTRUMENT'S WIRE CONTRACT: issue a slip, void one, import a
 * statement, bridge a partner's reference space, and read what is owed.
 *
 * ERROR BODY is the OPD/billing/membership convention `{ statusCode, message, code, detail? }`,
 * because the receivables screen branches on `code` and three of these refusals carry structure
 * (which partner owns a disputed attribution, which statement was already imported, which state a
 * claim is stuck in).
 *
 * ═══ EVERY ROUTE IS BEHIND `RECEIVABLE_COMMISSION_ENABLED`, AND IT IS OFF (DD14 / O-8) ═══
 *
 * The flag is the OWNER's — CA/counsel register item 2 — and this task does not flip it. It is
 * checked inside the module functions rather than here, once per entry point, so that the terminal,
 * the worker and this controller cannot disagree about whether the lane is armed. With it off,
 * every route below answers 409 `receivable_disabled` and NOTHING is written: no attribution, no
 * expectation, no ledger row. `attribution.test.ts`'s G5 mutant is the proof that the check is
 * load-bearing rather than decorative.
 *
 * ═══ THE PERMISSIONS ARE ALL IN `NOT_YET_MODELLED` (DD18) ═══
 *
 * `partners.attribution.issue`, `partners.statement.import`, `partners.receivable.operate` and
 * `partners.ledger.read` are declared on `partnersManifest` and granted to NOBODY until the owner
 * grants them. That is minimum authority working as ruled, not an oversight — these routes guard a
 * lane that ships structurally off, on a trust hospital, with no published role model. T8's runbook
 * names them beside the flag flips.
 */

const NOT_FOUND_CODES = new Set<PartnersErrorCode>([
  "unknown_counterparty", "unknown_agreement", "unknown_attribution", "unknown_expectation",
  "unknown_partner_ref", "unknown_invoice", "unknown_subject",
]);
const VALIDATION_CODES = new Set<PartnersErrorCode>(["statement_columns_unknown"]);

function partnersStatus(code: PartnersErrorCode): number {
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
  if (e instanceof PartnersError) throw httpError(partnersStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof z.ZodError) throw httpError(400, "request body failed validation", "invalid_request", e.issues);
  throw e;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, "request body failed validation", "invalid_request", r.error.issues);
  return r.data;
}

/**
 * `referredValuePaise` is the value of the service being referred OUT, in integer paise. The rate
 * that turns it into a claim is the agreement's, never a number in this file (DD3).
 */
const issueAttributionBody = z.object({
  counterpartyId: z.string().min(1),
  patientId: z.string().min(1).optional(),
  serviceHint: z.string().min(1).max(200).optional(),
  referredValuePaise: z.number().int().nonnegative(),
});

const voidAttributionBody = z.object({ reason: z.string().min(1).max(1000) });

/**
 * PLAN 09 T7 — the statement arrives as TEXT IN A JSON BODY, the `reconUploadBody` /
 * `importHolderBookBody` precedent: no multipart, no upload directory, no file on disk. A partner
 * statement is a few hundred kilobytes of CSV, and the alternative is a second storage surface to
 * secure, back up and clean up. `csv` is capped so a mis-sent file cannot become a memory incident.
 */
const importStatementBody = z.object({
  counterpartyId: z.string().min(1),
  statementRef: z.string().min(1).max(200),
  statementPeriod: z.string().min(1).max(16),
  csv: z.string().min(1).max(4_000_000),
  columnMapVersion: z.string().min(1).optional(),
});

const mapPartnerRefBody = z.object({
  counterpartyId: z.string().min(1),
  partnerRef: z.string().min(1).max(200),
  attributionId: z.string().min(1),
});

const writeOffBody = z.object({ reason: z.string().min(1).max(1000) });

const expireBody = z.object({ counterpartyId: z.string().min(1).optional() });

const agingQuery = z.object({ counterpartyId: z.string().min(1).optional() });

@Controller("partners")
export class PartnersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * ISSUE ONE SLIP (DD13). One referral, one id, one partner, at referral time — and the response
   * carries the QR payload the slip prints, which is the CODE and nothing else. A QR that encoded a
   * patient id or a name would put identity on a piece of paper that leaves the hospital in a
   * partner's hands (DD15).
   */
  @RequirePermission("partners.attribution.issue", "hospital")
  @Post("attributions")
  async issue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<AttributionSlip> {
    const b = parsed(issueAttributionBody, body);
    try {
      return await issueAttribution(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * THE WEDGE'S LOOKUP — a slip scanned back at the desk (11h's barcode lane). Exact on the printed
   * code; there is no prefix and no similarity, because guessing at a half-read barcode is the
   * fuzzy-join mistake V7 forbids, wearing a different hat.
   */
  @RequirePermission("partners.receivable.operate", "hospital")
  @Get("attributions/:code")
  async scan(@Param("code") code: string): Promise<ScannedAttribution> {
    const found = await findAttributionByCode(this.db, code);
    if (found === null) {
      throw httpError(404, `no attribution slip with code ${code}`, "unknown_attribution");
    }
    return found;
  }

  /** V4 — the referred test was cancelled, so the claim it backs is written off rather than chased. */
  @RequirePermission("partners.attribution.issue", "hospital")
  @Post("attributions/:attributionId/void")
  async voidSlip(
    @CurrentActor() actor: Actor,
    @Param("attributionId") attributionId: string,
    @Body() body: unknown,
  ): Promise<VoidAttributionResult> {
    const b = parsed(voidAttributionBody, body);
    try {
      return await voidAttribution(this.db, actor, { attributionId, reason: b.reason }, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /** ONE STATEMENT, IMPORTED ONCE (V1, V3, V6). The refusal on a re-send is typed, not an integrity error. */
  @RequirePermission("partners.statement.import", "hospital")
  @Post("statements/import")
  async importPartnerStatement(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<StatementImportResult> {
    const b = parsed(importStatementBody, body);
    try {
      return await importStatement(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /** The lines one statement refused, verbatim — the answer to "we billed you for that referral". */
  @RequirePermission("partners.statement.import", "hospital")
  @Get("statements/:statementRef/quarantine")
  async statementQuarantine(
    @Param("statementRef") statementRef: string,
  ): Promise<{ rows: { id: string; rowNo: number; reason: string; line: string }[] }> {
    return { rows: await listStatementQuarantine(this.db, statementRef) };
  }

  /**
   * V7 — A HUMAN WRITES THE BRIDGE between a partner's reference space and ours. This is the ONLY
   * route by which a partner reference enters the join, and `mapped_by` records whose decision it
   * was — which is exactly what a similarity score cannot give a dispute six months later.
   */
  @RequirePermission("partners.receivable.operate", "hospital")
  @Post("refs")
  async mapRef(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<PartnerRefMapping> {
    const b = parsed(mapPartnerRefBody, body);
    try {
      return await mapPartnerRef(this.db, actor, b, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /** The operator's end of the lifecycle: a claim nobody is going to settle, closed with a reason. */
  @RequirePermission("partners.receivable.operate", "hospital")
  @Post("receivables/:expectationId/write-off")
  async writeOff(
    @CurrentActor() actor: Actor,
    @Param("expectationId") expectationId: string,
    @Body() body: unknown,
  ): Promise<{ expectationId: string; state: "written_off" }> {
    const b = parsed(writeOffBody, body);
    try {
      return await writeOffExpectation(this.db, actor, { expectationId, reason: b.reason }, new Date());
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * V5 — the unclaimed-slip sweep, as an OPERATOR command rather than a schedule.
   *
   * There is deliberately no job wiring it to a clock in this phase: the lane ships off, the window
   * is per-agreement data that nobody has entered yet, and a sweep on a timer against an empty
   * configuration writes nothing while looking like it works. The aging report shows every claim
   * ageing past its due date every day, so nothing is invisible while the sweep is manual.
   */
  @RequirePermission("partners.receivable.operate", "hospital")
  @Post("receivables/expire")
  async expire(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ExpirySweepResult> {
    const b = parsed(expireBody, body);
    try {
      return await expireUnclaimed(this.db, actor, { at: new Date(), counterpartyId: b.counterpartyId });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * V2 — WHAT IS OWED AND HOW LONG IT HAS BEEN OWED. Identity-free by construction (DD15): the
   * query behind it never reaches `patients`, so this route cannot leak what it was never handed.
   *
   * It is NOT flag-gated, and that is deliberate: a read model over rows that exist reads zeros
   * while the lane is off, and an operator checking that the lane really is inert should not be
   * refused the one screen that would tell them.
   */
  @RequirePermission("partners.ledger.read", "hospital")
  @Get("receivables/aging")
  async aging(@Query() query: unknown): Promise<AgingReport> {
    const q = parsed(agingQuery, query);
    try {
      return await agingReport(this.db, { counterpartyId: q.counterpartyId, asOf: new Date() });
    } catch (e) {
      toHttp(e);
    }
  }
}
