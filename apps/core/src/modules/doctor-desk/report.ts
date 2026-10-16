import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { RATING_MIN_OWN, RATING_MIN_POOL_PEOPLE, RATING_MIN_POOL_RATINGS, newId } from "@hmis/contracts";
import type { Actor, WireUnitReport, WireUnitReports } from "@hmis/contracts";
import { doctorDeskActs, doctorDeskAgentRuns, orgDepartments } from "../../kernel/db/schema";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { doctorDayLines } from "../opd";
import { addIstDays, countingUnits, istDateOfInstant, istMidnightUtc, istMinutesOfInstant, shortUnitName, teamMembers } from "../roster";
import type { RosterTeamRow } from "../roster";
import { deskLevel, deskScope } from "./scope";
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
 * and the MS for all. HOD daily and MS weekly delivery (D8) are follow-ups.
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
 * THE 08:00 JOB. Every counting unit gets its report once per report date. One unit failing records a
 * failed run for that unit and never stops the others. Returns how many reports were sent this run.
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
  let sent = 0;
  let failed = 0;
  for (const unit of units) {
    try {
      const built = await buildUnitReport(db, unit, depts.get(unit.departmentId) ?? "", reportDate, now, {
        department: all.filter((a) => a.teamId !== null && deptOf.get(a.teamId) === unit.departmentId), hospital: all,
      });
      const heads = (await teamMembers(db, unit.id, now)).filter((m) => m.roleInTeam === "head").map((m) => m.userId);
      if (await deliver(db, built, [...new Set(heads)], now, deps)) sent += 1;
    } catch {
      failed += 1;
      await db.insert(doctorDeskAgentRuns).values({
        id: newId(), agent: REPORT_AGENT, teamId: unit.id, userId: null, outcome: "failed",
        summaryKey: "reportFailed", params: { reportDate }, ranAt: now,
      }).catch(() => undefined);
    }
  }
  return { sent, failed };
}

async function deliver(db: Db, built: Built, heads: string[], now: Date, deps: ReportDeps): Promise<boolean> {
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`doctor-desk-report:${built.teamId}:${built.reportDate}`}))`);
    const done = await tx.select({ id: doctorDeskAgentRuns.id }).from(doctorDeskAgentRuns).where(and(
      eq(doctorDeskAgentRuns.agent, REPORT_AGENT), eq(doctorDeskAgentRuns.teamId, built.teamId), isNull(doctorDeskAgentRuns.userId),
      eq(doctorDeskAgentRuns.outcome, "ok"), sql`${doctorDeskAgentRuns.params}->>'reportDate' = ${built.reportDate}`,
    )).limit(1);
    if (done.length > 0) return false;
    const runId = newId();
    await tx.insert(doctorDeskAgentRuns).values({
      id: runId, agent: REPORT_AGENT, teamId: built.teamId, userId: null, outcome: "ok", summaryKey: "reportSent",
      params: { reportDate: built.reportDate, heads: heads.length, report: built }, ranAt: now,
    });
    const bell = reportBell(built);
    for (const userId of heads) {
      await deps.raise(tx as unknown as Db, {
        userId, kind: REPORT_ALERT_KIND, title: bell.title, body: bell.body,
        refType: "doctor_desk_unit_report", refId: runId, sourceKey: `doctor-desk-report:${built.teamId}:${built.reportDate}`, at: now,
      });
    }
    return true;
  });
}

/**
 * THE PAGE: the reports the asker may read, newest first, the last 14 days. A head reads their unit's,
 * a HOD their department's units', the MS every unit's; anyone else reads none (the report goes to the
 * unit head, D8 — the page says so).
 */
export async function reportsFor(db: Db, actor: Actor, at: Date): Promise<WireUnitReports> {
  const scope = await deskScope(db, actor, at);
  const level = await deskLevel(db, actor, scope, at);
  let teamIds: string[] | null = [];
  if (level.level === "hospital") teamIds = null;
  else if (level.level === "department") teamIds = (await countingUnits(db, at)).filter((u) => u.departmentId === level.departmentId).map((u) => u.id);
  else if (level.level === "unit" && scope.unit !== null) teamIds = [scope.unit.teamId];
  if (teamIds !== null && teamIds.length === 0) return { scope: level, reports: [] };
  const since = addIstDays(istDateOfInstant(at), -REPORT_DAYS_KEPT_ON_PAGE);
  const rows = await db.select().from(doctorDeskAgentRuns).where(and(
    eq(doctorDeskAgentRuns.agent, REPORT_AGENT), eq(doctorDeskAgentRuns.outcome, "ok"), isNull(doctorDeskAgentRuns.userId),
    teamIds === null ? undefined : inArray(doctorDeskAgentRuns.teamId, teamIds),
    sql`${doctorDeskAgentRuns.params}->>'reportDate' >= ${since}`,
  )).orderBy(desc(doctorDeskAgentRuns.ranAt));
  return {
    scope: level,
    reports: rows.map((r) => ({ ...((r.params as { report: Built }).report), id: r.id, sentAt: r.ranAt.toISOString() })),
  };
}
