import { and, asc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { users } from "../../kernel/db/schema/auth";
import { orgDepartments } from "../../kernel/db/schema/org";
import { rosterDutyWindows, rosterTeams } from "../../kernel/db/schema/roster";
import { addIstDays, istMidnightUtc } from "./calendar";
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
    ))
    .orderBy(asc(rosterDutyWindows.startsAt), asc(rosterTeams.code));

  const withDoctors = opts.doctors !== false;
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
        .filter((m) => ROLE_ORDER.has(m.roleInTeam));
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
