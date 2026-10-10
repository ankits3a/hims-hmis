import { and, countDistinct, eq, isNotNull, isNull, min, or } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  imagingCriticalFindings, imagingReportDelivery, imagingReports, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { orderItems, orders } from "../../kernel/db/schema/orders";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema/opd";
import { waitingItem } from "../../kernel/desk/waiting";
import { TAT_MINUTES, tatClassOf } from "./reading";
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
 * The reading room's one: studies whose images are in and whose reading clock has run out
 * (`reading.ts` — STAT 30 min, ER 60, IPD 6 h, OPD 24 h).
 *
 * Counts only, and NO PHI read is logged: nothing about a patient leaves this file.
 */

async function treatedBy(ctx: DeskProviderCtx): Promise<SQL> {
  const me = ctx.actor.id;
  const canSeeRestricted = await hasPermission(ctx.db, me, "orders.read.restricted", "hospital");
  const treating = or(eq(orders.orderingClinicianId, me), eq(opdDoctors.userId, me))!;
  return canSeeRestricted ? treating
    : and(treating, or(eq(orderItems.restricted, false), eq(orders.orderingClinicianId, me)))!;
}

async function mine(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const mineOnly = await treatedBy(ctx);
  const released = and(eq(imagingReports.status, "signed"), isNotNull(imagingReports.publishedAt));
  const [unread] = await ctx.db
    .select({ n: countDistinct(imagingReports.id), oldest: min(imagingReports.publishedAt) })
    .from(imagingReports)
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(released, mineOnly, isNull(imagingReportDelivery.firstReadAt)));
  const [crit] = await ctx.db
    .select({ n: countDistinct(imagingCriticalFindings.id), oldest: min(imagingCriticalFindings.createdAt) })
    .from(imagingCriticalFindings)
    .innerJoin(imagingReports, eq(imagingReports.id, imagingCriticalFindings.reportId))
    .innerJoin(imagingStudies, eq(imagingStudies.id, imagingReports.studyId))
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .innerJoin(orderItems, eq(orderItems.id, imagingStudies.orderItemId))
    .leftJoin(opdEncounters, eq(opdEncounters.visitNo, imagingStudies.encounterNo))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(released, mineOnly, isNull(imagingCriticalFindings.acknowledgedAt)));
  return [
    waitingItem("radiology.criticalsMine", crit?.n ?? 0, crit?.oldest ?? null),
    waitingItem("radiology.unreadMine", unread?.n ?? 0, unread?.oldest ?? null),
  ].filter((i): i is WaitingItem => i !== null);
}

/** How many acquired studies one count looks at. The reading room's own list caps at 300. */
const READS_LIMIT = 500;

async function readingRoom(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const rows = await ctx.db
    .select({ priority: imagingStudies.priority, bedside: imagingStudies.bedsideLocation, acquiredAt: imagingStudies.acquiredAt })
    .from(imagingStudies)
    .where(and(eq(imagingStudies.status, "acquired"), isNotNull(imagingStudies.acquiredAt)))
    .limit(READS_LIMIT);
  const now = ctx.now.getTime();
  const overdue = rows.filter((r) => r.acquiredAt !== null
    && r.acquiredAt.getTime() + TAT_MINUTES[tatClassOf(r.priority, r.bedside)] * 60_000 < now);
  const oldest = overdue.reduce<Date | null>((o, r) => (o === null || r.acquiredAt! < o ? r.acquiredAt : o), null);
  const item = waitingItem("radiology.readsOverdue", overdue.length, oldest);
  return item === null ? [] : [item];
}

/** The treating doctor's lines, on the doctor's grant to read imaging reports (DD16). */
export const radiologyWaitingMine: DeskProvider = { key: "radiology.waitingMine", permission: "radiology.reports.read", load: noDeskCards, waiting: mine };
/** The reading room's line, on the grant to write reports (`reading.ts` `READING_WRITE`). */
export const radiologyWaitingReads: DeskProvider = { key: "radiology.waitingReads", permission: "radiology.reports.write", load: noDeskCards, waiting: readingRoom };
