import { and, eq, gte, inArray, lte, min, ne } from "drizzle-orm";
import { opdAppointments, opdDepartments, opdDoctors, opdEncounters, patients } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { LAB_DEPARTMENT_CODE } from "./encounters";
import { addDays, ageYearsAt, istDate, istHourMinute, istWeekday } from "./time";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE OPD REPORT — HOW MANY WERE BOOKED, HOW MANY WERE SEEN, AND WHO THEY WERE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"…the day report of the front desk … department wise breakup of appointments
 * consulted/booked with bifurcation of how many patients were revisit, new, renew patient. Then
 * another pdf/csv for each department with … details of patient name, short address, age, gender,
 * type of patient."*
 *
 * Owner, 2026-09-20: *"let the user download the report of 'This Week' (week starts on Monday -
 * Saturday) and 'This Month' as well along with Today and Yesterday."*
 *
 * ═══ THE PERIOD IS A RANGE OF IST CALENDAR DAYS, DECIDED ON THE SERVER ═══
 *
 * `rangeFor` is the ONE place the hospital's weeks and months are defined, because the sheet has to
 * print the same rule the query counted by. A client that computed its own `from`/`to` would be a
 * second definition of the week, and the first correction would land in only one of them.
 *
 *   · **day**   — that date.
 *   · **week**  — MONDAY TO SATURDAY (owner ruling). Sunday is not in the week; see `excludedSunday`.
 *   · **month** — the 1st of the anchor's month to the anchor.
 *
 * A period that contains today ENDS TODAY rather than running on to a future Saturday or month end: a
 * sheet headed "21-Sep to 26-Sep" that holds three days of data is a sheet that will be read wrong.
 * The range printed on the paper is the range that was counted.
 *
 * ═══ "NEW" MEANS NEW TO THE HOSPITAL — OWNER RULING 2026-09-19 ═══
 *
 * `opd_encounters.visit_type` is NOT that. It is the fee branch, anchored per DEPARTMENT
 * (`visit-type.ts`): a ten-year patient's first Cardiology visit is `new` there. So the report asks a
 * different question — **when was this patient's FIRST completed consultation at the hospital?** — and
 * compares it with the day of the visit in hand:
 *
 *   · **New**      — the visit is on that first day. Two departments on a patient's first day are both
 *                    New: they are new to the hospital on both. Over a week, a patient who came new on
 *                    Monday and returned on Thursday is one New and one Revisit/Renewal, which is what
 *                    keeps a week's New column equal to the patients who were new that week.
 *   · **Revisit**  — not New, and the visit is the free follow-up (`visit_type = 'revisit'`).
 *   · **Renewal**  — not New, and a fresh fee was due: the follow-up window lapsed (`renewal`), or it is
 *                    an existing patient's first visit to THIS department (`new` in the fee sense).
 *                    DECIDED 2026-09-19; the sheet prints the definition in its footnote.
 *
 * MERGES MATTER HERE MORE THAN ANYWHERE. The commonest way a returning patient reads as New is the
 * desk registering them again under a second UHID — exactly what the merge desk later repairs. So the
 * first-consultation day is asked of the whole merge family, both directions.
 *
 * ═══ WHAT IS COUNTED ═══
 *
 *   · **Booked**    — appointments whose slot falls in the period and which stood: `booked`,
 *                     `checked_in`, `no_show`. A cancelled, rescheduled-away or needs-rebooking slot
 *                     was not a booking for that day. (The desk brief counts bookings on the day they
 *                     were MADE — a clerk's work; this counts them on the day they are FOR — a
 *                     department's load.)
 *   · **Consulted** — encounters in the period whose consultation `completed`, the same predicate the
 *                     desk brief's `opd.consultsCompleted` uses.
 *   · **Still open** — encounters in the period neither completed nor abandoned. They are not counted
 *                     as consulted; the report says how many there are rather than letting a mid-day
 *                     export pass for the close.
 *   · The laboratory's walk-in "department" is not a consultation and is left out.
 */

export type PatientType = "new" | "revisit" | "renewal";
export type ReportPeriod = "day" | "week" | "month";

/** The days a report covers, inclusive, plus the day the reader anchored on. */
export type ReportRange = {
  period: ReportPeriod;
  /** Today for "this week"/"this month"; the picked day for a single day. */
  anchor: string;
  from: string;
  to: string;
};

export type ReportCounts = {
  booked: number;
  consulted: number;
  new: number;
  revisit: number;
  renewal: number;
  stillOpen: number;
};

export type ReportDepartment = ReportCounts & { departmentId: string; code: string; name: string };

export type ReportHospital = { name: string; addressLines: string[] };

/**
 * The Sunday a Monday-to-Saturday week leaves out, and what happened on it. Null unless the period is
 * a week whose Sunday carried consultations — the honest answer to "why is the week short of the month".
 */
export type ExcludedSunday = { date: string; consulted: number };

export type OpdReport = ReportRange & {
  generatedAt: string;
  /** The period reaches today: the numbers can still move. */
  provisional: boolean;
  hospital: ReportHospital;
  departments: ReportDepartment[];
  totals: ReportCounts;
  /** DISTINCT people — one patient seen in two departments is one here and two in the rows. */
  patientsConsulted: number;
  newPatients: number;
  excludedSunday: ExcludedSunday | null;
};

export type ReportPatientRow = {
  visitNo: string;
  /** The IST day of the visit — the column a week or a month needs and a single day does not. */
  date: string;
  /** IST wall clock the consultation completed, `HH:MM`. */
  time: string;
  /** The alias for a confidential patient the reader may not name. */
  name: string;
  restricted: boolean;
  uhid: string;
  age: string;
  gender: "M" | "F" | "O" | "—";
  shortAddress: string;
  patientType: PatientType;
  doctor: string;
};

export type OpdDepartmentReport = ReportRange & {
  generatedAt: string;
  provisional: boolean;
  hospital: ReportHospital;
  department: ReportDepartment;
  rows: ReportPatientRow[];
  excludedSunday: ExcludedSunday | null;
};

const STOOD = ["booked", "checked_in", "no_show"];
const ZERO: ReportCounts = { booked: 0, consulted: 0, new: 0, revisit: 0, renewal: 0, stillOpen: 0 };

type RangeEncounter = {
  visitNo: string; patientId: string; departmentId: string | null; doctorId: string | null;
  status: string; visitType: string; serviceDate: string; consultCompletedAt: Date | null;
};

/**
 * The period the reader asked for, as IST calendar days. Weeks run **Monday to Saturday** (owner,
 * 2026-09-20) and a period containing the anchor ends ON the anchor.
 */
export function rangeFor(period: ReportPeriod, anchor: string): ReportRange {
  if (period === "day") return { period, anchor, from: anchor, to: anchor };
  if (period === "week") {
    /* istWeekday: 0 = Sunday … 6 = Saturday. A Sunday belongs to the week that began the Monday before it. */
    const back = (istWeekday(anchor) + 6) % 7;
    const monday = addDays(anchor, -back);
    const saturday = addDays(monday, 5);
    return { period, anchor, from: monday, to: anchor < saturday ? anchor : saturday };
  }
  return { period, anchor, from: `${anchor.slice(0, 7)}-01`, to: anchor };
}

/** The Sunday a Mon–Sat week does not cover: the day after its Saturday. */
export function sundayOfWeek(range: ReportRange): string | null {
  return range.period === "week" ? addDays(range.from, 6) : null;
}

/** Hops a merge chain may take before we stop following it — `listMergedLoserIds` uses the same bound. */
const MERGE_HOPS = 5;

/**
 * Every record in the merge family of each id, keyed to one family root. Walks UP (`merged_into`)
 * and DOWN (records merged into these) so a visit opened under the duplicate and history held under
 * the original — or the reverse — land in one family.
 */
async function mergeFamilies(db: Db, ids: string[]): Promise<Map<string, string>> {
  const known = new Set(ids);
  /* loser → the record it was merged into; a family's root is the end of that chain. */
  const parent = new Map<string, string>();

  // UP: a visit's own record may since have been merged into another.
  let frontier = ids;
  for (let hop = 0; hop < MERGE_HOPS && frontier.length > 0; hop++) {
    const rows = await db.select({ id: patients.id, into: patients.mergedIntoPatientId }).from(patients)
      .where(and(inArray(patients.id, frontier), eq(patients.status, "merged")));
    const next: string[] = [];
    for (const r of rows) {
      if (r.into === null) continue;
      parent.set(r.id, r.into);
      if (!known.has(r.into)) { known.add(r.into); next.push(r.into); }
    }
    frontier = next;
  }

  // DOWN: records merged into any member carry that family's older visits.
  frontier = [...known];
  for (let hop = 0; hop < MERGE_HOPS && frontier.length > 0; hop++) {
    const rows = await db.select({ id: patients.id, into: patients.mergedIntoPatientId }).from(patients)
      .where(and(inArray(patients.mergedIntoPatientId, frontier), eq(patients.status, "merged")));
    const next: string[] = [];
    for (const r of rows) {
      if (r.into === null || known.has(r.id)) continue;
      parent.set(r.id, r.into);
      known.add(r.id);
      next.push(r.id);
    }
    frontier = next;
  }

  const rootOf = new Map<string, string>();
  for (const id of known) {
    let at = id;
    for (let hop = 0; hop <= 2 * MERGE_HOPS && parent.has(at); hop++) at = parent.get(at)!;
    rootOf.set(id, at);
  }
  return rootOf;
}

/**
 * For each merge family, the IST day of its FIRST completed consultation — over all history, not just
 * the period. A visit on that day is the patient's first at the hospital; anything later is a return.
 */
async function firstConsultDays(db: Db, patientIds: string[]): Promise<{ rootOf: Map<string, string>; firstOf: Map<string, string> }> {
  const rootOf = await mergeFamilies(db, [...new Set(patientIds)]);
  const members = [...rootOf.keys()];
  const firstOf = new Map<string, string>();
  if (members.length === 0) return { rootOf, firstOf };
  const rows = await db
    .select({ patientId: opdEncounters.patientId, first: min(opdEncounters.serviceDate) })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, members), eq(opdEncounters.status, "completed")))
    .groupBy(opdEncounters.patientId);
  for (const r of rows) {
    if (r.first === null) continue;
    const root = rootOf.get(r.patientId) ?? r.patientId;
    const held = firstOf.get(root);
    if (held === undefined || String(r.first) < held) firstOf.set(root, String(r.first));
  }
  return { rootOf, firstOf };
}

export function patientTypeOf(visitType: string, seenBefore: boolean): PatientType {
  if (!seenBefore) return "new";
  return visitType === "revisit" ? "revisit" : "renewal";
}

async function loadRange(db: Db, range: ReportRange) {
  const [depts, encounters, bookings, config] = await Promise.all([
    db.select().from(opdDepartments),
    db.select({
      visitNo: opdEncounters.visitNo, patientId: opdEncounters.patientId,
      departmentId: opdEncounters.departmentId, doctorId: opdEncounters.doctorId, status: opdEncounters.status,
      visitType: opdEncounters.visitType, serviceDate: opdEncounters.serviceDate,
      consultCompletedAt: opdEncounters.consultCompletedAt,
    }).from(opdEncounters).where(and(
      gte(opdEncounters.serviceDate, range.from), lte(opdEncounters.serviceDate, range.to),
      ne(opdEncounters.status, "abandoned"),
    )),
    db.select({ departmentId: opdAppointments.departmentId, status: opdAppointments.status }).from(opdAppointments)
      .where(and(
        gte(opdAppointments.serviceDate, range.from), lte(opdAppointments.serviceDate, range.to),
        inArray(opdAppointments.status, STOOD),
      )),
    loadOpdConfig(db),
  ]);
  const lab = new Set(depts.filter((d) => d.code === LAB_DEPARTMENT_CODE).map((d) => d.id));
  const visits: RangeEncounter[] = encounters.filter((e) => e.departmentId === null || !lab.has(e.departmentId));
  const completed = visits.filter((e) => e.status === "completed");
  const { rootOf, firstOf } = await firstConsultDays(db, completed.map((e) => e.patientId));
  const typeOf = (e: RangeEncounter): PatientType => {
    const first = firstOf.get(rootOf.get(e.patientId) ?? e.patientId);
    return patientTypeOf(e.visitType, first !== undefined && first < e.serviceDate);
  };
  const hospital: ReportHospital = { name: config.letterhead.name, addressLines: config.letterhead.addressLines };
  return { depts: depts.filter((d) => !lab.has(d.id)), visits, completed, bookings, typeOf, rootOf, hospital, lab };
}

/**
 * What the Monday-to-Saturday rule leaves out, and only when it leaves out something: the count of
 * consultations on that week's Sunday. A weekly total quietly short of the month is how a hospital
 * stops trusting both numbers.
 */
async function excludedSundayFor(db: Db, range: ReportRange, labIds: Set<string>): Promise<ExcludedSunday | null> {
  const sunday = sundayOfWeek(range);
  if (sunday === null) return null;
  const rows = await db.select({ departmentId: opdEncounters.departmentId }).from(opdEncounters)
    .where(and(eq(opdEncounters.serviceDate, sunday), eq(opdEncounters.status, "completed")));
  const consulted = rows.filter((r) => r.departmentId === null || !labIds.has(r.departmentId)).length;
  return consulted === 0 ? null : { date: sunday, consulted };
}

function tally(
  departmentIds: Set<string>,
  visits: RangeEncounter[],
  bookings: { departmentId: string }[],
  typeOf: (e: RangeEncounter) => PatientType,
): ReportCounts {
  const out = { ...ZERO };
  for (const b of bookings) if (departmentIds.has(b.departmentId)) out.booked += 1;
  for (const e of visits) {
    if (e.departmentId === null || !departmentIds.has(e.departmentId)) continue;
    if (e.status !== "completed") { out.stillOpen += 1; continue; }
    out.consulted += 1;
    out[typeOf(e)] += 1;
  }
  return out;
}

function stamp(range: ReportRange, now: Date): { generatedAt: string; provisional: boolean } {
  return { generatedAt: now.toISOString(), provisional: range.to >= istDate(now) };
}

/**
 * The hospital's period, one row per clinical department. Every active department is listed — a zero
 * is information — and an inactive one only when it still carried visits.
 */
export async function loadOpdReport(db: Db, range: ReportRange, now: Date = new Date()): Promise<OpdReport> {
  const data = await loadRange(db, range);
  const departments: ReportDepartment[] = data.depts
    .map((d) => ({ dept: d, counts: tally(new Set([d.id]), data.visits, data.bookings, data.typeOf) }))
    .filter(({ dept, counts }) => dept.active || counts.booked + counts.consulted + counts.stillOpen > 0)
    .sort((a, b) => a.dept.name.localeCompare(b.dept.name))
    .map(({ dept, counts }) => ({ departmentId: dept.id, code: dept.code, name: dept.name, ...counts }));
  const all = new Set(data.depts.map((d) => d.id));
  const families = (rows: RangeEncounter[]) => new Set(rows.map((e) => data.rootOf.get(e.patientId) ?? e.patientId));
  const consultedHere = data.completed.filter((e) => e.departmentId !== null && all.has(e.departmentId));
  return {
    ...range,
    ...stamp(range, now),
    hospital: data.hospital,
    departments,
    totals: tally(all, data.visits, data.bookings, data.typeOf),
    patientsConsulted: families(consultedHere).size,
    newPatients: families(consultedHere.filter((e) => data.typeOf(e) === "new")).size,
    excludedSunday: await excludedSundayFor(db, range, data.lab),
  };
}

/** `8 M`, `34 Y` — the register's own shorthand. A newborn reads in days. */
export function ageLabel(dob: Date | null, on: string): string {
  if (dob === null) return "—";
  const at = new Date(`${on}T12:00:00+05:30`);
  const years = ageYearsAt(dob, at);
  if (years >= 1) return `${String(years)} Y`;
  const months = (at.getUTCFullYear() - dob.getUTCFullYear()) * 12 + at.getUTCMonth() - dob.getUTCMonth()
    - (at.getUTCDate() < dob.getUTCDate() ? 1 : 0);
  if (months >= 1) return `${String(months)} M`;
  return `${String(Math.max(0, Math.floor((at.getTime() - dob.getTime()) / 86_400_000)))} D`;
}

export function genderLetter(gender: string | null): ReportPatientRow["gender"] {
  const g = (gender ?? "").toLowerCase();
  if (g.startsWith("f")) return "F";
  if (g.startsWith("m")) return "M";
  return g.startsWith("o") ? "O" : "—";
}

/**
 * The locality and the district — enough to say where a patient came from, short enough for a
 * column. The first comma-separated part of the typed address is the village or mohalla by the
 * counter's habit; the district is its own field and is added unless the address already says it.
 */
export function shortAddress(addressLine: string | null, district: string | null, pincode: string | null): string {
  const first = (addressLine ?? "").split(",")[0]?.trim() ?? "";
  const locality = first.length > 32 ? `${first.slice(0, 31).trimEnd()}…` : first;
  const d = (district ?? "").trim();
  const parts = [locality, d !== "" && !locality.toLowerCase().includes(d.toLowerCase()) ? d : ""].filter((p) => p !== "");
  if (parts.length > 0) return parts.join(", ");
  return (pincode ?? "").trim() || "—";
}

/**
 * One department's period with the people in it. The names come through `getPatientSummaries` with
 * the READER as actor, so a confidential patient is aliased against the clearance of whoever is
 * pulling the list — and a restricted row carries no address either, because the seal covers where
 * they live as much as who they are. Returns null for a department that does not exist.
 */
export async function loadOpdDepartmentReport(
  db: Db, reader: Actor, range: ReportRange, departmentId: string, now: Date = new Date(),
): Promise<OpdDepartmentReport | null> {
  const data = await loadRange(db, range);
  const dept = data.depts.find((d) => d.id === departmentId);
  if (dept === undefined) return null;
  const counts = tally(new Set([dept.id]), data.visits, data.bookings, data.typeOf);
  const seen = data.completed
    .filter((e) => e.departmentId === dept.id)
    .sort((a, b) =>
      a.serviceDate.localeCompare(b.serviceDate)
      || (a.consultCompletedAt?.getTime() ?? 0) - (b.consultCompletedAt?.getTime() ?? 0)
      || a.visitNo.localeCompare(b.visitNo));

  const ids = [...new Set(seen.map((e) => e.patientId))];
  const doctorIds = [...new Set(seen.map((e) => e.doctorId).filter((d): d is string => d !== null))];
  const addressColumns = {
    id: patients.id, addressLine: patients.addressLine, district: patients.district, pincode: patients.pincode,
  };
  const [summaries, addresses, doctors] = await Promise.all([
    getPatientSummaries(db, reader, ids),
    ids.length === 0 ? Promise.resolve([]) : db.select(addressColumns).from(patients).where(inArray(patients.id, ids)),
    doctorIds.length === 0 ? Promise.resolve([]) : db.select({ id: opdDoctors.id, name: opdDoctors.displayName })
      .from(opdDoctors).where(inArray(opdDoctors.id, doctorIds)),
  ]);
  const summaryOf = new Map(summaries.map((s) => [s.requestedId, s]));
  /* A summary resolves a merged record to its survivor; the address is read from that survivor too. */
  const survivorIds = summaries.map((s) => s.id).filter((id) => !ids.includes(id));
  const survivorAddresses = survivorIds.length === 0
    ? []
    : await db.select(addressColumns).from(patients).where(inArray(patients.id, survivorIds));
  const addressOf = new Map([...addresses, ...survivorAddresses].map((a) => [a.id, a]));
  const doctorOf = new Map(doctors.map((d) => [d.id, d.name]));

  const rows: ReportPatientRow[] = [];
  for (const e of seen) {
    const s = summaryOf.get(e.patientId);
    if (s === undefined) continue;
    const a = addressOf.get(s.id);
    rows.push({
      visitNo: e.visitNo,
      date: e.serviceDate,
      time: e.consultCompletedAt === null ? "—" : istHourMinute(e.consultCompletedAt),
      name: s.restricted ? (s.alias ?? "Confidential patient") : (s.name ?? "—"),
      restricted: s.restricted,
      uhid: s.uhid,
      age: ageLabel(s.dob, e.serviceDate),
      gender: genderLetter(s.administrativeGender),
      shortAddress: s.restricted || a === undefined ? "—" : shortAddress(a.addressLine, a.district, a.pincode),
      patientType: data.typeOf(e),
      doctor: e.doctorId === null ? "—" : (doctorOf.get(e.doctorId) ?? "—"),
    });
  }
  return {
    ...range,
    ...stamp(range, now),
    hospital: data.hospital,
    department: { departmentId: dept.id, code: dept.code, name: dept.name, ...counts },
    rows,
    excludedSunday: await excludedSundayFor(db, range, data.lab),
  };
}
