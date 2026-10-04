import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import {
  rosterAssignments, rosterDutyWindows, rosterHolidays, rosterPeriods, rosterTeamMemberships, rosterTeams, staffAbsences,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "./calendar";
import { listOrgDepartments, listRosterPositions } from "./masters";
import { assign, contentHash, periodWithAssignments, publishPeriod, unassign } from "./periods";
import { fairnessOf, proposalSeedFor, proposalStrategyFor, proposeMonth } from "./proposer";
import { acceptFinding, listFindings, recordFindings } from "./findings";
import { blockingFindings, findingKey, validate } from "./validator";
import { teamMembers } from "./teams";
import { membershipsOf } from "./memberships";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterAct } from "./policy";
import type { FairnessCounters } from "./proposer";
import type { RosterPeriodRow } from "./periods";
import type {
  RosterAssignmentKind, RosterAssignmentMode, RosterCoverScope, RosterOffKind, RosterRuleSeverity,
} from "../../kernel/db/schema/roster";

/**
 * 20-U U5b — **ROSTER: THE UNIT'S MONTH** (design `docs/design/2026-09-20-roster/Main.dc.html`,
 * owner-approved 2026-09-20). The unit's SR and its head open a month the proposer has already
 * drafted, read a *Before you publish* list of what is wrong with it, fix what they can in one tap,
 * and publish.
 *
 * ═══ ONE READ AND FOUR WRITES, AND EVERY WRITE IS A DOMAIN FUNCTION ═══
 *
 * This file composes; it decides nothing of its own. Drafting is `proposeMonth` (the same strategy
 * and seed as the monthly job — `proposalStrategyFor`/`proposalSeedFor`, so the button and the 20th
 * of the month can never draft differently). A slot edit is `unassign` + `assign` in ONE
 * transaction, so the act matrix (`propose` / `edit_human_draft`) and every one of `assign`'s checks
 * judge the new occupant. Accepting is `acceptFinding` (`accept_warning`). Publishing is
 * `publishPeriod`, whose gate (`blocked_by_findings`, V4's content hash, V3's stale base) is the only
 * place a publish is decided. Nothing here writes a roster table.
 *
 * ═══ THE FINDINGS ARE COMPUTED ON READ, THE ACCEPTANCES ARE STORED ═══
 *
 * A finding a screen shows must be the finding the gate will apply, so the read calls `validate()`
 * exactly as `publishPeriods` does and marks `blocking` with the same `blockingFindings` and the
 * same accepted-key set. Stored rows (`recordFindings`, refreshed after every write here) supply only
 * the acceptance — who, when, why — matched by `findingKey`, never by row identity.
 */

export type MonthRef = { teamId: string; month: string };
export type FindingKeyInput = { ruleKey: string; assignmentId: string | null; userId: string | null };

export type RosterUnitsDepartment = {
  departmentId: string; code: string; name: string;
  units: { teamId: string; code: string; name: string; confirmed: boolean }[];
};

export type MonthAssignment = {
  assignmentId: string; userId: string | null; name: string | null; positionKey: string;
  startsAt: Date; endsAt: Date; istDate: string; night: boolean; mode: string | null; kind: string;
};

export type MonthFinding = {
  ruleKey: string; severity: RosterRuleSeverity; userId: string | null; name: string | null;
  assignmentId: string | null; istDate: string | null; params: Record<string, unknown>;
  /** Stops the publish: a `block` nobody has accepted — `blockingFindings`, the gate's own rule. */
  blocking: boolean;
  accepted: null | { byName: string; at: Date; reason: string };
};

export type UnitMonth = {
  unit: { teamId: string; code: string; name: string; confirmed: boolean; departmentId: string; departmentName: string };
  month: string; startsAt: Date; endsAt: Date; days: string[];
  period: null | {
    periodId: string; version: number; status: string; origin: string; title: string;
    /** V4 — the hash of exactly what this read rendered; publish sends it back. */
    contentHash: string; publishedAt: Date | null;
  };
  positions: { key: string; label: string }[];
  /**
   * `postedFrom`/`postedTo` — the IST days this person's posting here starts and ends INSIDE the
   * month (inclusive); null when it began before the 1st or runs past the last day.
   */
  people: { userId: string; name: string; positionKey: string; grade: string; postedFrom: string | null; postedTo: string | null }[];
  assignments: MonthAssignment[];
  findings: MonthFinding[];
  counts: { blocking: number; warnings: number; info: number };
  fairness: (FairnessCounters & { name: string })[];
  /**
   * THE UNIT'S DAY, one per column: what the published cycle has THIS unit doing (its live
   * `roster_duty_windows`, by the IST day a window starts), with `take` split out because the board
   * marks it separately. `overlay` — the day ran the Sunday sequence.
   */
  unitDays: { istDate: string; activities: string[]; take: boolean; overlay: boolean }[];
  /** Holidays declared for days of this month (`roster_holidays`). */
  holidays: { istDate: string; kind: string; pattern: string }[];
  /**
   * APPROVED absences of this month's people, as IST days (inclusive). The kind and never the
   * reason: D6 keeps a leave reason for the approver alone.
   */
  leave: { userId: string; kind: string; from: string; to: string }[];
  /** The reader, for the Doctor Desk header (`rosterSelf`). */
  you: RosterSelf;
  /** What THIS actor may do here, probed through `requireRosterAct`. The server still decides. */
  youMay: {
    draft: boolean; edit: boolean; acceptWarning: boolean; publish: boolean;
    /** 20-U U6 — published, and the reader may ask a cover for anybody's duty here (`propose`). */
    cover: boolean;
  };
};

/**
 * 20-U U5 — **WHO IS READING**, for the Doctor Desk header ("Dr. Pooja Mishra · SR"). No route hands
 * a caller their own full name (`/auth/me` is `{ actor, permissions }`, kernel-owned), so the roster
 * reads carry it: the name from `users`, and — when the reader is posted to a unit now — the grade,
 * the post and the unit from their parent membership (else the first live one). Self only: it is
 * asked with the actor's own id and says nothing about anybody else.
 */
export type RosterSelf = {
  name: string | null; grade: string | null; positionKey: string | null; unitName: string | null; departmentName: string | null;
};
export async function rosterSelf(exec: Db | Tx, actor: Actor, at: Date): Promise<RosterSelf> {
  const none: RosterSelf = { name: null, grade: null, positionKey: null, unitName: null, departmentName: null };
  if (actor.type !== "user") return none;
  const me = (await (exec as Db).select({ fullName: users.fullName }).from(users).where(eq(users.id, actor.id)))[0];
  const m = (await membershipsOf(exec, actor.id, at))[0];
  if (m === undefined) return { ...none, name: me?.fullName ?? null };
  const team = (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.id, m.teamId)))[0];
  const dept = team === undefined ? undefined : (await listOrgDepartments(exec)).find((d) => d.id === team.departmentId);
  return {
    name: me?.fullName ?? null, grade: m.grade, positionKey: m.positionKey,
    unitName: team?.name ?? null, departmentName: dept?.name ?? null,
  };
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** An IST calendar month: the 1st at 00:00 IST to the next 1st, and one column per day. */
export function monthWindow(month: string): { startsAt: Date; endsAt: Date; days: string[] } {
  const m = MONTH_RE.exec(month);
  if (m === null) {
    throw new RosterError("invalid_window", "a month is written YYYY-MM, for example 2026-10", { month });
  }
  const [y, mo] = [Number(m[1]), Number(m[2])];
  const first = `${month}-01`;
  const next = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-01`;
  const days: string[] = [];
  for (let d = first; d < next; d = addIstDays(d, 1)) days.push(d);
  return { startsAt: istMidnightUtc(first), endsAt: istMidnightUtc(next), days };
}

/** The units a roster can be opened for: every department that runs clinical units, with its units. */
export async function rosterUnits(exec: Db | Tx): Promise<RosterUnitsDepartment[]> {
  const teams = (await (exec as Db).select().from(rosterTeams))
    // Unconfirmed units are LISTED and flagged, never hidden: the seed's establishment is ours until
    // a head confirms it (`rosterTeams.active`), and the screen says so rather than presenting it.
    .filter((t) => t.kind === "clinical_unit")
    .sort((a, b) => a.code.localeCompare(b.code));
  const out: RosterUnitsDepartment[] = [];
  for (const d of await listOrgDepartments(exec)) {
    const units = teams.filter((t) => t.departmentId === d.id).map((t) => ({ teamId: t.id, code: t.code, name: t.name, confirmed: t.active }));
    if (units.length > 0) out.push({ departmentId: d.id, code: d.code, name: d.name, units });
  }
  return out;
}

async function teamRow(exec: Db | Tx, teamId: string) {
  const team = (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.id, teamId)))[0];
  if (team === undefined) throw new RosterError("unknown_team", undefined, { teamId });
  return team;
}

/** The month's live version: the newest draft or published period for this unit and month. */
async function currentPeriod(exec: Db | Tx, teamId: string, startsAt: Date): Promise<RosterPeriodRow | undefined> {
  return (await (exec as Db).select().from(rosterPeriods).where(and(
    eq(rosterPeriods.scopeType, "team"), eq(rosterPeriods.scopeId, teamId), eq(rosterPeriods.startsAt, startsAt),
    inArray(rosterPeriods.status, ["draft", "published"]),
  )).orderBy(desc(rosterPeriods.version)).limit(1))[0];
}

/** May this actor do `act` here? A refusal is an answer (false); anything else is a fault. */
async function may(exec: Db | Tx, actor: Actor, act: RosterAct, departmentId: string): Promise<boolean> {
  try {
    await requireRosterAct(exec, actor, act, { departmentId });
    return true;
  } catch (e) {
    if (e instanceof RosterError) return false;
    throw e;
  }
}

const severityRank = { block: 0, warn: 1, info: 2 } as const;

/**
 * THE READ. Guarded by `read` at the unit's department; the write affordances in `youMay` are each
 * probed through the same `requireRosterAct` the write itself will call.
 */
export async function unitMonth(exec: Db | Tx, actor: Actor, teamId: string, month: string): Promise<UnitMonth> {
  const { startsAt, endsAt, days } = monthWindow(month);
  const team = await teamRow(exec, teamId);
  await requireRosterAct(exec, actor, "read", { departmentId: team.departmentId });
  const dept = (await listOrgDepartments(exec)).find((d) => d.id === team.departmentId);

  const period = await currentPeriod(exec, teamId, startsAt);
  const members = await teamMembers(exec, teamId, startsAt);
  // Everybody posted here at any moment of the month — a posting that starts on the 16th is a row too.
  const postings = await (exec as Db).select().from(rosterTeamMemberships).where(and(
    eq(rosterTeamMemberships.teamId, teamId), lt(rosterTeamMemberships.startsAt, endsAt),
    or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, startsAt)),
  )).orderBy(asc(rosterTeamMemberships.startsAt));
  const windows = await (exec as Db).select().from(rosterDutyWindows).where(and(
    eq(rosterDutyWindows.teamId, teamId), isNull(rosterDutyWindows.supersededAt),
    gte(rosterDutyWindows.startsAt, startsAt), lt(rosterDutyWindows.startsAt, endsAt),
  )).orderBy(asc(rosterDutyWindows.startsAt));
  const holidays = await (exec as Db).select().from(rosterHolidays).where(and(
    gte(rosterHolidays.istDate, days[0]!), lt(rosterHolidays.istDate, addIstDays(days[days.length - 1]!, 1)),
  )).orderBy(asc(rosterHolidays.istDate));
  const rows = period === undefined ? [] : (await periodWithAssignments(exec, period.id)).assignments.filter((a) => a.liveTo === null);

  const computed = period === undefined ? [] : await validate(exec, period.id);
  const stored = period === undefined ? [] : await listFindings(exec, period.id);
  const acceptedByKey = new Map(stored.filter((r) => r.acceptedAt !== null).map((r) => [findingKey(r), r]));
  const blockingKeys = new Set(blockingFindings(computed, new Set(acceptedByKey.keys())).map((f) => findingKey(f)));

  const ids = new Set<string>(members.map((m) => m.userId));
  for (const p of postings) ids.add(p.userId);
  for (const a of rows) if (a.userId !== null) ids.add(a.userId);
  for (const f of computed) if (f.userId !== null) ids.add(f.userId);
  for (const r of acceptedByKey.values()) if (r.acceptedBy !== null) ids.add(r.acceptedBy);
  const names = new Map<string, string>();
  if (ids.size > 0) {
    for (const u of await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, [...ids]))) {
      names.set(u.id, u.fullName);
    }
  }
  const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? id));

  const assignments: MonthAssignment[] = rows.map((a) => ({
    assignmentId: a.id, userId: a.userId, name: nameOf(a.userId), positionKey: a.positionKey,
    startsAt: a.startsAt, endsAt: a.endsAt, istDate: istDateOfInstant(a.startsAt),
    night: istDateOfInstant(a.endsAt) !== istDateOfInstant(a.startsAt), mode: a.mode, kind: a.kind,
  }));
  const byId = new Map(assignments.map((a) => [a.assignmentId, a]));

  const findings: MonthFinding[] = computed.map((f) => {
    const acc = acceptedByKey.get(findingKey(f));
    const p = f.params;
    const day = f.assignmentId !== null ? (byId.get(f.assignmentId)?.istDate ?? null)
      : typeof p.istDate === "string" ? p.istDate : typeof p.from === "string" ? p.from : null;
    return {
      ruleKey: f.ruleKey, severity: f.severity, userId: f.userId, name: nameOf(f.userId),
      assignmentId: f.assignmentId, istDate: day, params: f.params,
      blocking: blockingKeys.has(findingKey(f)),
      accepted: acc === undefined || acc.acceptedAt === null ? null
        : { byName: nameOf(acc.acceptedBy) ?? "", at: acc.acceptedAt, reason: acc.acceptReason ?? "" },
    };
  }).sort((a, b) => Number(b.blocking) - Number(a.blocking)
    || severityRank[a.severity] - severityRank[b.severity]
    || (a.istDate ?? "").localeCompare(b.istDate ?? "") || a.ruleKey.localeCompare(b.ruleKey));

  const posted = new Map<string, { postedFrom: string | null; postedTo: string | null }>();
  for (const p of postings) {
    const from = p.startsAt <= startsAt ? null : istDateOfInstant(p.startsAt);
    // `endsAt` is exclusive: a posting ending at 00:00 on the 16th was last here on the 15th.
    const to = p.endsAt === null || p.endsAt >= endsAt ? null : istDateOfInstant(new Date(p.endsAt.getTime() - 1));
    const prev = posted.get(p.userId);
    posted.set(p.userId, prev === undefined ? { postedFrom: from, postedTo: to } : {
      postedFrom: prev.postedFrom === null || from === null ? null : (from < prev.postedFrom ? from : prev.postedFrom),
      postedTo: prev.postedTo === null || to === null ? null : (to > prev.postedTo ? to : prev.postedTo),
    });
  }
  const postedOf = (userId: string) => posted.get(userId) ?? { postedFrom: null, postedTo: null };
  const people = members
    .map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? m.userId, positionKey: m.positionKey, grade: m.grade, ...postedOf(m.userId) }));
  for (const p of postings) {
    if (!people.some((x) => x.userId === p.userId)) {
      people.push({ userId: p.userId, name: names.get(p.userId) ?? p.userId, positionKey: p.positionKey, grade: p.grade, ...postedOf(p.userId) });
    }
  }
  for (const a of assignments) {
    if (a.userId !== null && !people.some((p) => p.userId === a.userId)) {
      people.push({ userId: a.userId, name: a.name ?? a.userId, positionKey: a.positionKey, grade: "", postedFrom: null, postedTo: null });
    }
  }
  people.sort((a, b) => a.name.localeCompare(b.name));

  const away = people.length === 0 ? [] : await (exec as Db).select({
    userId: staffAbsences.userId, kind: staffAbsences.kind, startsAt: staffAbsences.startsAt, endsAt: staffAbsences.endsAt,
  }).from(staffAbsences).where(and(
    eq(staffAbsences.status, "approved"), inArray(staffAbsences.userId, people.map((p) => p.userId)),
    lt(staffAbsences.startsAt, endsAt), gt(staffAbsences.endsAt, startsAt),
  )).orderBy(asc(staffAbsences.startsAt));
  const clampDay = (d: string): string => (d < days[0]! ? days[0]! : d > days[days.length - 1]! ? days[days.length - 1]! : d);
  const leave = away.map((x) => ({
    userId: x.userId, kind: x.kind,
    from: clampDay(istDateOfInstant(x.startsAt)), to: clampDay(istDateOfInstant(new Date(x.endsAt.getTime() - 1))),
  }));

  const unitDays = days.map((istDate) => {
    const mine = windows.filter((w) => istDateOfInstant(w.startsAt) === istDate);
    return {
      istDate,
      activities: [...new Set(mine.filter((w) => w.activity !== "take").map((w) => w.activity))],
      take: mine.some((w) => w.activity === "take"),
      overlay: mine.some((w) => w.source === "overlay"),
    };
  });

  const positionLabels = new Map((await listRosterPositions(exec)).map((p) => [p.key, p.label]));
  const draft = period?.status === "draft";
  const editAct: RosterAct = period?.humanTouchedAt == null ? "propose" : "edit_human_draft";

  return {
    unit: { teamId: team.id, code: team.code, name: team.name, confirmed: team.active, departmentId: team.departmentId, departmentName: dept?.name ?? "" },
    month, startsAt, endsAt, days,
    period: period === undefined ? null : {
      periodId: period.id, version: period.version, status: period.status, origin: period.origin, title: period.title,
      contentHash: period.contentHash ?? await contentHash(exec, period.id), publishedAt: period.publishedAt,
    },
    positions: (period?.coversPositions ?? []).map((key) => ({ key, label: positionLabels.get(key) ?? key })),
    people,
    assignments,
    findings,
    counts: {
      blocking: findings.filter((f) => f.blocking).length,
      warnings: findings.filter((f) => f.severity === "warn" && f.accepted === null).length,
      info: findings.filter((f) => f.severity === "info").length,
    },
    fairness: fairnessOf(rows).map((f) => ({ ...f, name: names.get(f.userId) ?? f.userId })),
    unitDays,
    holidays: holidays.map((h) => ({ istDate: h.istDate, kind: h.kind, pattern: h.pattern })),
    leave,
    you: await rosterSelf(exec, actor, new Date()),
    youMay: {
      draft: period === undefined && await may(exec, actor, "draft_machine_period", team.departmentId),
      edit: draft && await may(exec, actor, editAct, team.departmentId),
      acceptWarning: await may(exec, actor, "accept_warning", team.departmentId),
      publish: draft && await may(exec, actor, "publish", team.departmentId),
      cover: period?.status === "published" && await may(exec, actor, "propose", team.departmentId),
    },
  };
}

/**
 * ASK THE PROPOSER FOR THE MONTH — the same draft the monthly job would cut (same strategy, same
 * seed), on demand. **Idempotent**: a month that already has a draft or a published version is
 * returned as it is, exactly as the job skips a unit that has next month in hand.
 */
export async function draftUnitMonth(db: Db, actor: Actor, teamId: string, month: string): Promise<UnitMonth> {
  const { startsAt, endsAt } = monthWindow(month);
  const team = await teamRow(db, teamId);
  // Asked BEFORE the idempotency check, so a reader who may not draft is refused even when the
  // month already exists — the answer to "may I draft?" must not depend on whether somebody has.
  await requireRosterAct(db, actor, "draft_machine_period", { departmentId: team.departmentId });
  if (await currentPeriod(db, teamId, startsAt) === undefined) {
    const strategy = await proposalStrategyFor(db, teamId, startsAt);
    await withTx(db, async (tx) => {
      const r = await proposeMonth(tx, actor, {
        departmentId: team.departmentId, teamId, title: `${month} — ${team.name}`,
        startsAt, endsAt, strategy, seed: proposalSeedFor(`${month}-01`),
      });
      await recordFindings(tx, actor, r.periodId);
    });
  }
  return unitMonth(db, actor, teamId, month);
}

async function refOf(exec: Db | Tx, periodId: string): Promise<MonthRef> {
  const { period } = await periodWithAssignments(exec, periodId);
  if (period.teamId === null) throw new RosterError("unknown_team", undefined, { periodId });
  return { teamId: period.teamId, month: istDateOfInstant(period.startsAt).slice(0, 7) };
}

/**
 * ONE SLOT, A DIFFERENT PERSON — or nobody (`userId: null`, the board's "leave it vacant" fix).
 * `unassign` then `assign` in one transaction: the new occupant faces every check `assign` makes
 * (eligibility, the period's window, the act matrix), and a refusal leaves the old occupant in place.
 */
export async function editSlot(db: Db, actor: Actor, assignmentId: string, userId: string | null): Promise<MonthRef> {
  const row = (await (db as Db).select().from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId)))[0];
  if (row === undefined) throw new RosterError("unknown_assignment", undefined, { assignmentId });
  await withTx(db, async (tx) => {
    await unassign(tx, actor, assignmentId);
    await assign(tx, actor, row.periodId, {
      userId, positionKey: row.positionKey, startsAt: row.startsAt, endsAt: row.endsAt,
      departmentId: row.departmentId, teamId: row.teamId, mode: row.mode as RosterAssignmentMode | null,
      kind: row.kind as RosterAssignmentKind, offKind: row.offKind as RosterOffKind | null,
      coverScope: row.coverScope as RosterCoverScope, callTier: row.callTier,
      supernumerary: row.supernumerary, locationResourceId: row.locationResourceId,
      batchRef: row.batchRef, topic: row.topic, note: row.note, source: "manual",
    });
    await recordFindings(tx, actor, row.periodId);
  });
  return refOf(db, row.periodId);
}

/**
 * A NAMED PERSON SIGNS FOR A FINDING. `accept_warning` is asked first at the period's department,
 * so a reader who may not accept is refused before anything is recorded; `acceptFinding` asks again.
 */
export async function acceptUnitFinding(
  db: Db, actor: Actor, periodId: string, key: FindingKeyInput, reason: string,
): Promise<MonthRef> {
  await withTx(db, async (tx) => {
    const { period } = await periodWithAssignments(tx, periodId);
    await requireRosterAct(tx, actor, "accept_warning", period.departmentId === null ? {} : { departmentId: period.departmentId });
    const { stored } = await recordFindings(tx, actor, periodId);
    const wanted = findingKey(key);
    const row = stored.find((r) => findingKey(r) === wanted);
    if (row === undefined) throw new RosterError("unknown_finding", undefined, { periodId, ruleKey: key.ruleKey });
    await acceptFinding(tx, actor, row.id, reason);
  });
  return refOf(db, periodId);
}

/** PUBLISH — `publishPeriod`, and nothing else decides it. `expectedContentHash` is V4's. */
export async function publishUnitMonth(
  db: Db, actor: Actor, periodId: string, expectedContentHash?: string,
): Promise<MonthRef> {
  await withTx(db, (tx) => publishPeriod(tx, actor, periodId, expectedContentHash === undefined ? {} : { expectedContentHash }));
  return refOf(db, periodId);
}
