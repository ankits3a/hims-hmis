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

/**
 * PLAN 18c T6 — **`canManage` ARRIVES ON THE BOOK; THE SCREEN NEVER GUESSES AT IT.**
 *
 * 18b's close review (MAJOR B4) found the receptionist's console rendering an "Open images" button
 * that 403'd, and the fix was `canOpenImages` on the study view. This is that fix on this register:
 * a quality manager showing an inspector the file holds `aerb.registers.read` and not the pen, and
 * a screen that decided for itself would either hide the RSO's forms or offer forms that refuse.
 *
 * It rides the four reads that HAVE a write behind them. The dose register and the calendar carry
 * no flag, because there is no form on either.
 */
export type WireLicenceBook = { rows: WireLicence[]; canManage: boolean };

export function fetchLicences(includeInactive: boolean): Promise<WireLicenceBook> {
  return api<WireLicenceBook>("GET", `/aerb/licences?includeInactive=${String(includeInactive)}`);
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

export type WireQaBook = { rows: WireQaRecord[]; canManage: boolean };

export function fetchQaRecords(): Promise<WireQaBook> {
  return api<WireQaBook>("GET", "/aerb/qa");
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
  canManage: boolean;
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

export type WireAppointmentBook = { rows: WireAppointment[]; canManage: boolean };

export function fetchAppointments(): Promise<WireAppointmentBook> {
  return api<WireAppointmentBook>("GET", "/aerb/persons");
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════ */
/*  PLAN 18c T6 — THE WRITE HALF. Nine routes, transcribed the way the reads above are.            */
/* ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══ THE PICKERS COME FROM THE REGISTER, NOT FROM THE RESOURCE TREE ═══
 *
 * The RSO holds `aerb.registers.manage` and neither `resources.read` nor `auth.users.manage`, so
 * the device and staff lists a form needs are served by this module behind its own door. `read.ts`
 * carries the argument. `licensable` is the SERVER's answer to "does AERB licence this machine at
 * all" — the same list the gap check reads, never re-derived here.
 */
export type WireDeviceChoice = {
  resourceId: string;
  code: string;
  name: string;
  modality: string;
  status: string;
  licensable: boolean;
};

export type WireUserChoice = { userId: string; fullName: string };

export function fetchAerbPickers(): Promise<{ devices: WireDeviceChoice[]; users: WireUserChoice[] }> {
  return api<{ devices: WireDeviceChoice[]; users: WireUserChoice[] }>("GET", "/aerb/pickers");
}

/**
 * ═══ A RENEWAL IS THE NEXT WINDOW, NOT A SURRENDER ═══
 *
 * There is no `supersedesLicenceId` and there must never be one again. Pass 2 of 18c's close review
 * found the fix that added it surrendered the outgoing certificate the moment the incoming one was
 * filed — so entering the 2027 licence in November left the CT with **no licence in force on 20
 * November**, every ionising study refused from the day the paperwork arrived until 1 January, with
 * no way back because `surrendered` is terminal. A device holds a SEQUENCE of certificates with
 * non-overlapping validity and *which is in force* is a function of the date. Filing next year's
 * touches nothing of this year's.
 */
export type FileLicenceBody = {
  deviceResourceId: string;
  licenceType: string;
  licenceNo: string;
  eloraRef: string | null;
  typeApprovalRef: string | null;
  layoutApprovalRef: string | null;
  validFrom: string;
  validTo: string;
  rsoUserId: string | null;
  remarks: string | null;
};

export function fileLicence(body: FileLicenceBody): Promise<{ licenceId: string }> {
  return api<{ licenceId: string }>("POST", "/aerb/licences", body);
}

export function changeLicenceStatus(
  licenceId: string, to: "active" | "suspended" | "surrendered",
  opts: { reason: string | null; decommissionRef: string | null },
): Promise<{ ok: true }> {
  return api<{ ok: true }>("POST", `/aerb/licences/${licenceId}/status`, { to, ...opts });
}

export type AppointPersonBody = {
  userId: string;
  personRole: string;
  approvalRef: string | null;
  qualification: string;
  validFrom: string;
  validTo: string | null;
};

export function appointPerson(body: AppointPersonBody): Promise<{ personId: string }> {
  return api<{ personId: string }>("POST", "/aerb/persons", body);
}

export function endAppointment(personId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>("POST", `/aerb/persons/${personId}/end`, {});
}

/**
 * ═══ A `fail` STOPS THE MACHINE, IN THE SAME TRANSACTION ═══
 *
 * `blocked` comes back true when this record drove the device into `qa_blocked`, and
 * `releasedRecordId` names the failure a pass cleared. Both are rendered: a write whose whole
 * consequence is invisible is a write the RSO has to go and verify somewhere else.
 *
 * A `fail` on a machine with a patient on the table is REFUSED (`already_occupied`, 409) and the
 * record rolls back with it. That refusal is shown, never swallowed.
 */
export type RecordQaBody = {
  deviceResourceId: string;
  qaType: string;
  result: string;
  performedBy: string;
  performedOn: string;
  agencyRef: string | null;
  nextDueOn: string | null;
  remarks: string | null;
};

export function recordQa(
  body: RecordQaBody,
): Promise<{ recordId: string; blocked: boolean; releasedRecordId: string | null }> {
  return api<{ recordId: string; blocked: boolean; releasedRecordId: string | null }>("POST", "/aerb/qa", body);
}

export type IssueBadgeBody = { userId: string; badgeNo: string; issuedOn: string; remarks: string | null };

export function issueBadge(body: IssueBadgeBody): Promise<{ badgeId: string }> {
  return api<{ badgeId: string }>("POST", "/aerb/badges", body);
}

export function closeBadge(
  badgeId: string, status: "returned" | "lost", onDate: string,
): Promise<{ ok: true }> {
  return api<{ ok: true }>("POST", `/aerb/badges/${badgeId}/close`, { status, onDate });
}

export type RecordBadgeReadBody = {
  badgeId: string;
  periodStart: string;
  periodEnd: string;
  hp10Msv: number;
  hp007Msv: number | null;
  reportedOn: string;
  labRef: string | null;
  remarks: string | null;
};

export function recordBadgeRead(
  body: RecordBadgeReadBody,
): Promise<{ readId: string; investigation: boolean; investigationLevelMsv: number }> {
  return api<{ readId: string; investigation: boolean; investigationLevelMsv: number }>(
    "POST", "/aerb/badges/reads", body,
  );
}

/** D10 — the statutory limits are constants in the server; THIS number is institutional policy. */
export function setInvestigationLevel(perMonthMsv: number): Promise<{ ok: true }> {
  return api<{ ok: true }>("POST", "/aerb/settings/investigation-level", { perMonthMsv });
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
