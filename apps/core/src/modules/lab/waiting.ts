import { and, count, countDistinct, eq, gte, inArray, isNotNull, isNull, min } from "drizzle-orm";
import { labCriticalCalls, labReports, labResults, orderItems, orders } from "../../kernel/db/schema";
import { waitingItem } from "../../kernel/desk/waiting";
import type { WaitingItem } from "@hmis/contracts";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";

/**
 * E1.4 / E1.5 (decision 0064) — WHAT THE LAB HAS WAITING ON ONE PERSON, as counts.
 *
 * The doctor's two: critical calls still open on orders they are the RESPONSIBLE clinician of
 * (`orders.ordering_clinician_id`, DD6 — never the login that typed it), and reports that came back
 * in the last day. The lab's one: every critical call the bench has not yet closed with a read-back.
 *
 * Counts and the oldest instant only — no patient, no test, no value — see `kernel/desk/waiting.ts`.
 */

/**
 * "Back" means published in the last 24 hours. DECIDED: the lab keeps no doctor-read stamp
 * (`lab_report_deliveries` has a `doctor_screen` channel nothing writes), so this line ages out
 * rather than closes; a day matches the imaging Watchman's window (`UNREAD_REPORT_HOURS`).
 */
export const LAB_REPORTS_BACK_HOURS = 24;

/** A report is current while it is the published or amended version — never a superseded one. */
const CURRENT = ["published", "amended"] as const;

async function mine(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const me = ctx.actor.id;
  const since = new Date(ctx.now.getTime() - LAB_REPORTS_BACK_HOURS * 3_600_000);
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
