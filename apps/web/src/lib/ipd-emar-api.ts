import { api, newIdempotencyKey } from "./api";
import { serverNow } from "./ipd-nursing-api";
import type {
  IpdEmarDueList, IpdEmarLabelSheet, IpdEmarOverrideCounts, IpdEmarPatient, IpdEmarPharmacyQueue, IpdEmarScan, IpdEmarWardChart,
} from "@hmis/contracts";

/**
 * E4.3 (#735) — the eMAR's wire (spec SPEC-ipd-core §4.6, §4.9 D). Shapes are the contract's (`packages/contracts/src/ipd/
 * emar.ts`, types only). Every act carries a fresh idempotency key; a retried give records once.
 *
 * DOSES NEVER QUEUE (§0B): unlike vitals there is no offline queue here. Offline, the screen disables Give; a give that
 * fails on the network is NOT retried later — the nurse charts it on the paper MAR. The give is stamped with the SERVER's
 * clock (`serverNow`), and the server refuses a stamp older than 2 minutes.
 */
export const EMAR = {
  pharmacy: "/ipd/emar/pharmacy",
  verify: "/ipd/emar/verify",
  issue: "/ipd/emar/issue",
  labels: (id: string) => `/ipd/emar/issues/${encodeURIComponent(id)}/labels`,
  returnMed: "/ipd/emar/return",
  resolveFlag: "/ipd/emar/allergy-flags/resolve",
  patient: (id: string) => `/ipd/emar/admissions/${encodeURIComponent(id)}`,
  ward: "/ipd/emar/ward",
  due: "/ipd/emar/due",
  scan: "/ipd/emar/scan",
  give: "/ipd/emar/give",
  hold: "/ipd/emar/hold",
  refuse: "/ipd/emar/refuse",
  miss: "/ipd/emar/miss",
  reoffer: "/ipd/emar/reoffer",
  secondCheck: "/ipd/emar/second-check",
  overrides: "/ipd/emar/overrides",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}
const q = (path: string, params: Record<string, string | null | undefined>): string => {
  const s = Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  return s === "" ? path : `${path}?${s}`;
};

export const getPharmacyQueue = (): Promise<IpdEmarPharmacyQueue> => api("GET", EMAR.pharmacy);
export const getLabelSheet = (issueId: string): Promise<IpdEmarLabelSheet> => api("GET", EMAR.labels(issueId));
export const getEmarPatient = (admissionId: string): Promise<IpdEmarPatient> => api("GET", EMAR.patient(admissionId));
export const getWardChart = (wardId?: string | null, day?: string | null): Promise<IpdEmarWardChart> => api("GET", q(EMAR.ward, { wardId, day }));
export const getDue = (wardId?: string | null): Promise<IpdEmarDueList> => api("GET", q(EMAR.due, { wardId }));
export const getOverrides = (days?: number): Promise<IpdEmarOverrideCounts> => api("GET", q(EMAR.overrides, { days: days === undefined ? null : String(days) }));
export const scan = (b: { wristbandCode?: string; admissionId?: string; labelCode?: string }): Promise<IpdEmarScan> => api("POST", EMAR.scan, b);

export type Checks = { allergy: boolean; interaction: boolean; dose: boolean; duplicate: boolean };
export type AllergyOverride = { reason: "tolerated_before" | "desensitised" | "no_safe_alternative" | "benefit_outweighs_risk"; text: string };
export const verify = (orderId: string, decision: "verified" | "rejected" | "query", checks: Checks, note?: string, allergyOverride?: AllergyOverride): Promise<{ status: string; dosesScheduled: number }> =>
  post(EMAR.verify, { orderId, decision, checks, ...(note ? { note } : {}), ...(allergyOverride ? { allergyOverride } : {}) });
export const issue = (b: { orderId: string; units: number; stripSize?: number; ownMedicine: boolean; ownBatch?: { batchNo: string; expiry: string } }):
  Promise<{ issueId: string; units: number; labelIds: string[] }> => post(EMAR.issue, b);
export const returnMed = (issueId: string, units: number, reason: string): Promise<{ creditedUnits: number }> => post(EMAR.returnMed, { issueId, units, reason });
export const resolveFlag = (flagId: string, note: string): Promise<unknown> => post(EMAR.resolveFlag, { flagId, note });

export type PatientCheck =
  | { kind: "scan"; wristbandCode: string }
  | { kind: "override"; overrideReason: "band_unreadable" | "band_refused" | "no_band_burns" | "scanner_down"; note: string };
export const give = (b: {
  orderId: string; doseDueAt: string; patientCheck: PatientCheck; labelCode: string;
  secondNurse?: { userId: string; pinProof: string }; lasaConfirmed?: true; lateReason?: string; weightKg?: number;
  npoMeds?: { kind: "sips_allowed"; reason: string } | { kind: "doctor_ok"; doctorId: string; readBack: true; reason: string };
}): Promise<{ administrationId: string; late: boolean; overrideCounted: boolean }> =>
  post(EMAR.give, { ...b, givenAt: serverNow().toISOString() });
export const hold = (orderId: string, doseDueAt: string, reason: string, note?: string): Promise<{ reofferOnReturn: boolean }> =>
  post(EMAR.hold, { orderId, doseDueAt, reason, ...(note ? { note } : {}) });
export const refuse = (orderId: string, doseDueAt: string, reason: string, note?: string): Promise<{ doctorNotified: boolean }> =>
  post(EMAR.refuse, { orderId, doseDueAt, reason, ...(note ? { note } : {}) });
export const miss = (orderId: string, doseDueAt: string, reason: string, note?: string): Promise<unknown> =>
  post(EMAR.miss, { orderId, doseDueAt, reason, ...(note ? { note } : {}) });
export const reoffer = (admissionId: string, reason: "back_on_ward" | "npo_lifted"): Promise<{ reoffered: number }> => post(EMAR.reoffer, { admissionId, reason });
/** The proof is bound to its purpose, the order and (a scheduled dose) the slot — made for this give only. */
export const secondCheck = (purpose: "high_alert_dose" | "infusion" | "narcotic_wastage", target: { orderId: string; doseDueAt?: string }, username: string, pin: string):
  Promise<{ pinProof: string; userId: string; name: string; expiresAt: string }> => post(EMAR.secondCheck, { purpose, ...target, username, pin });
