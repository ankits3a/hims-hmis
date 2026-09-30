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
  /** 18-S RS3 — when the order arrived and when the patient was checked in (the desk's clocks). */
  createdAt: string; checkedInAt: string | null;
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
  /** 18-S RS12 — the archive's word on this study: when its images arrived and how many (null until then). */
  archive?: { arrivedAt: string; seriesCount: number; instanceCount: number } | null;
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

/* ── 18-S RS2 — the ordering door (`GET /radiology/advised`, `POST /radiology/orders`) ── */

export type WireImagingOrderable = {
  studyTypeCode: string; studyTypeName: string; modality: string; lateralityApplicable: boolean;
  contrast: "none" | "optional" | "required"; ionising: boolean; pcpndtApplicable: boolean;
};
export type WireAdvisedImagingLine = {
  serviceId: string; code: string; name: string; pricePaise: number;
  /** Null when the active book does not name the service (D6) — shown greyed with `reason`. */
  orderable: WireImagingOrderable | null; reason: string | null;
  alreadyOrderedItemId: string | null; alreadyOrderedOrderNo: string | null;
};
export type WireImagingBookEntry = WireImagingOrderable & { serviceId: string; pricePaise: number | null };
export type WireImagingRecentItem = { itemId: string; orderNo: string; encounterNo: string; placedAt: string };
export type WireImagingVisitOrder = {
  orderId: string; orderNo: string; priority: string; status: string; authority: string;
  indication: string | null; placedAt: string;
  items: {
    itemId: string; serviceId: string; serviceName: string; status: string;
    study: { studyId: string; accessionNo: string; status: string; scheduledAt: string | null } | null;
  }[];
};
export type WireImagingDoor = {
  visit: {
    encounterId: string; encounterNo: string; serviceDate: string; status: string;
    doctorName: string | null; doctorUserId: string | null; departmentName: string | null;
    patient: { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null; restricted: boolean };
  };
  bookActive: boolean;
  lines: WireAdvisedImagingLine[];
  book: WireImagingBookEntry[];
  recent: Record<string, WireImagingRecentItem[]>;
  orders: WireImagingVisitOrder[];
};

/** The controller's `orderBody`, transcribed (F57's lesson: an untyped body is an invisible 400). */
export type PlaceImagingOrderBody = {
  patientId: string; encounterNo: string; serviceDate: string; orderingClinicianId: string;
  priority?: "routine" | "urgent" | "stat";
  indication: string;
  items: { serviceId: string; duplicateOfItemId?: string | null; duplicateReason?: string | null }[];
  authority?: "clinician" | "external_prescription";
  referrer?: { name: string; registrationNo: string } | null;
};

export const fetchImagingDoor = (encounterNo: string) =>
  api<WireImagingDoor>("GET", `/radiology/advised?encounterNo=${encodeURIComponent(encounterNo)}`);

export const placeImagingOrder = (body: PlaceImagingOrderBody, idempotencyKey: string) =>
  api<{ orderId: string; orderNo: string; itemIds: string[] }>("POST", "/radiology/orders", body, idempotencyKey);

/* ── 18-S RS2b — the machine list and the portable round ── */

/** `GET /radiology/devices` — every bookable imaging machine (`devices.ts`). */
export type WireImagingDevice = {
  id: string; code: string; name: string; modality: string; room: string | null;
  portable: boolean; status: string; ionising: boolean;
  /** Ionising machines only; `null` when AERB licenses none (ultrasound, MRI). */
  licensedNow: boolean | null;
};

/** `GET /radiology/portable/round` — `bedside.ts`'s `BedsideStudyRow`. */
export type WireBedsideStudy = {
  studyId: string; accessionNo: string; status: string; priority: string; studyTypeCode: string;
  bedsideLocation: string; scheduledAt: string | null; deviceResourceId: string | null;
  deviceCode: string | null; encounterNo: string; patientId: string; patientName: string; restricted: boolean;
};

export const fetchImagingDevices = () => api<{ devices: WireImagingDevice[] }>("GET", "/radiology/devices");

export const fetchPortableRound = () => api<{ rows: WireBedsideStudy[] }>("GET", "/radiology/portable/round");

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

/** `deviceDiary` (schedule.ts) — widened in 18-S RS3 for the desk's diary grid. */
export type WireDiaryEntry = {
  studyId: string; accessionNo: string; scheduledAt: string | null; status: string;
  durationMin: number; studyTypeCode: string; priority: string; patientName: string;
  bedsideLocation: string | null;
};

export const fetchDeviceDiary = (deviceResourceId: string) =>
  api<{ studies: WireDiaryEntry[] }>("GET", `/radiology/studies/device/${deviceResourceId}/diary`);

/* ── 18-S RS3 — the imaging front desk: counter read, desk acts, hall board ── */

/** `counter.ts`'s `CounterView`, transcribed. */
export type WireCounterView = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; modality: string; durationMin: number;
  serviceId: string; encounterNo: string; patientId: string; patientName: string; uhid: string; restricted: boolean;
  scheduledAt: string | null; deviceResourceId: string | null; bedsideLocation: string | null;
  invoiceLineId: string | null;
  intendedPayer: string;
  /** `authorisationOf`'s answer — `null` is exactly the room's `payment_required`. */
  authorisation: "invoice" | "daycare" | "payer_branch" | "stat" | null;
  checks: {
    gates: string[];
    pregnancyReason: "opened" | "not_ionising" | "sex_not_female" | "age_outside_band";
    policySource: "published" | "default";
    prep: string[];
  };
  addOns: { kind: "film" | "cd"; serviceId: string; code: string; name: string }[];
};

export const fetchCounter = (studyId: string) =>
  api<{ study: WireCounterView }>("GET", `/radiology/studies/${studyId}/counter`);

/** Every desk act on a booking carries a reason; the server refuses `reason_required` without one. */
export const rescheduleStudy = (
  studyId: string,
  body: { deviceResourceId: string; scheduledAt: string; bedsideLocation?: string | null; reason: string },
) => api("POST", `/radiology/studies/${studyId}/reschedule`, body);

export const markNoShow = (studyId: string, reason: string) =>
  api("POST", `/radiology/studies/${studyId}/no-show`, { reason });

export const cancelImagingStudy = (studyId: string, reason: string) =>
  api<{ studyId: string; billDecisionId: string | null }>("POST", `/radiology/studies/${studyId}/cancel`, { reason });

/** The counter's link from a raised invoice line to the study it pays for (`linkInvoiceLine`). */
export const linkInvoiceLine = (studyId: string, invoiceLineId: string) =>
  api<{ studyId: string; invoiceLineId: string }>("POST", `/radiology/studies/${studyId}/invoice-line`, { invoiceLineId });

/** `GET /billing/invoices/:id` — only the fields the desk reads to find the line it just raised. */
export const fetchInvoiceLines = (invoiceId: string) =>
  api<{ invoice: { id: string; invoiceNo: string }; lines: { id: string; serviceId: string; lineNo: number }[] }>(
    "GET", `/billing/invoices/${encodeURIComponent(invoiceId)}`,
  );

/** `display.ts`'s `HallBoard`. */
export type WireHallEntry = { token: string; name: string | null };
export type WireHallRoom = {
  deviceResourceId: string; code: string; name: string; room: string | null; modality: string;
  closed: "down" | "not_licensed" | null; now: WireHallEntry | null; next: WireHallEntry[];
};
export const fetchHallBoard = () => api<{ day: string; rooms: WireHallRoom[] }>("GET", "/radiology/display");

/* ── intents ── */

export const scheduleStudy = (
  studyId: string,
  /** `bedsideLocation` — 18-S RS2b: only for a portable machine; the server refuses the rest. */
  body: { deviceResourceId: string; scheduledAt: string; bedsideLocation?: string | null },
) =>
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
  api<{ url: string; viewId: string; studyInstanceUid: string; viewer?: "ohif" | "other" }>("POST", `/radiology/studies/${studyId}/images/open`);

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
/** The refusal's `code`, for choosing which seat fixes it. The words stay the server's. */
export function radiologyErrorCode(e: unknown): string | null {
  return (e as { body?: { code?: string } } | undefined)?.body?.code ?? null;
}

/** The refusal's `detail`, when the server attached one (e.g. `duplicate_invoice_refused`'s invoice). */
export function radiologyErrorDetail(e: unknown): Record<string, unknown> | null {
  const d = (e as { body?: { detail?: unknown } } | undefined)?.body?.detail;
  return d !== null && typeof d === "object" ? d as Record<string, unknown> : null;
}

export function radiologyErrorText(e: unknown): string {
  const body = (e as { body?: { message?: string; code?: string } } | undefined)?.body;
  if (body?.message !== undefined) return body.code === undefined ? body.message : `${body.message} (${body.code})`;
  return e instanceof Error ? e.message : String(e);
}

/* ── 18-S RS5 — the prep & safety bay, the override request, contrast and reaction ── */

/** `prep-bay.ts`'s `PrepBayRow`. */
export type WirePrepRow = {
  studyId: string; accessionNo: string; priority: string; studyTypeCode: string;
  scheduledAt: string | null; checkedInAt: string | null; deviceCode: string | null;
  patientId: string; patientName: string; restricted: boolean;
  openPrep: string[]; openRoom: string[]; asked: string[];
};

export type WireEgfr =
  | { computed: true; egfr: number; band: "hold" | "hydrate" | "clear"; creatinineMgDl: number; ageYears: number; sex: string; metforminHold: boolean }
  | { computed: false; reason: "no_dob" | "sex_not_binary" | "under_18"; creatinineMgDl: number };

export type WirePrepGate = {
  id: string; kind: string; state: string; waivable: boolean;
  room: boolean; neverWaive: boolean; neverOverride: boolean;
  evidence: Record<string, unknown> | null; satisfiedAt: string | null; override: { actorId: string; reason: string } | null;
  asked: { approvalId: string; note: string | null; requestedAt: string; requesterName: string | null } | null;
};

export type WireContrastAdministration = {
  id: string; studyId: string; agent: string; volumeMl: string | number; route: string; site: string | null;
  vialBatchNo: string | null; vialExpiry: string | null; givenBy: string; givenAt: string;
};
export type WireContrastReaction = {
  id: string; administrationId: string; severity: string; onset: string; manifestation: string;
  treatmentGiven: string | null; outcome: string | null; observedBy: string; observedAt: string; allergyId: string | null;
};

/** `prep-bay.ts`'s `PrepStudyView`. */
export type WirePrepStudy = {
  study: {
    studyId: string; accessionNo: string; status: string; priority: string; studyTypeCode: string;
    studyTypeName: string; modality: string; ionising: boolean; contrastOption: string;
    laterality: string; lateralityApplicable: boolean; encounterNo: string;
    scheduledAt: string | null; deviceCode: string | null; formFRequired: boolean;
  };
  patient: { id: string; name: string; uhid: string; sex: string; dob: string | null; ageYears: number | null };
  allergies: { substance: string; severity: string | null; reaction: string | null; contrast: boolean }[];
  weight: { kg: number; recordedAt: string } | null;
  kidney: {
    creatinine: { resultId: string; umolL: number; reported: { value: string; unit: string | null }; sampledAt: string } | null;
    egfr: WireEgfr | null; validDays: number; ceilingUmolL: number;
    hydrationInstruction: string; metforminNote: string;
  };
  lmpDate: string | null;
  gates: WirePrepGate[];
  guardians: { guardianId: string; name: string; relationship: string; consents: boolean }[];
  staff: { id: string; name: string; roles: string[] }[];
  contrast: { administrations: WireContrastAdministration[]; reactions: WireContrastReaction[] };
};

export const fetchPrepBay = () => api<{ rows: WirePrepRow[] }>("GET", "/radiology/prep");

export const fetchPrepStudy = (studyId: string) =>
  api<{ view: WirePrepStudy }>("GET", `/radiology/prep/studies/${encodeURIComponent(studyId)}`);

/** "Ask the radiologist to override" — a kernel approval routed to the radiologist (T2). */
export const requestGateOverride = (studyId: string, kind: string, reason: string) =>
  api<{ approvalId: string; kind: string }>("POST", `/radiology/studies/${studyId}/gates/${kind}/override-request`, { reason });

/** `override-requests.ts`'s `GateOverrideRequest`. */
export type WireOverrideRequest = {
  approvalId: string; status: string; studyId: string; accessionNo: string; studyTypeCode: string;
  patientId: string; patientName: string; kind: string; gateState: string; note: string | null;
  requesterId: string; requesterName: string | null; requestedAt: string;
};

export const fetchOverrideRequests = (studyId?: string) =>
  api<{ requests: WireOverrideRequest[] }>(
    "GET", `/radiology/gate-override-requests${studyId === undefined ? "" : `?studyId=${encodeURIComponent(studyId)}`}`,
  );

/** The radiologist's decision; `grant` runs the existing override with this reason. */
export const decideOverrideRequest = (approvalId: string, verdict: "grant" | "refuse", reason: string) =>
  api<{ verdict: string; override: { kind: string; state: string } | null; study: { state: string; open: string[] } | null; note: string | null }>(
    "POST", `/radiology/gate-override-requests/${encodeURIComponent(approvalId)}/decide`, { verdict, reason },
  );

/** The controller's `contrastBody` (18a-iii T1), transcribed. */
export type RecordContrastBody = {
  agent: string; volumeMl: number; route: string; site?: string | null;
  vialBatchNo?: string | null; vialExpiry?: string | null; givenBy: string; givenAt: string;
};
export const recordContrast = (studyId: string, body: RecordContrastBody) =>
  api<{ administrationId: string }>("POST", `/radiology/studies/${studyId}/contrast`, body);

/** The controller's `reactionBody` (18a-iii T2), transcribed. */
export type RecordReactionBody = {
  administrationId: string; severity: "mild" | "moderate" | "severe"; onset: "immediate" | "delayed";
  manifestation: string; treatmentGiven?: string | null; managingClinicianId?: string | null;
  outcome?: "recovered" | "recovering" | "admitted" | "referred" | "died" | null;
  observedBy: string; observedAt: string;
};
export const recordContrastReaction = (body: RecordReactionBody) =>
  api<{ reactionId: string; allergyId: string }>("POST", "/radiology/studies/contrast-reactions", body);
