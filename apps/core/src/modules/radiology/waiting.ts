import { and, countDistinct, eq, inArray, isNotNull, isNull, lte, min, or } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  imagingCriticalFindings, imagingFollowups, imagingReportDelivery, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { waitingItem } from "../../kernel/desk/waiting";
import { addDays } from "../../kernel/desk/rollup";
import { istDayString } from "../../kernel/approvals/cumulative";
import { TAT_MINUTES, tatClassOf } from "./reading";
import { studySource } from "./study-source";
import { treatingDoctorIs } from "./closed-loop";
import type { SQL } from "drizzle-orm";
import type { WaitingItem } from "@hmis/contracts";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";

/**
 * E1.4 / E1.5 (decision 0064) — WHAT IMAGING HAS WAITING ON ONE PERSON, as counts.
 *
 * The treating doctor's two are the results inbox's own top bands (`closed-loop.ts`
 * `doctorResultsInbox`): critical findings not yet acknowledged, and released reports nobody but
 * the signer has opened. "Treating" is that file's rule — the ordering clinician or the doctor of
 * the visit — and a restricted study counts only for whoever the inbox would show it to, because for
 * a restricted study the existence of the study is the sensitive fact.
 *
 * #1084 adds a third: the follow-ups the radiologist recommended that fall due within 14 days.
 *
 * The reading room's one: studies whose images are in and whose reading clock has run out
 * (`reading.ts` — STAT 30 min, ER 60, IPD 6 h, OPD 24 h).
 *
 * Counts only, and NO PHI read is logged: nothing about a patient leaves this file.
 */

async function treatedBy(ctx: DeskProviderCtx): Promise<SQL> {
  const me = ctx.actor.id;
  const canSeeRestricted = await hasPermission(ctx.db, me, "orders.read.restricted", "hospital");
  const treating = treatingDoctorIs(me);
  return canSeeRestricted ? treating
    : and(treating, or(eq(orderItems.restricted, false), eq(orders.orderingClinicianId, me)))!;
}

/** #1084 — a follow-up joins the treating doctor's waiting items this many days before it falls due. */
export const FOLLOWUP_PROMPT_DAYS = 14;

async function mine(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const mineOnly = await treatedBy(ctx);
  const released = and(eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt));
  const [unread] = await ctx.db
    .select({ n: countDistinct(imagingReports.id), oldest: min(imagingReports.publishedAt) })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(released, mineOnly, isNull(imagingReportDelivery.firstReadAt)));
  const [crit] = await ctx.db
    .select({ n: countDistinct(imagingCriticalFindings.id), oldest: min(imagingCriticalFindings.createdAt) })
    .from(imagingCriticalFindings)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingCriticalFindings.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .where(and(released, mineOnly, isNull(imagingCriticalFindings.acknowledgedAt)));
  /**
   * #1084 (A7, L1) — follow-ups the radiologist recommended that fall due within FOLLOWUP_PROMPT_DAYS, or
   * already have, not yet booked or closed: the doctor sees them BEFORE they are overdue. The line opens
   * the consult's results inbox, where "Book it" (`bookFollowup`) sits beside each one. A count, so no age.
   */
  const dueBy = addDays(istDayString(ctx.now), FOLLOWUP_PROMPT_DAYS);
  const [due] = await ctx.db
    .select({ n: countDistinct(imagingFollowups.id) })
    .from(imagingFollowups)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingFollowups.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .where(and(inArray(imagingFollowups.state, ["open", "notified"]), lte(imagingFollowups.dueOn, dueBy), mineOnly));
  return [
    waitingItem("radiology.criticalsMine", crit?.n ?? 0, crit?.oldest ?? null),
    waitingItem("radiology.unreadMine", unread?.n ?? 0, unread?.oldest ?? null),
    waitingItem("radiology.followupsDue", due?.n ?? 0, null),
  ].filter((i): i is WaitingItem => i !== null);
}

/** How many acquired studies one count looks at. The reading room's own list caps at 300. */
const READS_LIMIT = 500;

async function readingRoom(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const rows = await ctx.db
    .select({
      priority: imagingStudies.priority, encounterNo: imagingStudies.encounterNo, bedsideLocation: imagingStudies.bedsideLocation,
      authority: orders.authority, acquiredAt: imagingStudies.acquiredAt,
    })
    .from(imagingStudies)
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .where(and(eq(imagingStudies.status, "acquired"), isNotNull(imagingStudies.acquiredAt)))
    .limit(READS_LIMIT);
  const now = ctx.now.getTime();
  const overdue = rows.filter((r) => r.acquiredAt !== null
    && r.acquiredAt.getTime() + TAT_MINUTES[tatClassOf(r.priority, studySource(r, r))] * 60_000 < now);
  const oldest = overdue.reduce<Date | null>((o, r) => (o === null || r.acquiredAt! < o ? r.acquiredAt : o), null);
  const item = waitingItem("radiology.readsOverdue", overdue.length, oldest);
  return item === null ? [] : [item];
}

/** The treating doctor's lines, on the doctor's grant to read imaging reports (DD16). */
export const radiologyWaitingMine: DeskProvider = { key: "radiology.waitingMine", permission: "radiology.reports.read", load: noDeskCards, waiting: mine };
/** The reading room's line, on the grant to write reports (`reading.ts` `READING_WRITE`). */
export const radiologyWaitingReads: DeskProvider = { key: "radiology.waitingReads", permission: "radiology.reports.write", load: noDeskCards, waiting: readingRoom };
