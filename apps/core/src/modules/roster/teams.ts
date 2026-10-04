import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  ROSTER_TEAM_KINDS, rosterOfficiating, rosterTeamMemberships, rosterTeams,
} from "../../kernel/db/schema/roster";
import { orgDepartments } from "../../kernel/db/schema/org";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterTeamKind, RosterTeamRole } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R3) — the standing teams a hospital is organised around, and who is in them.
 *
 * Read `kernel/db/schema/roster.ts`'s R3 header first: what a unit is, why the table is
 * `roster_teams` and not `clinical_units`, and why a membership is judged at the SLOT'S START.
 */

export type RosterTeamRow = typeof rosterTeams.$inferSelect;
export type RosterMembershipRow = typeof rosterTeamMemberships.$inferSelect;

/* ═══════════════════════════════ the establishment ═══════════════════════════════ */

/**
 * ═══ 22 UNITS — THE OWNER'S TABLE (2026-10-04) ═══
 *
 * "Department-Wise Unit and Bed Requirements", from the owner: General Medicine 5, General Surgery 5,
 * Obstetrics & Gynaecology 3, Paediatrics 3, Orthopaedics 2, Ophthalmology 1, ENT 1, Psychiatry 1,
 * Dermatology 1 — 22 units, 575 unit beds plus 30 combined ICU beds = 605 (`COMBINED_ICU_BEDS`, for the
 * future IPD; no bed is built here). Respiratory Medicine has NO unit. This SUPERSEDES the 2026-09-20
 * reading (the MSR 2020 table 5/5/3/3/4/2/2/1/1 + Respiratory 1 = 27): OBG 4→3, ORT 3→2, ENT 2→1,
 * OPH 2→1, RESP 1→0. `retireSurplusUnits` closes what an earlier seed wrote beyond it.
 *
 * Every seeded team still lands `active = false`: a unit counts only once its head confirms it
 * (`unitCountsAt`), and today only Unit I of MED, SUR, ENT, OBG and ORT is confirmed.
 */
export const UNIT_ESTABLISHMENT: readonly { departmentCode: string; units: number; sanctionedBeds: number }[] = [
  { departmentCode: "MED", units: 5, sanctionedBeds: 150 },
  { departmentCode: "SUR", units: 5, sanctionedBeds: 150 },
  { departmentCode: "OBG", units: 3, sanctionedBeds: 75 },
  { departmentCode: "PED", units: 3, sanctionedBeds: 75 },
  { departmentCode: "ORT", units: 2, sanctionedBeds: 60 },
  { departmentCode: "OPH", units: 1, sanctionedBeds: 20 },
  { departmentCode: "ENT", units: 1, sanctionedBeds: 20 },
  { departmentCode: "PSY", units: 1, sanctionedBeds: 15 },
  { departmentCode: "DER", units: 1, sanctionedBeds: 10 },
];

/** The owner's table: 30 beds of combined ICUs, belonging to no unit — recorded for the IPD, not built. */
export const COMBINED_ICU_BEDS = 30;

/** 5+5+3+3+2+1+1+1+1 = 22. Named so a test can pin the arithmetic rather than the list. */
export const UNIT_COUNT = UNIT_ESTABLISHMENT.reduce((n, d) => n + d.units, 0);

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/**
 * Seeds the units as DRAFTS, and the department NIGHT POOL beside them — because the owner's night
 * rule is only feasible pooled (stress test S4), and a pool with no team to hang a slot on cannot
 * be rostered at all. Idempotent on `code`, like every other seed here.
 */
export async function seedUnits(exec: Db | Tx, by = "seed"): Promise<{ added: number; present: number }> {
  const depts = await (exec as Db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name })
    .from(orgDepartments);
  const byCode = new Map(depts.map((d) => [d.code, d]));

  let added = 0;
  let intended = 0;
  for (const row of UNIT_ESTABLISHMENT) {
    const dept = byCode.get(row.departmentCode);
    if (dept === undefined) {
      throw new Error(
        `roster units name department "${row.departmentCode}", which is not in org_departments — `
        + "run `pnpm --filter @hmis/core seed:roster` first",
      );
    }
    const perUnit = row.units === 0 ? 0 : Math.floor(row.sanctionedBeds / row.units);
    for (let i = 1; i <= row.units; i += 1) {
      intended += 1;
      const inserted = await (exec as Db).insert(rosterTeams).values({
        id: newId(), kind: "clinical_unit", departmentId: dept.id,
        code: `${row.departmentCode}-U${i}`,
        name: `${dept.name} Unit ${ROMAN[i - 1] ?? String(i)}`,
        unitNumber: i, sanctionedBeds: perUnit, active: false,
        createdBy: by, updatedBy: by,
      }).onConflictDoNothing().returning({ id: rosterTeams.id });
      added += inserted.length;
    }
    // The department's night pool: one per unit-bearing department, and the reason S4 is workable.
    intended += 1;
    const pool = await (exec as Db).insert(rosterTeams).values({
      id: newId(), kind: "pool", departmentId: dept.id,
      code: `${row.departmentCode}-NIGHT`, name: `${dept.name} — night pool`,
      active: false, createdBy: by, updatedBy: by,
    }).onConflictDoNothing().returning({ id: rosterTeams.id });
    added += pool.length;
  }
  return { added, present: intended - added };
}

/**
 * ═══ 2026-10-04 — CLOSING WHAT AN EARLIER SEED WROTE BEYOND THE OWNER'S TABLE ═══
 *
 * An install seeded before 2026-10-04 holds the old 27 (OBG-U4, ORT-U3, ENT-U2, OPH-U2, RESP-U1 and
 * the RESP night pool beyond today's 22). Each such team that was NEVER CONFIRMED (inactive, still
 * open) is CLOSED, never deleted: `valid_to` one millisecond after its `valid_from`, so it never counted
 * at any instant (`unitCountsAt`) and every reader treats it as never having run. A CONFIRMED surplus
 * unit is a head's decision and is never closed here: it is returned in `keptConfirmed` for a human.
 * Only seed-shaped codes (`XXX-U<n>`, `XXX-NIGHT`) are judged; a team a HOD created by hand is left alone.
 * Idempotent: a closed team is not open, so a second run finds nothing.
 */
export const SURPLUS_REASON = "beyond the owner's unit establishment of 2026-10-04 (22 units; Respiratory Medicine none)";

export async function retireSurplusUnits(
  exec: Db | Tx, by = "seed",
): Promise<{ retired: string[]; keptConfirmed: string[] }> {
  const expected = new Set(UNIT_ESTABLISHMENT.flatMap((r) => [
    ...Array.from({ length: r.units }, (_, i) => `${r.departmentCode}-U${i + 1}`), `${r.departmentCode}-NIGHT`,
  ]));
  const open = (await (exec as Db).select().from(rosterTeams).where(isNull(rosterTeams.validTo)))
    .filter((t) => (t.kind === "clinical_unit" || t.kind === "pool") && /^[A-Z]+-(U\d+|NIGHT)$/.test(t.code) && !expected.has(t.code));
  const retired: string[] = [];
  const keptConfirmed: string[] = [];
  for (const t of open.sort((a, b) => a.code.localeCompare(b.code))) {
    if (t.active) { keptConfirmed.push(t.code); continue; }
    await (exec as Db).update(rosterTeams)
      .set({ validTo: new Date(t.validFrom.getTime() + 1), active: false, updatedBy: by, updatedAt: new Date() })
      .where(and(eq(rosterTeams.id, t.id), isNull(rosterTeams.validTo), eq(rosterTeams.active, false)));
    retired.push(t.code);
  }
  return { retired, keptConfirmed };
}

/* ═══════════════════════════════ writes ═══════════════════════════════ */

export interface CreateTeamInput {
  kind: RosterTeamKind;
  departmentId: string;
  code: string;
  name: string;
  homeLocationResourceId?: string | null;
  unitNumber?: number | null;
  sanctionedBeds?: number | null;
  active?: boolean;
}

export async function createTeam(tx: Tx, actor: Actor, input: CreateTeamInput): Promise<{ teamId: string }> {
  await requireRosterAct(tx, actor, "publish", { departmentId: input.departmentId });
  if (!(ROSTER_TEAM_KINDS as readonly string[]).includes(input.kind)) {
    throw new RosterError("invalid_window", `"${input.kind}" is not a kind of team the roster knows`, { kind: input.kind });
  }
  const code = input.code.trim().toUpperCase();
  if (code === "") throw new RosterError("invalid_window", "a team needs a code a human says out loud");

  const dept = (await (tx as Db).select({ id: orgDepartments.id }).from(orgDepartments).where(eq(orgDepartments.id, input.departmentId)))[0];
  if (dept === undefined) throw new RosterError("unknown_department", undefined, { departmentId: input.departmentId });

  const teamId = newId();
  try {
    await tx.insert(rosterTeams).values({
      id: teamId, kind: input.kind, departmentId: input.departmentId, code, name: input.name.trim(),
      homeLocationResourceId: input.homeLocationResourceId ?? null,
      unitNumber: input.unitNumber ?? null, sanctionedBeds: input.sanctionedBeds ?? null,
      active: input.active ?? false, createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isUniqueViolation(e, "roster_teams_code_ux")) {
      throw new RosterError("duplicate_team_code", undefined, { code });
    }
    throw e;
  }
  return { teamId };
}

/**
 * THE HEAD OF DEPARTMENT RATIFIES A SEEDED UNIT. Until this runs, the unit is our arithmetic and
 * not the hospital's establishment — see `UNIT_ESTABLISHMENT`'s note.
 */
export async function confirmTeam(tx: Tx, actor: Actor, teamId: string): Promise<void> {
  const team = await lockTeam(tx, teamId);
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });
  await tx.update(rosterTeams).set({ active: true, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(rosterTeams.id, teamId));
}

/** A team that closes keeps its rows: last year's roster and last year's return both name it. */
export async function closeTeam(tx: Tx, actor: Actor, teamId: string, validTo: Date): Promise<void> {
  const team = await lockTeam(tx, teamId);
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });
  if (validTo <= team.validFrom) {
    throw new RosterError("invalid_window", "a team cannot close before it opened", {
      teamId, validFrom: team.validFrom.toISOString(), validTo: validTo.toISOString(),
    });
  }
  await tx.update(rosterTeams).set({ active: false, validTo, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(rosterTeams.id, teamId));
}

async function lockTeam(tx: Tx, teamId: string): Promise<RosterTeamRow> {
  const row = (await tx.select().from(rosterTeams).where(eq(rosterTeams.id, teamId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_team", undefined, { teamId });
  return row;
}

/* ═══════════════════════════════ reads ═══════════════════════════════ */

export async function teamByCode(exec: Db | Tx, code: string): Promise<RosterTeamRow | undefined> {
  return (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.code, code.toUpperCase())).limit(1))[0];
}

export async function listTeams(
  exec: Db | Tx, opts: { departmentId?: string; kind?: RosterTeamKind; activeOnly?: boolean } = {},
): Promise<RosterTeamRow[]> {
  const rows = await (exec as Db).select().from(rosterTeams).orderBy(asc(rosterTeams.code));
  return rows.filter((r) =>
    (opts.departmentId === undefined || r.departmentId === opts.departmentId)
    && (opts.kind === undefined || r.kind === opts.kind)
    && (opts.activeOnly !== true || r.active));
}

/**
 * ═══ 2026-10-04 (owner) — ONLY A CONFIRMED UNIT COUNTS ═══
 *
 * *"We only have 1 unit per department right now … some departments do not even have any single
 * doctor so we don't have units there."* `seed:roster` writes the 27-unit establishment INACTIVE,
 * and until a head confirms a unit it is our arithmetic, not a unit the hospital runs. Every reader
 * that asks "which departments run units, and which units" — Who is on now, its "no take cycle"
 * hole, the as-it-stood board, the declarations picker, the month picker, the OPD unit line, the
 * census — asks THIS, so a seeded-but-unconfirmed Paediatrics is never drawn as a unit-running
 * department with a hole nobody can fill.
 *
 * A unit counts at `at` when it is open (`valid_to` null) and confirmed (`active`), or when it
 * closed AFTER `at` — `closeTeam` clears `active` at once, and last week's board still names the
 * unit that ran last week.
 */
export function unitCountsAt(team: Pick<RosterTeamRow, "active" | "validTo">, at: Date): boolean {
  return team.validTo === null ? team.active : team.validTo > at;
}

/** The clinical units that count at `at` (see `unitCountsAt`), by code. */
export async function countingUnits(exec: Db | Tx, at: Date): Promise<RosterTeamRow[]> {
  const rows = await (exec as Db).select().from(rosterTeams)
    .where(eq(rosterTeams.kind, "clinical_unit")).orderBy(asc(rosterTeams.code));
  return rows.filter((t) => unitCountsAt(t, at));
}

/** The units a HOD has not yet confirmed — the `standup:check` row, and the screen behind it. */
export async function unconfirmedTeams(exec: Db | Tx): Promise<RosterTeamRow[]> {
  return (exec as Db).select().from(rosterTeams)
    .where(and(eq(rosterTeams.active, false), isNull(rosterTeams.validTo)))
    .orderBy(asc(rosterTeams.code));
}

export interface TeamMember {
  userId: string;
  positionKey: string;
  grade: string;
  roleInTeam: RosterTeamRole;
  kind: string;
  /** TRUE when this person holds the role because somebody else is away, not because it is theirs. */
  officiating: boolean;
  retainsParentNights: boolean;
  supernumerary: boolean;
}

/**
 * ═══ WHO IS IN THIS TEAM AT INSTANT `at`, WITH OFFICIATING PREFERRED ═══
 *
 * A head on three weeks' leave has an officiating head. **The head's own membership is untouched**
 * — they have not stopped being the head — so a resolver that read memberships alone would ring a
 * phone in another state. Where an officiating row is in force for a role, the person named on it
 * is returned AS that role and marked `officiating: true`, and the substantive holder is returned
 * with their own membership role.
 *
 * Membership is judged at `at` and not "now", because yesterday's roster must not change when
 * somebody transfers today.
 */
export async function teamMembers(exec: Db | Tx, teamId: string, at: Date): Promise<TeamMember[]> {
  const live = (col: typeof rosterTeamMemberships.startsAt, end: typeof rosterTeamMemberships.endsAt) =>
    and(sql`${col} <= ${at}`, or(isNull(end), sql`${end} > ${at}`));

  const memberships = await (exec as Db).select().from(rosterTeamMemberships)
    .where(and(eq(rosterTeamMemberships.teamId, teamId), live(rosterTeamMemberships.startsAt, rosterTeamMemberships.endsAt)))
    .orderBy(asc(rosterTeamMemberships.startsAt), asc(rosterTeamMemberships.id));

  const acting = await (exec as Db).select().from(rosterOfficiating)
    .where(and(
      eq(rosterOfficiating.teamId, teamId),
      sql`${rosterOfficiating.startsAt} <= ${at}`,
      or(isNull(rosterOfficiating.endsAt), sql`${rosterOfficiating.endsAt} > ${at}`),
    ));

  const out: TeamMember[] = memberships.map((m) => ({
    userId: m.userId,
    positionKey: m.positionKey,
    grade: m.grade,
    roleInTeam: m.roleInTeam as RosterTeamRole,
    kind: m.kind,
    officiating: false,
    retainsParentNights: m.retainsParentNights,
    supernumerary: m.supernumeraryUntil !== null && m.supernumeraryUntil > at,
  }));

  for (const a of acting) {
    const existing = out.find((m) => m.userId === a.userId);
    if (existing !== undefined) {
      existing.roleInTeam = a.role === "hod" ? "head" : (a.role as RosterTeamRole);
      existing.officiating = true;
    } else {
      out.push({
        userId: a.userId, positionKey: "unit_head", grade: "associate_professor",
        roleInTeam: a.role === "hod" ? "head" : (a.role as RosterTeamRole),
        kind: "rotation", officiating: true, retainsParentNights: false, supernumerary: false,
      });
    }
  }
  return out;
}

/** The people a department's NIGHT POOL may draw on: every parent member, plus rotations that kept their nights. */
export async function nightPoolFor(exec: Db | Tx, departmentId: string, at: Date): Promise<string[]> {
  const teams = await listTeams(exec, { departmentId });
  const ids = new Set<string>();
  for (const team of teams) {
    for (const m of await teamMembers(exec, team.id, at)) {
      if (m.officiating) continue;
      if (m.kind === "parent" || (m.kind === "rotation" && m.retainsParentNights)) ids.add(m.userId);
    }
  }
  return [...ids].sort();
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur != null && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string" && c.code.length === 5) {
      return c.code === "23505" && c.constraint === constraint;
    }
    cur = c.cause;
  }
  return false;
}
