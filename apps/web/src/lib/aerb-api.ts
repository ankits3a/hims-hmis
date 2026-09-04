import { api } from "./api";

/**
 * PLAN 18c T1 — the AERB registers' wire contract, transcribed from `aerb.controller.ts` exactly as
 * `radiology-api.ts` transcribes the imaging department's: this file DESCRIBES what those routes
 * ship and never re-derives or widens it.
 *
 * ═══ NOTHING HERE DECIDES WHETHER A MACHINE MAY EMIT ═══
 *
 * Whether a licence covers today, whether the gap list should name a machine, which modalities AERB
 * licences at all — every one of those is on the server, and every one is a rule an inspector could
 * be shown. A screen that recomputed any of them would be the copy that drifted (§2.54), and here
 * the drift would be a console telling a radiographer a machine is licensed when the register says
 * it is not.
 */

export type WireLicence = {
  id: string;
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  modality: string | null;
  licenceType: string;
  licenceNo: string;
  eloraRef: string | null;
  typeApprovalRef: string | null;
  layoutApprovalRef: string | null;
  validFrom: string;
  validTo: string;
  status: string;
  rsoUserId: string | null;
  rsoName: string | null;
  decommissionedAt: string | null;
  decommissionRef: string | null;
  remarks: string | null;
};

export type WireLicenceGap = {
  deviceResourceId: string;
  code: string;
  name: string;
  modality: string;
};

export type WireAppointment = {
  id: string;
  userId: string;
  userName: string;
  personRole: string;
  approvalRef: string | null;
  qualification: string;
  validFrom: string;
  validTo: string | null;
  active: boolean;
};

export function fetchLicences(includeInactive: boolean): Promise<{ rows: WireLicence[] }> {
  return api<{ rows: WireLicence[] }>("GET", `/aerb/licences?includeInactive=${String(includeInactive)}`);
}

export function fetchLicenceGaps(onDate: string): Promise<{ rows: WireLicenceGap[] }> {
  return api<{ rows: WireLicenceGap[] }>("GET", `/aerb/licences/gaps?onDate=${onDate}`);
}

export type WireQaRecord = {
  id: string;
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  /** The machine's status TODAY. The record says what happened on the day; this says where it is. */
  deviceStatus: string;
  qaType: string;
  result: string;
  performedBy: string;
  performedOn: string;
  agencyRef: string | null;
  nextDueOn: string | null;
  blockApplied: boolean;
  releasedAt: string | null;
  remarks: string | null;
};

export function fetchQaRecords(): Promise<{ rows: WireQaRecord[] }> {
  return api<{ rows: WireQaRecord[] }>("GET", "/aerb/qa");
}

export type WireDoseRow = {
  id: string;
  source: string;
  sourceRef: string;
  patientId: string;
  patientName: string;
  /** Empty for a confidential patient read without clearance — see `restricted`. */
  uhid: string;
  /** PASS 2 — the client must be able to tell an aliased row from a real one. */
  restricted: boolean;
  deviceCode: string | null;
  modality: string;
  procedureCode: string;
  doseCtdivol: string | null;
  doseDlp: string | null;
  doseDap: string | null;
  fluoroSeconds: number | null;
  doseManual: boolean;
  drlQuantity: string | null;
  drlValue: string | null;
  /** NULL means no published reference level — which is NOT the same as "under". */
  overDrl: boolean | null;
  occurredAt: string;
};

export type WireCumulativeDose = {
  patientId: string;
  months: number;
  studyCount: number;
  totalDlp: string | null;
  totalDap: string | null;
  totalFluoroSeconds: number | null;
  overDrlCount: number;
  lastOccurredAt: string | null;
};

/**
 * PLAN 18c T3 / D6 — the units, transcribed from `aerb/units.ts`. 18b's close review found DAP
 * rendered with a unit the tree never named; these are the names, and nothing here infers one.
 */
export const DOSE_UNITS: Readonly<Record<string, string>> = {
  ctdivol: "mGy",
  dlp: "mGy·cm",
  dap: "Gy·cm²",
  fluoro_seconds: "s",
};

export function fetchDoseRegister(overDrlOnly: boolean): Promise<{ rows: WireDoseRow[] }> {
  return api<{ rows: WireDoseRow[] }>("GET", `/aerb/doses?overDrlOnly=${String(overDrlOnly)}`);
}

export function fetchCumulativeDose(patientId: string): Promise<WireCumulativeDose> {
  return api<WireCumulativeDose>("GET", `/aerb/doses/patient/${patientId}`);
}

export type WireBadge = {
  badgeId: string;
  userId: string;
  userName: string;
  badgeNo: string;
  issuedOn: string;
  returnedOn: string | null;
  status: string;
  lastPeriodEnd: string | null;
  lastHp10Msv: string | null;
  lastInvestigation: boolean | null;
  /**
   * CLOSE REVIEW — these are the WORKER's totals across every badge they have ever worn, not this
   * badge's. A badge lost mid-year and replaced used to split the ledger, and a radiographer over
   * the 30 mSv statutory ceiling showed as two green rows.
   */
  workerYtdMsv: string;
  workerFiveYearMsv: string;
  /** The worst calendar year on record and its total — a late Q4 report lands in ITS year. */
  worstYear: string | null;
  worstYearMsv: string;
  overAnnualLimit: boolean;
  overFiveYearLimit: boolean;
  readCount: number;
};

export type WireBadgeGap = {
  badgeId: string;
  userId: string;
  userName: string;
  badgeNo: string;
  issuedOn: string;
  lastPeriodEnd: string | null;
  daysSince: number;
};

export type WireBadgeRead = {
  id: string;
  badgeId: string;
  badgeNo: string;
  userName: string;
  periodStart: string;
  periodEnd: string;
  hp10Msv: string;
  hp007Msv: string | null;
  reportedOn: string;
  labRef: string | null;
  investigationFlag: boolean;
  investigationLevelMsv: string | null;
};

export type WireBadgeBook = {
  rows: WireBadge[];
  gaps: WireBadgeGap[];
  reads: WireBadgeRead[];
  /** The statutory numbers, so a screen never states a limit the server did not. */
  limits: { annualMsv: number; fiveYearAverageMsv: number; fiveYearTotalMsv: number };
  investigationLevelMsvPerMonth: number;
};

export function fetchBadges(): Promise<WireBadgeBook> {
  return api<WireBadgeBook>("GET", "/aerb/badges");
}

export type WireCalendarRow = {
  kind: "licence" | "qa" | "appointment" | "badge";
  subject: string;
  detail: string;
  /** null for a badge nobody has read — nothing was ever scheduled for it to be late against. */
  dueOn: string | null;
  state: "ok" | "due" | "overdue";
  daysOverdue: number;
  ref: string;
};

export function fetchCalendar(includeOk: boolean): Promise<{ rows: WireCalendarRow[] }> {
  return api<{ rows: WireCalendarRow[] }>("GET", `/aerb/calendar?includeOk=${String(includeOk)}`);
}

export function fetchAppointments(): Promise<{ rows: WireAppointment[] }> {
  return api<{ rows: WireAppointment[] }>("GET", "/aerb/persons");
}

/**
 * The refusal's own code and message — `device_not_licensed` is a sentence with an action in it,
 * and "cannot proceed" is not. `radiology-api.ts`'s shape, unchanged.
 */
export function aerbErrorText(e: unknown): string {
  const body = (e as { body?: { message?: string; code?: string } } | undefined)?.body;
  if (body?.message !== undefined) return body.code === undefined ? body.message : `${body.message} (${body.code})`;
  return e instanceof Error ? e.message : String(e);
}
