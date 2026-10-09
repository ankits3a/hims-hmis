import { and, eq, inArray } from "drizzle-orm";
import { addDayIso, mondayIndex, newId } from "@hmis/contracts";
import type { Actor, FindingType, FlowLeg } from "@hmis/contracts";
import { opdFlowBaselines, opdFlowFindings } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { DB_LEG, istHour, legsOf, loadFlowVisits, medianOf, p90Of } from "./flow";
import type { VisitLegs } from "./flow";
import {
  BASELINE_DAYS, BAY_PEAK_DAY_MIN_N, BAY_PEAK_HIT_DAYS, BAY_PEAK_LOOK_DAYS, BAY_PEAK_MIN_N, BAY_PEAK_RATIO, BAY_WINDOW_HOURS,
  BAY_WINDOW_STARTS, DEPT_OUTLIER_MIN_N, DEPT_OUTLIER_RATIO, DISMISS_QUIET_DAYS, DISMISS_RETURN_RATIO, RESOLVE_DAYS, RESOLVE_RATIO,
  START_LATE_DAY_MIN_N, START_LATE_HIT_DAYS, START_LATE_LOOK_DAYS, START_LATE_MIN_N, START_LATE_RATIO, START_LATE_WINDOW_MIN,
  WEEK_DAYS, WEEK_REGRESSION_BASE_DAYS, WEEK_REGRESSION_MIN_N, WEEK_REGRESSION_RATIO,
} from "./flow-rules";
import { FLOW_FIRST_HOUR, FLOW_LAST_HOUR, FLOW_LEGS, FLOW_MIN_N } from "@hmis/contracts";
import { flowFindingDismissed, flowFindingTried } from "./events";
import { istDate } from "./time";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE WAITS, LEARNED NIGHTLY (owner 2026-10-09) ═══
 *
 * "I want a system in place that keeps learning these metrics and show suggestions to improve the
 * metrics based on analysis." LEARNING here is three things, all arithmetic over stored timestamps:
 *
 *   1. BASELINES — each department's own rolling numbers (and the hospital's): the last 28 days, per
 *      leg, median and p90, by weekday × hour (`opd_flow_baselines`, replaced whole each night).
 *   2. FINDINGS — a CLOSED set of patterns (`flow-rules.ts` holds every threshold), each a row in
 *      `opd_flow_findings` with the numbers that made it fire. Its words are the phone's fixed
 *      templates filled with these numbers. No model writes, reads or ranks anything here.
 *   3. WHAT PEOPLE DID — × (dismiss) keeps a finding quiet for 28 days unless it comes back 20 % worse;
 *      "Tried it" stamps a day so the numbers after it can be shown beside the numbers before; a finding
 *      whose numbers sit within 1.1× its baseline over the last two weeks is RESOLVED, with the minutes
 *      it won.
 *
 * Runs inside the existing 23:55 IST OPD job (`sweepAppointmentNoShows`, `kernel/worker/jobs.ts`) — the
 * day's visits are done by then — so no job, no census site and no pool client is added. Idempotent: a
 * second run the same night recomputes the same numbers and updates the same rows.
 *
 */

type Candidate = {
  key: string; type: FindingType; scope: string; leg: FlowLeg;
  weekday: number | null; hourFrom: number | null; hourTo: number | null;
  observed: number; baseline: number; patients: number;
};
export const findingKey = (c: Pick<Candidate, "type" | "scope" | "leg" | "weekday" | "hourFrom">): string =>
  `${c.type}|${c.scope}|${DB_LEG[c.leg]}|${c.weekday === null ? "-" : String(c.weekday)}|${c.hourFrom === null ? "-" : String(c.hourFrom)}`;

const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);
const med = (xs: readonly number[]): number | null => medianOf(sorted(xs));
const legValues = (vs: readonly VisitLegs[], leg: FlowLeg): number[] => vs.flatMap((v) => (v.legs[leg] === undefined ? [] : [v.legs[leg]!.min]));
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The last `count` dates (newest first) that fall on `weekday`, up to and including `today`. */
export function lastWeekdays(today: string, weekday: number, count: number): string[] {
  const back = (mondayIndex(today) - weekday + 7) % 7;
  return Array.from({ length: count }, (_, i) => addDayIso(today, -(back + 7 * i)));
}

/** Leg A values of `vs` on `day` whose desk time falls in [hourFrom, hourTo). */
function windowValues(vs: readonly VisitLegs[], day: string, hourFrom: number, hourTo: number): number[] {
  return vs.filter((v) => v.serviceDate === day && v.legs.deskToVitals !== undefined)
    .filter((v) => { const h = istHour(v.legs.deskToVitals!.at); return h >= hourFrom && h < hourTo; })
    .map((v) => v.legs.deskToVitals!.min);
}

/** Leg B in a department's first hour on `day`: from its first vitals save, `START_LATE_WINDOW_MIN` minutes. */
function firstHour(vs: readonly VisitLegs[], day: string): { values: number[]; startHour: number | null } {
  const b = vs.filter((v) => v.serviceDate === day && v.legs.vitalsToDoctor !== undefined).map((v) => v.legs.vitalsToDoctor!);
  if (b.length === 0) return { values: [], startHour: null };
  const first = Math.min(...b.map((x) => x.at.getTime()));
  return { values: b.filter((x) => x.at.getTime() < first + START_LATE_WINDOW_MIN * 60_000).map((x) => x.min), startHour: istHour(new Date(first)) };
}

/** Pure: every finding the rules raise on `today` from `visits` (which must cover the last 35 days). */
export function findCandidates(visits: readonly VisitLegs[], today: string): Candidate[] {
  const out: Candidate[] = [];
  const since28 = addDayIso(today, -(BASELINE_DAYS - 1));
  const w28 = visits.filter((v) => v.serviceDate >= since28 && v.serviceDate <= today);
  const depts = [...new Set(w28.flatMap((v) => (v.departmentId === null ? [] : [v.departmentId])))].sort();
  const push = (c: Omit<Candidate, "key">): void => { out.push({ ...c, key: findingKey(c) }); };

  for (const d of depts) {
    const mine = w28.filter((v) => v.departmentId === d);

    /* bay_peak — leg A in a two-hour window ≥ 1.5× the department's own median, on ≥ 3 of the last 4 same weekdays. */
    const aAll = legValues(mine, "deskToVitals");
    const aBase = aAll.length >= FLOW_MIN_N ? med(aAll) : null;
    if (aBase !== null && aBase > 0) {
      for (let w = 0; w < 7; w += 1) {
        const days = lastWeekdays(today, w, BAY_PEAK_LOOK_DAYS);
        for (const s of BAY_WINDOW_STARTS) {
          const per = days.map((day) => windowValues(mine, day, s, s + BAY_WINDOW_HOURS));
          const hot = per.filter((xs) => xs.length >= BAY_PEAK_DAY_MIN_N && med(xs)! >= BAY_PEAK_RATIO * aBase).length;
          const all = per.flat();
          if (hot >= BAY_PEAK_HIT_DAYS && all.length >= BAY_PEAK_MIN_N) {
            push({ type: "bay_peak", scope: d, leg: "deskToVitals", weekday: w, hourFrom: s, hourTo: s + BAY_WINDOW_HOURS, observed: med(all)!, baseline: aBase, patients: all.length });
          }
        }
      }
    }

    /* doctor_start_late — leg B long in the department's first hour, on ≥ 3 of the last 4 same weekdays. */
    const bAll = legValues(mine, "vitalsToDoctor");
    const bBase = bAll.length >= FLOW_MIN_N ? med(bAll) : null;
    if (bBase !== null && bBase > 0) {
      for (let w = 0; w < 7; w += 1) {
        const per = lastWeekdays(today, w, START_LATE_LOOK_DAYS).map((day) => firstHour(mine, day));
        const hotDays = per.filter((p) => p.values.length >= START_LATE_DAY_MIN_N && med(p.values)! >= START_LATE_RATIO * bBase);
        const all = per.flatMap((p) => p.values);
        if (hotDays.length >= START_LATE_HIT_DAYS && all.length >= START_LATE_MIN_N) {
          const start = Math.min(...hotDays.map((p) => p.startHour!));
          push({ type: "doctor_start_late", scope: d, leg: "vitalsToDoctor", weekday: w, hourFrom: start, hourTo: start + 1, observed: med(all)!, baseline: bBase, patients: all.length });
        }
      }
    }
  }

  /* dept_outlier — a department's leg-B median ≥ 1.5× the hospital's over 28 days, n ≥ 30. */
  const hb = legValues(w28, "vitalsToDoctor");
  const hBase = hb.length >= FLOW_MIN_N ? med(hb) : null;
  if (hBase !== null && hBase > 0) {
    for (const d of depts) {
      const xs = legValues(w28.filter((v) => v.departmentId === d), "vitalsToDoctor");
      if (xs.length >= DEPT_OUTLIER_MIN_N && med(xs)! >= DEPT_OUTLIER_RATIO * hBase) {
        push({ type: "dept_outlier", scope: d, leg: "vitalsToDoctor", weekday: null, hourFrom: null, hourTo: null, observed: med(xs)!, baseline: hBase, patients: xs.length });
      }
    }
  }

  /* week_regression — this week's desk → doctor median ≥ 25 % over the four weeks before, n ≥ 30 in each. */
  const weekFrom = addDayIso(today, -(WEEK_DAYS - 1));
  const baseFrom = addDayIso(weekFrom, -WEEK_REGRESSION_BASE_DAYS), baseTo = addDayIso(weekFrom, -1);
  for (const scope of ["hospital", ...depts]) {
    const mine = scope === "hospital" ? visits : visits.filter((v) => v.departmentId === scope);
    const week = legValues(mine.filter((v) => v.serviceDate >= weekFrom && v.serviceDate <= today), "deskToDoctor");
    const base = legValues(mine.filter((v) => v.serviceDate >= baseFrom && v.serviceDate <= baseTo), "deskToDoctor");
    if (week.length < WEEK_REGRESSION_MIN_N || base.length < WEEK_REGRESSION_MIN_N) continue;
    const b = med(base)!;
    if (b > 0 && med(week)! >= WEEK_REGRESSION_RATIO * b) {
      push({ type: "week_regression", scope, leg: "deskToDoctor", weekday: null, hourFrom: null, hourTo: null, observed: med(week)!, baseline: b, patients: week.length });
    }
  }
  return out;
}

type Row = typeof opdFlowFindings.$inferSelect;

/** A finding's own measure over the last `RESOLVE_DAYS` days — the "after" of a resolution. */
export function currentOf(row: Pick<Row, "type" | "scope" | "weekday" | "hourFrom" | "hourTo">, visits: readonly VisitLegs[], today: string): { observed: number | null; n: number } {
  const since = addDayIso(today, -(RESOLVE_DAYS - 1));
  const recent = visits.filter((v) => v.serviceDate >= since && v.serviceDate <= today && (row.scope === "hospital" || v.departmentId === row.scope));
  let xs: number[];
  if (row.type === "bay_peak") {
    xs = lastWeekdays(today, row.weekday ?? 0, RESOLVE_DAYS / 7).flatMap((day) => windowValues(recent, day, row.hourFrom ?? 0, row.hourTo ?? 24));
  } else if (row.type === "doctor_start_late") {
    xs = lastWeekdays(today, row.weekday ?? 0, RESOLVE_DAYS / 7).flatMap((day) => firstHour(recent, day).values);
  } else if (row.type === "dept_outlier") {
    xs = legValues(recent, "vitalsToDoctor");
  } else {
    xs = legValues(recent, "deskToDoctor");
  }
  return { observed: xs.length < FLOW_MIN_N ? null : med(xs), n: xs.length };
}

const lost = (observed: number, baseline: number, patients: number): number => Math.max(0, Math.round((observed - baseline) * patients));

export type FlowLearningReport = { ran: boolean; baselines: number; opened: number; updated: number; reopened: number; resolved: number };

/** Each leg's baseline per scope × weekday × hour (−1 = every), last 28 days. */
function baselinesOf(visits: readonly VisitLegs[], today: string, now: Date): (typeof opdFlowBaselines.$inferInsert)[] {
  const from = addDayIso(today, -(BASELINE_DAYS - 1));
  const w28 = visits.filter((v) => v.serviceDate >= from && v.serviceDate <= today);
  const scopes = ["hospital", ...new Set(w28.flatMap((v) => (v.departmentId === null ? [] : [v.departmentId])))];
  const rows: (typeof opdFlowBaselines.$inferInsert)[] = [];
  for (const scope of scopes) {
    const mine = scope === "hospital" ? w28 : w28.filter((v) => v.departmentId === scope);
    for (const leg of FLOW_LEGS) {
      const cells = new Map<string, number[]>();
      for (const v of mine) {
        const l = v.legs[leg];
        if (l === undefined) continue;
        const w = mondayIndex(v.serviceDate), h = istHour(l.at);
        const hours = h >= FLOW_FIRST_HOUR && h <= FLOW_LAST_HOUR ? [-1, h] : [-1];
        for (const wd of [-1, w]) for (const hh of hours) { const k = `${String(wd)}:${String(hh)}`; cells.set(k, [...(cells.get(k) ?? []), l.min]); }
      }
      for (const [k, xs] of cells) {
        const [wd, hh] = k.split(":").map(Number);
        const s = sorted(xs);
        rows.push({
          id: newId(), scope, leg: DB_LEG[leg], weekday: wd!, hour: hh!, n: s.length,
          medianMin: s.length < FLOW_MIN_N ? null : medianOf(s), p90Min: s.length < FLOW_MIN_N ? null : p90Of(s),
          windowFrom: from, windowTo: today, computedAt: now,
        });
      }
    }
  }
  return rows;
}

/**
 * THE NIGHTLY RUN. With `enabled` false (`FLOW_FINDINGS_ENABLED=false`) it reads nothing and writes
 * nothing. It calls no outside service either way.
 */
export async function runFlowLearning(db: Db, enabled: boolean, now: Date = new Date()): Promise<FlowLearningReport> {
  const report: FlowLearningReport = { ran: false, baselines: 0, opened: 0, updated: 0, reopened: 0, resolved: 0 };
  if (!enabled) return report;
  report.ran = true;
  const today = istDate(now);
  const from = addDayIso(today, -(WEEK_DAYS + WEEK_REGRESSION_BASE_DAYS - 1));
  const visits = (await loadFlowVisits(db, { from, to: today })).map(legsOf);
  const baselines = baselinesOf(visits, today, now);
  const candidates = findCandidates(visits, today);

  await withTx(db, async (tx: Tx) => {
    await tx.delete(opdFlowBaselines);
    for (let i = 0; i < baselines.length; i += 500) await tx.insert(opdFlowBaselines).values(baselines.slice(i, i + 500));
    report.baselines = baselines.length;

    const live = await tx.select().from(opdFlowFindings).where(inArray(opdFlowFindings.state, ["open", "dismissed"]));
    const byKey = new Map(live.map((r) => [r.findingKey, r]));
    const firing = new Set<string>();
    for (const c of candidates) {
      firing.add(c.key);
      const numbers = { observedMin: c.observed, baselineMin: c.baseline, patients: c.patients, minutesLost: lost(c.observed, c.baseline, c.patients), lastSeen: today, updatedAt: now };
      const row = byKey.get(c.key);
      if (row === undefined) {
        await tx.insert(opdFlowFindings).values({
          id: newId(), findingKey: c.key, type: c.type, scope: c.scope, leg: DB_LEG[c.leg],
          weekday: c.weekday, hourFrom: c.hourFrom, hourTo: c.hourTo, ...numbers, firstSeen: today, state: "open", createdAt: now,
        });
        report.opened += 1;
      } else if (row.state === "open") {
        await tx.update(opdFlowFindings).set({ ...numbers, ...(row.triedAt !== null ? { afterMedianMin: c.observed } : {}) }).where(eq(opdFlowFindings.id, row.id));
        report.updated += 1;
      } else {
        /* Dismissed: quiet for 28 days unless 20 % worse than when × was pressed; after that, back when it fires. */
        const quiet = daysBetween(istDate(row.dismissedAt!), today) < DISMISS_QUIET_DAYS;
        const worse = row.dismissedObservedMin !== null && c.observed >= DISMISS_RETURN_RATIO * row.dismissedObservedMin;
        if (quiet && !worse) continue;
        await tx.update(opdFlowFindings).set({
          ...numbers, state: "open", dismissedBy: null, dismissedAt: null, dismissedObservedMin: null, note: quiet ? "returned_worse" : "returned",
        }).where(eq(opdFlowFindings.id, row.id));
        report.reopened += 1;
      }
    }
    /* improved — an open finding that did not fire tonight and sits within 1.1× its baseline over two weeks. */
    for (const row of live) {
      if (row.state !== "open" || firing.has(row.findingKey)) continue;
      const cur = currentOf(row, visits, today);
      if (cur.observed === null) continue;
      if (cur.observed <= RESOLVE_RATIO * row.baselineMin) {
        const before = row.beforeMedianMin ?? row.observedMin;
        await tx.update(opdFlowFindings).set({
          state: "resolved", resolvedOn: today, beforeMedianMin: before, afterMedianMin: cur.observed,
          minutesWon: Math.max(0, Math.round((before - cur.observed) * cur.n)), updatedAt: now,
        }).where(eq(opdFlowFindings.id, row.id));
        report.resolved += 1;
      } else if (row.triedAt !== null) {
        await tx.update(opdFlowFindings).set({ afterMedianMin: cur.observed, updatedAt: now }).where(eq(opdFlowFindings.id, row.id));
      }
    }
  });
  return report;
}

/* ═══ the two acts — × and "Tried it" ═══ */

export type FindingActProblem = "unknown_finding" | "finding_not_open" | "already_tried";

/**
 * × — the finding goes quiet (`DISMISS_QUIET_DAYS`), remembering the median it was dismissed at. Audited
 * as `flow.finding_dismissed` naming the actor, the finding and its numbers; no patient is in it.
 */
export async function dismissFinding(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; problem: FindingActProblem }> {
  return withTx(db, async (tx) => {
    const row = (await tx.select().from(opdFlowFindings).where(eq(opdFlowFindings.id, id)).for("update"))[0];
    if (row === undefined) return { ok: false as const, problem: "unknown_finding" as const };
    if (row.state !== "open") return { ok: false as const, problem: "finding_not_open" as const };
    await tx.update(opdFlowFindings).set({ state: "dismissed", dismissedBy: actor.id, dismissedAt: now, dismissedObservedMin: row.observedMin, updatedAt: now })
      .where(and(eq(opdFlowFindings.id, id), eq(opdFlowFindings.state, "open")));
    await appendEvent(tx, flowFindingDismissed.make({ actor, payload: { findingId: id, type: row.type, scope: row.scope, observedMin: row.observedMin, baselineMin: row.baselineMin } }));
    return { ok: true as const };
  });
}

/**
 * "Tried it" — stamps the day and the median then (`before`), so the nights after can show what the
 * numbers did. Once per finding. Audited as `flow.finding_tried`.
 */
export async function triedFinding(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; problem: FindingActProblem }> {
  return withTx(db, async (tx) => {
    const row = (await tx.select().from(opdFlowFindings).where(eq(opdFlowFindings.id, id)).for("update"))[0];
    if (row === undefined) return { ok: false as const, problem: "unknown_finding" as const };
    if (row.state !== "open") return { ok: false as const, problem: "finding_not_open" as const };
    if (row.triedAt !== null) return { ok: false as const, problem: "already_tried" as const };
    await tx.update(opdFlowFindings).set({ triedBy: actor.id, triedAt: now, beforeMedianMin: row.observedMin, updatedAt: now }).where(eq(opdFlowFindings.id, id));
    await appendEvent(tx, flowFindingTried.make({ actor, payload: { findingId: id, type: row.type, scope: row.scope, observedMin: row.observedMin, baselineMin: row.baselineMin } }));
    return { ok: true as const };
  });
}

