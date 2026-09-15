import { api, ApiError } from "./api";
import en from "../locales/en.json";

/**
 * PLAN 15 T8 — the mini-OT's wire contract, transcribed from the four `ot-*.controller.ts` files
 * exactly as `materials-api.ts` and `formulary-api.ts` transcribe theirs: this file DESCRIBES what
 * those routes ship and never re-derives or widens it.
 *
 * ═══ NOTHING HERE DECIDES WHETHER A CASE MAY PROCEED ═══
 *
 * Every hard gate in this phase is structural and lives on the server: the deposit gate, the
 * privilege check, the readiness evaluation, the count reconciliation, the escort verification.
 * A screen that computed "ready" itself would be a second copy of the rule (§2.54), and the copy
 * that drifted would be the one a nurse was reading at 7 a.m. So the client renders the state the
 * server reports and sends intents; the ONLY thing it decides is what to show.
 *
 * ═══ TIMESTAMPS ARE THE SERVER'S, NEVER THE BROWSER'S ═══
 *
 * `wheel_in`, `induction`, `incision`, `closure` and `wheel_out` are written once and can never be
 * rewritten (DD8, enforced by `0035`'s trigger). None of them crosses this wire on the way in: the
 * cockpit posts an INTENT (`POST /ot/cockpit/:caseId/incision`) and the server stamps the clock.
 * A theatre wall clock that is four minutes fast must not become the legal record of an incision,
 * and a browser's clock is worse than a wall clock.
 */

export type WireGate = { kind: string; state: string };

export type WireListItem = {
  caseId: string; seq: number; procedureClass: string; procedureCode: string;
  laterality: string | null; surgeonId: string; anaesthetistId: string | null;
  state: string;
  /** F20 — the name this VIEWER may see. Never the patient's legal name for a confidential one. */
  patientDisplay: string;
  gates: WireGate[];
};

export type WireCaseGate = {
  id: string; caseId: string; kind: string; state: string;
  satisfiedBy: string | null; satisfiedAt: string | null;
  evidence: unknown; waivedReason: string | null;
};

export type WireBay = {
  bayResourceId: string; code: string; status: string;
  occupantType: string | null; occupantRef: string | null;
  /** F20 — as above. `null` when the bay is empty. */
  patientDisplay: string | null;
};

export type WireScore = {
  id: string; encounterId: string; occurredAt: string;
  values: Record<string, number>; total: number; recordedBy: string;
};

export type WireImplantLine = {
  implantId: string; ledgerEntryId: string; serviceCode: string; qtyBase: number;
  mrpPaisePerBase: number | null; ceilingPaisePerBase: number | null;
  capUnitPaise: number; boundApplied: string;
};

export type WireBillPreview = {
  encounterId: string; patientId: string;
  packageLines: { caseId: string; serviceCode: string }[];
  implantLines: WireImplantLine[];
  expectedNetPaise: number; heldPaise: number;
  divergences: { ledgerEntryId: string; frozen: number | null; derived: number | null }[];
  handoffUnbilled: { ledgerEntryId: string; itemId: string; occurredAt: string }[];
  unreturnedIssues: { ledgerEntryId: string; itemId: string; qtyBase: number }[];
  notes: Record<string, string>;
};

export type WireSettlement = {
  invoiceId: string; invoiceNo: string; netPayablePaise: number; allocatedPaise: number;
  refundApprovalId: string | null; refundPaise: number;
};

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

export function fetchList(q: { listDate: string; theatreResourceId: string }): Promise<WireListItem[]> {
  const qs = new URLSearchParams({ listDate: q.listDate, theatreResourceId: q.theatreResourceId });
  return api<WireListItem[]>("GET", `/ot/list?${qs.toString()}`);
}
export function fetchCaseGates(caseId: string): Promise<WireCaseGate[]> {
  return api<WireCaseGate[]>("GET", `/ot/cases/${caseId}/gates`);
}
export function fetchCounts(caseId: string): Promise<unknown[]> {
  return api<unknown[]>("GET", `/ot/cockpit/${caseId}/counts`);
}
export function fetchImplants(caseId: string): Promise<{ id: string; serial: string | null; state: string; serviceCode: string }[]> {
  return api("GET", `/ot/cockpit/${caseId}/implants`);
}
export function fetchRecoveryBoard(): Promise<WireBay[]> {
  return api<WireBay[]>("GET", "/ot/recovery/board");
}
export function fetchScores(encounterId: string): Promise<WireScore[]> {
  return api<WireScore[]>("GET", `/ot/recovery/${encounterId}/scores`);
}
export function fetchBillPreview(encounterId: string): Promise<WireBillPreview> {
  return api<WireBillPreview>("GET", `/ot/recovery/${encounterId}/bill-preview`);
}

// ── writes ─────────────────────────────────────────────────────────────────────────────────────

export function bookCase(body: {
  patientId: string; procedureClass: string; procedureCode: string; laterality?: string;
  surgeonId: string; anaesthetistId?: string; listDate: string; theatreResourceId: string;
  payerClass: string; anaesthesiaType: string; estimatedMinutes: number;
}, key?: string): Promise<{ caseId: string; encounterId: string; encounterNo: string }> {
  return api("POST", "/ot/cases", body, key);
}
export function holdDeposit(encounterId: string, body: { receiptId: string; amountPaise: number }, key?: string): Promise<unknown> {
  return api("POST", `/ot/encounters/${encounterId}/deposit-hold`, body, key);
}
export function satisfyGate(gateId: string, evidence: Record<string, unknown>, key?: string): Promise<unknown> {
  return api("POST", `/ot/gates/${gateId}/satisfy`, evidence, key);
}
export function publishList(body: { listDate: string; theatreResourceId: string }, key?: string): Promise<{ caseCount: number; readyCaseIds: string[] }> {
  return api("POST", "/ot/lists/publish", body, key);
}
/** `caseIdsInOrder`, not `order` — the server validates against that name and this end used its own,
 *  so every call failed validation. `reason` is optional and now actually lands: it rides on
 *  `list.resequenced`. */
export function resequenceList(body: { listDate: string; theatreResourceId: string; caseIdsInOrder: string[]; reason?: string }, key?: string): Promise<unknown> {
  return api("POST", "/ot/lists/resequence", body, key);
}

/**
 * The cockpit's clock intents. Each one is a bare POST with no body — see the header: the SERVER
 * stamps the time. They are listed as a table rather than five near-identical functions because the
 * screen renders them as a table too, and a list that can drift from the buttons is a list that
 * will.
 */
export const CLOCK_STEPS = [
  "to-holding", "sign-in", "time-out", "incision", "closure", "sign-out", "wheel-out",
] as const;
export type ClockStep = (typeof CLOCK_STEPS)[number];

export function clockStep(caseId: string, step: ClockStep, key?: string): Promise<unknown> {
  return api("POST", `/ot/cockpit/${caseId}/${step}`, {}, key);
}
export function recordChecklist(caseId: string, body: {
  phase: string; items: { key: string; answer: string }[]; participants: string[];
}, key?: string): Promise<unknown> {
  return api("POST", `/ot/cockpit/${caseId}/checklist`, body, key);
}
export function recordCount(caseId: string, body: {
  round: string; itemType: string; expected: number; counted: number;
  scrubBy: string; circulatingBy: string;
}, key?: string): Promise<unknown> {
  return api("POST", `/ot/cockpit/${caseId}/counts`, body, key);
}
export function scanImplant(caseId: string, body: {
  itemId: string; batchId: string; lotId?: string; storeResourceId: string;
  serviceCode: string; qtyBase: number; serial?: string;
}, key?: string): Promise<{ implantId: string; state: string }> {
  return api("POST", `/ot/cockpit/${caseId}/implants`, body, key);
}
export function admitToRecovery(encounterId: string, body: { caseId: string; bayResourceId: string }, key?: string): Promise<unknown> {
  return api("POST", `/ot/recovery/${encounterId}/admit`, body, key);
}
export function recordScore(encounterId: string, body: {
  caseId: string; values: Record<string, number>; occurredAt: string;
}, key?: string): Promise<{ readiness: { ready: boolean; reasons: string[] } }> {
  return api("POST", `/ot/recovery/${encounterId}/scores`, body, key);
}
export function verifyEscort(encounterId: string, body: {
  at: string; escort: { name: string; relation: string; phone: string; idType: string; idLast4: string; ageYears: number };
}, key?: string): Promise<unknown> {
  return api("POST", `/ot/recovery/${encounterId}/escort`, body, key);
}
export function dischargeFromRecovery(encounterId: string, body: { caseId: string; isbarAcknowledgedBy: string }, key?: string): Promise<unknown> {
  return api("POST", `/ot/recovery/${encounterId}/discharge`, body, key);
}
export function settleBill(encounterId: string, body: { cashTenderPaise?: number; note?: string }, key?: string): Promise<WireSettlement> {
  return api("POST", `/ot/recovery/${encounterId}/bill`, body, key);
}

// ── errors ─────────────────────────────────────────────────────────────────────────────────────

function otErrorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

function otErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown } | null;
    if (typeof body?.message === "string") return body.message;
    return `HTTP ${String(e.status)}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The CODE first through `otErrors.<code>`, the server's MESSAGE second — the `materialsErrorText`
 * order, and for its reasons. The OT surface makes the second half matter more than usual: this
 * module's routes can also raise a `ResourceError` (the theatre or bay is taken), a
 * `WorkflowError` (this actor may not make this move), an `ApprovalError`, a `BillingError` and a
 * `TariffError`, none of which have keys here. A wrong-language sentence beats a blank box.
 *
 * `apps/core/src/modules/ot/errors.test.ts` asserts this block against `OT_ERROR_CODES` in BOTH
 * directions and in both locales, so a code added in `apps/core` cannot reach a screen with no
 * sentence to show for it, and a stale sentence cannot outlive its code.
 */
export function otErrorText(e: unknown, t: (key: string) => string): string {
  const code = otErrorCode(e);
  if (code !== null && Object.prototype.hasOwnProperty.call(en.otErrors, code)) {
    return t(`otErrors.${code}`);
  }
  return otErrorMessage(e);
}
