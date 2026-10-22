import { and, count, countDistinct, eq, gte, inArray, isNotNull, isNull, min, sql } from "drizzle-orm";
import { labCriticalCalls, labReports, labResults, orderItems, orders } from "../../kernel/db/schema";
import { DOCTOR_SCREEN } from "./doctor-read";
import { waitingItem } from "../../kernel/desk/waiting";
import type { WaitingItem } from "@hmis/contracts";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";

/**
 * E1.4 / E1.5 (decision 0064) — WHAT THE LAB HAS WAITING ON ONE PERSON, as counts.
 *
 * The doctor's two: critical calls still open on orders they are the RESPONSIBLE clinician of
 * (`orders.ordering_clinician_id`, DD6 — never the login that typed it), and reports that came back
 * and no treating doctor has opened yet. The lab's one: every critical call the bench has not yet
 * closed with a read-back.
 *
 * Counts and the oldest instant only — no patient, no test, no value — see `kernel/desk/waiting.ts`.
 */

/**
 * "Back" means published and not yet opened by a treating doctor (#682): the first read is a
 * `doctor_screen` row in `lab_report_deliveries` (`doctor-read.ts`), and the line CLOSES on it, as
 * imaging's `radiology.unreadMine` closes on `first_read_at`. A report nobody opened for two days is
 * more waiting, not less, so the horizon is a week, not a day.
 *
 * DECIDED (review 2026-10-19): unread counts for `LAB_REPORTS_BACK_DAYS` (7) after publication. Nothing
 * wrote a `doctor_screen` read before #682, so with no horizon every report ever published would count
 * as unread on the day this ships, the line's "oldest" months old. A week bounds that backlog and still
 * lets the line close on the read rather than age out within the day.
 *
 * A report is current while it is the published or amended version — never a superseded one.
 */
export const LAB_REPORTS_BACK_DAYS = 7;

const CURRENT = ["published", "amended"] as const;

async function mine(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const me = ctx.actor.id;
  const since = new Date(ctx.now.getTime() - LAB_REPORTS_BACK_DAYS * 24 * 3_600_000);
  const [crit] = await ctx.db
    .select({ n: count(), oldest: min(labCriticalCalls.openedAt) })
    .from(labCriticalCalls)
    .innerJoin(labResults, eq(labResults.id, labCriticalCalls.resultId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(isNull(labCriticalCalls.closedAt), eq(orders.orderingClinicianId, me)));
  const [back] = await ctx.db
    .select({ n: countDistinct(labReports.orderId), oldest: min(labReports.publishedAt) })
    .from(labReports)
    .innerJoin(orders, eq(orders.id, labReports.orderId))
    .where(and(
      eq(orders.orderingClinicianId, me),
      inArray(labReports.status, [...CURRENT]),
      isNotNull(labReports.publishedAt),
      gte(labReports.publishedAt, since),
      sql`not exists (select 1 from lab_report_deliveries d
        where d.report_id = ${labReports.id} and d.channel = ${DOCTOR_SCREEN})`,
    ));
  return [
    waitingItem("lab.criticalsMine", crit?.n ?? 0, crit?.oldest ?? null),
    waitingItem("lab.reportsBack", back?.n ?? 0, back?.oldest ?? null),
  ].filter((i): i is WaitingItem => i !== null);
}

async function bench(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const [open] = await ctx.db
    .select({ n: count(), oldest: min(labCriticalCalls.openedAt) })
    .from(labCriticalCalls)
    .where(isNull(labCriticalCalls.closedAt));
  const item = waitingItem("lab.callsOpen", open?.n ?? 0, open?.oldest ?? null);
  return item === null ? [] : [item];
}

/** The doctor's lines, on the doctor's grant to read results (the role holds it; the route checks it). */
export const labWaitingMine: DeskProvider = { key: "lab.waitingMine", permission: "lab.results.read", load: noDeskCards, waiting: mine };
/** The bench's line, on the grant that closes a call. */
export const labWaitingCalls: DeskProvider = { key: "lab.waitingCalls", permission: "lab.criticals.close", load: noDeskCards, waiting: bench };
