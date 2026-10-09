import { and, eq, gte, sql } from "drizzle-orm";
import {
  FLOW_FIRST_HOUR, FLOW_GROUP_BYS, FLOW_LAST_HOUR, FLOW_LEGS, FLOW_MIN_N, addDayIso, mondayIndex, ownerRange, rangeProblem,
} from "@hmis/contracts";
import type {
  DayRange, FindingState, FindingType, FlowCell, FlowDrops, FlowFinding, FlowGroup, FlowGroupBy, FlowLeg, FlowReport, FlowStat, RangeProblem,
} from "@hmis/contracts";
import { opdDepartments, opdFlowFindings } from "../../kernel/db/schema";
import { FIXED_SHOWN_DAYS, FLOW_MAX_WAIT_MIN } from "./flow-rules";
import { LAB_DEPARTMENT_CODE, PHARMACY_VISIT_TYPE } from "./encounters";
import { IST_OFFSET_MS, istDate } from "./time";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ HOW LONG PATIENTS WAIT — DESK → VITALS → DOCTOR (owner 2026-10-09) ═══
 *
 * Every number here is read off timestamps the visit already stores; nothing new is written to read it.
 *
 *   A  Desk → vitals    `opd_encounters.opened_at` (the desk opened the visit and the token)
 *                       → the visit's FIRST `opd_vitals.recorded_at` (an amendment later is not a wait)
 *   B  Vitals → doctor  that first save → `opd_encounters.consult_started_at`
 *   C  Desk → doctor    A + B, for a visit that has both
 *
 * WHICH VISITS. OPD consultations only: `type = 'opd'`, not a pharmacy visit and not a lab walk-in.
 * There is no tele-call or channel column on the visit on this branch, so nothing more can be told
 * apart. Then, per visit, the FIRST of these that applies drops its waits and is counted:
 *   guardian      a guardian came alone (`patient_absent_at`) — nobody to weigh
 *   left          the visit was abandoned, or its token `left` the line
 *   paperNoStart  closed from paper with no start of its own (`consult_started_at = paper_completed_at`):
 *                 only leg B is dropped — the desk → vitals wait was real
 *   reEntry       sent back through the line with results: the start on record is the SECOND one,
 *                 so leg B is dropped
 *   outOfRange    a leg under 0 or over `FLOW_MAX_WAIT_MIN` minutes — that leg (and C) dropped
 *
 * "DESK → PAID" IS NOT BUILT. No column stamps the moment the consultation fee was settled: the fee's
 * state is derived from the visit's invoices and their receipts (`billing`), and a visit can be paid by
 * one of several invoices. A sub-leg built on that guess would be a number shown as fact that is not one.
 *
 * NO NAMES. Rows carry a department id, a day and three instants — no patient, no doctor, no clerk.
 */

export type FlowVisit = {
  departmentId: string | null;
  serviceDate: string;
  openedAt: Date;
  vitalsAt: Date | null;
  startedAt: Date | null;
  guardian: boolean;
  left: boolean;
  paperNoStart: boolean;
  reEntry: boolean;
};

/** One leg of one visit: its minutes and the instant it started (for the by-hour strip). */
export type LegValue = { min: number; at: Date };
export type VisitLegs = {
  departmentId: string | null;
  serviceDate: string;
  legs: Partial<Record<FlowLeg, LegValue>>;
  drop: keyof FlowDrops | null;
};

const minutesBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 60_000;
const inRange = (m: number): boolean => m >= 0 && m <= FLOW_MAX_WAIT_MIN;

/** Pure: a visit's three legs, and why any of them was left out. */
export function legsOf(v: FlowVisit): VisitLegs {
  const out: VisitLegs = { departmentId: v.departmentId, serviceDate: v.serviceDate, legs: {}, drop: null };
  if (v.guardian) { out.drop = "guardian"; return out; }
  if (v.left) { out.drop = "left"; return out; }
  let a: LegValue | null = null;
  let b: LegValue | null = null;
  if (v.vitalsAt !== null) {
    const m = minutesBetween(v.openedAt, v.vitalsAt);
    if (inRange(m)) a = { min: m, at: v.openedAt }; else out.drop = "outOfRange";
  }
  if (v.vitalsAt !== null && v.startedAt !== null) {
    if (v.paperNoStart) out.drop ??= "paperNoStart";
    else if (v.reEntry) out.drop ??= "reEntry";
    else {
      const m = minutesBetween(v.vitalsAt, v.startedAt);
      if (inRange(m)) b = { min: m, at: v.vitalsAt }; else out.drop ??= "outOfRange";
    }
  }
  if (a !== null) out.legs.deskToVitals = a;
  if (b !== null) out.legs.vitalsToDoctor = b;
  if (a !== null && b !== null) out.legs.deskToDoctor = { min: a.min + b.min, at: v.openedAt };
  return out;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Median of sorted values (the mean of the middle two for an even count). */
export function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
/** The 90th percentile, nearest rank. */
export function p90Of(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)]!;
}

/** n, Avg, median and p90 — the three figures null below `FLOW_MIN_N`. */
export function statOf(values: readonly number[]): FlowStat {
  const n = values.length;
  if (n < FLOW_MIN_N) return { n, avg: null, median: null, p90: null };
  const sorted = [...values].sort((x, y) => x - y);
  return { n, avg: round1(sorted.reduce((s, x) => s + x, 0) / n), median: round1(medianOf(sorted)!), p90: round1(p90Of(sorted)!) };
}

export function cellOf(visits: readonly VisitLegs[], pick: (leg: FlowLeg, v: VisitLegs) => boolean = () => true): FlowCell {
  const cell = {} as FlowCell;
  for (const leg of FLOW_LEGS) {
    const values: number[] = [];
    for (const v of visits) { const l = v.legs[leg]; if (l !== undefined && pick(leg, v)) values.push(l.min); }
    cell[leg] = statOf(values);
  }
  return cell;
}

export function dropsOf(visits: readonly VisitLegs[]): FlowDrops {
  const d: FlowDrops = { guardian: 0, left: 0, paperNoStart: 0, reEntry: 0, outOfRange: 0 };
  for (const v of visits) if (v.drop !== null) d[v.drop] += 1;
  return d;
}

/** The IST hour (0–23) of an instant. */
export function istHour(at: Date): number {
  return new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Every OPD consultation visit with a service day in `from`..`to`, as the instants the legs need. */
export async function loadFlowVisits(db: Db | Tx, range: DayRange): Promise<FlowVisit[]> {
  const res = await db.execute(sql`
    select e.department_id, e.service_date::text as service_date, e.opened_at, e.consult_started_at,
           (e.patient_absent_at is not null) as guardian,
           (e.status = 'abandoned' or e.abandoned_at is not null
              or exists (select 1 from opd_queue_entries q where q.encounter_id = e.id and q.status = 'left')) as left_line,
           (e.completed_via = 'paper' and e.consult_started_at is not null and e.consult_started_at = e.paper_completed_at) as paper_no_start,
           exists (select 1 from opd_queue_entries q where q.encounter_id = e.id and q.re_entry) as re_entry,
           (select min(v.recorded_at) from opd_vitals v where v.encounter_id = e.id) as vitals_at
      from opd_encounters e
      left join opd_departments d on d.id = e.department_id
     where e.service_date between ${range.from} and ${range.to}
       and e.type = 'opd'
       and e.visit_type <> ${PHARMACY_VISIT_TYPE}
       and (d.code is null or d.code <> ${LAB_DEPARTMENT_CODE})
  `);
  const at = (x: unknown): Date | null => (x === null || x === undefined ? null : x instanceof Date ? x : new Date(String(x)));
  return res.rows.map((r) => ({
    departmentId: (r["department_id"] as string | null) ?? null,
    serviceDate: String(r["service_date"]),
    openedAt: at(r["opened_at"])!,
    vitalsAt: at(r["vitals_at"]),
    startedAt: at(r["consult_started_at"]),
    guardian: r["guardian"] === true,
    left: r["left_line"] === true,
    paperNoStart: r["paper_no_start"] === true,
    reEntry: r["re_entry"] === true,
  }));
}

/* ═══ what the caller asked for ═══ */

export type FlowAsk = { range: DayRange; compare: DayRange | null; groupBy: FlowGroupBy | null; departmentId: string | null };
export type FlowAskProblem = RangeProblem | "bad_group" | "bad_department";

/**
 * `period=today|week|month` (the server's own today, from the clock it is HANDED) or `from`/`to` with an
 * optional `cfrom`/`cto`; `groupBy`; `departmentId`. A named period is compared like with like through
 * the contract's `ownerRange`: today ↔ the same weekday last week, week ↔ the previous week to the same
 * weekday, month ↔ the previous month to the same day number.
 */
export function flowAskOf(query: unknown, now: Date): { ok: true; ask: FlowAsk } | { ok: false; problem: FlowAskProblem } {
  const q = (query ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof q[k] === "string" && (q[k] as string).length <= 64 ? (q[k] as string) : undefined);
  const today = istDate(now);
  const groupBy = str("groupBy");
  if (groupBy !== undefined && !(FLOW_GROUP_BYS as readonly string[]).includes(groupBy)) return { ok: false, problem: "bad_group" };
  const departmentId = str("departmentId") ?? null;
  if (q["departmentId"] !== undefined && departmentId === null) return { ok: false, problem: "bad_department" };
  const period = str("period");
  let range: DayRange; let compare: DayRange | null;
  if (period === "today" || period === "week" || period === "month") {
    const r = ownerRange(period, today)!;
    range = { from: r.from, to: r.to }; compare = r.compare;
  } else {
    if (period !== undefined) return { ok: false, problem: "bad_date" };
    const from = str("from") ?? str("to") ?? today, to = str("to") ?? str("from") ?? today;
    const bad = rangeProblem(from, to, today);
    if (bad !== null) return { ok: false, problem: bad };
    range = { from, to };
    if (q["cfrom"] === undefined && q["cto"] === undefined) compare = null;
    else {
      const cbad = rangeProblem(q["cfrom"], q["cto"], today);
      if (cbad !== null) return { ok: false, problem: cbad };
      compare = { from: q["cfrom"] as string, to: q["cto"] as string };
    }
  }
  return { ok: true, ask: { range, compare, groupBy: (groupBy as FlowGroupBy | undefined) ?? null, departmentId } };
}

/* ═══ the report ═══ */

function groupsOf(visits: readonly VisitLegs[], ask: FlowAsk, names: Map<string, string>): FlowGroup[] {
  if (ask.groupBy === "department") {
    const by = new Map<string, VisitLegs[]>();
    for (const v of visits) if (v.departmentId !== null) by.set(v.departmentId, [...(by.get(v.departmentId) ?? []), v]);
    const groups = [...by.entries()].map(([key, vs]) => ({ key, name: names.get(key) ?? null, cell: cellOf(vs) }));
    /* Ranked by the desk → doctor median, longest first; a department below the floor goes last. */
    return groups.sort((x, y) => (y.cell.deskToDoctor.median ?? -1) - (x.cell.deskToDoctor.median ?? -1)
      || y.cell.deskToDoctor.n - x.cell.deskToDoctor.n || (x.name ?? x.key).localeCompare(y.name ?? y.key));
  }
  if (ask.groupBy === "day") {
    const out: FlowGroup[] = [];
    for (let d = ask.range.from; d <= ask.range.to; d = addDayIso(d, 1)) out.push({ key: d, name: null, cell: cellOf(visits.filter((v) => v.serviceDate === d)) });
    return out;
  }
  if (ask.groupBy === "weekday") {
    return Array.from({ length: 7 }, (_, w) => ({ key: String(w), name: null, cell: cellOf(visits.filter((v) => mondayIndex(v.serviceDate) === w)) }));
  }
  if (ask.groupBy === "hour") {
    const out: FlowGroup[] = [];
    /* Each leg falls in the hour it STARTED: A and C at the desk, B at the vitals save. */
    for (let h = FLOW_FIRST_HOUR; h <= FLOW_LAST_HOUR; h += 1) {
      out.push({ key: String(h).padStart(2, "0"), name: null, cell: cellOf(visits, (leg, v) => istHour(v.legs[leg]!.at) === h) });
    }
    return out;
  }
  return [];
}

const LEG_OF_DB: Record<string, FlowLeg> = { desk_vitals: "deskToVitals", vitals_doctor: "vitalsToDoctor", desk_doctor: "deskToDoctor" };
export const DB_LEG: Record<FlowLeg, string> = { deskToVitals: "desk_vitals", vitalsToDoctor: "vitals_doctor", deskToDoctor: "desk_doctor" };

type FindingRow = typeof opdFlowFindings.$inferSelect;
export function findingView(r: FindingRow, names: Map<string, string>): FlowFinding {
  const dept = r.scope === "hospital" ? null : r.scope;
  return {
    id: r.id, type: r.type as FindingType, departmentId: dept, department: dept === null ? null : (names.get(dept) ?? null),
    leg: LEG_OF_DB[r.leg] ?? "deskToDoctor", weekday: r.weekday, hourFrom: r.hourFrom, hourTo: r.hourTo,
    observed: round1(r.observedMin), baseline: round1(r.baselineMin), patients: r.patients, minutesLost: r.minutesLost,
    firstSeen: r.firstSeen, lastSeen: r.lastSeen, state: r.state as FindingState,
    triedOn: r.triedAt === null ? null : istDate(r.triedAt),
    before: r.beforeMedianMin === null ? null : round1(r.beforeMedianMin),
    after: r.afterMedianMin === null ? null : round1(r.afterMedianMin),
    resolvedOn: r.resolvedOn, minutesWon: r.minutesWon,
  };
}

/**
 * ═══ SEAM — A CHOOSER MAY LATER ONLY RANK ═══
 * `rankFindings` orders the open findings shown to the owner. Today it is minutes lost, largest first.
 * A later chooser (a model behind the house's `ChoiceClient`) may be passed in its place, and it can
 * ONLY reorder the ids it was given: anything it adds is ignored and anything it drops is put back at the
 * end. It never writes a finding, a number or a sentence. Nothing calls a model in this version.
 */
export type FindingRanker = (open: readonly FlowFinding[]) => readonly string[];
export const byMinutesLost: FindingRanker = (open) => [...open].sort((x, y) => y.minutesLost - x.minutesLost || x.id.localeCompare(y.id)).map((f) => f.id);

export function rankFindings(open: readonly FlowFinding[], ranker: FindingRanker = byMinutesLost): FlowFinding[] {
  const byId = new Map(open.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const out: FlowFinding[] = [];
  for (const id of ranker(open)) { const f = byId.get(id); if (f !== undefined && !seen.has(id)) { seen.add(id); out.push(f); } }
  for (const f of open) if (!seen.has(f.id)) out.push(f);
  return out;
}

export async function departmentNames(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db.select({ id: opdDepartments.id, name: opdDepartments.name }).from(opdDepartments);
  return new Map(rows.map((d) => [d.id, d.name]));
}

export async function loadFlowReport(
  db: Db, ask: FlowAsk, opts: { mayAct: boolean; learning: boolean; now: Date },
): Promise<FlowReport> {
  const scoped = (vs: VisitLegs[]): VisitLegs[] => (ask.departmentId === null ? vs : vs.filter((v) => v.departmentId === ask.departmentId));
  const visits = scoped((await loadFlowVisits(db, ask.range)).map(legsOf));
  const names = await departmentNames(db);
  let previous: FlowReport["previous"] = null;
  if (ask.compare !== null) {
    const before = scoped((await loadFlowVisits(db, ask.compare)).map(legsOf));
    previous = { ...ask.compare, ...cellOf(before) };
  }
  let findings: FlowFinding[] = [];
  let fixed: FlowFinding[] = [];
  if (opts.learning) {
    const fixedSince = addDayIso(istDate(opts.now), -FIXED_SHOWN_DAYS);
    const live = await db.select().from(opdFlowFindings).where(eq(opdFlowFindings.state, "open"));
    const done = await db.select().from(opdFlowFindings)
      .where(and(eq(opdFlowFindings.state, "resolved"), gte(opdFlowFindings.resolvedOn, fixedSince)));
    const mine = (r: FindingRow): boolean => ask.departmentId === null || r.scope === ask.departmentId || r.scope === "hospital";
    findings = rankFindings(live.filter(mine).map((r) => findingView(r, names)));
    fixed = done.filter(mine).map((r) => findingView(r, names)).sort((x, y) => (y.resolvedOn ?? "").localeCompare(x.resolvedOn ?? "") || x.id.localeCompare(y.id));
  }
  return {
    from: ask.range.from, to: ask.range.to, groupBy: ask.groupBy, departmentId: ask.departmentId,
    hospital: cellOf(visits), previous, groups: groupsOf(visits, ask, names), drops: dropsOf(visits),
    findings, fixed, mayAct: opts.mayAct, learning: opts.learning,
  };
}

