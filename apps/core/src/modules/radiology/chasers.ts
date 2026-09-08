import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  imagingCriticalFindings, imagingReportDelivery, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { withTx } from "../../kernel/db/client";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { imagingCriticalOverdue, imagingReportUnread } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { CriticalCategoriesBody } from "./definitions";

/**
 * PLAN 18a-iii T5 / D7 — **THE TWO CHASERS. THEY ESCALATE TO A HUMAN, NEVER TO A STATUS.**
 *
 * 18a made the critical-communication SLA record-only on purpose: the tier book says a red finding
 * must reach a clinician within N minutes, and nothing in the tree ever asked whether it had.
 * `imaging_critical_findings`' own header left the note — *"the escalation ladder that chases an
 * unacknowledged critical at 02:00 is 18a-iii's, and it reads these rows."* This is that ladder, and
 * its twin for the report nobody opened.
 *
 * ═══ WHAT THEY DELIBERATELY DO NOT DO ═══
 *
 * Neither changes a study's status, cancels anything, closes a finding, or pages a rota. **D7 gives
 * these SLAs a voice, not teeth.** Each writes one mark saying it escalated and emits one event; the
 * alerts consumer turns that into a row in front of a human, and a human decides what happens next.
 *
 * That restraint is the design rather than a limitation. A chaser that could act would be an
 * automatic clinical decision made by a cron job at 02:00 on evidence nobody re-read — and the two
 * things it would most naturally "fix" (marking a critical acknowledged, marking a report read) are
 * exactly the two facts whose whole value is that a HUMAN asserted them.
 *
 * ═══ WHY EACH ONE HAS A MARK, AND WHY A MARK IS NOT A STATUS ═══
 *
 * A sweep with no memory alerts every cycle. The Critical Chaser runs every minute, because a sweep
 * coarser than the window it enforces cannot enforce it (16c's argument for the pharmacy pick
 * sweep, and the tier book's windows are in minutes) — so without a mark, one unacknowledged red
 * finding would put sixty rows an hour in front of a human, which is precisely how an alert surface
 * becomes one nobody reads.
 *
 * `chased_at` and `unread_chased_at` are therefore records that an escalation HAPPENED. Nothing
 * reads either to decide what a finding or a report IS: `acknowledged_at` remains the only answer
 * to "was this closed", and a chased finding is exactly as unacknowledged as it was a minute before.
 *
 * ═══ ONE ESCALATION EACH, AND THE LADDER IS A LATER PHASE'S ═══
 *
 * Each row is chased ONCE. A repeating ladder — chase, wait, chase louder, wake the owner — is a
 * real thing a hospital wants and it is not this task: it needs a rung vocabulary, a per-rung
 * interval and a rota to escalate INTO, and 18a's §7 has none of the three. One escalation to the
 * people who can act is the honest first rung, and the mark is the column a ladder would extend.
 */

/** The system actor these sweeps run as. They are the worker's, not a user's. */
export const CHASER_ACTOR: Actor = { type: "system", id: "radiology-chasers" };

/**
 * How long a published report may go unread before the Watchman speaks, in hours.
 *
 * A literal rather than a `JobIntervals` key, for 16c's stated reason: widening that type is an
 * event that stops every census literal in the suite from compiling, and this window has no
 * operator knob worth that. **Twenty-four hours** is the ordinary Indian-corporate-hospital answer —
 * a report signed on the evening list is read on the morning round, and a working day is the
 * shortest window that does not fire on every overnight study. DECIDED; not money, procurement or
 * law.
 */
export const UNREAD_REPORT_HOURS = 24;

/** How many rows one cycle will chase. A sweep that cannot finish is a sweep that never runs. */
const CHASE_LIMIT = 200;

export type CriticalChaseResult = { chased: { criticalId: string; category: string; overdueMin: number }[] };
export type UnreadChaseResult = { chased: { reportId: string; studyId: string; unreadHours: number }[] };

/**
 * ═══ THE CRITICAL CHASER ═══
 *
 * A flagged critical finding that no clinician has acknowledged, past the window its own tier
 * promised. The window comes from the ACTIVE `critical_categories` book — the same governed
 * definition the radiologist's screen reads — so a hospital that shortens its red window shortens
 * the chase in the same act, with no code change and no second copy of the number.
 *
 * **A tier the book does not name is not chased, and that is deliberate.** The alternative is a
 * default window invented here, which would be this module quietly setting a clinical
 * communication standard the governed book is the only place allowed to set.
 */
export async function sweepCriticalChaser(db: Db, now: Date = new Date()): Promise<CriticalChaseResult> {
  const row = await activeDefinitionRow(db, "critical_categories");
  if (!row) return { chased: [] };
  const book: CriticalCategoriesBody = parseDefinitionBody("critical_categories", row.body);
  const windowByCategory = new Map<string, number>(
    book.categories.map((c) => [c.category as string, c.communicate_within_min]),
  );
  if (windowByCategory.size === 0) return { chased: [] };

  const due = await db
    .select({
      id: imagingCriticalFindings.id,
      reportId: imagingCriticalFindings.reportId,
      category: imagingCriticalFindings.category,
      createdAt: imagingCriticalFindings.createdAt,
      studyId: imagingReports.studyId,
      patientId: imagingStudies.patientId,
    })
    .from(imagingCriticalFindings)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingCriticalFindings.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .where(and(
      isNull(imagingCriticalFindings.acknowledgedAt),
      isNull(imagingCriticalFindings.chasedAt),
    ))
    .orderBy(asc(imagingCriticalFindings.createdAt))
    .limit(CHASE_LIMIT);

  const chased: CriticalChaseResult["chased"] = [];
  for (const finding of due) {
    const windowMin = windowByCategory.get(finding.category);
    if (windowMin === undefined) continue;
    const overdueMin = Math.floor((now.getTime() - finding.createdAt.getTime()) / 60_000) - windowMin;
    if (overdueMin <= 0) continue;

    /**
     * The mark is taken under a CONDITIONAL update rather than read-then-write. Two worker cycles
     * overlapping — which the scheduler permits and 16c's sweep already survives — would otherwise
     * both see `chased_at IS NULL` and both escalate. The update returns nothing for the loser, and
     * the loser emits nothing.
     */
    const won = await withTx(db, async (tx) => {
      const updated = await tx
        .update(imagingCriticalFindings)
        .set({ chasedAt: now })
        .where(and(
          eq(imagingCriticalFindings.id, finding.id),
          isNull(imagingCriticalFindings.chasedAt),
          isNull(imagingCriticalFindings.acknowledgedAt),
        ))
        .returning({ id: imagingCriticalFindings.id });
      if (updated.length === 0) return false;

      /**
       * The payload carries ids, a tier and a number of minutes. **No finding text, no impression,
       * no patient name** — `events.ts`'s rule for this module, and the alerts consumer builds its
       * title and body EXCLUSIVELY from structural payload fields because an alert is fanned to a
       * browser (`kernel/alerts/consumer.ts`: "NO ALERT COLUMN EVER CARRIES PATIENT IDENTITY").
       */
      await appendEvent(tx, imagingCriticalOverdue.make({
        actor: CHASER_ACTOR,
        patientId: finding.patientId,
        payload: {
          criticalId: finding.id, reportId: finding.reportId, studyId: finding.studyId,
          category: finding.category, overdueMin,
        },
      }));
      return true;
    });

    if (won) chased.push({ criticalId: finding.id, category: finding.category, overdueMin });
  }
  return { chased };
}

/**
 * ═══ THE UNREAD WATCHMAN ═══
 *
 * A report signed, published, and opened by nobody but its author after a working day. The referring
 * clinician has not acted on it and does not know they have not — which is the failure a radiology
 * department cannot see from inside itself, because from in here the work is finished.
 *
 * `first_read_at` is stamped by `reportView` for a reader who is not the signer (see the column's
 * own comment for why the signer is excluded and why it is the FIRST read).
 */
export async function sweepUnreadWatchman(db: Db, now: Date = new Date()): Promise<UnreadChaseResult> {
  const cutoff = new Date(now.getTime() - UNREAD_REPORT_HOURS * 3_600_000);

  /**
   * LEFT JOIN, not INNER: a report nobody has opened has **no delivery row at all**, and that is the
   * commonest case rather than an edge one. An inner join here would chase only reports that had
   * already been read or already been chased — the exact complement of what the Watchman is for,
   * and it would have passed a test that seeded a delivery row.
   */
  const due = await db
    .select({
      id: imagingReports.id,
      studyId: imagingReports.studyId,
      publishedAt: imagingReports.publishedAt,
      patientId: imagingStudies.patientId,
      deliveryId: imagingReportDelivery.id,
    })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(
      eq(imagingReports.status, "signed"),
      isNull(imagingReportDelivery.firstReadAt),
      isNull(imagingReportDelivery.unreadChasedAt),
      sql`${imagingReports.publishedAt} is not null`,
      lt(imagingReports.publishedAt, cutoff),
    ))
    .orderBy(asc(imagingReports.publishedAt))
    .limit(CHASE_LIMIT);

  const chased: UnreadChaseResult["chased"] = [];
  for (const report of due) {
    const publishedAt = report.publishedAt;
    if (publishedAt === null) continue;
    const unreadHours = Math.floor((now.getTime() - publishedAt.getTime()) / 3_600_000);

    /**
     * The mark is an UPSERT on the delivery row, because the row may not exist — and the conflict
     * target is what makes two overlapping cycles safe: the second `insert` hits
     * `imaging_report_delivery_report_ux`, the `where` on the update arm finds the mark already set,
     * and it returns nothing. One escalation, whatever the scheduler does.
     */
    const won = await withTx(db, async (tx) => {
      const marked = await tx
        .insert(imagingReportDelivery)
        .values({ id: newId(), reportId: report.id, unreadChasedAt: now })
        .onConflictDoUpdate({
          target: imagingReportDelivery.reportId,
          set: { unreadChasedAt: now },
          setWhere: and(
            isNull(imagingReportDelivery.unreadChasedAt),
            isNull(imagingReportDelivery.firstReadAt),
          ),
        })
        .returning({ id: imagingReportDelivery.id });
      if (marked.length === 0) return false;

      await appendEvent(tx, imagingReportUnread.make({
        actor: CHASER_ACTOR,
        patientId: report.patientId,
        payload: { reportId: report.id, studyId: report.studyId, unreadHours },
      }));
      return true;
    });

    if (won) chased.push({ reportId: report.id, studyId: report.studyId, unreadHours });
  }
  return { chased };
}
