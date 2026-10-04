import { and, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import {
  rosterAmendments, rosterAssignments, rosterModeDeclarations, rosterPeriods, rosterTeams,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { listOrgDepartments, listRosterPositions } from "./masters";
import { resolverEnabled } from "./resolve";
import { backupUnit, istDateOfInstant, istMidnightUtc, unitOnTake } from "./calendar";
import { publishedAsKnownAt } from "./periods";
import { boardColumn } from "./board";
import { RosterError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { BoardDepartment, BoardPerson, BoardRung, BoardService, BoardUnit, OnNowBoard } from "./board";
import type { OnTakeAnswer } from "./calendar";

/**
 * 20-U I23 — **"SHOW ME WHO WAS ON DUTY IN SURGERY LAST TUESDAY."** The NMC surprise inspection.
 *
 * The who-is-on board's `?at=` answers from the rows in effect NOW: ask it about last Tuesday and it
 * answers with every correction made since, which is exactly what plan 20-U §8 I23 forbids — *"for
 * last Tuesday the **published version as it stood that day**, with amendments listed — never
 * today's edit of history"* — and what I26 relies on (a back-dated amendment is allowed, stamped
 * `after_the_fact`, and LISTED here).
 *
 * So this read answers on the KNOWLEDGE axis (`periods.ts` `asKnownAt`, here across every scope as
 * `publishedAsKnownAt`) at the same instant it asks about: the rows that were published and live at
 * `at`, and covering `at`. Then it lists everything done to that IST day's roster SINCE — each
 * amendment (who approved it, when, whether it was after the fact, who came off and who went on)
 * and each re-published version — so the inspector sees both the record and its edits, side by side
 * and never merged.
 *
 * The board's shape is reused on purpose (the screen draws the same table), with three DECIDED
 * differences, each a rule rather than a shortcut:
 *
 *   · **No phone numbers.** D6 lets a number be shown only for a person on duty at that instant, and
 *     a past instant is nobody's "now".
 *   · **No holes.** "Holes in the next 24 hours" is a forward look; an inspection is a record.
 *   · **The unit on take is the calendar's** (`roster_duty_windows`), which is not versioned on the
 *     knowledge axis — a holiday declared later re-materialises that day's windows. The people are
 *     from the published roster as it stood, which is the question asked; the unit label is context.
 *   · **Amendment reasons are not on the list.** A reason is prose ("covering for Dr Rao, her
 *     father is in ICU") and D6 keeps it with the people it touches; the kind, the approver, the
 *     instant and the after-the-fact stamp are the inspection's facts.
 */

export interface ChangedSlot {
  userId: string | null; name: string | null; positionKey: string; positionLabel: string;
  startsAt: Date; endsAt: Date;
}
export interface AsItStoodChange {
  /** An amendment's kind (`swap`, `cover`, `correction`, …), or `new_version` for a re-publish. */
  kind: string;
  periodId: string;
  departmentId: string | null;
  departmentName: string | null;
  at: Date;
  afterTheFact: boolean;
  byName: string | null;
  version: number | null;
  removed: ChangedSlot[];
  added: ChangedSlot[];
}
export interface AsItStoodBoard extends OnNowBoard {
  /** The knowledge instant — equal to `at`: the roster as it was known when it was in force. */
  knownAt: Date;
  /** Every change made to that IST day's roster after `at`, oldest first. */
  changes: AsItStoodChange[];
}

const DAY_MS = 86_400_000;
const RESIDENT_CADRES = new Set(["intern", "junior_resident", "senior_resident"]);

export async function boardAsItStood(
  exec: Db | Tx, at: Date, now: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<AsItStoodBoard> {
  if (at.getTime() > now.getTime()) {
    throw new RosterError("invalid_window", "\"as it stood\" is a past instant — for now or later, read the board", { at: at.toISOString() });
  }
  const positions = await listRosterPositions(exec);
  const posByKey = new Map(positions.map((p) => [p.key, p]));
  const labelOf = (key: string): string => posByKey.get(key)?.label ?? key;
  const columnOf = (key: string) => {
    const p = posByKey.get(key);
    return p === undefined ? undefined : boardColumn(p);
  };
  const departments = await listOrgDepartments(exec);
  const deptById = new Map(departments.map((d) => [d.id, d]));

  const unitTeams = (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.kind, "clinical_unit")))
    // As the board does: a unit not closed by `at`. `valid_from` is not read — a unit seeded today
    // was running last Tuesday too; its seed instant is not the day the unit began.
    .filter((t) => t.validTo === null || t.validTo > at);
  const teamById = new Map(unitTeams.map((t) => [t.id, t]));
  const unitCount = new Map<string, number>();
  for (const t of unitTeams) unitCount.set(t.departmentId, (unitCount.get(t.departmentId) ?? 0) + 1);

  const names = new Map<string, string>();
  const nameOf = async (ids: readonly (string | null)[]): Promise<void> => {
    const missing = [...new Set(ids.filter((i): i is string => i !== null))].filter((i) => !names.has(i));
    if (missing.length === 0) return;
    for (const r of await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, missing))) {
      names.set(r.id, r.fullName);
    }
  };
  const unitOf = async (answer: OnTakeAnswer): Promise<BoardUnit | null> => {
    if (answer.teamId === null || answer.startsAt === null || answer.endsAt === null) return null;
    const team = teamById.get(answer.teamId)
      ?? (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.id, answer.teamId)))[0];
    if (team === undefined) return null;
    return { teamId: team.id, code: team.code, name: team.name, startsAt: answer.startsAt, endsAt: answer.endsAt };
  };

  // The roster AS IT WAS KNOWN at `at`, covering `at`.
  const known = (await publishedAsKnownAt(exec, at, at, new Date(at.getTime() + 1)))
    .filter((r) => r.assignment.kind !== "off");
  await nameOf(known.map((r) => r.assignment.userId));

  // Skeleton cover as it had been declared by `at` (a withdrawal after `at` does not unsay it).
  const istDate = istDateOfInstant(at);
  const declared = (await (exec as Db).select().from(rosterModeDeclarations)
    .where(eq(rosterModeDeclarations.istDate, istDate)))
    .filter((d) => d.declaredAt <= at && (d.withdrawnAt === null || d.withdrawnAt > at));
  const skeletonFor = (departmentId: string): boolean =>
    declared.some((d) => d.departmentId === null || d.departmentId === departmentId);

  const rows: BoardDepartment[] = [];
  for (const departmentId of [...unitCount.keys()]) {
    const dept = deptById.get(departmentId);
    if (dept === undefined) continue;
    const here = known.filter((r) => r.assignment.departmentId === departmentId);
    const unitRows = here.filter((r) => columnOf(r.assignment.positionKey) === "building" || columnOf(r.assignment.positionKey) === "faculty");

    const inTheBuilding: BoardPerson[] = [];
    const seen = new Set<string>();
    for (const r of unitRows
      .filter((x) => columnOf(x.assignment.positionKey) === "building" && x.assignment.userId !== null)
      .sort((a, b) => (posByKey.get(b.assignment.positionKey)!.ladderRank - posByKey.get(a.assignment.positionKey)!.ladderRank)
        || (names.get(a.assignment.userId!) ?? "").localeCompare(names.get(b.assignment.userId!) ?? ""))) {
      const userId = r.assignment.userId!;
      if (seen.has(userId)) continue;
      seen.add(userId);
      const pos = posByKey.get(r.assignment.positionKey)!;
      if (!RESIDENT_CADRES.has(pos.cadre)) continue;
      inTheBuilding.push({ userId, name: names.get(userId) ?? userId, positionKey: pos.key, positionLabel: pos.label, cadre: pos.cadre, phone: null });
    }

    const faculty = unitRows.filter((x) => columnOf(x.assignment.positionKey) === "faculty");
    const tierOf = (x: typeof faculty[number]): number => x.assignment.callTier ?? 99;
    const firstTier = faculty.length === 0 ? null : Math.min(...faculty.map(tierOf));
    const facultyOnCall: BoardRung[] = faculty.filter((x) => tierOf(x) === firstTier).map((x) => ({
      userId: x.assignment.userId, name: x.assignment.userId === null ? null : (names.get(x.assignment.userId) ?? x.assignment.userId),
      positionKey: x.assignment.positionKey, positionLabel: labelOf(x.assignment.positionKey), callTier: x.assignment.callTier,
    }));

    rows.push({
      departmentId, code: dept.code, name: dept.name, units: unitCount.get(departmentId) ?? 0,
      source: unitRows.length > 0 ? "published" : "static",
      skeleton: skeletonFor(departmentId),
      unitOnTake: await unitOf(await unitOnTake(exec, departmentId, at)),
      backupUnit: await unitOf(await backupUnit(exec, departmentId, at)),
      inTheBuilding, facultyOnCall,
    });
  }
  rows.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));

  const services: BoardService[] = [];
  for (const pos of positions.filter((p) => p.active && boardColumn(p) === "service")) {
    const declaring = known.some((r) => r.period.coversPositions.includes(pos.key));
    const people = new Map<string, { userId: string; name: string; departmentId: string | null }>();
    for (const r of known) {
      if (r.assignment.positionKey !== pos.key || r.assignment.userId === null) continue;
      people.set(r.assignment.userId, { userId: r.assignment.userId, name: names.get(r.assignment.userId) ?? r.assignment.userId, departmentId: r.assignment.departmentId });
    }
    services.push({ positionKey: pos.key, positionLabel: pos.label, cadre: pos.cadre, source: declaring ? "published" : "static", people: [...people.values()] });
  }

  return {
    at, knownAt: at, resolverEnabled: resolverEnabled(env), departments: rows, services, holes: [],
    changes: await changesSince(exec, at, istDate, deptById, labelOf, names, nameOf),
  };
}

/** Every amendment and every re-publish to the IST day's roster made after `at`, oldest first. */
async function changesSince(
  exec: Db | Tx, at: Date, istDate: string,
  deptById: ReadonlyMap<string, { name: string }>,
  labelOf: (key: string) => string,
  names: Map<string, string>,
  nameOf: (ids: readonly (string | null)[]) => Promise<void>,
): Promise<AsItStoodChange[]> {
  const dayStart = istMidnightUtc(istDate);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const periods = await (exec as Db).select().from(rosterPeriods).where(and(
    isNotNull(rosterPeriods.publishedAt), lt(rosterPeriods.startsAt, dayEnd), gt(rosterPeriods.endsAt, dayStart),
  ));
  if (periods.length === 0) return [];
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const touchesDay = (a: { startsAt: Date; endsAt: Date }): boolean => a.startsAt < dayEnd && a.endsAt > dayStart;
  const asSlot = (a: typeof rosterAssignments.$inferSelect): ChangedSlot => ({
    userId: a.userId, name: a.userId === null ? null : (names.get(a.userId) ?? a.userId),
    positionKey: a.positionKey, positionLabel: labelOf(a.positionKey), startsAt: a.startsAt, endsAt: a.endsAt,
  });

  const amendments = await (exec as Db).select().from(rosterAmendments).where(and(
    inArray(rosterAmendments.periodId, [...periodById.keys()]), gt(rosterAmendments.appliedAt, at),
  ));
  const out: AsItStoodChange[] = [];
  for (const am of amendments) {
    const opened = (await (exec as Db).select().from(rosterAssignments).where(eq(rosterAssignments.amendmentId, am.id)))
      .filter(touchesDay);
    const closed = (await (exec as Db).select().from(rosterAssignments).where(and(
      eq(rosterAssignments.periodId, am.periodId), eq(rosterAssignments.liveTo, am.appliedAt),
    ))).filter(touchesDay);
    if (opened.length === 0 && closed.length === 0) continue;
    await nameOf([...opened, ...closed].map((a) => a.userId).concat([am.approvedBy]));
    const p = periodById.get(am.periodId)!;
    out.push({
      kind: am.kind, periodId: am.periodId, departmentId: p.departmentId,
      departmentName: p.departmentId === null ? null : (deptById.get(p.departmentId)?.name ?? null),
      at: am.appliedAt, afterTheFact: am.afterTheFact, byName: names.get(am.approvedBy) ?? am.approvedBy, version: p.version,
      removed: closed.map(asSlot), added: opened.map(asSlot),
    });
  }
  for (const p of periods) {
    if (p.publishedAt === null || p.publishedAt <= at || p.version <= 1) continue;
    await nameOf([p.publishedBy]);
    out.push({
      kind: "new_version", periodId: p.id, departmentId: p.departmentId,
      departmentName: p.departmentId === null ? null : (deptById.get(p.departmentId)?.name ?? null),
      at: p.publishedAt, afterTheFact: false, byName: p.publishedBy === null ? null : (names.get(p.publishedBy) ?? p.publishedBy),
      version: p.version, removed: [], added: [],
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
