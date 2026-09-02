import { api } from "./api";

/**
 * PLAN 18a T9 — the imaging department's wire contract, transcribed from the five
 * `radiology-*.controller.ts` files and `pcpndt.controller.ts` exactly as `lab-api.ts` transcribes
 * the laboratory's: this file DESCRIBES what those routes ship and never re-derives or widens it.
 *
 * ═══ NOTHING HERE DECIDES ANYTHING, AND THIS PHASE HAS THE SHARPEST REASON YET ═══
 *
 * Every control in this department is on the server and every one of them is a rule somebody could
 * be prosecuted over: whether a scan falls under the PCPNDT Act, whether a gate may be waived,
 * whether a report may be signed, whether a machine is registered. **A screen that computed any of
 * them would be a second copy of the rule (§2.54), and the copy that drifted would be the one a
 * sonologist was reading at 02:00.**
 *
 * So the client renders the state the server reports and sends intents. When the server refuses,
 * the screen shows the refusal's own `code` and message rather than translating it into something
 * friendlier — a technologist told "cannot proceed" cannot fix anything, and `form_f_missing` is a
 * sentence with an action in it.
 */

export type WireWorklistRow = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; scheduledAt: string | null; deviceResourceId: string | null;
  encounterNo: string; patientId: string; patientName: string;
  formFRequired: boolean; restricted: boolean;
};

export type WireStudyView = WireWorklistRow & {
  /** F59/F73 — the side the `laterality_confirm` gate recorded at check-in. */
  laterality: string;
  ionising: boolean; contrastGiven: boolean; acquiredAt: string | null; authorisedBy: string | null;
  /** 18b T2 — null until acquired; `mintedStudyInstanceUid` is what the console pre-fills (D3). */
  studyInstanceUid: string | null; imageSource: string | null; mintedStudyInstanceUid: string;
  /** 18b T3 — who opened the images, latest first. */
  views: { id: string; viewerId: string; viewerName: string; via: string; viewedAt: string }[];
  /** Close review B4 — the console shows "Open images" because the server says this reader may. */
  canOpenImages: boolean;
  /** 18b T4 — `machineDrafted` is true only on a version the drafter proposed (§6.8). */
  reports: { id: string; version: number; status: string; publishedAt: string | null; machineDrafted: boolean }[];
};

export type WireGate = { id: string; kind: string; state: string; waivable: boolean };
export type WireReadiness = { state: string; ready: boolean; gates: WireGate[]; open: string[] };

export type WireReportView = {
  reportId: string; studyId: string; accessionNo: string; version: number; status: string;
  templateKey: string; body: Record<string, unknown>; impression: string | null;
  laterality: string | null; criticalCategory: string | null;
  signerId: string | null; signedAt: string | null; publishedAt: string | null;
  amendmentReason: string | null; supersedesId: string | null; patientName: string;
  /** 18b T4 — non-null only on a machine-proposed draft. */
  provenance: { drafter: string; version: string; at: string } | null;
};

export type WireFormFView = {
  formFId: string; serialNo: number; serialYear: number; status: string;
  applicability: string; indicationCode: string; gestationWeeks: number | null;
  sections: Record<string, unknown>; declaration: Record<string, unknown>;
  referral: Record<string, unknown>; resultSummary: string | null;
  signedBy: string | null; signedAt: string | null;
  verifiedBy: string | null; verifiedAt: string | null;
  /** THE REAL NAME. A statutory declaration with an alias on it is a false declaration (T6 A6). */
  patientName: string; patientUhid: string; patientIsConfidential: boolean;
  machine: { id: string; make: string; model: string; serial: string };
  person: { id: string; userId: string; qualification: string };
};

export type WireBillDecision = {
  id: string; studyId: string; kind: string; detail: unknown; raisedAt: string;
};

/* ── reads ── */

export const fetchWorklist = (view: "floor" | "unread" | "all" = "floor") =>
  api<{ rows: WireWorklistRow[] }>("GET", `/radiology/worklist?view=${view}`);

export const fetchStudy = (studyId: string) =>
  api<{ study: WireStudyView | null }>("GET", `/radiology/studies/${studyId}`);

export const fetchReadiness = (studyId: string) =>
  api<WireReadiness>("GET", `/radiology/studies/${studyId}/readiness`);

export const fetchReport = (reportId: string) =>
  api<{ report: WireReportView | null }>("GET", `/radiology/reports/${reportId}`);

export const fetchFormF = (studyId: string) =>
  api<{ form: WireFormFView | null }>("GET", `/pcpndt/studies/${studyId}/form-f`);

export const fetchBillDecisions = () =>
  api<{ decisions: WireBillDecision[] }>("GET", "/radiology/bill-decisions");

export const fetchDeviceDiary = (deviceResourceId: string) =>
  api<{ studies: { studyId: string; accessionNo: string; scheduledAt: string | null; status: string }[] }>(
    "GET", `/radiology/studies/device/${deviceResourceId}/diary`,
  );

/* ── intents ── */

export const scheduleStudy = (studyId: string, body: { deviceResourceId: string; scheduledAt: string }) =>
  api("POST", `/radiology/studies/${studyId}/schedule`, body);

export const walkIn = (studyId: string) =>
  api("POST", `/radiology/studies/${studyId}/walk-in`, {});

export const checkInStudy = (studyId: string) =>
  api<{ studyId: string; status: string; gates: string[]; pregnancyReason: string; policySource: string }>(
    "POST", `/radiology/studies/${studyId}/check-in`, {},
  );

export const satisfyGate = (studyId: string, kind: string, evidence: unknown) =>
  api("POST", `/radiology/studies/${studyId}/gates/${kind}/satisfy`, evidence);

export const overrideGate = (studyId: string, kind: string, reason: string) =>
  api("POST", `/radiology/studies/${studyId}/gates/${kind}/override`, { reason });

export const waiveGate = (studyId: string, kind: string, reason: string) =>
  api("POST", `/radiology/studies/${studyId}/gates/${kind}/waive`, { reason });

/**
 * F52 — `onDate` is GONE from this call. The PCPNDT registration window is a legal date and the
 * server now derives it from its own IST clock; this function used to pass the browser's UTC day,
 * which is yesterday for five and a half hours every night.
 */
export const startAcquisition = (studyId: string) =>
  api("POST", `/radiology/studies/${studyId}/acquisition/start`, {});

export const recordAcquired = (studyId: string, body: Record<string, unknown>) =>
  api("POST", `/radiology/studies/${studyId}/acquisition/acquired`, body);

/** 18b T3 — a POST: the view row, the event and the PHI line exist before the URL comes back. */
export const openImages = (studyId: string) =>
  api<{ url: string; viewId: string; studyInstanceUid: string }>("POST", `/radiology/studies/${studyId}/images/open`);

/** 18b T4 — the drafter proposes from the study's recorded facts; no body travels. */
export const proposeDraft = (studyId: string) =>
  api<{
    reportId: string; version: number; templateKey: string;
    body: Record<string, string>; impression: string | null; provenance: { drafter: string };
  }>("POST", `/radiology/studies/${studyId}/reports/propose`);

export const draftReport = (studyId: string, body: Record<string, unknown>) =>
  api<{ reportId: string; version: number }>("POST", `/radiology/studies/${studyId}/reports/draft`, body);

export const signReport = (studyId: string, body: { reportId: string; criticalCategory?: string | null }) =>
  api<{ reportId: string; version: number }>("POST", `/radiology/studies/${studyId}/reports/sign`, body);

export const publishReport = (studyId: string) =>
  api<{ reportId: string; version: number; notified: boolean }>(
    "POST", `/radiology/studies/${studyId}/reports/publish`, {},
  );

/**
 * ═══ F57 (CLOSE REVIEW) — THIS WAS `Record<string, unknown>`, AND THAT IS WHY THE SCREEN 400'd ═══
 *
 * The screen sent four fields where the controller requires seven, and nothing could see it: an
 * untyped body makes the wire the one place in a TypeScript codebase where a mismatch is invisible
 * at compile time and silent until a human clicks. The type below is the controller's `openBody`,
 * transcribed — `onDate` deliberately absent, because the serial year is the server's (F52).
 */
export type OpenFormFBody = {
  studyId: string;
  patientId: string;
  deviceResourceId: string;
  /** Part H's registered person. Optional: the server defaults it to the authenticated actor. */
  personUserId?: string;
  indicationCode: string;
  applicability: "pregnant" | "not_pregnant" | "indication_only";
};

export const openFormF = (body: OpenFormFBody) =>
  api<{ formFId: string; serialNo: number; serialYear: number }>("POST", "/pcpndt/form-f", body);

export const recordFormF = (formFId: string, body: Record<string, unknown>) =>
  api("POST", `/pcpndt/form-f/${formFId}/record`, body);

export const verifyFormF = (formFId: string) =>
  api("POST", `/pcpndt/form-f/${formFId}/verify`, {});

/**
 * The refusal, as the server worded it. **Never re-worded here.** `form_f_missing`,
 * `machine_not_registered` and `lexical_lockout` each name a thing a person can go and do; a
 * friendlier "could not complete" names nothing, and this department's refusals are the whole
 * product.
 */
export function radiologyErrorText(e: unknown): string {
  const body = (e as { body?: { message?: string; code?: string } } | undefined)?.body;
  if (body?.message !== undefined) return body.code === undefined ? body.message : `${body.message} (${body.code})`;
  return e instanceof Error ? e.message : String(e);
}
