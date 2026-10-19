import { inArray } from "drizzle-orm";
import { users } from "../../kernel/db/schema";
import { doctorUnitsOn, istDateOfInstant, membershipsOf, teamMembers } from "../roster";
import type { DoctorUnit, TeamMember } from "../roster";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD-0.3 (plan D-C) — WHOSE DESK THIS IS, AND WHICH UNIT IT LOOKS AT, decided at READ time.
 *
 * The unit is the roster's answer for the IST day (`doctorUnitsOn`: the parent clinical-unit
 * membership that counts, judged at noon IST), never a column stamped on a visit — so a doctor who
 * moved units mid-month is read against the old unit for the old days and the new one for today, and
 * a doctor in no unit (visiting faculty) gets `unit: null` and their own rows only (plan E17, E18).
 */
export type DeskScope = {
  userId: string;
  name: string;
  grade: string | null;
  istDate: string;
  unit: DoctorUnit | null;
  /** The unit's members at `at`, officiating preferred (`teamMembers`), with names. Empty without a unit. */
  members: (TeamMember & { name: string })[];
};

export async function namesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await (exec as Db).select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}

/** The unit a user belongs to on `istDate`, or null. */
export async function unitOfOn(exec: Db | Tx, userId: string, istDate: string): Promise<DoctorUnit | null> {
  return (await doctorUnitsOn(exec, istDate)).find((u) => u.userId === userId) ?? null;
}

export async function deskScope(exec: Db | Tx, actor: Actor, at: Date): Promise<DeskScope> {
  const istDate = istDateOfInstant(at);
  const userId = actor.id;
  const unit = actor.type === "user" ? await unitOfOn(exec, userId, istDate) : null;
  const grade = actor.type === "user" ? (await membershipsOf(exec, userId, at)).find((m) => m.kind === "parent")?.grade ?? null : null;
  const team = unit === null ? [] : await teamMembers(exec, unit.teamId, at);
  const names = await namesOf(exec, [userId, ...team.map((m) => m.userId)]);
  return {
    userId, name: names.get(userId) ?? "", grade, istDate, unit,
    members: team.map((m) => ({ ...m, name: names.get(m.userId) ?? "" })),
  };
}

/** A patient as a Desk line shows them: a confidential patient by their alias, never their name. */
export function patientOf(
  s: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean } | undefined, fallbackId: string,
): { id: string; uhid: string | null; name: string | null; restricted: boolean } {
  if (s === undefined) return { id: fallbackId, uhid: null, name: null, restricted: false };
  return { id: s.id, uhid: s.uhid, name: s.restricted ? s.alias : s.name, restricted: s.restricted };
}
