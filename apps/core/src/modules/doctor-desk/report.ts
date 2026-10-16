import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { RATING_MIN_OWN, RATING_MIN_POOL_PEOPLE, RATING_MIN_POOL_RATINGS, WEEKLY_REPORT_DAYS, newId } from "@hmis/contracts";
import type { Actor, WireDepartmentReport, WireDepartmentWeekRow, WireHospitalReport, WireUnitReport, WireUnitReports } from "@hmis/contracts";
import { doctorDeskActs, doctorDeskAgentRuns, orgDepartments } from "../../kernel/db/schema";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { doctorDayLines } from "../opd";
import { addIstDays, countingUnits, istDateOfInstant, istMidnightUtc, istMinutesOfInstant, istWeekday, shortUnitName, teamMembers } from "../roster";
import type { RosterTeamRow } from "../roster";
import { departmentHeads, deskLevel, deskScope, superintendents } from "./scope";
import { LAB_CRITICAL_DUE_MINUTES, owedByUnit } from "./owed";
import { medianMinutes, minutesBetween } from "./acts";
import type { ActRow } from "./acts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ DD-report v0 — THE UNIT'S REPORT, SENT AT 08:00 IST, NOBODY TYPED IT (plan DD-R.1/R.2) ═══
 *
 * Owner R4 (2026-09-18): *"the agent … sends the unit's report automatically."* At 08:00 IST — the take
 * boundary (D-G) — for the 24 h that ended then, one report per counting unit:
 *   · critical values → act: how many acts, the median, how many over 15 min, the longest (DD-1.3's
 *     `doctor_desk_acts`, so the clock is the ACT, not the acknowledgement — D3);
 *   · the same median for the department and the hospital beside it, anonymous, only above the
 *     ratings' floors (one rule for every average the Desk shows: owner 2026-10-09);
 *   · the unit's OPD on the day before (seen, doctors with a session);
 *   · what the unit owed at 08:00, how much past its time, criticals still without an act.
 *
 * COUNTS ONLY (D8): no patient, no UHID, no person's name, in the stored report, the bell or the page.
 * Wording is neutral; nothing is ranked.
 *
 * IDEMPOTENT PER UNIT PER DAY: the report is the `doctor_desk_agent_runs` row (`agent = unit_report`,
 * the report in `params.report`), written under a transaction-scoped advisory lock keyed on unit+date
 * and only when no such row exists; the bell's source key is the same unit+date, so a second run —
 * a restart at 08:00, a double tick — writes nothing (DD-R.1 acceptance, plan E31). DECIDED: the run
 * log already IS "what the Desk's jobs did for this unit" (DD-0.9), so the report needs no table of
 * its own and DD-report adds no migration.
 *
 * Delivered to the unit's head — and to an officiating head, who stands in (plan E07) — as a bell, and
 * kept on `/doctor-desk/report`, which a head reads for their unit, a HOD for their department's units
 * and the MS for all. The same run makes the HOD's daily report (the department's units side by side) and,
 * on a Monday, the MS's weekly report (the 7 days before, every department) — D8. The WhatsApp/SMS count
 * line waits for an approved template.
 */
export const REPORT_AGENT = "unit_report";
export const REPORT_ALERT_KIND = "doctor_desk_unit_report";
export const REPORT_DAYS_KEPT_ON_PAGE = 14;
const REPORT_MINUTE = 8 * 60;

/** The report date a run at `now` makes: today's if it is 08:00 IST or later, else yesterday's. */
export function reportDateAt(now: Date): string {
  const today = istDateOfInstant(now);
  return istMinutesOfInstant(now) >= REPORT_MINUTE ? today : addIstDays(today, -1);
}

const eightOf = (istDate: string): Date => new Date(istMidnightUtc(istDate).getTime() + REPORT_MINUTE * 60_000);

/** A pool's median critical→act: null unless enough units contribute and enough acts exist. */
function poolMedian(acts: readonly ActRow[]): number | null {
  const units = new Set(acts.map((a) => a.teamId).filter((x): x is string => x !== null));
  return units.size < RATING_MIN_POOL_PEOPLE || acts.length < RATING_MIN_POOL_RATINGS ? null : medianMinutes(acts);
}

type Built = Omit<WireUnitReport, "id" | "sentAt">;

/** Builds one unit's report for `reportDate`. Pure reads; `pools` are the window's acts (department, hospital). */
export async function buildUnitReport(
  db: Db, unit: RosterTeamRow, departmentName: string, reportDate: string, now: Date,
  pools: { department: readonly ActRow[]; hospital: readonly ActRow[] },
): Promise<Built> {
  const to = eightOf(reportDate);
  const from = new Date(to.getTime() - 86_400_000);
  // The pools are the window's acts already (`sendUnitReports` reads exactly [08:00 − 24 h, 08:00)).
  const acts = pools.hospital.filter((a) => a.teamId === unit.id);
  const minutes = acts.map((a) => minutesBetween(a.openedAt, a.actedAt));
  const members = (await teamMembers(db, unit.id, now)).map((m) => ({ userId: m.userId, name: "" }));
  const owed = await owedByUnit(db, members, now).catch(() => []);
  const opdDate = addIstDays(reportDate, -1);
  const lines = (await doctorDayLines(db, members.map((m) => m.userId), opdDate, now).catch(() => [])).filter((l) => l.session !== "none");
  return {
    teamId: unit.id, unitName: unit.name, short: shortUnitName(unit.name, departmentName), departmentName,
    reportDate, windowFrom: from.toISOString(), windowTo: to.toISOString(),
    critical: {
      acts: acts.length, median: acts.length < RATING_MIN_OWN ? null : medianMinutes(acts),
      over: minutes.filter((m) => m > LAB_CRITICAL_DUE_MINUTES).length,
      longest: minutes.length === 0 ? null : Math.max(...minutes), overMinutes: LAB_CRITICAL_DUE_MINUTES,
    },
    compare: { department: poolMedian(pools.department), hospital: poolMedian(pools.hospital) },
    opd: { date: opdDate, seen: lines.reduce((n, l) => n + l.seen, 0), doctors: lines.length },
    owed: {
      open: owed.length, past: owed.filter((r) => Date.parse(r.dueAt) < now.getTime()).length,
      criticalsWithoutAct: owed.filter((r) => r.kind === "lab_critical").length,
    },
  };
}

/** The bell's words: counts only, no patient, no person. */
export function reportBell(r: Built): { title: string; body: string } {
  const crit = r.critical.acts === 0 ? "No critical result was acted on."
    : `${String(r.critical.acts)} critical result${r.critical.acts === 1 ? "" : "s"} acted on${r.critical.median === null ? "" : `, median ${String(r.critical.median)} min`}.`;
  return {
    title: `Unit report · ${r.short} · ${r.reportDate}`,
    body: `${crit} ${String(r.owed.open)} item${r.owed.open === 1 ? "" : "s"} open at 08:00. Open the Doctor Desk to read it.`,
  };
}

export type ReportDeps = { raise: typeof raiseNotice };

/**
 * THE 08:00 JOB. Every counting unit gets its report once per report date; then every department with
 * a counting unit gets the HOD's daily report (its units side by side); and on a Monday the MS gets the
 * hospital's weekly report for the 7 days before (D8). One report failing records a failed run and
 * never stops the others. ONE job for all three (no new job name, so no new alert rule): the weekly is
 * a no-op on six days in seven, as `runMonthlyProposals` is on 29 in 30. Returns reports sent.
 */
export async function sendUnitReports(db: Db, now: Date, deps: ReportDeps = { raise: raiseNotice }): Promise<{ sent: number; failed: number }> {
  const reportDate = reportDateAt(now);
  const to = eightOf(reportDate);
  const from = new Date(to.getTime() - 86_400_000);
  const units = await countingUnits(db, now);
  if (units.length === 0) return { sent: 0, failed: 0 };
  const depts = new Map((await db.select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, [...new Set(units.map((u) => u.departmentId))]))).map((d) => [d.id, d.name] as const));
  const all = (await db.select().from(doctorDeskActs)
    .where(and(gte(doctorDeskActs.actedAt, from), lt(doctorDeskActs.actedAt, to)))) as ActRow[];
  const deptOf = new Map(units.map((u) => [u.id, u.departmentId] as const));
  const inDept = (acts: readonly ActRow[], departmentId: string): ActRow[] => acts.filter((a) => a.teamId !== null && deptOf.get(a.teamId) === departmentId);
  let sent = 0;
  let failed = 0;
  const failedRun = async (agent: string, teamId: string | null, params: Record<string, string>): Promise<void> => {
    failed += 1;
    await db.insert(doctorDeskAgentRuns).values({
      id: newId(), agent, teamId, userId: null, outcome: "failed", summaryKey: "reportFailed", params, ranAt: now,
    }).catch(() => undefined);
  };
  const built: Built[] = [];
  for (const unit of units) {
    try {
      const b = await buildUnitReport(db, unit, depts.get(unit.departmentId) ?? "", reportDate, now, {
        department: inDept(all, unit.departmentId), hospital: all,
      });
      built.push(b);
      const heads = (await teamMembers(db, unit.id, now)).filter((m) => m.roleInTeam === "head").map((m) => m.userId);
      if (await deliverOnce(db, {
        agent: REPORT_AGENT, teamId: unit.id, key: `doctor-desk-report:${unit.id}:${reportDate}`, reportDate,
        params: { reportDate, heads: heads.length, report: b }, to: [...new Set(heads)], bell: reportBell(b), refType: "doctor_desk_unit_report",
      }, now, deps)) sent += 1;
    } catch {
      await failedRun(REPORT_AGENT, unit.id, { reportDate });
    }
  }
  // The HOD's daily report: the same 24 h, the department's units side by side.
  for (const [departmentId, departmentName] of depts) {
    try {
      const report = departmentReport(departmentId, departmentName, reportDate, built.filter((b) => deptOf.get(b.teamId) === departmentId), inDept(all, departmentId), all);
      const heads = await departmentHeads(db, departmentId, now);
      if (await deliverOnce(db, {
        agent: DEPARTMENT_REPORT_AGENT, teamId: null, key: `doctor-desk-dept-report:${departmentId}:${reportDate}`, reportDate, departmentId,
        params: { reportDate, departmentId, heads: heads.length, report }, to: heads, bell: departmentBell(report), refType: "doctor_desk_department_report",
      }, now, deps)) sent += 1;
    } catch {
      await failedRun(DEPARTMENT_REPORT_AGENT, null, { reportDate, departmentId });
    }
  }
  // The MS's weekly report: Monday 08:00 IST, the seven days before it.
  if (istWeekday(reportDate) === 1) {
    try {
      const report = await hospitalReport(db, units, depts, reportDate, now);
      const ms = await superintendents(db);
      if (await deliverOnce(db, {
        agent: HOSPITAL_REPORT_AGENT, teamId: null, key: `doctor-desk-hospital-report:${reportDate}`, reportDate,
        params: { reportDate, heads: ms.length, report }, to: ms, bell: hospitalBell(report), refType: "doctor_desk_hospital_report",
      }, now, deps)) sent += 1;
    } catch {
      await failedRun(HOSPITAL_REPORT_AGENT, null, { reportDate });
    }
  }
  return { sent, failed };
}

export const DEPARTMENT_REPORT_AGENT = "department_report";
export const HOSPITAL_REPORT_AGENT = "hospital_report";

type DeptBuilt = Omit<WireDepartmentReport, "id" | "sentAt">;
type HospBuilt = Omit<WireHospitalReport, "id" | "sentAt">;

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

/** The HOD's daily report from the units' own reports: no new read, so the two can never disagree. */
export function departmentReport(
  departmentId: string, departmentName: string, reportDate: string, units: readonly Built[], deptActs: readonly ActRow[], allActs: readonly ActRow[],
): DeptBuilt {
  const to = eightOf(reportDate);
  const rows = units.map((u) => ({
    teamId: u.teamId, short: u.short, acts: u.critical.acts, median: u.critical.median, over: u.critical.over,
    owedOpen: u.owed.open, owedPast: u.owed.past, opdSeen: u.opd.seen,
  }));
  return {
    departmentId, departmentName, reportDate, windowFrom: new Date(to.getTime() - 86_400_000).toISOString(), windowTo: to.toISOString(),
    units: rows, median: poolMedian(deptActs), hospital: poolMedian(allActs),
    totals: {
      acts: sum(rows.map((r) => r.acts)), over: sum(rows.map((r) => r.over)), owedOpen: sum(rows.map((r) => r.owedOpen)),
      owedPast: sum(rows.map((r) => r.owedPast)), opdSeen: sum(rows.map((r) => r.opdSeen)),
    },
  };
}

/** The MS's weekly report: the 7 days before Monday 08:00, every department, counts only. */
export async function hospitalReport(
  db: Db, units: readonly RosterTeamRow[], depts: ReadonlyMap<string, string>, reportDate: string, now: Date,
): Promise<HospBuilt> {
  const to = eightOf(reportDate);
  const from = new Date(to.getTime() - WEEKLY_REPORT_DAYS * 86_400_000);
  const acts = (await db.select().from(doctorDeskActs)
    .where(and(gte(doctorDeskActs.actedAt, from), lt(doctorDeskActs.actedAt, to)))) as ActRow[];
  const days = Array.from({ length: WEEKLY_REPORT_DAYS }, (_, i) => addIstDays(reportDate, -(i + 1)));
  const rows: WireDepartmentWeekRow[] = [];
  for (const [departmentId, departmentName] of depts) {
    const mine = units.filter((u) => u.departmentId === departmentId);
    const ids = new Set(mine.map((u) => u.id));
    const deptActs = acts.filter((a) => a.teamId !== null && ids.has(a.teamId));
    let opdSeen = 0; let owedOpen = 0; let owedPast = 0;
    for (const u of mine) {
      const members = (await teamMembers(db, u.id, now)).map((m) => ({ userId: m.userId, name: "" }));
      for (const d of days) opdSeen += sum((await doctorDayLines(db, members.map((m) => m.userId), d, now).catch(() => [])).map((l) => l.seen));
      const owed = await owedByUnit(db, members, now).catch(() => []);
      owedOpen += owed.length;
      owedPast += owed.filter((r) => Date.parse(r.dueAt) < now.getTime()).length;
    }
    rows.push({
      departmentId, departmentName, units: mine.length, acts: deptActs.length, median: poolMedian(deptActs),
      over: deptActs.filter((a) => minutesBetween(a.openedAt, a.actedAt) > LAB_CRITICAL_DUE_MINUTES).length, opdSeen, owedOpen, owedPast,
    });
  }
  rows.sort((a, b) => a.departmentName.localeCompare(b.departmentName));
  return {
    reportDate, windowFrom: from.toISOString(), windowTo: to.toISOString(), days: WEEKLY_REPORT_DAYS,
    departments: rows, median: poolMedian(acts),
    totals: {
      acts: acts.length, over: sum(rows.map((r) => r.over)), opdSeen: sum(rows.map((r) => r.opdSeen)),
      owedOpen: sum(rows.map((r) => r.owedOpen)), owedPast: sum(rows.map((r) => r.owedPast)),
    },
  };
}

export function departmentBell(r: DeptBuilt): { title: string; body: string } {
  return {
    title: `Department report · ${r.departmentName} · ${r.reportDate}`,
    body: `${String(r.units.length)} unit${r.units.length === 1 ? "" : "s"} · ${String(r.totals.acts)} critical result${r.totals.acts === 1 ? "" : "s"} acted on · ${String(r.totals.owedOpen)} item${r.totals.owedOpen === 1 ? "" : "s"} open at 08:00. Open the Doctor Desk to read it.`,
  };
}

export function hospitalBell(r: HospBuilt): { title: string; body: string } {
  return {
    title: `Weekly hospital report · week to ${r.reportDate}`,
    body: `${String(r.departments.length)} department${r.departments.length === 1 ? "" : "s"} · ${String(r.totals.acts)} critical result${r.totals.acts === 1 ? "" : "s"} acted on in 7 days. Open the Doctor Desk to read it.`,
  };
}

type Delivery = {
  agent: string; teamId: string | null; key: string; reportDate: string; departmentId?: string;
  params: Record<string, unknown>; to: string[]; bell: { title: string; body: string }; refType: string;
};

/**
 * ONCE PER SCOPE PER PERIOD: a transaction-scoped advisory lock on the report's key, then the run row only
 * if none exists for that agent, scope and date; the bell's source key is the same key, so a second run
 * writes nothing anywhere.
 */
async function deliverOnce(db: Db, d: Delivery, now: Date, deps: ReportDeps): Promise<boolean> {
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${d.key}))`);
    const done = await tx.select({ id: doctorDeskAgentRuns.id }).from(doctorDeskAgentRuns).where(and(
      eq(doctorDeskAgentRuns.agent, d.agent), isNull(doctorDeskAgentRuns.userId), eq(doctorDeskAgentRuns.outcome, "ok"),
      d.teamId === null ? isNull(doctorDeskAgentRuns.teamId) : eq(doctorDeskAgentRuns.teamId, d.teamId),
      sql`${doctorDeskAgentRuns.params}->>'reportDate' = ${d.reportDate}`,
      d.departmentId === undefined ? undefined : sql`${doctorDeskAgentRuns.params}->>'departmentId' = ${d.departmentId}`,
    )).limit(1);
    if (done.length > 0) return false;
    const runId = newId();
    await tx.insert(doctorDeskAgentRuns).values({
      id: runId, agent: d.agent, teamId: d.teamId, userId: null, outcome: "ok", summaryKey: "reportSent", params: d.params, ranAt: now,
    });
    for (const userId of d.to) {
      await deps.raise(tx as unknown as Db, {
        userId, kind: REPORT_ALERT_KIND, title: d.bell.title, body: d.bell.body, refType: d.refType, refId: runId, sourceKey: d.key, at: now,
      });
    }
    return true;
  });
}

/**
 * THE PAGE: the reports the asker may read, newest first, the last 14 days. A head reads their unit's;
 * a HOD their department's units' and the department's daily report; the MS every unit's, every
 * department's and the hospital's weekly. Anyone else reads none (the page says where it goes).
 */
export async function reportsFor(db: Db, actor: Actor, at: Date): Promise<WireUnitReports> {
  const scope = await deskScope(db, actor, at);
  const level = await deskLevel(db, actor, scope, at);
  const none: WireUnitReports = { scope: level, reports: [], departments: [], hospital: [] };
  let teamIds: string[] | null = [];
  if (level.level === "hospital") teamIds = null;
  else if (level.level === "department") teamIds = (await countingUnits(db, at)).filter((u) => u.departmentId === level.departmentId).map((u) => u.id);
  else if (level.level === "unit" && scope.unit !== null) teamIds = [scope.unit.teamId];
  if (teamIds !== null && teamIds.length === 0) return none;
  const since = addIstDays(istDateOfInstant(at), -REPORT_DAYS_KEPT_ON_PAGE);
  const fresh = sql`${doctorDeskAgentRuns.params}->>'reportDate' >= ${since}`;
  const ok = and(eq(doctorDeskAgentRuns.outcome, "ok"), isNull(doctorDeskAgentRuns.userId), fresh);
  const rows = await db.select().from(doctorDeskAgentRuns).where(and(
    eq(doctorDeskAgentRuns.agent, REPORT_AGENT), ok, teamIds === null ? undefined : inArray(doctorDeskAgentRuns.teamId, teamIds),
  )).orderBy(desc(doctorDeskAgentRuns.ranAt));
  const deptRows = level.level !== "department" && level.level !== "hospital" ? [] : await db.select().from(doctorDeskAgentRuns).where(and(
    eq(doctorDeskAgentRuns.agent, DEPARTMENT_REPORT_AGENT), ok,
    level.level === "department" ? sql`${doctorDeskAgentRuns.params}->>'departmentId' = ${level.departmentId}` : undefined,
  )).orderBy(desc(doctorDeskAgentRuns.ranAt));
  const hospRows = level.level !== "hospital" ? [] : await db.select().from(doctorDeskAgentRuns)
    .where(and(eq(doctorDeskAgentRuns.agent, HOSPITAL_REPORT_AGENT), ok)).orderBy(desc(doctorDeskAgentRuns.ranAt));
  const stamp = <T>(r: { id: string; ranAt: Date; params: unknown }): T & { id: string; sentAt: string } =>
    ({ ...((r.params as { report: T }).report), id: r.id, sentAt: r.ranAt.toISOString() });
  return {
    scope: level,
    reports: rows.map((r) => stamp<Built>(r)),
    departments: deptRows.map((r) => stamp<DeptBuilt>(r)),
    hospital: hospRows.map((r) => stamp<HospBuilt>(r)),
  };
}
