import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { users } from "../../kernel/db/schema/auth";
import { opdDoctorLeaves, opdDoctorSchedules, opdDoctors } from "../../kernel/db/schema/opd";
import { orgDepartments } from "../../kernel/db/schema/org";
import { rosterDutyWindows, rosterTeams } from "../../kernel/db/schema/roster";
import { addIstDays, istDateOfInstant, istMidnightUtc, istWeekday } from "./calendar";
import { teamMembers } from "./teams";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ 20-U U7 — OPD READS THE UNIT CALENDAR, READ-ONLY ═══
 *
 * Which unit holds a department's OPD on an IST day, and which of its doctors. The answer is the
 * published cycle's `opd` windows (`roster_duty_windows`, live rows only — a declared holiday that
 * withdrew OPD has superseded them, so a closed OPD names nobody). Keyed by the OPD clinic the
 * department runs (`org_departments.opd_department_id`), because that is the id every OPD screen and
 * report already holds.
 *
 * **The queue model is not touched** (plan §7 U7): a session is still a doctor-day, a token is still
 * a doctor's, and nothing here decides who a patient is seated with. This only SAYS which unit's day
 * it is. A department that runs no units, or whose cycle sets no OPD window that day, is simply
 * absent from the answer — the screens draw nothing for it rather than "Unit —".
 *
 * DECIDED (20-U U7) — **the doctors named are the unit's head, faculty and senior residents**, at the
 * window's start: the people a patient is seen by in an Indian teaching OPD and asks for by name.
 * Junior residents and interns sit in the same OPD but are not named to the front desk.
 *
 * ═══ 2026-10-04 (owner) — ONLY A CONFIRMED UNIT, AND ONLY THE DOCTORS SITTING THAT DAY ═══
 *
 * A window on a unit nobody has confirmed (`unitCountsAt`) is not answered: a seeded Paediatrics
 * unit must not tell the front desk it "holds today's OPD". And a unit's doctor is named only on a
 * day they SIT: one General Medicine unit holds the OPD Monday to Saturday, but Dr Chandan sits
 * Monday–Wednesday and Dr Yash Vardhan Thursday–Saturday, so Monday's line names Chandan alone.
 * DECIDED — the OPD's own weekly schedule is the evidence (`opd_doctor_schedules` for that weekday,
 * valid that day, less a planned OPD leave). A member with no OPD doctor profile at all is named as
 * before — the roster is then the only word on them. Read straight from the kernel schema; the opd
 * module is not imported (the roster reaches into no module, plan §2.4).
 */

export interface OpdUnitDoctor { userId: string; name: string; role: "head" | "faculty" | "senior_resident" }
export interface OpdUnit {
  teamId: string;
  code: string;
  /** The unit's full name — `General Medicine Unit II`. */
  name: string;
  /** The name with the department's own prefix taken off — `Unit II` — for a line already under it. */
  short: string;
  startsAt: Date;
  endsAt: Date;
  doctors: OpdUnitDoctor[];
}
export interface OpdDepartmentUnits {
  /** `opd_departments.id` — the clinic. */
  opdDepartmentId: string;
  /** `org_departments.id` — the department that runs it. */
  departmentId: string;
  units: OpdUnit[];
}

const NAMED_ROLES = ["head", "faculty", "senior_resident"] as const;
const ROLE_ORDER = new Map<string, number>(NAMED_ROLES.map((r, i) => [r, i]));

/** `General Medicine Unit II` under `General Medicine` → `Unit II`. Anything else as it is. */
export function shortUnitName(unitName: string, departmentName: string): string {
  return unitName.startsWith(`${departmentName} `) ? unitName.slice(departmentName.length + 1) : unitName;
}

/**
 * Every OPD clinic's unit(s) on `istDate`, in the order their windows open. `doctors: false` skips
 * the members read — the day report needs the unit, not its people.
 */
export async function opdUnitsOn(
  exec: Db | Tx, istDate: string, opts: { doctors?: boolean } = {},
): Promise<OpdDepartmentUnits[]> {
  const from = istMidnightUtc(istDate);
  const to = istMidnightUtc(addIstDays(istDate, 1));
  const rows = await (exec as Db).select({
    opdDepartmentId: orgDepartments.opdDepartmentId, departmentId: orgDepartments.id, departmentName: orgDepartments.name,
    teamId: rosterTeams.id, code: rosterTeams.code, name: rosterTeams.name,
    startsAt: rosterDutyWindows.startsAt, endsAt: rosterDutyWindows.endsAt,
  })
    .from(rosterDutyWindows)
    .innerJoin(orgDepartments, eq(orgDepartments.id, rosterDutyWindows.departmentId))
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterDutyWindows.teamId))
    .where(and(
      eq(rosterDutyWindows.activity, "opd"), isNull(rosterDutyWindows.supersededAt),
      gte(rosterDutyWindows.startsAt, from), lt(rosterDutyWindows.startsAt, to),
      isNotNull(orgDepartments.opdDepartmentId),
      // Only a unit that counts that day: confirmed and open, or closed after the day began.
      or(and(isNull(rosterTeams.validTo), eq(rosterTeams.active, true)), gt(rosterTeams.validTo, from)),
    ))
    .orderBy(asc(rosterDutyWindows.startsAt), asc(rosterTeams.code));

  const withDoctors = opts.doctors !== false;
  const sitting = withDoctors ? await sittingThatDay(exec, istDate) : null;
  const out = new Map<string, OpdDepartmentUnits>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const clinic = r.opdDepartmentId!;
    const entry = out.get(clinic) ?? { opdDepartmentId: clinic, departmentId: r.departmentId, units: [] };
    out.set(clinic, entry);
    // A unit with two OPD windows the same day (a morning and an evening clinic) is one unit here.
    if (entry.units.some((u) => u.teamId === r.teamId)) continue;
    let doctors: OpdUnitDoctor[] = [];
    if (withDoctors) {
      const members = (await teamMembers(exec, r.teamId, r.startsAt))
        .filter((m) => ROLE_ORDER.has(m.roleInTeam))
        .filter((m) => !sitting!.hasProfile.has(m.userId) || sitting!.sits.has(m.userId));
      const missing = members.map((m) => m.userId).filter((id) => !names.has(id));
      if (missing.length > 0) {
        for (const u of await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, missing))) {
          names.set(u.id, u.fullName);
        }
      }
      doctors = members
        .map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? "", role: m.roleInTeam as OpdUnitDoctor["role"] }))
        .filter((d) => d.name !== "")
        .sort((a, b) => (ROLE_ORDER.get(a.role)! - ROLE_ORDER.get(b.role)!) || a.name.localeCompare(b.name));
    }
    entry.units.push({
      teamId: r.teamId, code: r.code, name: r.name, short: shortUnitName(r.name, r.departmentName),
      startsAt: r.startsAt, endsAt: r.endsAt, doctors,
    });
  }
  return [...out.values()];
}

/**
 * Who sits in an OPD clinic on `istDate`, by the OPD's own weekly schedule: users with an active
 * OPD doctor profile (`hasProfile`), and of those the ones with a schedule row for that weekday,
 * valid that day, and no planned (not cancelled) OPD leave covering it (`sits`).
 */
async function sittingThatDay(exec: Db | Tx, istDate: string): Promise<{ hasProfile: Set<string>; sits: Set<string> }> {
  const profiles = await (exec as Db).select({ id: opdDoctors.id, userId: opdDoctors.userId })
    .from(opdDoctors).where(eq(opdDoctors.active, true));
  const hasProfile = new Set(profiles.map((p) => p.userId));
  const userOf = new Map(profiles.map((p) => [p.id, p.userId]));
  const scheduled = await (exec as Db).select({ doctorId: opdDoctorSchedules.doctorId }).from(opdDoctorSchedules).where(and(
    eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, istWeekday(istDate)),
    lte(opdDoctorSchedules.validFrom, istDate),
    or(isNull(opdDoctorSchedules.validTo), gte(opdDoctorSchedules.validTo, istDate)),
  ));
  const away = new Set((await (exec as Db).select({ doctorId: opdDoctorLeaves.doctorId }).from(opdDoctorLeaves).where(and(
    eq(opdDoctorLeaves.status, "scheduled"), lte(opdDoctorLeaves.fromDate, istDate), gte(opdDoctorLeaves.toDate, istDate),
  ))).map((l) => l.doctorId));
  const sits = new Set(scheduled.filter((s) => !away.has(s.doctorId)).flatMap((s) => {
    const u = userOf.get(s.doctorId);
    return u === undefined ? [] : [u];
  }));
  return { hasProfile, sits };
}

/**
 * ═══ 2026-10-04 (owner) — WHO IS SITTING IN OPD, FOR A BOARD WITH NO DUTY ROSTER ═══
 *
 * Only the OPD is live in this hospital: no inpatient take, no duty roster published. A who-is-on
 * board of amber "not published" rows tells the desk nothing, so where a department has no published
 * duty roster the board shows who is SITTING IN OPD, from the OPD's own weekly schedule (that weekday,
 * valid that day, less a planned leave). Per clinic, each doctor's NEXT session that has not ended by
 * `at`: sitting now ("in OPD till 16:00") or later today ("in OPD from 14:00"). A doctor whose last
 * session has ended is not listed. Read from the kernel schema; the opd module is not imported.
 */
export interface OpdSitting {
  userId: string; name: string; designation: string | null;
  from: Date; till: Date;
  /** True when `from <= at < till`. */
  now: boolean;
}

export async function opdSittingAt(exec: Db | Tx, at: Date): Promise<Map<string, OpdSitting[]>> {
  const istDate = istDateOfInstant(at);
  const midnight = istMidnightUtc(istDate).getTime();
  const clock = (hhmm: string): Date => new Date(midnight + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000);
  const doctors = await (exec as Db).select({
    id: opdDoctors.id, userId: opdDoctors.userId, name: opdDoctors.displayName, designation: opdDoctors.designation, clinic: opdDoctors.departmentId,
  }).from(opdDoctors).innerJoin(users, eq(users.id, opdDoctors.userId))
    .where(and(eq(opdDoctors.active, true), eq(users.active, true)));
  if (doctors.length === 0) return new Map();
  const rows = await (exec as Db).select({ doctorId: opdDoctorSchedules.doctorId, startTime: opdDoctorSchedules.startTime, endTime: opdDoctorSchedules.endTime })
    .from(opdDoctorSchedules).where(and(
      eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, istWeekday(istDate)),
      lte(opdDoctorSchedules.validFrom, istDate),
      or(isNull(opdDoctorSchedules.validTo), gte(opdDoctorSchedules.validTo, istDate)),
    ));
  const away = new Set((await (exec as Db).select({ doctorId: opdDoctorLeaves.doctorId }).from(opdDoctorLeaves).where(and(
    eq(opdDoctorLeaves.status, "scheduled"), lte(opdDoctorLeaves.fromDate, istDate), gte(opdDoctorLeaves.toDate, istDate),
  ))).map((l) => l.doctorId));
  const out = new Map<string, OpdSitting[]>();
  for (const d of doctors) {
    if (away.has(d.id)) continue;
    const next = rows.filter((r) => r.doctorId === d.id)
      .map((r) => ({ from: clock(r.startTime), till: clock(r.endTime) }))
      .filter((s) => s.till > at)
      .sort((a, b) => a.from.getTime() - b.from.getTime())[0];
    if (next === undefined) continue;
    const list = out.get(d.clinic) ?? [];
    list.push({ userId: d.userId, name: d.name, designation: d.designation, from: next.from, till: next.till, now: next.from <= at });
    out.set(d.clinic, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => Number(b.now) - Number(a.now) || a.from.getTime() - b.from.getTime() || a.name.localeCompare(b.name));
  }
  return out;
}
