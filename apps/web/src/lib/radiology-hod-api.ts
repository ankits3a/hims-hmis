import { api } from "./api";

/**
 * PLAN 18-S RS10 — the wire contract of `radiology-supervisor.controller.ts`, transcribed (the
 * `radiology-api.ts` rule: this file describes what the routes ship and decides nothing). Every
 * route is `radiology.definitions.manage` — the department head's grant.
 */

export const FLOOR_STAGES = [
  "scheduled", "checked_in", "ready", "in_acquisition", "to_read", "drafted", "reported", "published",
] as const;
export type FloorStage = (typeof FLOOR_STAGES)[number];

export type WireFloor = {
  generatedAt: string;
  day: string;
  pipeline: { stage: FloorStage; count: number; held: number; oldest: { studyId: string; accessionNo: string; studyTypeCode: string; waitMin: number } | null }[];
  rooms: {
    deviceId: string; code: string; name: string; modality: string; room: string | null; status: string;
    licensedNow: boolean | null; queue: number; onTable: string | null; nextFreeAt: string | null; technologist: null;
  }[];
  readers: { toRead: number; stat: number; drafted: number; claimed: { userId: string; name: string; studies: number }[]; unclaimed: number };
  turnaround: {
    from: string; to: string;
    rows: { modality: string; source: string; n: number; medianMin: number | null; p90Min: number | null; targetMin: number; withinTarget: boolean | null }[];
    northStar: { orderToActed: { n: number; medianMin: number | null; p90Min: number | null }; signedUnreadOver24h: number; publishedNotActedOver72h: number };
  };
  leakage: {
    open: number; estimatedPaise: number; unpriced: number;
    rows: { billDecisionId: string; studyId: string; accessionNo: string; studyTypeCode: string; raisedAt: string; ageMin: number; listPricePaise: number | null }[];
  };
  criticals: { openRed: number; openAll: number; oldestRedMin: number | null };
  unmatchedPacs: { measured: boolean; open: number; olderThan24h: number };
  licenceGaps: { deviceId: string; code: string; name: string; booked: number }[];
  qaOverdue: { deviceCode: string; qaType: string; dueOn: string; daysOverdue: number; state: string }[];
  escalations: { open: number; raised: number };
  approvals: { pending: number };
};

export type EscalationCause =
  | "stat_unread" | "held_study" | "red_critical" | "machine_down" | "licence_gap" | "bill_decision_stale" | "abnormal_unopened"
  | "unmatched_pacs";

export type WireEscalation = {
  cause: EscalationCause;
  subjectType: string;
  subjectId: string;
  since: string;
  studyId: string | null;
  accessionNo: string | null;
  studyTypeCode: string | null;
  deviceCode: string | null;
  detail: string;
  gateKinds: string[] | null;
  seat: string;
  title: string;
  ageMin: number;
  instanceId: string | null;
  raisedAt: string | null;
  myAlert: { alertId: string; ackKind: string | null; ownedUntil: string | null; handedToUserId: string | null } | null;
};

export type WireApproval = {
  approvalId: string; typeKey: string; approverRole: string; urgencyClass: string; requesterName: string | null;
  requestedAt: string; ageMin: number; note: string | null; subject: string; studyId: string | null; gateKind: string | null;
  accessionNo: string | null; studyTypeCode: string | null;
};
export type WireBillDecision = {
  billDecisionId: string; kind: string; studyId: string; accessionNo: string; studyTypeCode: string;
  raisedAt: string; ageMin: number; listPricePaise: number | null;
};

export type QualityKey =
  | "tat_compliance" | "critical_communication" | "repeat_rate" | "amendment_rate" | "contrast_reaction_rate"
  | "peer_review_discrepancy" | "waiting_time";
export type WireQuality = {
  from: string; to: string;
  indicators: {
    key: QualityKey; unit: "%" | "min"; comparator: "≥" | "≤"; target: number; value: number | null;
    numerator: number | null; denominator: number | null; status: "ok" | "out" | "not_measured"; note: string;
    days: { day: string; value: number | null; status: "ok" | "out" | "not_measured" }[];
  }[];
};

export type WireEquipment = {
  machines: (WireFloor["rooms"][number] & { uptimePct: number | null; booked: number; lastChange: { to: string; at: string; reason: string | null } | null })[];
  qa: { deviceCode: string; qaType: string; dueOn: string; state: string; daysOverdue: number }[];
  radiationSafety: { red: number; amber: number };
  tickets: { store: false; note: string };
};

export type WireRoster = {
  resolverEnabled: boolean;
  department: { code: string; name: string } | null;
  source: string;
  positions: { positionKey: string; people: { userId: string; name: string }[] }[];
  roles: { roleKey: string; people: { userId: string; name: string }[] }[];
  note: string;
};

export type WireMoney = {
  day: string;
  billed: { modality: string; source: string; studies: number; netPaise: number }[];
  billedTotal: { studies: number; netPaise: number };
  monthToDate: { modality: string; studies: number; netPaise: number }[];
  billDecisions: WireBillDecision[];
  leakagePaise: number;
};

export type WireAccessLog = {
  from: string; to: string; truncated: boolean;
  counts: { openings: number; images: number; breakGlass: number; noCareContext: number };
  rows: {
    at: string; who: string; whoName: string; roles: string[]; kind: "images" | "record"; what: string;
    patientUhid: string; patientName: string; accessionNo: string | null; context: string | null; reason: string | null;
    sealed: boolean; breakGlass: boolean;
  }[];
};

export const fetchHodFloor = () => api<WireFloor>("GET", "/radiology/supervisor/floor");
export const fetchHodEscalations = () =>
  api<{ rows: WireEscalation[]; notActive: EscalationCause[] }>("GET", "/radiology/supervisor/escalations");
export const fetchHodApprovals = () =>
  api<{ rows: WireApproval[]; billDecisions: WireBillDecision[] }>("GET", "/radiology/supervisor/approvals");
export const fetchHodQuality = () => api<WireQuality>("GET", "/radiology/supervisor/quality");
export const fetchHodEquipment = () => api<WireEquipment>("GET", "/radiology/supervisor/equipment");
export const fetchHodRoster = () => api<WireRoster>("GET", "/radiology/supervisor/roster");
export const fetchHodMoney = () => api<WireMoney>("GET", "/radiology/supervisor/money");
export const fetchHodAccessLog = (from?: string, to?: string) => {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const qs = q.toString();
  return api<WireAccessLog>("GET", `/radiology/supervisor/access-log${qs === "" ? "" : `?${qs}`}`);
};

/* ── #1085 (IM6c) — the morning sweep: the stored digest, yesterday's register gaps, the automations ── */

export const IMAGING_AUTOMATIONS = ["no_show_sweep", "patient_reminders", "hod_digest", "register_completeness"] as const;
export type ImagingAutomation = (typeof IMAGING_AUTOMATIONS)[number];

export type WireDigest = {
  reportDay: string;
  modalities: { modality: string; source: string; ordered: number; orderToSignedMedianMin: number | null; orderToSignedP90Min: number | null }[];
  total: { ordered: number; orderToSignedMedianMin: number | null; orderToSignedP90Min: number | null } | null;
  repeatRate: { value: number | null; numerator: number | null; denominator: number | null } | null;
  dosesOverDrlWithoutReason: number | null;
  reportsUnreadOver24h: number | null;
  openCriticals: number | null;
  overdueFollowups: number | null;
  noShows: number | null;
  machinesDown: number | null;
  registerGaps: { pcpndt: number; aerb: number } | null;
};
export type WireRegisterGap = {
  kind: "form_f_missing" | "form_f_not_recorded" | "form_f_incomplete" | "form_f_unverified" | "dose_missing" | "drl_reason_missing";
  register: "pcpndt" | "aerb"; studyId: string; accessionNo: string; missing?: string[];
};
export type WireAutomation = {
  kind: ImagingAutomation; enabled: boolean; isDefault: boolean; reason: string | null;
  changedBy: string | null; changedByName: string | null; changedAt: string | null;
  lastRun: { day: string; ranAt: string; counts: Record<string, unknown> } | null;
};

export const fetchHodDigest = () =>
  api<{ digest: { day: string; ranAt: string; digest: WireDigest } | null }>("GET", "/radiology/supervisor/digest");
export const fetchRegisterGaps = () =>
  api<{ day: string; gaps: WireRegisterGap[]; counts: { pcpndt: number; aerb: number } }>("GET", "/radiology/supervisor/completeness");
export const fetchAutomations = () => api<{ automations: WireAutomation[] }>("GET", "/radiology/supervisor/automations");
export const switchAutomation = (kind: ImagingAutomation, body: { enabled: boolean; reason: string }) =>
  api<{ kind: ImagingAutomation; enabled: boolean; changed: boolean }>("POST", `/radiology/supervisor/automations/${kind}`, body);
