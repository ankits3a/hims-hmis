import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import {
  BED_CLEAN_KINDS, HK_IN_HOUSE, HOUSEKEEPING_KINDS, HOUSEKEEPING_KIND_LIST, hkMonth, hkMonthWindow, hkShiftAt,
} from "@hmis/contracts";
import { hkAreas, hkContractors, hkRounds, hkWork, resources } from "../../kernel/db/schema";
import { findTasks, rejectionsOf, taskKinds } from "../tasks";
import { HousekeepingRefusal } from "./errors";
import { inspectionsOfFloorShift, inspectionsScoredBetween } from "./inspections";
import { ancestry, floorIn } from "./places";
import { staffFacts } from "./setup";
import type { HkBucket, HkDailyView, HkSlaRow, HkSlaView, HkToCheck, HousekeepingKind } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * HK-2 (#974, decision 0086) — THE DEPARTMENT'S REPORTS, read-only.
 *
 * `contractorSla` — per company per IST month (each contractor, and In-house for comparison): rounds on time / late /
 * missed (by the round's due time: the first finished attempt against it; missed = never finished), discharge-clean
 * turnaround median and 90th percentile (release → passed check, by the clean's raise time), first-time pass rate (a
 * checked task whose first attempt passed, by the first attempt's time), and the average inspection score (by the
 * inspection's time, the company that last worked the area). A REPORT ONLY: no money and no deduction anywhere (0086), and
 * no person — company names only. Work is credited to the company recorded with the attempt (`hk_work.company`, a
 * snapshot); a round nobody finished goes to its holder's company; one nobody held is left out.
 *
 * `dailyReport` — one floor, one shift: rounds due / done / missed, bed turnarounds (cleans passed in the shift),
 * requests raised and closed, fails (tasks raised in the shift that failed a check), rework from failed inspections, and
 * the inspections drawn / passed / failed. Every count carries the ids behind it, so a count is checked against its tasks.
 *
 * `toCheck` — what waits for a nurse's or the supervisor's Pass or Fail (the staff app's check list).
 */
const DONE = new Set(["done", "verified"]);
const CHECKED_KINDS: readonly string[] = [HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.terminal, HOUSEKEEPING_KINDS.roundChecked, HOUSEKEEPING_KINDS.rework];
const ROUND_KINDS: readonly string[] = [HOUSEKEEPING_KINDS.round, HOUSEKEEPING_KINDS.roundChecked];
const TASK_SCAN = 50_000;
const DAY = 86_400_000;

const minutes = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / 60_000);
const raisedOf = (t: TaskRow): Date => t.raisedAt ?? t.createdAt;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
/** The 90th percentile by the nearest rank. */
export function p90(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!;
}

type Attempt = typeof hkWork.$inferSelect;
async function attemptsOf(db: Db, taskIds: readonly string[]): Promise<Map<string, Attempt[]>> {
  const out = new Map<string, Attempt[]>();
  for (let i = 0; i < taskIds.length; i += 1000) {
    const chunk = taskIds.slice(i, i + 1000);
    if (chunk.length === 0) continue;
    for (const w of await db.select().from(hkWork).where(inArray(hkWork.taskId, chunk)).orderBy(asc(hkWork.attempt))) {
      out.set(w.taskId, [...(out.get(w.taskId) ?? []), w]);
    }
  }
  return out;
}

async function rejections(db: Db, taskIds: readonly string[]): Promise<Map<string, { count: number; lastReason: string | null }>> {
  const out = new Map<string, { count: number; lastReason: string | null }>();
  for (let i = 0; i < taskIds.length; i += 1000) for (const [k, v] of await rejectionsOf(db, taskIds.slice(i, i + 1000))) out.set(k, v);
  return out;
}

const IN_HOUSE_KEY = "in-house";

export async function contractorSla(db: Db, month: string, now: Date = new Date()): Promise<HkSlaView> {
  if (!hkMonth.safeParse(month).success) throw new HousekeepingRefusal("bad_month", { month });
  const { start, end } = hkMonthWindow(month);
  const inMonth = (d: Date | null | undefined): boolean => d != null && d >= start && d < end && d <= now;
  const contractors = await db.select({ id: hkContractors.id, name: hkContractors.name, active: hkContractors.active }).from(hkContractors).orderBy(asc(hkContractors.name));
  const rows = new Map<string, HkSlaRow>();
  const blank = (company: string, contractorId: string | null): HkSlaRow => ({
    company, contractorId, inHouse: contractorId === null,
    rounds: { onTime: 0, late: 0, missed: 0 }, turnaround: { count: 0, medianMin: null, p90Min: null },
    firstPass: { checked: 0, passedFirstTime: 0, ratePct: null }, inspections: { count: 0, avgScorePct: null },
  });
  for (const c of contractors) if (c.active) rows.set(c.id, blank(c.name, c.id));
  rows.set(IN_HOUSE_KEY, blank(HK_IN_HOUSE, null));
  const row = (contractorId: string | null): HkSlaRow => {
    const k = contractorId ?? IN_HOUSE_KEY;
    let r = rows.get(k);
    if (r === undefined) { r = blank(contractors.find((c) => c.id === k)?.name ?? HK_IN_HOUSE, contractorId); rows.set(k, r); }
    return r;
  };

  // Every housekeeping task that can bear on this month (raised from a day before it; a task lives hours, not days).
  const tasks = (await findTasks(db, { kinds: HOUSEKEEPING_KIND_LIST, createdSince: new Date(start.getTime() - DAY), limit: TASK_SCAN }))
    .filter((t) => raisedOf(t) < end);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const attempts = await attemptsOf(db, tasks.map((t) => t.id));
  const rej = await rejections(db, tasks.map((t) => t.id));
  const holders = await staffFacts(db, [...new Set(tasks.flatMap((t) => [t.assigneeId, t.doneBy]).filter((x): x is string => x !== null))]);
  const companyOfPerson = (userId: string | null): string | null | undefined => (userId === null ? undefined : holders.get(userId)?.contractorId ?? null);

  // Rounds, by due time.
  const rounds = await db.select().from(hkRounds).where(and(gte(hkRounds.dueAt, start), lt(hkRounds.dueAt, end)));
  for (const r of rounds) {
    const t = taskById.get(r.taskId);
    const first = attempts.get(r.taskId)?.[0];
    if (first !== undefined) {
      const rr = row(first.contractorId);
      if (first.scannedAt <= r.dueAt) rr.rounds.onTime += 1; else rr.rounds.late += 1;
    } else if (t !== undefined && t.doneAt !== null && t.doneBy !== null) {
      const rr = row(companyOfPerson(t.doneBy) ?? null);
      if (t.doneAt <= r.dueAt) rr.rounds.onTime += 1; else rr.rounds.late += 1;
    } else if (r.status === "missed") {
      const c = companyOfPerson(t?.assigneeId ?? null);
      if (c !== undefined) row(c).rounds.missed += 1;
    }
  }

  // Discharge-clean turnaround: release → passed check, by the clean's raise time.
  const turn = new Map<string, number[]>();
  for (const t of tasks) {
    if (!BED_CLEAN_KINDS.includes(t.kind as HousekeepingKind) || t.state !== "verified" || t.verifiedAt === null || !inMonth(raisedOf(t))) continue;
    const last = attempts.get(t.id)?.at(-1);
    const c = last !== undefined ? last.contractorId : companyOfPerson(t.doneBy);
    if (c === undefined) continue;
    const k = c ?? IN_HOUSE_KEY;
    turn.set(k, [...(turn.get(k) ?? []), minutes(raisedOf(t), t.verifiedAt)]);
  }
  for (const [k, xs] of turn) {
    const r = row(k === IN_HOUSE_KEY ? null : k);
    r.turnaround = { count: xs.length, medianMin: median(xs), p90Min: p90(xs) };
  }

  // First-time pass: a checked task, by its first attempt's time.
  for (const t of tasks) {
    if (!CHECKED_KINDS.includes(t.kind)) continue;
    const first = attempts.get(t.id)?.[0];
    if (first === undefined || !inMonth(first.scannedAt)) continue;
    const fails = rej.get(t.id)?.count ?? 0;
    if (t.state !== "verified" && fails === 0) continue; // not checked yet
    const r = row(first.contractorId);
    r.firstPass.checked += 1;
    if (fails === 0) r.firstPass.passedFirstTime += 1;
  }

  // Inspection score, by the inspection's time.
  const scores = new Map<string, number[]>();
  for (const i of await inspectionsScoredBetween(db, start, end)) {
    if (i.company === null || i.scorePct === null) continue;
    const k = i.contractorId ?? IN_HOUSE_KEY;
    scores.set(k, [...(scores.get(k) ?? []), i.scorePct]);
  }
  for (const [k, xs] of scores) {
    row(k === IN_HOUSE_KEY ? null : k).inspections = { count: xs.length, avgScorePct: Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) };
  }

  for (const r of rows.values()) {
    r.firstPass.ratePct = r.firstPass.checked === 0 ? null : Math.round((r.firstPass.passedFirstTime * 100) / r.firstPass.checked);
  }
  const out = [...rows.values()].sort((a, b) => Number(a.inHouse) - Number(b.inHouse) || a.company.localeCompare(b.company));
  return { month, rows: out };
}

const bucket = (ids: readonly string[]): HkBucket => {
  const u = [...new Set(ids)];
  return { count: u.length, ids: u };
};

export async function dailyReport(db: Db, floorId: string, at: Date = new Date()): Promise<HkDailyView> {
  const floor = (await db.select({ kind: resources.kind, name: resources.name }).from(resources).where(eq(resources.id, floorId)))[0];
  if (floor?.kind !== "floor") throw new HousekeepingRefusal("not_a_floor", { floorId });
  const shift = hkShiftAt(at);
  const inShift = (d: Date | null): boolean => d !== null && d >= shift.startsAt && d < shift.endsAt;

  const rounds = await db.select({ r: hkRounds }).from(hkRounds).innerJoin(hkAreas, eq(hkAreas.id, hkRounds.areaId))
    .where(and(eq(hkAreas.floorId, floorId), gte(hkRounds.slotStart, shift.startsAt), lt(hkRounds.slotStart, shift.endsAt)));
  const tasks = await findTasks(db, { kinds: HOUSEKEEPING_KIND_LIST, createdSince: new Date(shift.startsAt.getTime() - DAY), limit: TASK_SCAN });
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const floorOf = new Map<string, string | null>();
  const onFloor = async (t: TaskRow): Promise<boolean> => {
    if (t.placeResourceId === null) return false;
    if (!floorOf.has(t.placeResourceId)) floorOf.set(t.placeResourceId, floorIn(await ancestry(db, t.placeResourceId)));
    return floorOf.get(t.placeResourceId) === floorId;
  };
  const here: TaskRow[] = [];
  for (const t of tasks) if (!ROUND_KINDS.includes(t.kind) && await onFloor(t)) here.push(t);

  const roundDone = rounds.filter(({ r }) => r.status !== "missed" && (r.status === "done" || DONE.has(taskById.get(r.taskId)?.state ?? "")));
  const cleans = here.filter((t) => BED_CLEAN_KINDS.includes(t.kind as HousekeepingKind) && t.state === "verified" && inShift(t.verifiedAt));
  const requests = here.filter((t) => t.kind === HOUSEKEEPING_KINDS.request && inShift(raisedOf(t)));
  const raisedHere = [...here.filter((t) => inShift(raisedOf(t))), ...rounds.map(({ r }) => taskById.get(r.taskId)).filter((t): t is TaskRow => t !== undefined)];
  const rej = await rejectionsOf(db, raisedHere.map((t) => t.id));
  const inspections = await inspectionsOfFloorShift(db, floorId, shift.startsAt);

  return {
    floorId, floorName: floor.name, shift: shift.key, shiftStartsAt: shift.startsAt.toISOString(), shiftEndsAt: shift.endsAt.toISOString(),
    rounds: {
      due: bucket(rounds.map(({ r }) => r.taskId)),
      done: bucket(roundDone.map(({ r }) => r.taskId)),
      missed: bucket(rounds.filter(({ r }) => r.status === "missed").map(({ r }) => r.taskId)),
    },
    turnarounds: { ...bucket(cleans.map((t) => t.id)), medianMin: median(cleans.map((t) => minutes(raisedOf(t), t.verifiedAt!))) },
    requests: { raised: bucket(requests.map((t) => t.id)), closed: bucket(requests.filter((t) => DONE.has(t.state)).map((t) => t.id)) },
    fails: bucket(raisedHere.filter((t) => (rej.get(t.id)?.count ?? 0) > 0).map((t) => t.id)),
    rework: bucket(here.filter((t) => t.kind === HOUSEKEEPING_KINDS.rework && inShift(raisedOf(t))).map((t) => t.id)),
    inspections: {
      drawn: bucket(inspections.map((i) => i.id)),
      passed: bucket(inspections.filter((i) => i.status === "passed").map((i) => i.id)),
      failed: bucket(inspections.filter((i) => i.status === "failed").map((i) => i.id)),
    },
  };
}

/** Housekeeping work waiting for a Pass or Fail, oldest first. A wall-safe list: kind, place, no person, no patient. */
export async function toCheck(db: Db, limit = 200): Promise<HkToCheck[]> {
  const rows = (await findTasks(db, { kinds: CHECKED_KINDS, states: ["done"], limit })).sort((a, b) => (a.doneAt?.getTime() ?? 0) - (b.doneAt?.getTime() ?? 0));
  if (rows.length === 0) return [];
  const labels = new Map(taskKinds().map((k) => [k.kind, k.label]));
  const placeIds = [...new Set(rows.map((t) => t.placeResourceId).filter((x): x is string => x !== null))];
  const names = placeIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, placeIds))).map((p) => [p.id, p.name]));
  const rej = await rejectionsOf(db, rows.map((t) => t.id));
  return rows.map((t) => ({
    taskId: t.id, kind: t.kind, kindLabel: labels.get(t.kind) ?? t.kind, placeName: t.placeResourceId === null ? null : names.get(t.placeResourceId) ?? null,
    doneAt: t.doneAt?.toISOString() ?? null, terminal: t.kind === HOUSEKEEPING_KINDS.terminal, fails: rej.get(t.id)?.count ?? 0,
  }));
}
