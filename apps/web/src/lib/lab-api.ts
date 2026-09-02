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
  /** 17c T4 / D11 — the last VERIFIED value of this analyte on the canonical patient, or null. */
  previous: { resultId: string; value: string; flag: string | null; at: string } | null;
};

export type WireWorklistRow = {
  orderItemId: string; orderId: string; orderNo: string; encounterNo: string;
  patientId: string; patientDisplay: string;
  serviceId: string; orderableCode: string; orderableName: string; discipline: string;
  priority: string; state: string; specimenNo: string | null; tatStartedAt: string | null;
  /** 17c T4 — the orderable's target for this item's priority, in minutes. */
  tatTargetMinutes: number;
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
  encounterNo: string;
  orderId: string; orderNo: string; orderGroupId: string; itemIds: string[];
  invoice: {
    invoiceId: string; invoiceNo: string; netPayablePaise: number;
    receiptId: string | null; receiptNo: string | null; creditExtended: boolean;
  };
  reflexConsent: boolean;
  duplicates: { acknowledged: string[]; warnings: WireDuplicateWarning[] };
};

/**
 * 17c T2 F1 — this type was written in 17b T8 against fields the server never sent
 * (`patientDisplay`, `waitingMinutes`, `labelledAt`), so the shipped queue rendered blanks. It now
 * mirrors `CollectionQueueRow` exactly, and the server sends every field named here.
 */
export type WireCollectionRow = {
  specimenId: string; specimenNo: string; orderGroupId: string; patientId: string;
  patientName: string; patientDisplay: string; uhid: string; encounterNo: string;
  tokenNo: number | null; labelledAt: string; waitingMinutes: number;
  specimenType: string; container: string; collectionSite: string; priority: string;
  requiresFasting: boolean; orderableCodes: string[]; itemIds: string[];
};

/** 17c T2 — an order group waiting for its LABEL, the half of the chair's queue 17a did not have. */
export type WireAwaitingRow = {
  orderGroupId: string; patientId: string; patientDisplay: string; uhid: string; encounterNo: string;
  tokenNo: number | null; priority: string; requiresFasting: boolean; orderableCodes: string[];
  itemIds: string[]; placedAt: string; waitingMinutes: number;
};

export const awaitingLabels = (serviceDate: string): Promise<WireAwaitingRow[]> =>
  api("GET", `/lab/collection/awaiting?serviceDate=${serviceDate}`);

export type WirePrintedSpecimen = {
  specimenId: string; specimenNo: string; specimenType: string; container: string; itemIds: string[];
};

export type WireCriticalCall = {
  id: string; resultId: string; openedAt: string; openedBy: string;
  attempts: { at: string; by: string; contact: string; outcome: string }[];
  /** WHOSE value it is and WHAT it was — a ladder without these is a ladder nobody can work. */
  patientDisplay: string; patientId: string; orderNo: string; encounterNo: string;
  analyteCode: string; value: string; unit: string | null; flag: string | null;
  /** Non-null when the value has been RETRACTED by an amendment since the call opened (F17). */
  supersededBy: { value: string; flag: string | null } | null;
};

export type WirePublishable = {
  orderId: string; orderNo: string; encounterNo: string;
  patientId: string; patientDisplay: string; serviceDate: string;
  /** False ⇒ only 02 D7's PARTIAL report is available; the rest follows as a later version. */
  complete: boolean; itemCount: number; completedCount: number; orderables: string[];
  /** Non-null when a PARTIAL version already stands — the screen AMENDS it (pass 2, F9). */
  amendsReportId: string | null;
};

export type WirePricedDraft = {
  tariffVersionId: string;
  intendedPayer: string;
  /** Billing's own per-line net — the seat sums the PAID lines from these, never from a tariff of its own. */
  lines: { lineId: string; serviceId: string; serviceName: string; netPaise: number }[];
  totals: { grossPaise: number; discountPaise: number; taxableBasePaise: number;
    cgstPaise: number; sgstPaise: number; roundingPaise: number; netPayablePaise: number };
  /** 17c T1 — what the chair will draw, in order of draw. */
  tubes: WireTubePlanRow[];
};

export type WireTubePlanRow = { container: string; specimenType: string; codes: string[] };

/* ─────────────────────────── 17c T1 — the reception seat's find ─────────────────────────── */

export type WireAdvisedLine = {
  serviceId: string; code: string; name: string; pricePaise: number;
  orderable: { container: string; specimenType: string; consentRequired: boolean; sensitive: boolean; requiresFasting: boolean } | null;
  alreadyOrderedItemId: string | null;
};

export type WireDeskFindHit = {
  matchedOn: "token" | "visit" | "order" | "uhid" | "mobile" | "name";
  patient: { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null; restricted: boolean };
  visit: {
    encounterId: string; encounterNo: string; serviceDate: string; status: string;
    tokenNo: number | null; doctorName: string | null; doctorUserId: string | null; departmentName: string | null;
    referrerName: string | null;
    advised: WireAdvisedLine[];
  } | null;
  orders: { orderId: string; orderNo: string; status: string; itemCount: number }[];
};

export const deskFind = (q: string, serviceDate: string): Promise<{ hits: WireDeskFindHit[] }> =>
  api("GET", `/lab/desk/find?q=${encodeURIComponent(q)}&serviceDate=${serviceDate}`);

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
  patientId: string; serviceDate: string;
  /** A visit order names its visit and clinician; a walk-in names neither (17c T1, the walk-in door). */
  encounterNo?: string; orderingClinicianId?: string;
  walkIn?: { referrerName?: string; doctorId?: string; intendedPayer?: "self" | "tpa" | "pmjay" | "corporate" };
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

/** What the basket costs, priced by BILLING's own engine — never totalled on the client (§2.54). */
export const previewLabOrder = (
  patientId: string, encounterNo: string | null, serviceIds: string[],
): Promise<WirePricedDraft> =>
  api("POST", "/lab/desk/preview", { patientId, ...(encounterNo === null ? {} : { encounterNo }), serviceIds });

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

/** 17c T3 / D7 — a tube drawn and not yet received, WITH its patient: what a scan at the bench resolves against first. */
export type WireBenchArrival = {
  specimenId: string; specimenNo: string; orderGroupId: string; patientId: string; patientDisplay: string;
  encounterNo: string; container: string; specimenType: string; collectionSite: string; priority: string;
  orderableCodes: string[]; itemIds: string[]; collectedAt: string | null; wristbandScanned: boolean;
  waitingMinutes: number;
};

export const benchArrivals = (): Promise<WireBenchArrival[]> => api("GET", "/lab/bench/arrivals");

/** The department-wide topics the bench and the verify seat watch (server: `LAB_BENCH_TOPIC`, `lab_critical`). */
export const LAB_BENCH_TOPIC = "lab:bench";
export const LAB_CRITICAL_TOPIC = "lab_critical";

export const receiveSpecimen = (
  body: { specimenNo: string; containerSeen?: string; identityRecheckBy?: string }, key: string,
): Promise<unknown> => api("POST", "/lab/bench/receive", body, key);

export const rejectSpecimen = (
  body: { specimenNo: string; reason: string; attributableTo: string }, key: string,
): Promise<unknown> => api("POST", "/lab/bench/reject", body, key);

export type EnterResultRequest = {
  orderItemId: string; analyteId: string; value: string;
  entryMode: "manual" | "manual_from_printout";
  /**
   * 02 H1 — a NAMED second holder of `lab.results.enter`, never a boolean the same person ticks.
   * It is a `users.id`, which is why the screen asks for a login rather than a name.
   */
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

/**
 * The orders a report can be published for. A SEPARATE queue from the verify worklist, because an
 * item leaves that worklist at the exact moment it becomes publishable (close review, web C3).
 */
export const publishableOrders = (): Promise<WirePublishable[]> =>
  api("GET", "/lab/reports/publishable");

export const verifyResult = (resultId: string, key: string): Promise<unknown> =>
  api("POST", `/lab/verify/results/${resultId}`, undefined, key);

export const requestRerun = (resultId: string, reason: string): Promise<unknown> =>
  api("POST", "/lab/verify/rerun", { resultId, reason });

export const publishReport = (
  orderId: string, key: string, partial = false,
): Promise<{ reportId: string; version: number }> =>
  api("POST", "/lab/reports", partial ? { orderId, partial: true } : { orderId }, key);

export const getReport = (reportId: string): Promise<WireReportView> =>
  api("GET", `/lab/reports/${reportId}`);

/** The named projection C1 left behind — `reportId`, never `id`, and NO snapshot (pass 2, F19). */
export type WireReportVersion = {
  reportId: string; version: number; status: string; partial: boolean;
  channels: string[]; printCount: number; priorVersionId: string | null;
  amendmentReasonCode: string | null; publishedAt: string | null; signedBy: string | null;
};

export const reportVersions = (orderId: string): Promise<{ versions: WireReportVersion[] }> =>
  api("GET", `/lab/reports/order/${orderId}`);

export const amendReport = (
  reportId: string, reasonCode: string, key: string,
): Promise<{ reportId: string; version: number }> =>
  api("POST", `/lab/reports/${reportId}/amend`, { reasonCode }, key);

export const printReport = (
  reportId: string, body: { channel: string; collectorIdentity?: string }, key: string,
): Promise<{ deliveryId: string; printCount: number }> =>
  api("POST", `/lab/reports/${reportId}/print`, body, key);

/* ─────────────────────────── 17c T5 — the report centre ─────────────────────────── */

export type WireReportDelivery = { deliveryId: string; channel: string; at: string; collectorIdentity: string | null; deliveredBy: string };
export type WireReportNotice = { status: string; sentChannel: string | null; sentAt: string | null };

export type WirePatientReportRow = {
  reportId: string; orderId: string; orderNo: string; encounterNo: string; serviceDate: string;
  version: number; partial: boolean; publishedAt: string | null; channels: string[]; printCount: number;
  orderables: string[]; sensitive: boolean; delivery: WireDeliveryVerdict; deliveries: WireReportDelivery[];
  notice: WireReportNotice | null;
  /** Present ONLY when the verdict allows the hand-over — a held document is never sent. */
  snapshot: WireReportSnapshot | null;
};

export type WirePatientReports = {
  patient: { id: string; uhid: string; display: string; restricted: boolean };
  reports: WirePatientReportRow[];
  pending: { orderId: string; orderNo: string; serviceDate: string; orderables: string[]; completedCount: number; itemCount: number }[];
};

export type WireDeliveryRegisterRow = {
  reportId: string; orderId: string; orderNo: string; patientId: string; patientDisplay: string;
  orderables: string[]; sensitive: boolean; partial: boolean; version: number; publishedAt: string; signedBy: string | null;
  delivery: WireDeliveryVerdict; deliveries: WireReportDelivery[]; notice: WireReportNotice | null;
};

export const reportsForPatient = (patientId: string): Promise<WirePatientReports> =>
  api("GET", `/lab/reports/patient/${patientId}`);

export const deliveryRegister = (serviceDate: string): Promise<WireDeliveryRegisterRow[]> =>
  api("GET", `/lab/reports/register?serviceDate=${serviceDate}`);

/** DD6 — the release of a HELD report is a `lab_release_unpaid` approval ABOUT THE ORDER, decided by the billing manager. */
export const requestReleaseApproval = (
  body: { orderId: string; patientId: string; amountPaise: number; note: string },
): Promise<{ approvalId: string }> =>
  api("POST", "/approvals", {
    typeKey: "lab_release_unpaid", subject: { type: "lab_order", id: body.orderId },
    patientId: body.patientId, amountPaise: body.amountPaise, requestNote: body.note,
  });

export const releaseReport = (
  reportId: string, body: { approvalId: string; collectorIdentity: string; channel?: "print" | "in_person" }, key: string,
): Promise<{ deliveryId: string; printCount: number }> =>
  api("POST", `/lab/reports/${reportId}/release`, body, key);

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
/**
 * ═══ THE IST CALENDAR DAY, NOT THE BROWSER'S UTC ONE (close review, web MAJOR) ═══
 *
 * The screens defaulted `serviceDate` to `new Date().toISOString().slice(0, 10)`, which is the UTC
 * day. Between 00:00 and 05:30 IST that is YESTERDAY — so every order placed on a night shift was
 * dated to the previous day, missed the collection queue (which filters on `serviceDate`), and
 * minted its `S` number from the wrong daily counter.
 *
 * It formats through `Asia/Kolkata` rather than adding 5.5 hours, because this is a BROWSER and the
 * offset census in `apps/core` counts the server's copies of the clock; a thirteenth one over here
 * would be a copy nothing counts. `en-CA` yields `YYYY-MM-DD`.
 */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

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
    /**
     * ═══ A ZOD REFUSAL IS AN ARRAY OF ISSUES, AND IT MUST NOT BECOME "HTTP 400" ═══
     *
     * Nest's `BadRequestException(issues)` puts the ISSUE LIST in `message`, so the string branch
     * above misses it and every schema refusal read as a bare status code — a clerk told "HTTP 400"
     * cannot find the field. Each issue carries its own `path` and `message`; both are shown.
     */
    if (Array.isArray(body?.message)) {
      const issues = (body.message as { path?: unknown[]; message?: unknown }[])
        .map((i) => `${(i.path ?? []).join(".")}: ${String(i.message ?? "invalid")}`)
        .filter((line) => line !== ": invalid");
      if (issues.length > 0) return issues.join("; ");
    }
    if (typeof body?.code === "string") return body.code;
    return `HTTP ${String(e.status)}`;
  }
  return e instanceof Error ? e.message : String(e);
}
