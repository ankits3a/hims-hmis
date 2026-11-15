import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDayString } from "../../kernel/approvals/cumulative";
import { roleAssignments, rolePermissions } from "../../kernel/db/schema/auth";
import { doseRegister } from "../../kernel/db/schema/aerb";
import {
  imagingAutomationRuns, imagingCriticalFindings, imagingFollowups, imagingReportDelivery, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { rosterOfficiating, rosterTeams } from "../../kernel/db/schema/roster";
import { ROSTER_PUBLISH, orgDepartmentByCode } from "../roster";
import { activeUsers, addIstDays, automationEnabled, istStart, permissionHolders, runOnce } from "./automation";
import { registerCompleteness } from "./completeness";
import { imagingDevices } from "./devices";
import { RadiologyError } from "./errors";
import { northStar } from "./north-star";
import { supervisorQuality } from "./supervisor";
import type { NorthStarSource } from "./north-star";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #1085 (IM6c) — THE HOD'S MORNING DIGEST: ONE ROW A DAY, A BELL, COUNTS AND MINUTES ONLY ═══
 *
 * The HOD had live views and no morning summary. At 08:00 IST this reads YESTERDAY (IST) through the
 * functions the HOD's own screens already use — `northStar` for studies and turnaround by modality and
 * source, `supervisorQuality` for the repeat rate, `registerCompleteness` for the register gaps,
 * `imagingDevices` for machines out of service — plus five counts the department already keeps (doses
 * above the reference level with no reason, reports unread over 24 h, open criticals, overdue follow-ups,
 * no-shows). It stores the digest as the day's `imaging_automation_runs` row and rings the department head.
 *
 * NO NAMES, NO GENERATED TEXT: the row holds counts and minutes, never a patient, a UHID or a person; the
 * bell is a fixed sentence with three numbers in it. A source that fails to read is `null` in the digest
 * ("not measured"), never a zero and never the end of the digest.
 */

export type DigestModalityRow = {
  modality: string; source: NorthStarSource; ordered: number;
  orderToSignedMedianMin: number | null; orderToSignedP90Min: number | null;
};

export type HodDigest = {
  reportDay: string;
  modalities: DigestModalityRow[];
  total: { ordered: number; orderToSignedMedianMin: number | null; orderToSignedP90Min: number | null } | null;
  repeatRate: { value: number | null; numerator: number | null; denominator: number | null } | null;
  dosesOverDrlWithoutReason: number | null;
  reportsUnreadOver24h: number | null;
  openCriticals: number | null;
  overdueFollowups: number | null;
  noShows: number | null;
  machinesDown: number | null;
  registerGaps: { pcpndt: number; aerb: number } | null;
};

const OUT_OF_SERVICE = ["down", "maintenance", "qa_blocked"];
const UNREAD_HOURS = 24;

async function measured<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch { return null; }
}
const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]?.n ?? 0;

/** Builds the digest for `reportDay` (pure reads). `now` is the run's instant: "unread over 24 h" is as of then. */
export async function buildHodDigest(db: Db, reportDay: string, now: Date): Promise<HodDigest> {
  const lo = istStart(reportDay);
  const hi = istStart(addIstDays(reportDay, 1));
  const today = addIstDays(reportDay, 1);
  const north = await measured(() => northStar(db, { from: reportDay, to: reportDay, now }));
  const quality = await measured(() => supervisorQuality(db, { from: reportDay, to: reportDay, now }));
  const repeat = quality?.indicators.find((i) => i.key === "repeat_rate");
  const gaps = await measured(() => registerCompleteness(db, { day: reportDay }));
  const n = sql<number>`count(*)::int`;
  return {
    reportDay,
    modalities: (north?.rows ?? []).map((r) => ({
      modality: r.modality, source: r.source, ordered: r.ordered,
      orderToSignedMedianMin: r.orderToSigned.medianMin, orderToSignedP90Min: r.orderToSigned.p90Min,
    })),
    total: north === null ? null : {
      ordered: north.total.ordered, orderToSignedMedianMin: north.total.orderToSigned.medianMin, orderToSignedP90Min: north.total.orderToSigned.p90Min,
    },
    repeatRate: repeat === undefined ? null : { value: repeat.value, numerator: repeat.numerator, denominator: repeat.denominator },
    dosesOverDrlWithoutReason: await measured(() => count(db.select({ n }).from(doseRegister).where(and(
      eq(doseRegister.source, "imaging"), eq(doseRegister.overDrl, true), isNull(doseRegister.drlReason),
      sql`${doseRegister.occurredAt} >= ${lo} and ${doseRegister.occurredAt} < ${hi}`,
    )))),
    reportsUnreadOver24h: await measured(() => count(db.select({ n }).from(imagingReports)
      .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
      .where(and(
        eq(imagingReports.status, "signed"), sql`${imagingReports.publishedAt} is not null`,
        lt(imagingReports.publishedAt, new Date(now.getTime() - UNREAD_HOURS * 3_600_000)), isNull(imagingReportDelivery.firstReadAt),
      )))),
    openCriticals: await measured(() => count(db.select({ n }).from(imagingCriticalFindings).where(isNull(imagingCriticalFindings.acknowledgedAt)))),
    overdueFollowups: await measured(() => count(db.select({ n }).from(imagingFollowups).where(and(
      inArray(imagingFollowups.state, ["open", "notified"]), lt(imagingFollowups.dueOn, today),
    )))),
    noShows: await measured(() => count(db.select({ n }).from(imagingStudies).where(and(
      eq(imagingStudies.status, "no_show"), sql`${imagingStudies.scheduledAt} >= ${lo} and ${imagingStudies.scheduledAt} < ${hi}`,
    )))),
    machinesDown: await measured(async () => (await imagingDevices(db, today)).filter((d) => OUT_OF_SERVICE.includes(d.status)).length),
    registerGaps: gaps === null ? null : gaps.counts,
  };
}

/** The bell: a fixed sentence, three counts, no name. */
export function digestBell(d: HodDigest): { title: string; body: string } {
  const ordered = d.total?.ordered ?? 0;
  const gaps = d.registerGaps === null ? 0 : d.registerGaps.pcpndt + d.registerGaps.aerb;
  return {
    title: `Imaging morning digest · ${d.reportDay}`,
    body: `${String(ordered)} stud${ordered === 1 ? "y" : "ies"} ordered, ${String(d.reportsUnreadOver24h ?? 0)} report(s) unread over 24 h, `
      + `${String(d.openCriticals ?? 0)} open critical(s), ${String(gaps)} register gap(s). Open the HOD station to read it.`,
  };
}

/**
 * THE DEPARTMENT HEAD — the roster's two records, as the Doctor Desk's report reads them: an officiating
 * `hod` in force on one of the Radiology department's teams, or a department-scoped grant of
 * `roster.periods.publish`. DECIDED: when the roster names nobody, the bell goes to the holders of the HOD
 * station's own grant (`radiology.definitions.manage`), so the digest is never written to an empty room.
 */
export async function radiologyHeads(exec: Db | Tx, now: Date): Promise<string[]> {
  const dept = await orgDepartmentByCode(exec, "RAD");
  const ids: string[] = [];
  if (dept !== undefined) {
    const standIn = await (exec as Db).select({ userId: rosterOfficiating.userId }).from(rosterOfficiating)
      .innerJoin(rosterTeams, eq(rosterTeams.id, rosterOfficiating.teamId))
      .where(and(
        eq(rosterTeams.departmentId, dept.id), eq(rosterOfficiating.role, "hod"),
        ne(rosterOfficiating.approvedBy, rosterOfficiating.userId),
        lte(rosterOfficiating.startsAt, now), or(isNull(rosterOfficiating.endsAt), gt(rosterOfficiating.endsAt, now)),
      ));
    const grants = await (exec as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
      .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
      .where(and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, dept.id), eq(rolePermissions.permission, ROSTER_PUBLISH)));
    ids.push(...standIn.map((r) => r.userId), ...grants.map((r) => r.userId));
  }
  const heads = await activeUsers(exec, ids);
  return heads.length > 0 ? heads : permissionHolders(exec, "radiology.definitions.manage");
}

export const DIGEST_ALERT_KIND = "imaging_hod_digest";

export type DigestSweep = { ran: boolean; enabled: boolean; runId: string | null; digest: HodDigest | null; bells: number };

export async function sendHodDigest(db: Db, now: Date): Promise<DigestSweep> {
  if (!(await automationEnabled(db, "hod_digest"))) return { ran: false, enabled: false, runId: null, digest: null, bells: 0 };
  const day = istDayString(now);
  const reportDay = addIstDays(day, -1);
  /** A cheap look first, so a second run does not read the department again only to find the row taken. */
  const taken = await db.select({ id: imagingAutomationRuns.id }).from(imagingAutomationRuns)
    .where(and(eq(imagingAutomationRuns.kind, "hod_digest"), eq(imagingAutomationRuns.day, day)));
  if (taken.length > 0) return { ran: false, enabled: true, runId: null, digest: null, bells: 0 };
  const digest = await buildHodDigest(db, reportDay, now);
  let bells = 0;
  const run = await runOnce(db, "hod_digest", day, now, async (tx, runId) => {
    const bell = digestBell(digest);
    for (const userId of await radiologyHeads(tx, now)) {
      if (await raiseNotice(tx as unknown as Db, {
        userId, kind: DIGEST_ALERT_KIND, title: bell.title, body: bell.body, refType: "imaging_automation_run", refId: runId,
        sourceKey: `imaging-hod-digest:${reportDay}`, at: now,
      })) bells += 1;
    }
    return { ...digest, bells } as Record<string, unknown>;
  });
  return run.ran ? { ran: true, enabled: true, runId: run.runId, digest, bells } : { ran: false, enabled: true, runId: null, digest: null, bells: 0 };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The HOD's read: the digest stored for a run day (default: the newest), or null when none was sent. */
export async function storedDigest(db: Db, input: { day?: string } = {}): Promise<{ day: string; ranAt: string; digest: HodDigest } | null> {
  if (input.day !== undefined && !DAY_RE.test(input.day)) throw new RadiologyError("invalid_date", "day is a calendar day, YYYY-MM-DD");
  const row = (await db.select().from(imagingAutomationRuns)
    .where(input.day === undefined ? eq(imagingAutomationRuns.kind, "hod_digest")
      : and(eq(imagingAutomationRuns.kind, "hod_digest"), eq(imagingAutomationRuns.day, input.day)))
    .orderBy(desc(imagingAutomationRuns.day)).limit(1))[0];
  if (row === undefined) return null;
  return { day: row.day, ranAt: row.ranAt.toISOString(), digest: row.counts as HodDigest };
}
