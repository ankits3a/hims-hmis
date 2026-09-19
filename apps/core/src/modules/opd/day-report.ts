import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { opdAppointments, opdDepartments, opdDoctors, opdEncounters, patients } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { LAB_DEPARTMENT_CODE } from "./encounters";
import { ageYearsAt, istDate, istHourMinute } from "./time";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE OPD DAY REPORT — HOW MANY WERE BOOKED, HOW MANY WERE SEEN, AND WHO THEY WERE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"download the day report of the front desk. Total number patient consulted for
 * specific day in pdf/csv exportable format … department wise breakup of appointments consulted/booked
 * with bifurcation of how many patients were revisit, new, renew patient. Then another pdf/csv for
 * each department with brief of the department stats and then detailed breakup like details of
 * patient name, short address, age, gender, type of patient."*
 *
 * ═══ "NEW" MEANS NEW TO THE HOSPITAL — OWNER RULING 2026-09-19 ═══
 *
 * `opd_encounters.visit_type` is NOT that. It is the fee branch, anchored per DEPARTMENT
 * (`visit-type.ts`): a ten-year patient's first Cardiology visit is `new` there. The owner ruled the
 * report's "New" is the hospital's, so it is derived here and the column is only used for the rest:
 *
 *   · **New**      — no consultation COMPLETED on any earlier day, in any department, under this
 *                    patient's record or any record merged into it. Two departments on a patient's
 *                    first day are both New: they are new to the hospital on both.
 *   · **Revisit**  — not New, and the visit is the free follow-up (`visit_type = 'revisit'`).
 *   · **Renewal**  — not New, and a fresh fee was due: the follow-up window lapsed
 *                    (`renewal`), or an existing patient's first visit to THIS department (`new` in
 *                    the fee sense). DECIDED 2026-09-19 — the owner gave three buckets and an existing
 *                    patient paying a fresh consultation fee is the renewal of their card, not a new
 *                    patient. The printed report carries this definition in its footnote.
 *
 * MERGES MATTER HERE MORE THAN ANYWHERE. The commonest way a returning patient reads as New is the
 * desk registering them again under a second UHID — and that is exactly the case the merge desk
 * later repairs. So "earlier consultation" is asked of the whole merge family, both directions.
 *
 * ═══ WHAT IS COUNTED ═══
 *
 *   · **Booked**    — appointments whose slot is on the day and which stood: `booked`, `checked_in`,
 *                     `no_show`. A cancelled, rescheduled-away or needs-rebooking slot was not a
 *                     booking FOR that day. (The desk brief counts bookings on the day they were MADE
 *                     — a clerk's work; this counts them on the day they are FOR — a department's load.)
 *   · **Consulted** — encounters on the day whose consultation `completed`, the same predicate the
 *                     desk brief's `opd.consultsCompleted` uses.
 *   · **Still open** — encounters on the day neither completed nor abandoned. They are not counted as
 *                     consulted; the report says how many there are rather than letting a mid-day
 *                     export pass for the close.
 *   · The laboratory's walk-in "department" is not a consultation and is left out.
 */

export type PatientType = "new" | "revisit" | "renewal";

export type DayReportCounts = {
  booked: number;
  consulted: number;
  new: number;
  revisit: number;
  renewal: number;
  stillOpen: number;
};

export type DayReportDepartment = DayReportCounts & { departmentId: string; code: string; name: string };

export type ReportHospital = { name: string; addressLines: string[] };

export type OpdDayReport = {
  date: string;
  generatedAt: string;
  /** The day is today or later: the numbers can still move. */
  provisional: boolean;
  hospital: ReportHospital;
  departments: DayReportDepartment[];
  totals: DayReportCounts;
  /** DISTINCT people — one patient seen in two departments is one here and two in the rows. */
  patientsConsulted: number;
  newPatients: number;
};

export type DayReportPatientRow = {
  visitNo: string;
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

export type OpdDepartmentDayReport = {
  date: string;
  generatedAt: string;
  provisional: boolean;
  hospital: ReportHospital;
  department: DayReportDepartment;
  rows: DayReportPatientRow[];
};

const STOOD = ["booked", "checked_in", "no_show"];
const ZERO: DayReportCounts = { booked: 0, consulted: 0, new: 0, revisit: 0, renewal: 0, stillOpen: 0 };

type DayEncounter = {
  id: string; visitNo: string; patientId: string; departmentId: string | null; doctorId: string | null;
  status: string; visitType: string; consultCompletedAt: Date | null;
};

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

/** Of these patients, the family roots that completed a consultation on some day before `date`. */
async function familiesSeenBefore(db: Db, patientIds: string[], date: string): Promise<{ rootOf: Map<string, string>; seen: Set<string> }> {
  const rootOf = await mergeFamilies(db, [...new Set(patientIds)]);
  const members = [...rootOf.keys()];
  if (members.length === 0) return { rootOf, seen: new Set() };
  const rows = await db.selectDistinct({ patientId: opdEncounters.patientId }).from(opdEncounters)
    .where(and(
      inArray(opdEncounters.patientId, members),
      eq(opdEncounters.status, "completed"),
      lt(opdEncounters.serviceDate, date),
    ));
  return { rootOf, seen: new Set(rows.map((r) => rootOf.get(r.patientId) ?? r.patientId)) };
}

export function patientTypeOf(visitType: string, seenBefore: boolean): PatientType {
  if (!seenBefore) return "new";
  return visitType === "revisit" ? "revisit" : "renewal";
}

async function loadDay(db: Db, date: string) {
  const [depts, encounters, bookings, config] = await Promise.all([
    db.select().from(opdDepartments),
    db.select({
      id: opdEncounters.id, visitNo: opdEncounters.visitNo, patientId: opdEncounters.patientId,
      departmentId: opdEncounters.departmentId, doctorId: opdEncounters.doctorId, status: opdEncounters.status,
      visitType: opdEncounters.visitType, consultCompletedAt: opdEncounters.consultCompletedAt,
    }).from(opdEncounters)
      .where(and(eq(opdEncounters.serviceDate, date), ne(opdEncounters.status, "abandoned"))),
    db.select({ departmentId: opdAppointments.departmentId, status: opdAppointments.status }).from(opdAppointments)
      .where(and(eq(opdAppointments.serviceDate, date), inArray(opdAppointments.status, STOOD))),
    loadOpdConfig(db),
  ]);
  const lab = new Set(depts.filter((d) => d.code === LAB_DEPARTMENT_CODE).map((d) => d.id));
  const visits: DayEncounter[] = encounters.filter((e) => e.departmentId === null || !lab.has(e.departmentId));
  const completed = visits.filter((e) => e.status === "completed");
  const { rootOf, seen } = await familiesSeenBefore(db, completed.map((e) => e.patientId), date);
  const typeOf = (e: DayEncounter): PatientType =>
    patientTypeOf(e.visitType, seen.has(rootOf.get(e.patientId) ?? e.patientId));
  const hospital: ReportHospital = { name: config.letterhead.name, addressLines: config.letterhead.addressLines };
  return { depts: depts.filter((d) => !lab.has(d.id)), visits, completed, bookings, typeOf, rootOf, hospital };
}

function tally(
  departmentIds: Set<string>,
  visits: DayEncounter[],
  bookings: { departmentId: string }[],
  typeOf: (e: DayEncounter) => PatientType,
): DayReportCounts {
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

function stamp(date: string, now: Date): { generatedAt: string; provisional: boolean } {
  return { generatedAt: now.toISOString(), provisional: date >= istDate(now) };
}

/**
 * The hospital's day, one row per clinical department. Every active department is listed — a zero
 * is information — and an inactive one only when it still carried visits that day.
 */
export async function loadOpdDayReport(db: Db, date: string, now: Date = new Date()): Promise<OpdDayReport> {
  const day = await loadDay(db, date);
  const departments: DayReportDepartment[] = day.depts
    .map((d) => ({ dept: d, counts: tally(new Set([d.id]), day.visits, day.bookings, day.typeOf) }))
    .filter(({ dept, counts }) => dept.active || counts.booked + counts.consulted + counts.stillOpen > 0)
    .sort((a, b) => a.dept.name.localeCompare(b.dept.name))
    .map(({ dept, counts }) => ({ departmentId: dept.id, code: dept.code, name: dept.name, ...counts }));
  const all = new Set(day.depts.map((d) => d.id));
  const families = (rows: DayEncounter[]) => new Set(rows.map((e) => day.rootOf.get(e.patientId) ?? e.patientId));
  const consultedHere = day.completed.filter((e) => e.departmentId !== null && all.has(e.departmentId));
  return {
    date,
    ...stamp(date, now),
    hospital: day.hospital,
    departments,
    totals: tally(all, day.visits, day.bookings, day.typeOf),
    patientsConsulted: families(consultedHere).size,
    newPatients: families(consultedHere.filter((e) => day.typeOf(e) === "new")).size,
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

export function genderLetter(gender: string | null): DayReportPatientRow["gender"] {
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
 * One department's day with the people in it. The names come through `getPatientSummaries` with the
 * READER as actor, so a confidential patient is aliased against the clearance of whoever is pulling
 * the list — and a restricted row carries no address either, because the seal covers where they
 * live as much as who they are. Returns null for a department that does not exist.
 */
export async function loadOpdDepartmentDayReport(
  db: Db, reader: Actor, date: string, departmentId: string, now: Date = new Date(),
): Promise<OpdDepartmentDayReport | null> {
  const day = await loadDay(db, date);
  const dept = day.depts.find((d) => d.id === departmentId);
  if (dept === undefined) return null;
  const counts = tally(new Set([dept.id]), day.visits, day.bookings, day.typeOf);
  const seen = day.completed
    .filter((e) => e.departmentId === dept.id)
    .sort((a, b) => (a.consultCompletedAt?.getTime() ?? 0) - (b.consultCompletedAt?.getTime() ?? 0) || a.visitNo.localeCompare(b.visitNo));

  const ids = [...new Set(seen.map((e) => e.patientId))];
  const doctorIds = [...new Set(seen.map((e) => e.doctorId).filter((d): d is string => d !== null))];
  const [summaries, addresses, doctors] = await Promise.all([
    getPatientSummaries(db, reader, ids),
    ids.length === 0 ? Promise.resolve([]) : db.select({
      id: patients.id, addressLine: patients.addressLine, district: patients.district, pincode: patients.pincode,
      mergedInto: patients.mergedIntoPatientId,
    }).from(patients).where(inArray(patients.id, ids)),
    doctorIds.length === 0 ? Promise.resolve([]) : db.select({ id: opdDoctors.id, name: opdDoctors.displayName })
      .from(opdDoctors).where(inArray(opdDoctors.id, doctorIds)),
  ]);
  const summaryOf = new Map(summaries.map((s) => [s.requestedId, s]));
  /* A summary resolves a merged record to its survivor; the address is read from that survivor too. */
  const survivorIds = summaries.map((s) => s.id).filter((id) => !ids.includes(id));
  const survivorAddresses = survivorIds.length === 0 ? [] : await db.select({
    id: patients.id, addressLine: patients.addressLine, district: patients.district, pincode: patients.pincode,
    mergedInto: patients.mergedIntoPatientId,
  }).from(patients).where(inArray(patients.id, survivorIds));
  const addressOf = new Map([...addresses, ...survivorAddresses].map((a) => [a.id, a]));
  const doctorOf = new Map(doctors.map((d) => [d.id, d.name]));

  const rows: DayReportPatientRow[] = [];
  for (const e of seen) {
    const s = summaryOf.get(e.patientId);
    if (s === undefined) continue;
    const a = addressOf.get(s.id);
    rows.push({
      visitNo: e.visitNo,
      time: e.consultCompletedAt === null ? "—" : istHourMinute(e.consultCompletedAt),
      name: s.restricted ? (s.alias ?? "Confidential patient") : (s.name ?? "—"),
      restricted: s.restricted,
      uhid: s.uhid,
      age: ageLabel(s.dob, date),
      gender: genderLetter(s.administrativeGender),
      shortAddress: s.restricted || a === undefined ? "—" : shortAddress(a.addressLine, a.district, a.pincode),
      patientType: day.typeOf(e),
      doctor: e.doctorId === null ? "—" : (doctorOf.get(e.doctorId) ?? "—"),
    });
  }
  return {
    date,
    ...stamp(date, now),
    hospital: day.hospital,
    department: { departmentId: dept.id, code: dept.code, name: dept.name, ...counts },
    rows,
  };
}
