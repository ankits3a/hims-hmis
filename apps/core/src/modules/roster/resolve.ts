import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { rosterAssignments, rosterPeriods, rosterPositions, rosterTeams } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { RosterError } from "./errors";
import { absentUserIds } from "./absences";
import { teamMembers } from "./teams";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PHASE R (R5) — **WHO IS ON, AND THE FLAG THAT LETS THE HOSPITAL FIND OUT SAFELY.**
 *
 * ═══ THE RESOLVER IS SCOPED, AND THAT IS THE WHOLE OF FINDING S1 ═══
 *
 * Plan 20 T2's resolver took a role key and no scope. Roster every resident as `doctor` — which is
 * all RBAC has — and `whoIsOn("doctor", 02:14)` returns **every doctor on any published roster in
 * the building**. Worse, because it takes no scope, *a Medicine alert resolves to Surgery's
 * resident if only Surgery has published October.* Somebody would have been woken for a ward they
 * had never seen, and the system would have been behaving exactly as designed.
 *
 * So the question is `whoIsOn({ position, departmentId?, teamId?, locationId? }, at)`: a **duty
 * position**, and the place it is being asked about.
 *
 * ═══ THREE ANSWERS, AND THE SCREEN MUST BE ABLE TO TELL THEM APART ═══
 *
 *   · **`published`** — a roster answers for this position here, and these are the people. An empty
 *     answer is still `published`: *"this unit has published October and nobody is on at 03:10"* is
 *     a real and important statement, and V13 says it is not an error.
 *   · **`static`** — no roster answers for this position here, so the answer is who HOLDS the RBAC
 *     role, exactly as the hospital behaved before this phase. Identical ids, identical order.
 *   · **`pattern`** — R7's calendar will answer from a department's cycle when no period is
 *     published. It is in the union today and never returned, so a screen written now against
 *     "UNPUBLISHED — pattern" does not have to change when R7 lands.
 *
 * ═══ THE FLAG IS OFF, AND WHAT THAT MEANS IS PARITY (V14) ═══
 *
 * `ROSTER_RESOLVER_ENABLED=false` is the default and makes every answer `static`. A hospital turns
 * it on per deployment once its rosters are published, and until it does the behaviour is not
 * "degraded" — it is **bit-for-bit what it was**, which is the only kind of rollout a thing that
 * decides who is woken at 02:00 may have.
 *
 * ═══ THE CLOCK IS THE CALLER'S, ALWAYS ═══
 *
 * Every function here takes `at`. None defaults it. A resolver that reads the clock cannot be asked
 * what it said last Tuesday, and "who was on at 03:10 that night" is the question this whole phase
 * exists to be able to answer.
 */

/** The same local-flag shape `modules/billing/invoices.ts` uses for its own gates. */
const flag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
export const ROSTER_RESOLVER_FLAG = "ROSTER_RESOLVER_ENABLED";

export function resolverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag.parse(env[ROSTER_RESOLVER_FLAG]);
}

/**
 * ═══ THE LOOK-BACK BOUND, AND WHY IT IS CORRECTNESS RATHER THAN SPEED ═══
 *
 * A duty covering instant `at` must have STARTED at or before it — and by the database's own
 * `roster_assignments_window_cap_ck`, no single window is longer than 35 days. So no slot starting
 * earlier than `at − 35 days` can possibly be running, and the query says so.
 *
 * It reads as an optimisation and is really a statement of the invariant: if the cap were ever
 * relaxed without changing this constant, the resolver would start silently missing long duties.
 * The two are named together here so that cannot happen quietly.
 */
export const LOOK_BACK_DAYS = 35;
const DAY_MS = 86_400_000;
const lookBackFrom = (at: Date): Date => new Date(at.getTime() - LOOK_BACK_DAYS * DAY_MS);

export type RosterAnswerSource = "published" | "pattern" | "static";

export interface WhoIsOnQuery {
  position: string;
  departmentId?: string;
  teamId?: string;
  locationId?: string;
}

export interface WhoIsOnAnswer {
  userIds: string[];
  source: RosterAnswerSource;
  /** The positions a roster DOES answer for here, when the asked-for one is not among them. */
  declared?: string[];
}

type AssignmentRow = typeof rosterAssignments.$inferSelect;

/* ═══════════════════════════════ the fallback ═══════════════════════════════ */

/**
 * V14 — what the hospital did before this phase, unchanged: everybody holding the RBAC role the
 * position is eligible against, deduped and sorted, which is `usersHoldingRole`'s own contract.
 *
 * A position with NO eligible role (an intern; a nurse, until phase N gives nursing its role)
 * falls back to nobody — and that is honest rather than empty-by-accident: there is no RBAC
 * question whose answer is "the interns", so a caller that gets `[]` here has been told the truth.
 */
async function staticAnswer(exec: Db | Tx, position: string): Promise<WhoIsOnAnswer> {
  const row = (await (exec as Db).select().from(rosterPositions).where(eq(rosterPositions.key, position)))[0];
  if (row === undefined) throw new RosterError("unknown_position", undefined, { positionKey: position });
  if (row.eligibleRoleKey === null) return { userIds: [], source: "static" };
  return { userIds: await usersHoldingRole(exec as Tx, row.eligibleRoleKey), source: "static" };
}

/* ═══════════════════════════════ scope reach ═══════════════════════════════ */

/**
 * Which published periods answer for this place at this instant.
 *
 * Matched on the period's OWN `department_id` / `team_id`, not on the opaque `scope_id`: those are
 * real foreign keys, and a hospital-wide period (both null) reaches everywhere by construction
 * rather than by a string comparison somebody has to remember to write.
 */
async function periodsAnswering(
  exec: Db | Tx, q: WhoIsOnQuery, at: Date, teamDepartmentId?: string,
): Promise<{ id: string; coversPositions: string[] }[]> {
  /**
   * **A DEPARTMENT'S ROSTER ANSWERS A QUESTION ABOUT A TEAM INSIDE IT**, and the first version of
   * this did not — it matched a team question only against periods whose own `team_id` was that
   * team, so a department-pooled night published at department scope came back `static` for every
   * unit in the department. That is the S4 shape failing in the one place S4 is about: the pooled
   * night exists precisely so that no unit publishes it.
   */
  const reach = [
    and(isNull(rosterPeriods.departmentId), isNull(rosterPeriods.teamId)), // hospital-wide
    q.departmentId === undefined ? undefined : eq(rosterPeriods.departmentId, q.departmentId),
    q.teamId === undefined ? undefined : eq(rosterPeriods.teamId, q.teamId),
    teamDepartmentId === undefined ? undefined : and(
      eq(rosterPeriods.departmentId, teamDepartmentId), isNull(rosterPeriods.teamId),
    ),
  ].filter((c) => c !== undefined);

  return (exec as Db)
    .select({ id: rosterPeriods.id, coversPositions: rosterPeriods.coversPositions })
    .from(rosterPeriods)
    .where(and(
      eq(rosterPeriods.status, "published"),
      lte(rosterPeriods.startsAt, at),
      gt(rosterPeriods.endsAt, at),
      or(...reach),
    ));
}

/**
 * Does this slot's cover reach the place being asked about?
 *
 * The stress test's S4 finding in one function: the owner's night rule is only feasible if nights
 * are POOLED at department level, so a slot must be able to say *"I cover this whole department"*
 * and be found by a question about any team inside it. A slot that covers only its team must NOT
 * be found by a question about another.
 */
function reaches(a: AssignmentRow, q: WhoIsOnQuery, teamDepartmentId: string | undefined): boolean {
  if (a.coverScope === "hospital") return true;
  if (q.teamId !== undefined) {
    if (a.teamId === q.teamId) return true;
    return a.coverScope === "department" && teamDepartmentId !== undefined && a.departmentId === teamDepartmentId;
  }
  if (q.departmentId !== undefined) return a.departmentId === q.departmentId;
  if (q.locationId !== undefined) {
    return a.locationResourceId === q.locationId || a.coverScope === "location";
  }
  return true;
}

/* ═══════════════════════════════ whoIsOn ═══════════════════════════════ */

export async function whoIsOn(
  exec: Db | Tx, q: WhoIsOnQuery, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<WhoIsOnAnswer> {
  if (!resolverEnabled(env)) return staticAnswer(exec, q.position);

  // Resolved FIRST, because it decides which periods answer at all — not only which slots reach.
  const teamDepartmentId = q.teamId === undefined
    ? undefined
    : (await (exec as Db).select({ departmentId: rosterTeams.departmentId })
      .from(rosterTeams).where(eq(rosterTeams.id, q.teamId)))[0]?.departmentId;

  const periods = await periodsAnswering(exec, q, at, teamDepartmentId);
  const declaring = periods.filter((p) => p.coversPositions.includes(q.position));
  if (declaring.length === 0) {
    // V14's other half: a roster that does not answer for this position must not be read as
    // "nobody is on". The difference between "declared and empty" and "not this roster's business"
    // is the difference between a silent hole and normal operation.
    const answer = await staticAnswer(exec, q.position);
    const declared = [...new Set(periods.flatMap((p) => p.coversPositions))].sort();
    return declared.length === 0 ? answer : { ...answer, declared };
  }

  const slots = await (exec as Db).select().from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true),
    eq(rosterAssignments.positionKey, q.position),
    ne(rosterAssignments.kind, "off"),
    inArray(rosterAssignments.periodId, declaring.map((p) => p.id)),
    gte(rosterAssignments.startsAt, lookBackFrom(at)),
    lte(rosterAssignments.startsAt, at),
    gt(rosterAssignments.endsAt, at),
  ));

  const named = slots.filter((a) => a.userId !== null && reaches(a, q, teamDepartmentId));
  const userIds = await subtract(exec, named, at);
  return { userIds, source: "published" };
}

/**
 * ═══ V13 — SLOTS MINUS ABSENCE, MINUS PEOPLE WHO HAVE LEFT, MINUS CLOSED MEMBERSHIPS ═══
 *
 * A published roster is a plan made weeks ago, and three things overtake it between then and
 * 03:10. Each is subtracted here rather than by the caller, because a caller that forgets one is a
 * caller that rings a phone belonging to somebody on maternity leave.
 *
 * **The closed-membership rule is the subtle one.** A junior resident rostered into Unit I's
 * October who rotated out on the 10th is no longer that unit's, and a slot naming them after the
 * 10th is stale. It is subtracted only where the slot names a TEAM — a department-pooled night
 * belongs to the department, not to whichever team the person sits in — and it is deliberately not
 * a refusal: the roster still says what it said, and R8's validator is what raises the hole.
 */
async function subtract(exec: Db | Tx, slots: readonly AssignmentRow[], at: Date): Promise<string[]> {
  if (slots.length === 0) return [];
  const candidateIds = [...new Set(slots.map((a) => a.userId!))];

  const active = await (exec as Db).select({ id: users.id })
    .from(users).where(and(inArray(users.id, candidateIds), eq(users.active, true)));
  const activeIds = new Set(active.map((u) => u.id));

  const away = new Set(await absentUserIds(exec, at, new Date(at.getTime() + 1)));

  const teamIds = [...new Set(slots.map((a) => a.teamId).filter((t): t is string => t !== null))];
  const membersByTeam = new Map<string, Set<string>>();
  for (const teamId of teamIds) {
    membersByTeam.set(teamId, new Set((await teamMembers(exec, teamId, at)).map((m) => m.userId)));
  }

  const out = new Set<string>();
  for (const a of slots) {
    const userId = a.userId!;
    if (!activeIds.has(userId) || away.has(userId)) continue;
    if (a.teamId !== null && !(membersByTeam.get(a.teamId)?.has(userId) ?? false)) continue;
    out.add(userId);
  }
  return [...out].sort();
}

/* ═══════════════════════════════ the other questions ═══════════════════════════════ */

/** Everybody physically at this ward, theatre or room at this instant, whatever they answer as. */
export async function whoIsAt(
  exec: Db | Tx, locationId: string, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<WhoIsOnAnswer> {
  if (!resolverEnabled(env)) return { userIds: [], source: "static" };
  const slots = await (exec as Db).select().from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true),
    eq(rosterAssignments.locationResourceId, locationId),
    eq(rosterAssignments.mode, "presence"),
    ne(rosterAssignments.kind, "off"),
    gte(rosterAssignments.startsAt, lookBackFrom(at)),
    lte(rosterAssignments.startsAt, at),
    gt(rosterAssignments.endsAt, at),
  ));
  return { userIds: await subtract(exec, slots.filter((a) => a.userId !== null), at), source: "published" };
}

export interface Duty {
  assignmentId: string;
  positionKey: string;
  startsAt: Date;
  endsAt: Date;
  mode: string | null;
  kind: string;
  departmentId: string;
  teamId: string | null;
  locationResourceId: string | null;
}

/** One person's own duties across a window — what "My duties" renders, and nobody else's. */
export async function dutiesOf(exec: Db | Tx, userId: string, from: Date, to: Date): Promise<Duty[]> {
  if (to <= from) {
    throw new RosterError("invalid_window", "a stretch of duty cannot end before it begins", {
      from: from.toISOString(), to: to.toISOString(),
    });
  }
  const rows = await (exec as Db).select().from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true),
    eq(rosterAssignments.userId, userId),
    gte(rosterAssignments.startsAt, lookBackFrom(from)),
    lt(rosterAssignments.startsAt, to),
    gt(rosterAssignments.endsAt, from),
  )).orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));

  return rows.map((a) => ({
    assignmentId: a.id, positionKey: a.positionKey, startsAt: a.startsAt, endsAt: a.endsAt,
    mode: a.mode, kind: a.kind, departmentId: a.departmentId, teamId: a.teamId,
    locationResourceId: a.locationResourceId,
  }));
}

export interface CallRung {
  userId: string | null;
  positionKey: string;
  callTier: number | null;
  ladderRank: number;
}

/**
 * ═══ WHO TO RING, IN ORDER ═══
 *
 * `call_tier` first, because it is the roster's own explicit statement of "first on call"; then the
 * position's `ladder_rank`, so a department that never sets a tier still gets the intern before the
 * professor rather than an arbitrary order. A VACANT rung is returned with `userId: null` and is not
 * skipped — the ladder phase needs to be able to say *"the first rung is empty"* rather than
 * silently ringing the second, which is how a hole becomes invisible.
 */
export async function calloutList(
  exec: Db | Tx, departmentId: string, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<CallRung[]> {
  if (!resolverEnabled(env)) return [];
  const rows = await (exec as Db)
    .select({ a: rosterAssignments, ladderRank: rosterPositions.ladderRank })
    .from(rosterAssignments)
    .innerJoin(rosterPositions, eq(rosterPositions.key, rosterAssignments.positionKey))
    .where(and(
      eq(rosterAssignments.effective, true),
      ne(rosterAssignments.kind, "off"),
      or(eq(rosterAssignments.departmentId, departmentId), eq(rosterAssignments.coverScope, "hospital")),
      gte(rosterAssignments.startsAt, lookBackFrom(at)),
      lte(rosterAssignments.startsAt, at),
      gt(rosterAssignments.endsAt, at),
    ));

  const live = new Set(await subtract(exec, rows.map((r) => r.a).filter((a) => a.userId !== null), at));
  return rows
    .filter((r) => r.a.userId === null || live.has(r.a.userId))
    .map((r) => ({
      userId: r.a.userId, positionKey: r.a.positionKey, callTier: r.a.callTier, ladderRank: r.ladderRank,
    }))
    .sort((x, y) =>
      (x.callTier ?? 99) - (y.callTier ?? 99)
      || x.ladderRank - y.ladderRank
      || x.positionKey.localeCompare(y.positionKey));
}

export interface OnDutyNow {
  departmentId: string;
  source: RosterAnswerSource;
  positions: { positionKey: string; userIds: string[] }[];
}

/**
 * The board's own read. **`source` is the point**: a screen must be able to say *"UNPUBLISHED —
 * pattern"* rather than showing an empty department as though it were a staffed one that happens to
 * have nobody on. An empty published department and an unpublished department look identical in
 * every rendering that does not carry this field, and they mean opposite things.
 */
export async function onDutyNow(
  exec: Db | Tx, departmentId: string, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<OnDutyNow> {
  const periods = await periodsAnswering(exec, { position: "", departmentId }, at);
  const declared = [...new Set(periods.flatMap((p) => p.coversPositions))].sort();
  const source: RosterAnswerSource = !resolverEnabled(env) || declared.length === 0 ? "static" : "published";

  const positions: { positionKey: string; userIds: string[] }[] = [];
  for (const positionKey of declared) {
    const answer = await whoIsOn(exec, { position: positionKey, departmentId }, at, env);
    positions.push({ positionKey, userIds: answer.userIds });
  }
  return { departmentId, source, positions };
}

export { teamMembers } from "./teams";
export { asKnownAt } from "./periods";
