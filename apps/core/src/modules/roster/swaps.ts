import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  rosterAssignments, rosterCoverRequests, rosterPeriods, rosterPositions, rosterTeams,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { amend } from "./periods";
import { absentUserIds } from "./absences";
import { simulate } from "./simulate";
import { listTeams, teamMembers } from "./teams";
import { addMembership } from "./memberships";
import { istDateOfInstant } from "./calendar";
import { rosterCoverAnswered, rosterCoverDecided, rosterCoverRequested } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterAssignmentRow, RosterPeriodRow } from "./periods";
import type { HypotheticalRoster, RosterFinding } from "./validator";
import type { SimulateDelta } from "./simulate";
import type { TeamMember } from "./teams";
import type {
  RosterAssignmentKind, RosterAssignmentMode, RosterCoverKind, RosterCoverScope, RosterCoverStatus,
  RosterGrade, RosterOffKind,
} from "../../kernel/db/schema/roster";

/**
 * ═══ 20-U U6 — SWAPS AND COVERS: "I CAN'T DO THIS" TO AN APPROVED AMENDMENT ═══
 *
 * The resident's phone (board `docs/design/2026-09-20-roster/MyDuties.dc.html`) asks one question —
 * *who could take my Saturday night?* — and this file answers it, then carries the answer through
 * the three people a change of duty needs (brainstorm §C "Swaps and covers"):
 *
 *   1. **the owner asks** (`requestCover`) — for their OWN duty (`request_cover`, a reader's act), or
 *      the unit's SR asks for somebody (`propose`). The validator has already been asked about the
 *      person named; a must-fix rule refuses the request in a sentence (`cover_breaks_rule`).
 *   2. **the person asked says yes or no** (`answerCover`) — nobody else can say it for them.
 *   3. **somebody who answers for the unit approves** (`decideCover`) — never one of the two people,
 *      and, when they belong to DIFFERENT units, somebody who answers for the department (the HOD):
 *      `approve_swap` asked WITHOUT the unit, so a unit head's team-scoped delegation does not reach.
 *      **The validator runs again at that moment, over both people's adjoining days** (E10 — the
 *      swap that makes the ACCEPTOR break the rest rule two days later), and a must-fix refuses it,
 *      naming the rule. Otherwise the change is applied as an AMENDMENT through `amend` — row by
 *      row, the old slot superseded and the new one carrying its lineage, `after_the_fact` when the
 *      duty had already begun — and never by writing a roster table here.
 *
 * **The duty stays the owner's until step 3.** Nothing before it is read by the resolver, the board
 * or the ladder: a request is a row in `roster_cover_requests`, not a change to anybody's night.
 *
 * ═══ WHO COULD TAKE IT, AND WHY EVERYBODY ELSE CANNOT ═══
 *
 * The pool is everybody posted to a unit of the duty's department in the same POSITION (a ward JR's
 * night goes to a ward JR), owner excepted. Each is judged by R8's `simulate` over a hypothetical
 * that holds the duty's month PLUS every live duty the pool has elsewhere in the eight days either
 * side — a JR of Unit I is not free on Saturday just because Unit II's month does not mention him.
 * The answer per person is the rule that stops them (`unavailable` for approved leave, never its
 * kind — D6/A-4), and the screen says it as a sentence.
 *
 * One rule is set aside for a person from ANOTHER unit: `member_not_in_unit`. It warns that the
 * resolver will not count somebody rostered on a unit they are not posted to — which is true of a
 * cross-unit cover as written, and is exactly what approval fixes: it adds a FLOAT membership for
 * the window of the duty (register I12, "the second unit borrows by a cover, which the validator
 * sees"), so the resolver counts them.
 */

const DAY_MS = 86_400_000;
/** How far either side of the duty the validator is shown — rest, one-in-three and the week. */
const NEIGHBOURHOOD_MS = 8 * DAY_MS;
/** A swap is offered for duties of theirs within a week of mine. */
const SWAP_WINDOW_MS = 7 * DAY_MS;
const SWAP_OFFERS_PER_PERSON = 3;
const NOTE_MAX = 280;

export type CoverRequestRow = typeof rosterCoverRequests.$inferSelect;

/** A duty as the screens name it. */
export type DutyRef = {
  assignmentId: string; userId: string | null; positionKey: string; positionLabel: string;
  startsAt: Date; endsAt: Date; istDate: string; night: boolean; mode: string | null; kind: string;
  departmentId: string; teamId: string | null; teamName: string | null;
};

/** One person who cannot take the duty, and the rule that says so. */
export type CoverReason = { ruleKey: string; severity: "block" | "warn" | "unavailable"; params: Record<string, unknown> };

export type CoverCandidate = {
  userId: string; name: string; grade: string; teamId: string; teamName: string;
  /** They belong to another unit — the HOD approves as well. */
  crossUnit: boolean;
  /** What they have the IST day after the duty starts: a duty, or nothing ("off Sunday"). */
  nextDay: { istDate: string; duty: null | { night: boolean; positionKey: string } };
  /** Duties of theirs, near mine, they could give me in exchange — each already checked both ways. */
  swaps: DutyRef[];
};
export type CoverRefusal = {
  userId: string; name: string; grade: string; teamId: string; teamName: string;
  reason: CoverReason;
  /** Their nearest duty to mine, so "Has Sunday night" can be said. Null when they have none near. */
  near: null | { istDate: string; night: boolean };
};
export type CoverOptions = {
  duty: DutyRef;
  ownerName: string;
  canTake: CoverCandidate[];
  cannot: CoverRefusal[];
  /** A request already open for this duty, if any — a second cannot be made. */
  openRequestId: string | null;
};

/* ═══════════════════════════════ reading a duty ═══════════════════════════════ */

async function dbNow(exec: Db | Tx): Promise<Date> {
  const r = await (exec as Db).execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

/** A live duty on a PUBLISHED roster, held by somebody. A draft is edited, not swapped. */
async function publishedDuty(exec: Db | Tx, assignmentId: string): Promise<{ row: RosterAssignmentRow; period: RosterPeriodRow }> {
  const row = (await (exec as Db).select().from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId)))[0];
  if (row === undefined) throw new RosterError("unknown_assignment", undefined, { assignmentId });
  const period = (await (exec as Db).select().from(rosterPeriods).where(eq(rosterPeriods.id, row.periodId)))[0]!;
  if (period.status !== "published") {
    throw new RosterError("period_not_published", "this roster is still a draft — its duties are changed on the grid, not by a swap", { periodId: period.id, status: period.status });
  }
  if (row.liveTo !== null || !row.effective) throw new RosterError("unknown_assignment", undefined, { assignmentId });
  if (row.userId === null || row.kind === "off") {
    throw new RosterError("unknown_assignment", "nobody holds that duty, so there is nothing to hand over — fill it on the roster instead", { assignmentId });
  }
  return { row, period };
}

async function labels(exec: Db | Tx): Promise<Map<string, string>> {
  return new Map((await (exec as Db).select({ key: rosterPositions.key, label: rosterPositions.label }).from(rosterPositions)).map((p) => [p.key, p.label]));
}

async function teamNames(exec: Db | Tx): Promise<Map<string, string>> {
  return new Map((await (exec as Db).select({ id: rosterTeams.id, name: rosterTeams.name }).from(rosterTeams)).map((t) => [t.id, t.name]));
}

async function namesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids)];
  if (want.length === 0) return new Map();
  return new Map((await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, want))).map((u) => [u.id, u.fullName]));
}

const isNight = (a: { startsAt: Date; endsAt: Date }): boolean => istDateOfInstant(a.endsAt) !== istDateOfInstant(a.startsAt);

function dutyRef(a: RosterAssignmentRow, positions: Map<string, string>, teams: Map<string, string>): DutyRef {
  return {
    assignmentId: a.id, userId: a.userId, positionKey: a.positionKey, positionLabel: positions.get(a.positionKey) ?? a.positionKey,
    startsAt: a.startsAt, endsAt: a.endsAt, istDate: istDateOfInstant(a.startsAt), night: isNight(a), mode: a.mode, kind: a.kind,
    departmentId: a.departmentId, teamId: a.teamId, teamName: a.teamId === null ? null : (teams.get(a.teamId) ?? null),
  };
}

/**
 * The asker's act: their OWN duty is `request_cover` (any reader); somebody else's is `propose`
 * (the unit's SR, `roster.periods.manage`) — the R4 shape `requestAbsence` has.
 */
async function requireAsker(exec: Db | Tx, actor: Actor, row: RosterAssignmentRow): Promise<void> {
  const own = actor.type === "user" && actor.id === row.userId;
  await requireRosterAct(exec, actor, own ? "request_cover" : "propose", { departmentId: row.departmentId });
}

/* ═══════════════════════════════ the validator, over both people ═══════════════════════════════ */

type PoolMember = TeamMember & { teamId: string };

/** Everybody posted to a unit of the duty's department in the duty's own position, owner excepted. */
async function poolFor(exec: Db | Tx, row: RosterAssignmentRow): Promise<PoolMember[]> {
  const out: PoolMember[] = [];
  for (const team of await listTeams(exec, { departmentId: row.departmentId, kind: "clinical_unit" })) {
    if (team.validTo !== null && team.validTo <= row.startsAt) continue;
    for (const m of await teamMembers(exec, team.id, row.startsAt)) {
      if (m.officiating || m.userId === row.userId || m.positionKey !== row.positionKey) continue;
      if (out.some((x) => x.userId === m.userId)) continue;
      out.push({ ...m, teamId: team.id });
    }
  }
  return out.sort((a, b) => (a.userId < b.userId ? -1 : 1));
}

/**
 * THE HYPOTHETICAL THE VALIDATOR IS SHOWN: the duty's month as it is live now, plus every live duty
 * the named people hold on any OTHER roster within eight days of it. Without the second half a JR
 * of another unit always looks free — their own month is somewhere else.
 */
async function neighbourhood(
  exec: Db | Tx, period: RosterPeriodRow, around: { startsAt: Date; endsAt: Date }, userIds: readonly string[],
): Promise<HypotheticalRoster> {
  const own = (await (exec as Db).select().from(rosterAssignments)
    .where(and(eq(rosterAssignments.periodId, period.id), isNull(rosterAssignments.liveTo))));
  const from = new Date(around.startsAt.getTime() - NEIGHBOURHOOD_MS);
  const to = new Date(around.endsAt.getTime() + NEIGHBOURHOOD_MS);
  const elsewhere = userIds.length === 0 ? [] : await (exec as Db).select().from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true), inArray(rosterAssignments.userId, [...userIds]),
    ne(rosterAssignments.periodId, period.id), lt(rosterAssignments.startsAt, to), gt(rosterAssignments.endsAt, from),
  ));
  return { period, assignments: [...own, ...elsewhere] };
}

const fKey = (f: RosterFinding): string => `${f.ruleKey}|${f.userId ?? ""}|${f.assignmentId ?? ""}`;

/**
 * What the change would newly break, for the named people only. `simulate` with no target is
 * `validate` over the deltas — R8's own what-if, and nothing written. `member_not_in_unit` is set
 * aside for people from another unit (see the header: approval posts them as a float).
 */
async function consequences(
  exec: Db | Tx, base: HypotheticalRoster, deltas: readonly SimulateDelta[], people: readonly string[],
  borrowed: ReadonlySet<string>, baseline?: readonly RosterFinding[],
): Promise<RosterFinding[]> {
  const before = baseline ?? (await simulate(exec, base)).findings;
  const had = new Set(before.map(fKey));
  const after = (await simulate(exec, base, deltas)).findings;
  return after.filter((f) => f.userId !== null && people.includes(f.userId) && !had.has(fKey(f))
    && !(f.ruleKey === "member_not_in_unit" && borrowed.has(f.userId)));
}

/** The first reason, worst first: away, then a must-fix, then a warning. Null when nothing stops it. */
async function reasonAgainst(
  exec: Db | Tx, base: HypotheticalRoster, deltas: readonly SimulateDelta[], people: readonly string[],
  windows: readonly { userId: string; startsAt: Date; endsAt: Date }[], borrowed: ReadonlySet<string>,
  baseline?: readonly RosterFinding[],
): Promise<CoverReason | null> {
  for (const w of windows) {
    // Approved leave, said as `unavailable` and nothing more (simulate's own flattening, D6).
    if ((await absentUserIds(exec, w.startsAt, w.endsAt)).includes(w.userId)) {
      return { ruleKey: "unavailable", severity: "unavailable", params: { userId: w.userId } };
    }
  }
  const found = await consequences(exec, base, deltas, people, borrowed, baseline);
  const worst = found.find((f) => f.severity === "block") ?? found.find((f) => f.severity === "warn");
  return worst === undefined ? null : { ruleKey: worst.ruleKey, severity: worst.severity as "block" | "warn", params: { ...worst.params, userId: worst.userId } };
}

/* ═══════════════════════════════ who could take it ═══════════════════════════════ */

/**
 * "I CAN'T DO THIS" — who can take the duty without breaking a rule, and for everybody else, why
 * not. A READ, guarded as the request would be (your own duty, or `propose`).
 */
export async function coverOptions(exec: Db | Tx, actor: Actor, assignmentId: string): Promise<CoverOptions> {
  const { row, period } = await publishedDuty(exec, assignmentId);
  await requireAsker(exec, actor, row);
  const positions = await labels(exec);
  const teams = await teamNames(exec);
  const pool = await poolFor(exec, row);
  const base = await neighbourhood(exec, period, row, [row.userId!, ...pool.map((p) => p.userId)]);
  const baseline = (await simulate(exec, base)).findings;
  const names = await namesOf(exec, [row.userId!, ...pool.map((p) => p.userId)]);
  const borrowed = new Set(pool.filter((p) => p.teamId !== row.teamId).map((p) => p.userId));
  const nextDay = istDateOfInstant(new Date(row.startsAt.getTime() + DAY_MS));

  const canTake: CoverCandidate[] = [];
  const cannot: CoverRefusal[] = [];
  for (const p of pool) {
    const theirs = base.assignments.filter((a) => a.userId === p.userId && a.liveTo === null && a.kind !== "off");
    const reason = await reasonAgainst(
      exec, base, [{ kind: "fill", assignmentId: row.id, userId: p.userId }], [p.userId],
      [{ userId: p.userId, startsAt: row.startsAt, endsAt: row.endsAt }], borrowed, baseline,
    );
    const person = { userId: p.userId, name: names.get(p.userId) ?? p.userId, grade: p.grade, teamId: p.teamId, teamName: teams.get(p.teamId) ?? "" };
    if (reason !== null) {
      const near = [...theirs].sort((a, b) => Math.abs(a.startsAt.getTime() - row.startsAt.getTime()) - Math.abs(b.startsAt.getTime() - row.startsAt.getTime()))[0];
      cannot.push({
        ...person, reason,
        near: near === undefined || Math.abs(near.startsAt.getTime() - row.startsAt.getTime()) > 3 * DAY_MS
          ? null : { istDate: istDateOfInstant(near.startsAt), night: isNight(near) },
      });
      continue;
    }
    // A swap: one of theirs, near mine, in my position, that I could take in exchange.
    const swaps: DutyRef[] = [];
    const offers = theirs.filter((a) => a.positionKey === row.positionKey && a.kind === row.kind
      && Math.abs(a.startsAt.getTime() - row.startsAt.getTime()) <= SWAP_WINDOW_MS
      && a.endsAt.getTime() > Date.now()
      && (a.endsAt <= row.startsAt || a.startsAt >= row.endsAt));
    for (const a of offers.sort((x, y) => Math.abs(x.startsAt.getTime() - row.startsAt.getTime()) - Math.abs(y.startsAt.getTime() - row.startsAt.getTime()))) {
      if (swaps.length >= SWAP_OFFERS_PER_PERSON) break;
      const both = await reasonAgainst(
        exec, base,
        [{ kind: "fill", assignmentId: row.id, userId: p.userId }, { kind: "fill", assignmentId: a.id, userId: row.userId }],
        [p.userId, row.userId!], [{ userId: row.userId!, startsAt: a.startsAt, endsAt: a.endsAt }],
        new Set([...borrowed, ...(a.teamId !== row.teamId ? [row.userId!] : [])]), baseline,
      );
      if (both === null) swaps.push(dutyRef(a, positions, teams));
    }
    const next = theirs.find((a) => istDateOfInstant(a.startsAt) === nextDay);
    canTake.push({
      ...person, crossUnit: p.teamId !== row.teamId,
      nextDay: { istDate: nextDay, duty: next === undefined ? null : { night: isNight(next), positionKey: next.positionKey } },
      swaps,
    });
  }

  const open = (await (exec as Db).select({ id: rosterCoverRequests.id }).from(rosterCoverRequests).where(and(
    eq(rosterCoverRequests.assignmentId, row.id), inArray(rosterCoverRequests.status, ["asked", "accepted"]),
  )))[0];
  return {
    duty: dutyRef(row, positions, teams), ownerName: names.get(row.userId!) ?? row.userId!,
    canTake: canTake.sort((a, b) => Number(a.crossUnit) - Number(b.crossUnit) || a.name.localeCompare(b.name)),
    cannot: cannot.sort((a, b) => a.name.localeCompare(b.name)),
    openRequestId: open?.id ?? null,
  };
}

/* ═══════════════════════════════ the three steps ═══════════════════════════════ */

export interface RequestCoverInput {
  assignmentId: string;
  counterpartId: string;
  /** A SWAP: the counterpart's duty the owner takes in exchange. Omitted: a cover. */
  counterpartAssignmentId?: string;
  note?: string | null;
}

/** The check both the request and the approval run: everything the change newly breaks, for both. */
async function checkChange(
  exec: Db | Tx, row: RosterAssignmentRow, period: RosterPeriodRow, counterpartId: string,
  give: RosterAssignmentRow | null, counterpartTeamId: string | null,
): Promise<CoverReason | null> {
  const ownerId = row.userId!;
  const near = await neighbourhood(exec, period, give === null ? row : {
    startsAt: row.startsAt < give.startsAt ? row.startsAt : give.startsAt,
    endsAt: row.endsAt > give.endsAt ? row.endsAt : give.endsAt,
  }, [ownerId, counterpartId]);
  const base: HypotheticalRoster = give !== null && !near.assignments.some((a) => a.id === give.id)
    ? { period: near.period, assignments: [...near.assignments, give] } : near;
  const deltas: SimulateDelta[] = [{ kind: "fill", assignmentId: row.id, userId: counterpartId }];
  const windows = [{ userId: counterpartId, startsAt: row.startsAt, endsAt: row.endsAt }];
  const borrowed = new Set<string>();
  if (counterpartTeamId !== row.teamId) borrowed.add(counterpartId);
  if (give !== null) {
    deltas.push({ kind: "fill", assignmentId: give.id, userId: ownerId });
    windows.push({ userId: ownerId, startsAt: give.startsAt, endsAt: give.endsAt });
    if (give.teamId !== row.teamId) borrowed.add(ownerId);
  }
  return reasonAgainst(exec, base, deltas, [ownerId, counterpartId], windows, borrowed);
}

async function parentTeamAt(exec: Db | Tx, userId: string, departmentId: string, at: Date): Promise<string | null> {
  for (const team of await listTeams(exec, { departmentId, kind: "clinical_unit" })) {
    const m = (await teamMembers(exec, team.id, at)).find((x) => x.userId === userId && !x.officiating);
    if (m !== undefined) return team.id;
  }
  return null;
}

/**
 * STEP 1 — ASK. The validator is asked about the person named NOW, so a request nobody could ever
 * approve is refused in a sentence rather than left waiting for a yes.
 */
export async function requestCover(tx: Tx, actor: Actor, input: RequestCoverInput): Promise<{ requestId: string }> {
  const { row, period } = await publishedDuty(tx, input.assignmentId);
  await requireAsker(tx, actor, row);
  if (input.counterpartId === row.userId) {
    throw new RosterError("invalid_window", "a duty cannot be handed to the person who already holds it", { assignmentId: row.id });
  }
  const counterpart = (await (tx as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.counterpartId)))[0];
  if (counterpart === undefined || !counterpart.active) throw new RosterError("unknown_user", undefined, { userId: input.counterpartId });
  const note = input.note == null ? null : input.note.trim() === "" ? null : input.note.trim();
  if (note !== null && note.length > NOTE_MAX) {
    throw new RosterError("invalid_window", `a note to the person asked is ${String(NOTE_MAX)} characters or fewer`, { noteLength: note.length });
  }

  let give: RosterAssignmentRow | null = null;
  if (input.counterpartAssignmentId !== undefined) {
    give = (await publishedDuty(tx, input.counterpartAssignmentId)).row;
    if (give.userId !== input.counterpartId) {
      throw new RosterError("unknown_assignment", "that duty is not the person's you asked — a swap gives back one of THEIR duties", { assignmentId: give.id });
    }
    if (give.positionKey !== row.positionKey) {
      throw new RosterError("position_ineligible", "a swap exchanges duties of the same post — a ward night for a ward night", { assignmentId: give.id });
    }
  }

  const open = (await (tx as Db).select({ id: rosterCoverRequests.id }).from(rosterCoverRequests).where(and(
    inArray(rosterCoverRequests.assignmentId, give === null ? [row.id] : [row.id, give.id]),
    inArray(rosterCoverRequests.status, ["asked", "accepted"]),
  )))[0];
  if (open !== undefined) throw new RosterError("cover_already_asked", undefined, { requestId: open.id });

  const counterpartTeamId = give?.teamId ?? await parentTeamAt(tx, input.counterpartId, row.departmentId, row.startsAt);
  const reason = await checkChange(tx, row, period, input.counterpartId, give, counterpartTeamId);
  if (reason !== null && reason.severity !== "warn") {
    throw new RosterError("cover_breaks_rule", undefined, { ruleKey: reason.ruleKey, userId: reason.params.userId ?? null, params: reason.params });
  }

  const requestId = newId();
  const now = await dbNow(tx);
  const crossUnit = counterpartTeamId !== row.teamId;
  await tx.insert(rosterCoverRequests).values({
    id: requestId, kind: give === null ? "cover" : "swap", status: "asked",
    assignmentId: row.id, periodId: period.id, ownerId: row.userId!, requestedBy: actor.id,
    counterpartId: input.counterpartId, counterpartAssignmentId: give?.id ?? null,
    departmentId: row.departmentId, teamId: row.teamId, counterpartTeamId, crossUnit, note,
    requestedAt: now, createdBy: actor.id, updatedBy: actor.id,
  });
  await appendEvent(tx, rosterCoverRequested.make({
    payload: {
      requestId, kind: give === null ? "cover" : "swap", assignmentId: row.id, ownerId: row.userId!,
      counterpartId: input.counterpartId, counterpartAssignmentId: give?.id ?? null, crossUnit, requestedAt: now.toISOString(),
    },
    actor, correlationId: requestId,
  }));
  return { requestId };
}

async function lockRequest(tx: Tx, requestId: string): Promise<CoverRequestRow> {
  const r = (await (tx as Db).select().from(rosterCoverRequests).where(eq(rosterCoverRequests.id, requestId)).for("update"))[0];
  if (r === undefined) throw new RosterError("unknown_cover_request", undefined, { requestId });
  return r;
}

/** STEP 2 — THE PERSON ASKED says yes or no. Only they can, and only while it is still asked. */
export async function answerCover(tx: Tx, actor: Actor, requestId: string, accept: boolean): Promise<void> {
  const r = await lockRequest(tx, requestId);
  await requireRosterAct(tx, actor, "request_cover", { departmentId: r.departmentId });
  if (actor.id !== r.counterpartId) throw new RosterError("cover_not_counterpart", undefined, { requestId });
  if (r.status !== "asked") throw new RosterError("cover_not_open", undefined, { requestId, status: r.status });
  const now = await dbNow(tx);
  const status: RosterCoverStatus = accept ? "accepted" : "declined";
  await tx.update(rosterCoverRequests).set({ status, answeredAt: now, updatedBy: actor.id, updatedAt: now })
    .where(eq(rosterCoverRequests.id, requestId));
  await appendEvent(tx, rosterCoverAnswered.make({
    payload: { requestId, counterpartId: r.counterpartId, answer: accept ? "accepted" : "declined", answeredAt: now.toISOString() },
    actor, correlationId: requestId,
  }));
}

/** The owner (or whoever asked) takes it back, before it is decided. */
export async function withdrawCover(tx: Tx, actor: Actor, requestId: string): Promise<void> {
  const r = await lockRequest(tx, requestId);
  const own = actor.id === r.ownerId || actor.id === r.requestedBy;
  await requireRosterAct(tx, actor, own ? "request_cover" : "propose", { departmentId: r.departmentId });
  if (r.status !== "asked" && r.status !== "accepted") throw new RosterError("cover_not_open", undefined, { requestId, status: r.status });
  const now = await dbNow(tx);
  await tx.update(rosterCoverRequests).set({ status: "withdrawn", updatedBy: actor.id, updatedAt: now })
    .where(eq(rosterCoverRequests.id, requestId));
  await appendEvent(tx, rosterCoverDecided.make({
    payload: { requestId, status: "withdrawn", ruleKey: null, amendmentIds: [], decidedAt: now.toISOString() },
    actor, correlationId: requestId,
  }));
}

/** The approver's scope: the unit for a same-unit change; the department (no unit) across units. */
const approvalScope = (r: CoverRequestRow): { departmentId: string; teamId?: string } =>
  r.crossUnit || r.teamId === null ? { departmentId: r.departmentId } : { departmentId: r.departmentId, teamId: r.teamId };

export type CoverDecision = { status: "approved" | "refused"; ruleKey: string | null; amendmentIds: string[] };

/**
 * STEP 3 — APPROVE OR REFUSE. Approval re-runs the validator over both people's adjoining days and
 * refuses a must-fix (recorded, with the rule); otherwise it is applied as an amendment of each
 * period touched, in ONE transaction, and a person from another unit is posted as a float for the
 * window of the duty so the resolver counts them.
 */
export async function decideCover(
  tx: Tx, actor: Actor, requestId: string, input: { approve: boolean; note?: string | null },
): Promise<CoverDecision> {
  const r = await lockRequest(tx, requestId);
  const scope = approvalScope(r);
  await requireRosterAct(tx, actor, "approve_swap", scope);
  // Before anything else about the request: a party to it never decides it, whatever they hold.
  if (actor.id === r.ownerId || actor.id === r.counterpartId || actor.id === r.requestedBy) {
    throw new RosterError("cover_self_approval", undefined, { requestId });
  }
  if (r.status === "asked") throw new RosterError("cover_not_accepted", undefined, { requestId });
  if (r.status !== "accepted") throw new RosterError("cover_not_open", undefined, { requestId, status: r.status });
  const now = await dbNow(tx);
  const note = input.note == null || input.note.trim() === "" ? null : input.note.trim().slice(0, NOTE_MAX);

  const finish = async (status: "approved" | "refused", ruleKey: string | null, amendmentIds: string[]): Promise<CoverDecision> => {
    await tx.update(rosterCoverRequests).set({
      status, decidedBy: actor.id, decidedAt: now, refusedRule: ruleKey, decisionNote: note, amendmentIds,
      updatedBy: actor.id, updatedAt: now,
    }).where(eq(rosterCoverRequests.id, requestId));
    await appendEvent(tx, rosterCoverDecided.make({
      payload: { requestId, status, ruleKey, amendmentIds, decidedAt: now.toISOString() },
      actor, correlationId: requestId,
    }));
    return { status, ruleKey, amendmentIds };
  };

  if (!input.approve) return finish("refused", null, []);

  // The duties must still be live and still the two people's: a month republished, or a slot given
  // to somebody else on the grid since, makes this request about a duty that no longer exists.
  const { row, period } = await publishedDuty(tx, r.assignmentId);
  const giveCtx = r.counterpartAssignmentId === null ? null : await publishedDuty(tx, r.counterpartAssignmentId);
  if (row.userId !== r.ownerId || (giveCtx !== null && giveCtx.row.userId !== r.counterpartId)) {
    throw new RosterError("unknown_assignment", "that duty has changed hands since it was asked about — ask again", { requestId });
  }
  const give = giveCtx?.row ?? null;

  const reason = await checkChange(tx, row, period, r.counterpartId, give, r.counterpartTeamId);
  if (reason !== null && reason.severity !== "warn") return finish("refused", reason.ruleKey, []);

  const kind: RosterCoverKind = give === null ? "cover" : "swap";
  const approvedAs = { act: "approve_swap" as const, ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }) };
  const reasonText = kind === "swap" ? "Swap approved from a request" : "Cover approved from a request";
  const copy = (a: RosterAssignmentRow, userId: string, swapOfId?: string) => ({
    userId, positionKey: a.positionKey, startsAt: a.startsAt, endsAt: a.endsAt,
    departmentId: a.departmentId, teamId: a.teamId, mode: a.mode as RosterAssignmentMode | null,
    kind: a.kind as RosterAssignmentKind, offKind: a.offKind as RosterOffKind | null,
    coverScope: a.coverScope as RosterCoverScope, callTier: a.callTier, supernumerary: a.supernumerary,
    locationResourceId: a.locationResourceId, batchRef: a.batchRef, topic: a.topic, note: a.note,
    source: "manual" as const, replacesAssignmentId: a.id, ...(swapOfId === undefined ? {} : { swapOfId }),
  });

  // A person borrowed from another unit is posted to this one for the window of the duty (I12).
  const borrow = async (a: RosterAssignmentRow, userId: string, theirTeam: string | null): Promise<void> => {
    if (a.teamId === null || theirTeam === a.teamId) return;
    const already = (await teamMembers(tx, a.teamId, a.startsAt)).some((m) => m.userId === userId);
    if (already) return;
    const home = theirTeam === null ? undefined : (await teamMembers(tx, theirTeam, a.startsAt)).find((m) => m.userId === userId);
    await addMembership(tx, actor, {
      teamId: a.teamId, userId, positionKey: a.positionKey, grade: (home?.grade ?? "jr1") as RosterGrade,
      roleInTeam: home?.roleInTeam ?? "junior_resident", kind: "float", startsAt: a.startsAt, endsAt: a.endsAt,
    });
  };
  await borrow(row, r.counterpartId, r.counterpartTeamId);
  if (give !== null) await borrow(give, r.ownerId, r.teamId);

  const amendmentIds: string[] = [];
  const afterTheFact = (a: RosterAssignmentRow): boolean => a.startsAt.getTime() <= now.getTime();
  if (give !== null && give.periodId === row.periodId) {
    const res = await amend(tx, actor, row.periodId, {
      kind, reason: reasonText, requestedBy: r.requestedBy, close: [row.id, give.id],
      open: [copy(row, r.counterpartId, give.id), copy(give, r.ownerId, row.id)],
      afterTheFact: afterTheFact(row) || afterTheFact(give), approvedAs,
    });
    amendmentIds.push(res.amendmentId);
  } else {
    // Two periods (or a cover): the owner's slot first, then the slot given back. A same-night swap
    // across two units would be one body in two rooms between the two and is refused by `amend`.
    const first = await amend(tx, actor, row.periodId, {
      kind, reason: reasonText, requestedBy: r.requestedBy, close: [row.id],
      open: [copy(row, r.counterpartId, give?.id)], afterTheFact: afterTheFact(row), approvedAs,
    });
    amendmentIds.push(first.amendmentId);
    if (give !== null) {
      const second = await amend(tx, actor, give.periodId, {
        kind, reason: reasonText, requestedBy: r.requestedBy, close: [give.id],
        open: [copy(give, r.ownerId, row.id)], afterTheFact: afterTheFact(give),
        approvedAs: { act: "approve_swap", ...(r.crossUnit || give.teamId === null ? {} : { teamId: give.teamId }) },
      });
      amendmentIds.push(second.amendmentId);
    }
  }
  return finish("approved", null, amendmentIds);
}

/* ═══════════════════════════════ reading requests ═══════════════════════════════ */

export type CoverRequestView = {
  requestId: string; kind: RosterCoverKind; status: RosterCoverStatus; crossUnit: boolean;
  owner: { userId: string; name: string }; counterpart: { userId: string; name: string };
  requestedBy: { userId: string; name: string };
  duty: DutyRef; give: DutyRef | null;
  note: string | null; requestedAt: Date; answeredAt: Date | null;
  decidedBy: { userId: string; name: string } | null; decidedAt: Date | null; refusedRule: string | null;
  /** For a request still open: what the validator says about it NOW (null: nothing stops it). */
  check: CoverReason | null;
  youMay: { answer: boolean; approve: boolean; withdraw: boolean };
};

async function mayAct(exec: Db | Tx, actor: Actor, act: "approve_swap" | "propose", scope: { departmentId: string; teamId?: string }): Promise<boolean> {
  try {
    await requireRosterAct(exec, actor, act, scope);
    return true;
  } catch (e) {
    if (e instanceof RosterError) return false;
    throw e;
  }
}

/**
 * The requests a reader may see: their own (as the owner, the asker or the person asked), and every
 * request they could approve. `teamId` narrows to one unit's (either side). Decided requests are kept
 * for seven days, so "Approved" is still on the screen the next morning.
 */
export async function coverRequests(
  exec: Db | Tx, actor: Actor, opts: { teamId?: string; userId?: string } = {},
): Promise<CoverRequestView[]> {
  await requireRosterAct(exec, actor, "read");
  const since = new Date((await dbNow(exec)).getTime() - 7 * DAY_MS);
  const rows = await (exec as Db).select().from(rosterCoverRequests).where(and(
    or(inArray(rosterCoverRequests.status, ["asked", "accepted"]), gt(rosterCoverRequests.updatedAt, since)),
    opts.teamId === undefined ? undefined : or(eq(rosterCoverRequests.teamId, opts.teamId), eq(rosterCoverRequests.counterpartTeamId, opts.teamId)),
    opts.userId === undefined ? undefined : or(eq(rosterCoverRequests.ownerId, opts.userId), eq(rosterCoverRequests.counterpartId, opts.userId), eq(rosterCoverRequests.requestedBy, opts.userId)),
  )).orderBy(desc(rosterCoverRequests.requestedAt));
  if (rows.length === 0) return [];

  const positions = await labels(exec);
  const teams = await teamNames(exec);
  const slotIds = rows.flatMap((r) => (r.counterpartAssignmentId === null ? [r.assignmentId] : [r.assignmentId, r.counterpartAssignmentId]));
  const slots = new Map((await (exec as Db).select().from(rosterAssignments).where(inArray(rosterAssignments.id, slotIds))).map((a) => [a.id, a]));
  const names = await namesOf(exec, rows.flatMap((r) => [r.ownerId, r.counterpartId, r.requestedBy, ...(r.decidedBy === null ? [] : [r.decidedBy])]));
  const person = (id: string) => ({ userId: id, name: names.get(id) ?? id });

  const out: CoverRequestView[] = [];
  for (const r of rows) {
    const party = actor.id === r.ownerId || actor.id === r.counterpartId || actor.id === r.requestedBy;
    const open = r.status === "asked" || r.status === "accepted";
    const approver = !party && open && await mayAct(exec, actor, "approve_swap", approvalScope(r));
    // A decided request of somebody else's is shown only to whoever could have decided it.
    if (!party && !approver && !(await mayAct(exec, actor, "approve_swap", approvalScope(r)))) continue;
    const duty = slots.get(r.assignmentId)!;
    const give = r.counterpartAssignmentId === null ? null : slots.get(r.counterpartAssignmentId)!;
    let check: CoverReason | null = null;
    if (open) {
      const period = (await (exec as Db).select().from(rosterPeriods).where(eq(rosterPeriods.id, duty.periodId)))[0]!;
      if (duty.liveTo === null && (give === null || give.liveTo === null)) {
        check = await checkChange(exec, duty, period, r.counterpartId, give, r.counterpartTeamId);
      }
    }
    out.push({
      requestId: r.id, kind: r.kind as RosterCoverKind, status: r.status as RosterCoverStatus, crossUnit: r.crossUnit,
      owner: person(r.ownerId), counterpart: person(r.counterpartId), requestedBy: person(r.requestedBy),
      duty: dutyRef(duty, positions, teams), give: give === null ? null : dutyRef(give, positions, teams),
      // The note is the parties' and the approver's (it may say why); nobody else reaches this row.
      note: r.note, requestedAt: r.requestedAt, answeredAt: r.answeredAt,
      decidedBy: r.decidedBy === null ? null : person(r.decidedBy), decidedAt: r.decidedAt, refusedRule: r.refusedRule,
      check,
      youMay: {
        answer: r.status === "asked" && actor.id === r.counterpartId,
        approve: r.status === "accepted" && approver,
        withdraw: open && (actor.id === r.ownerId || actor.id === r.requestedBy),
      },
    });
  }
  return out;
}

/* ═══════════════════════════════ my duties ═══════════════════════════════ */

export type MyDuty = DutyRef & {
  /** The unit's activity that day (OPD / theatre / ward …), from the published cycle. */
  activities: string[];
  /** Before it ends — a request can still be made. */
  upcoming: boolean;
};

/** Live duties of ONE person — the reader — from `from` to `to`. A read of your own and nobody else's. */
export async function myDutyRows(exec: Db | Tx, actor: Actor, from: Date, to: Date): Promise<RosterAssignmentRow[]> {
  await requireRosterAct(exec, actor, "read");
  return (exec as Db).select().from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true), eq(rosterAssignments.userId, actor.id),
    lt(rosterAssignments.startsAt, to), gt(rosterAssignments.endsAt, from),
  )).orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));
}

export { dutyRef as toDutyRef, labels as positionLabels, teamNames as rosterTeamNames };
