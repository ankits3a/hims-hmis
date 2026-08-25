import { api, ApiError } from "./api";

/**
 * PLAN 09 T7 — THE RECEIVABLE LANE'S WIRE CONTRACT, transcribed from `partners.controller.ts`
 * exactly as `ops-api.ts`, `billing-api.ts` and `membership-api.ts` transcribe theirs: this file
 * DESCRIBES the shape those routes ship, it never re-derives or widens it.
 *
 * ═══ THERE IS NO PATIENT TYPE IN THIS FILE, AND THAT IS DD15 ═══
 *
 * Every shape below is instrument ids, attribution ids, codes this hospital minted, states, dates
 * and amounts. No name, no UHID, no phone, no patient id — because the receivables desk works with
 * a partner's statement in front of it, and a screen that could render a patient's name from a
 * partner's claim would be one careless column away from putting it in an export. The server's own
 * query never reaches `patients`; this file cannot describe what it is never sent.
 */

export type WireAttributionSlip = {
  attributionId: string;
  /** Printed on the slip. `qrPayload` is this same string and nothing else. */
  code: string;
  counterpartyId: string;
  patientId: string | null;
  serviceHint: string | null;
  expectationId: string;
  expectedPaise: number;
  issuedAt: string;
  expiresAt: string;
  qrPayload: string;
};

export type WireScannedAttribution = {
  attributionId: string;
  code: string;
  counterpartyId: string;
  /** `'issued' | 'claimed' | 'expired' | 'void'`. */
  state: string;
  serviceHint: string | null;
  issuedAt: string;
  expiresAt: string | null;
  expectation: { id: string; state: string; amountPaise: number; dueAt: string | null } | null;
};

export type WireAgingBucket = "0-30" | "31-60" | "61-90" | "90+";

export type WireAgingItem = {
  expectationId: string;
  counterpartyId: string;
  attributionId: string | null;
  attributionCode: string | null;
  serviceHint: string | null;
  amountPaise: number;
  /** `'expected' | 'matched' | 'disputed' | 'written_off'`. */
  state: string;
  statementRef: string | null;
  statementPeriod: string | null;
  disputeReason: string | null;
  expectedAt: string;
  dueAt: string | null;
  ageDays: number;
  bucket: WireAgingBucket;
  overdue: boolean;
};

export type WireAgingReport = {
  asOf: string;
  buckets: { bucket: WireAgingBucket; count: number; amountPaise: number }[];
  totals: {
    outstandingPaise: number;
    disputedPaise: number;
    writtenOffPaise: number;
    /** MONEY, from the append-only ledger — what statements actually confirmed. */
    confirmedPaise: number;
    outstandingCount: number;
    disputedCount: number;
  };
  items: WireAgingItem[];
};

export type WireStatementLineOutcome = {
  rowNo: number;
  outcome: "quarantined" | "matched" | "corrected" | "disputed";
  reason?: string;
  expectationId?: string;
  attributionId?: string | null;
  accrualId?: string | null;
  correctsPeriod?: string;
  deltaPaise?: number;
  amountPaise?: number;
};

export type WireStatementImport = {
  counterpartyId: string;
  statementRef: string;
  statementPeriod: string;
  columnMapVersion: string;
  linesTotal: number;
  linesMatched: number;
  linesDisputed: number;
  linesCorrected: number;
  linesQuarantined: number;
  confirmedPaise: number;
  lines: WireStatementLineOutcome[];
};

export type WireStatementQuarantine = {
  rows: { id: string; rowNo: number; reason: string; line: string }[];
};

/**
 * PLAN 09 T8 — THE CHANNEL P&L. One row per partner; every field is a count or a sum (DD15 — there
 * is no per-patient row here to describe, and none of these fields is a patient's).
 */
export type WirePartnerPnl = {
  counterpartyId: string;
  counterpartyName: string;
  /** `'channel_partner' | 'staff_internal' | 'external_rmp'`. */
  payeeClass: string;
  asOf: string;
  cardsActive: number;
  memberSpendPaise: number;
  payableCommissionPaise: number;
  receivableExpectedPaise: number;
  /** The append-only ledger's own confirmed total — never a sum over claim rows (DD5). */
  receivableMatchedPaise: number;
  receivableDisputedPaise: number;
  netChannelMarginPaise: number;
};

export function fetchPartnerPnl(counterpartyId?: string): Promise<WirePartnerPnl[]> {
  const params = new URLSearchParams();
  if (counterpartyId !== undefined && counterpartyId !== "") params.set("counterpartyId", counterpartyId);
  const query = params.toString();
  return api("GET", `/partners/pnl${query === "" ? "" : `?${query}`}`);
}

export function fetchAging(counterpartyId?: string): Promise<WireAgingReport> {
  const params = new URLSearchParams();
  if (counterpartyId !== undefined && counterpartyId !== "") params.set("counterpartyId", counterpartyId);
  const query = params.toString();
  return api("GET", `/partners/receivables/aging${query === "" ? "" : `?${query}`}`);
}

export function issueAttribution(body: {
  counterpartyId: string; patientId?: string; serviceHint?: string; referredValuePaise: number;
}): Promise<WireAttributionSlip> {
  return api("POST", "/partners/attributions", body);
}

/** The 11h barcode wedge's lookup. EXACT on the printed code — there is no prefix and no guess. */
export function scanAttribution(code: string): Promise<WireScannedAttribution> {
  return api("GET", `/partners/attributions/${encodeURIComponent(code)}`);
}

export function voidAttribution(attributionId: string, reason: string): Promise<{
  attributionId: string; expectationIds: string[]; state: "void";
}> {
  return api("POST", `/partners/attributions/${encodeURIComponent(attributionId)}/void`, { reason });
}

export function importStatement(body: {
  counterpartyId: string; statementRef: string; statementPeriod: string; csv: string; columnMapVersion?: string;
}): Promise<WireStatementImport> {
  return api("POST", "/partners/statements/import", body);
}

export function fetchStatementQuarantine(statementRef: string): Promise<WireStatementQuarantine> {
  return api("GET", `/partners/statements/${encodeURIComponent(statementRef)}/quarantine`);
}

export function mapPartnerRef(body: { counterpartyId: string; partnerRef: string; attributionId: string }): Promise<{
  id: string; counterpartyId: string; partnerRef: string; attributionId: string; mappedBy: string; at: string;
}> {
  return api("POST", "/partners/refs", body);
}

export function writeOffExpectation(expectationId: string, reason: string): Promise<{
  expectationId: string; state: "written_off";
}> {
  return api("POST", `/partners/receivables/${encodeURIComponent(expectationId)}/write-off`, { reason });
}

export function expireUnclaimed(counterpartyId?: string): Promise<{
  expiredExpectationIds: string[]; expiredAttributionIds: string[];
}> {
  const body: { counterpartyId?: string } = {};
  if (counterpartyId !== undefined && counterpartyId !== "") body.counterpartyId = counterpartyId;
  return api("POST", "/partners/receivables/expire", body);
}

// ────────────────────────────────── error helpers ──────────────────────────────────
//
// The `opsErrorMessage`/`membershipErrorMessage` precedent, transcribed as SEPARATE functions over
// the same `ApiError` shape rather than imported — `billing-api.ts` states the reason in its own
// comment: so that "align the three error conventions" can never become a one-line temptation.
// This module's `toHttp` sends `{statusCode, message, code, detail?}`; a 401/403 from the guards is
// Nest's own shape, for which `partnersErrorCode` correctly returns null.

export function partnersErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

export function partnersErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return null;
}
