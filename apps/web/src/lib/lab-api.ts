import { api, ApiError } from "./api";

/**
 * PLAN 17b T8 — the laboratory's wire contract, transcribed from the five `lab-*.controller.ts`
 * files exactly as `ot-api.ts` and `materials-api.ts` transcribe theirs: this file DESCRIBES what
 * those routes ship and never re-derives or widens it.
 *
 * ═══ NOTHING HERE DECIDES ANYTHING ═══
 *
 * Every gate in this phase is on the server and every one of them matters: the absurd envelope, the
 * separation of duties, the delivery interlock, the critical read-back, the right-patient scan. A
 * screen that computed any of them would be a second copy of the rule (§2.54), and the copy that
 * drifted would be the one a technologist was reading at 02:00. The client renders the state the
 * server reports and sends intents.
 *
 * ═══ THE ONE THING THE CLIENT DOES DECIDE IS WHAT TO SHOW ═══
 *
 * A flag is a colour, a delta is a marker, an unsigned row is greyed. None of that changes what the
 * hospital did; all of it changes whether a person notices in time.
 */

export type WireAnalyteRow = {
  analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
  resultId: string | null; value: string | null; flag: string | null;
  refLow: string | null; refHigh: string | null; refText: string | null;
  verificationStatus: string | null; enteredById: string | null;
  pathologistReviewPending: boolean;
};

export type WireWorklistRow = {
  orderItemId: string; orderId: string; orderNo: string; encounterNo: string;
  patientId: string; patientDisplay: string;
  serviceId: string; orderableCode: string; orderableName: string; discipline: string;
  priority: string; state: string; specimenNo: string | null; tatStartedAt: string | null;
  analytes: WireAnalyteRow[];
};

export type WireOrderable = {
  serviceId: string; code: string; nameEn: string; nameHi: string | null;
  discipline: string; specimenType: string; container: string;
  consentRequired: boolean; sensitive: boolean; active: boolean;
};

export type WireDuplicateWarning = {
  serviceId: string; duplicateOfItemId: string; reason: string;
};

export type WireDeskOrder = {
  orderId: string; orderNo: string; orderGroupId: string; itemIds: string[];
  invoice: {
    invoiceId: string; invoiceNo: string; netPayablePaise: number;
    receiptId: string | null; receiptNo: string | null; creditExtended: boolean;
  };
  reflexConsent: boolean;
  duplicates: { acknowledged: string[]; warnings: WireDuplicateWarning[] };
};

export type WireCollectionRow = {
  specimenId: string; specimenNo: string; patientId: string; patientDisplay: string;
  specimenType: string; container: string; status: string; orderGroupId: string;
  itemIds: string[]; labelledAt: string | null; waitingMinutes: number;
};

export type WirePrintedSpecimen = {
  specimenId: string; specimenNo: string; specimenType: string; container: string; itemIds: string[];
};

export type WireCriticalCall = {
  id: string; resultId: string; openedAt: string; openedBy: string;
  attempts: { at: string; by: string; contact: string; outcome: string }[];
  readbackText: string | null; closedBy: string | null; closedAt: string | null;
};

export type WireDeliveryVerdict = {
  allowed: boolean;
  reason: "unpaid_invoices" | "exempt_payer" | "settled" | "released_by_approval";
  unpaidInvoiceIds: string[];
  outstandingPaise: number;
};

export type WireReportLine = {
  analyteCode: string; nameEn: string; nameHi: string | null; value: string;
  unit: string | null; flag: string | null;
  refLow: string | null; refHigh: string | null; refText: string | null; refNote: string | null;
  deltaFlag: boolean; verifiedAt: string | null; pathologistReviewPending: boolean;
};

export type WireReportPanel = {
  orderItemId: string; orderableCode: string; nameEn: string; nameHi: string | null;
  discipline: string; specimenNo: string | null; sensitive: boolean;
  analytes: WireReportLine[];
};

export type WireReportSnapshot = {
  orderId: string; orderNo: string; encounterNo: string; serviceDate: string;
  patient: { id: string; uhid: string; name: string; sex: string; dob: string | null };
  orderingClinicianId: string | null;
  panels: WireReportPanel[];
  signatory: { userId: string; username: string; signedAt: string };
  partial: boolean;
  notes: string[];
};

export type WireReportView = {
  reportId: string; orderId: string; version: number; status: string; partial: boolean;
  channels: string[]; printCount: number; priorVersionId: string | null;
  amendmentReasonCode: string | null; publishedAt: string | null;
  snapshot: WireReportSnapshot;
  delivery: WireDeliveryVerdict;
};

export type WireEncounterResult = {
  orderId: string; orderItemId: string; orderableCode: string; orderableName: string;
  analyteCode: string; analyteName: string; value: string; unit: string | null;
  flag: string | null; refLow: string | null; refHigh: string | null; refText: string | null;
  deltaFlag: boolean; verifiedAt: string | null; pathologistReviewPending: boolean;
};

/* ─────────────────────────────── the catalogue ─────────────────────────────── */

export const searchOrderables = (q: string): Promise<WireOrderable[]> =>
  api("GET", `/lab/catalogue/search?q=${encodeURIComponent(q)}`);

export const duplicateWarnings = (
  patientId: string, serviceIds: string[],
): Promise<WireDuplicateWarning[]> =>
  api("POST", "/lab/catalogue/duplicates", { patientId, serviceIds });

/* ─────────────────────────────────── the desk ─────────────────────────────────── */

export type DeskOrderRequest = {
  patientId: string; encounterNo: string; serviceDate: string; orderingClinicianId: string;
  items: { serviceId: string; consent?: { recordedBy: string } }[];
  priority?: "routine" | "urgent" | "stat";
  reflexConsent?: boolean;
  acknowledgedDuplicates?: string[];
  credit?: { reason: string };
  receipt?: { tenders: { mode: string; amountPaise: number }[] };
};

export const placeLabOrder = (body: DeskOrderRequest, key: string): Promise<WireDeskOrder> =>
  api("POST", "/lab/desk/orders", body, key);

export const cancelLabItem = (itemId: string, reason: string, key: string): Promise<unknown> =>
  api("POST", `/lab/desk/items/${itemId}/cancel`, { reason }, key);

/* ───────────────────────────────── collection ───────────────────────────────── */

export const collectionQueue = (serviceDate: string): Promise<WireCollectionRow[]> =>
  api("GET", `/lab/collection/queue?serviceDate=${serviceDate}`);

export const printLabels = (
  orderGroupId: string, scannedUhid: string, key: string,
): Promise<{ specimens: WirePrintedSpecimen[] }> =>
  api("POST", "/lab/collection/labels", { orderGroupId, scannedUhid }, key);

export const drawSpecimen = (
  specimenId: string, wristbandScanned: boolean, key: string,
): Promise<unknown> =>
  api("POST", "/lab/collection/collect", { specimenId, wristbandScanned }, key);

/* ─────────────────────────────────── the bench ─────────────────────────────────── */

export const benchWorklist = (): Promise<WireWorklistRow[]> => api("GET", "/lab/bench/worklist");

export const receiveSpecimen = (
  body: { specimenNo: string; containerSeen?: string; identityRecheckBy?: string }, key: string,
): Promise<unknown> => api("POST", "/lab/bench/receive", body, key);

export const rejectSpecimen = (
  body: { specimenNo: string; reason: string; attributableTo: string }, key: string,
): Promise<unknown> => api("POST", "/lab/bench/reject", body, key);

export type EnterResultRequest = {
  orderItemId: string; analyteId: string; value: string;
  entryMode: "manual" | "manual_from_printout";
  /** 02 H1 — a NAMED second holder of `lab.results.enter`, never a boolean the same person ticks. */
  absurdOverride?: { by: string };
};

export const enterResult = (body: EnterResultRequest, key: string): Promise<{
  resultId: string; flag: string | null; deltaFlagged: boolean; criticalCallId: string | null;
}> => api("POST", "/lab/bench/results", body, key);

export const openCriticals = (): Promise<WireCriticalCall[]> => api("GET", "/lab/bench/criticals");

export const acknowledgeCritical = (
  callId: string,
  body: { attempt?: { contact: string; outcome: string }; readback?: string },
): Promise<unknown> => api("POST", `/lab/bench/criticals/${callId}/ack`, body);

/* ────────────────────────── the signature and the document ────────────────────────── */

export const verifyWorklist = (): Promise<WireWorklistRow[]> => api("GET", "/lab/verify/worklist");

export const verifyResult = (resultId: string, key: string): Promise<unknown> =>
  api("POST", `/lab/verify/results/${resultId}`, undefined, key);

export const requestRerun = (resultId: string, reason: string): Promise<unknown> =>
  api("POST", "/lab/verify/rerun", { resultId, reason });

export const publishReport = (orderId: string, key: string): Promise<{ reportId: string; version: number }> =>
  api("POST", "/lab/reports", { orderId }, key);

export const getReport = (reportId: string): Promise<WireReportView> =>
  api("GET", `/lab/reports/${reportId}`);

export const reportVersions = (orderId: string): Promise<{
  versions: { id: string; version: number; status: string; publishedAt: string | null }[];
  delivery: WireDeliveryVerdict;
}> => api("GET", `/lab/reports/order/${orderId}`);

export const printReport = (
  reportId: string, body: { channel: string; collectorIdentity?: string }, key: string,
): Promise<{ deliveryId: string; printCount: number }> =>
  api("POST", `/lab/reports/${reportId}/print`, body, key);

export const resultsForEncounter = (encounterNo: string): Promise<WireEncounterResult[]> =>
  api("GET", `/lab/results/encounter/${encounterNo}`);

/**
 * ═══ THE ONE PIECE OF PRESENTATION LOGIC, AND IT IS A COLOUR ═══
 *
 * The flag is the SERVER's — resolved against the range that was snapshotted at entry — and this
 * only says how to draw it. `LL`/`HH` are the critical band and are the reason this function
 * exists: a potassium of 6.8 that rendered the same amber as a mildly high one is a number a tired
 * technologist scrolls past.
 */
export function flagTone(flag: string | null): "critical" | "abnormal" | "normal" | "none" {
  if (flag === "LL" || flag === "HH") return "critical";
  if (flag === "L" || flag === "H" || flag === "A") return "abnormal";
  if (flag === "N") return "normal";
  return "none";
}

/**
 * ═══ THE SERVER'S OWN SENTENCE, NOT A CLIENT-INVENTED ONE ═══
 *
 * Every refusal in this module was written to be READ AT A COUNTER: *"no lab orderable for X — the
 * advised test is not in this hospital's catalogue, and placing the rest would bill the patient for
 * part of what the doctor advised"*, *"the scan says HMS-…-5 and this order group belongs to
 * HMS-…-7 — no label was printed"*, *"₹300.00 outstanding"*. A client that re-worded them from a
 * `code` would either lose the detail (which invoice, which analyte, which UHID) or keep a second
 * copy of a sentence the server owns — §2.54 with a refusal as the fact that drifts.
 *
 * So the MESSAGE is preferred and the code is the fallback label. That is the opposite of
 * `otErrorText`'s order, and it is deliberate: the OT's codes name states a screen can explain on
 * its own; the laboratory's messages carry NUMBERS and IDENTIFIERS that only the server knows.
 */
export function labErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (typeof body?.code === "string") return body.code;
    return `HTTP ${String(e.status)}`;
  }
  return e instanceof Error ? e.message : String(e);
}
