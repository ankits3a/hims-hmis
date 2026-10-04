import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { orgDepartments } from "../../kernel/db/schema/org";
import { opdDoctors } from "../../kernel/db/schema/opd";
import { users } from "../../kernel/db/schema/auth";
import { rosterTeamMemberships, rosterTeams } from "../../kernel/db/schema/roster";
import { istMidnightUtc } from "./calendar";
import { opdUnitsOn, shortUnitName } from "./opd-units";
import { officiatingAt } from "./officiating";
import { unitCountsAt } from "./teams";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ 2026-10-04 (owner) — THE UNIT BESIDE A DOCTOR'S NAME ═══
 *
 * *"OPD screens show the unit beside the doctor's name: Dr. Chandan · Unit I."* For an IST day, every
 * person's PARENT membership of a clinical unit that counts (`unitCountsAt`), judged at noon IST — the
 * middle of the OPD day, so a posting that starts or ends at midnight is read for the day it covers.
 * Read-only; a person in no unit (guest faculty, Community Medicine) is simply absent.
 */
export interface DoctorUnit {
  userId: string; teamId: string; code: string;
  /** `General Medicine Unit I`. */
  unitName: string;
  /** `Unit I` — the name with the department's prefix taken off. */
  short: string;
  departmentId: string; departmentName: string;
  roleInTeam: string;
}

export async function doctorUnitsOn(exec: Db | Tx, istDate: string): Promise<DoctorUnit[]> {
  const at = new Date(istMidnightUtc(istDate).getTime() + 12 * 3_600_000);
  const rows = await (exec as Db).select({
    userId: rosterTeamMemberships.userId, roleInTeam: rosterTeamMemberships.roleInTeam,
    teamId: rosterTeams.id, code: rosterTeams.code, name: rosterTeams.name, active: rosterTeams.active, validTo: rosterTeams.validTo,
    departmentId: orgDepartments.id, departmentName: orgDepartments.name,
  })
    .from(rosterTeamMemberships)
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterTeamMemberships.teamId))
    .innerJoin(orgDepartments, eq(orgDepartments.id, rosterTeams.departmentId))
    .where(and(
      eq(rosterTeamMemberships.kind, "parent"), eq(rosterTeams.kind, "clinical_unit"),
      lte(rosterTeamMemberships.startsAt, at),
      or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, at)),
    ));
  return rows.filter((r) => unitCountsAt(r, at)).map((r) => ({
    userId: r.userId, teamId: r.teamId, code: r.code, unitName: r.name, short: shortUnitName(r.name, r.departmentName),
    departmentId: r.departmentId, departmentName: r.departmentName, roleInTeam: r.roleInTeam,
  }));
}

/**
 * ═══ 2026-10-04 (owner) — WHAT THE OPD PRESCRIPTION PRINTS FOR ITS PRESCRIBER ═══
 *
 * No doctor's name, anywhere on the paper. Two fields:
 *   · **Unit Number** — the prescriber's unit on the visit's IST day ("Unit I"). A doctor in no unit
 *     (Guest Faculty, and DECIDED: anyone else in none, e.g. Community Medicine) prints their Doctor
 *     ID in the same field. The words "Guest Faculty" never print.
 *   · **Dept. Regn** — the DEPARTMENT registration number: the council number of THAT DAY's head of
 *     the unit concerned — not the prescriber's own. A unit doctor → their unit's head. A doctor in no
 *     unit → the head of the unit that holds the visit department's OPD that day (Raza on a Monday in
 *     General Medicine → MED Unit I's head). A department with no unit → null (prints blank). Somebody
 *     OFFICIATING as head that day (`roster_officiating`, role `head`) is the head. A head with no
 *     number on file → null, and `unitHeadsWithoutRegn` lists them so the gap is seen.
 */
export interface PrescriberPrint { unitNumber: string; inUnit: boolean; deptRegn: string | null; headUserId: string | null }

const present = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};
const noonOf = (istDate: string): Date => new Date(istMidnightUtc(istDate).getTime() + 12 * 3_600_000);

/** The head of a unit at `at`: whoever officiates as head then, else the substantive head. */
async function headOf(exec: Db | Tx, teamId: string, at: Date, units: readonly DoctorUnit[]): Promise<string | null> {
  const standIn = (await officiatingAt(exec, teamId, at)).find((o) => o.role === "head");
  if (standIn !== undefined) return standIn.userId;
  return units.find((u) => u.teamId === teamId && u.roleInTeam === "head")?.userId ?? null;
}

const regnOf = async (exec: Db | Tx, userId: string): Promise<string | null> =>
  present((await (exec as Db).select({ r: opdDoctors.registrationNo }).from(opdDoctors).where(eq(opdDoctors.userId, userId)))[0]?.r);

export async function prescriberPrint(
  exec: Db | Tx, doctor: { userId: string; code: string | null }, visit: { istDate: string; opdDepartmentId: string | null },
): Promise<PrescriberPrint> {
  const at = noonOf(visit.istDate);
  const units = await doctorUnitsOn(exec, visit.istDate);
  const mine = units.find((u) => u.userId === doctor.userId);
  let teamId = mine?.teamId ?? null;
  if (teamId === null && visit.opdDepartmentId !== null) {
    const clinic = (await opdUnitsOn(exec, visit.istDate, { doctors: false })).find((c) => c.opdDepartmentId === visit.opdDepartmentId);
    teamId = clinic?.units[0]?.teamId ?? null;
  }
  const head = teamId === null ? null : await headOf(exec, teamId, at, units);
  return {
    unitNumber: mine?.short ?? doctor.code ?? "—",
    inUnit: mine !== undefined,
    deptRegn: head === null ? null : await regnOf(exec, head),
    headUserId: head,
  };
}

/** The heads (substantive or officiating) of every counting unit on `istDate` with no council number on file. */
export async function unitHeadsWithoutRegn(exec: Db | Tx, istDate: string): Promise<{ teamId: string; unitName: string; userId: string; name: string }[]> {
  const at = noonOf(istDate);
  const units = await doctorUnitsOn(exec, istDate);
  const teams = new Map(units.map((u) => [u.teamId, u.unitName]));
  const out: { teamId: string; unitName: string; userId: string; name: string }[] = [];
  for (const [teamId, unitName] of teams) {
    const head = await headOf(exec, teamId, at, units);
    if (head === null || (await regnOf(exec, head)) !== null) continue;
    const name = (await (exec as Db).select({ n: users.fullName }).from(users).where(eq(users.id, head)))[0]?.n ?? head;
    out.push({ teamId, unitName, userId: head, name });
  }
  return out.sort((a, b) => a.unitName.localeCompare(b.unitName));
}
