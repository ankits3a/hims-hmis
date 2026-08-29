import type { OrderItemStatus } from "../db/schema/orders";

/**
 * PLAN 17 PHASE 0 T4 / DD4 — THE ENVELOPE'S STATE MACHINE, AS DATA IN CODE.
 *
 * ═══ FOUR STATES, FOUR EDGES, AND IT IS NOT A WORKFLOW DEFINITION ═══
 *
 * `kernel/workflow` exists and this deliberately does not use it. Workflow DEFINITIONS are DATA:
 * drafted, approved and activated per deployment (§10.4), which is exactly right for a hospital's
 * own processes and exactly wrong here. An envelope whose terminal states could differ between two
 * hospitals is not an envelope that five plans can build against — 18a, 24a, 26 and 22c-F all read
 * `completed` and mean the same thing by it.
 *
 * ═══ WHY FOUR AND NOT MORE ═══
 *
 * Every candidate fifth state is ONE KIND'S BUSINESS. *accessioned* is the lab's, *scheduled* and
 * *checked_in* are radiology's, *resulted-unverified* is the lab's again, *dispensed* is pharmacy's.
 * All of them are stages INSIDE `in_progress`, and they live in that module's own workflow
 * definitions over its own extension tables — which PROJECT onto this machine by calling
 * `advanceOrderItem` at their milestones. The `held`/`on_hold` case (consent missing, QC lockout) is
 * likewise inside `in_progress` or before it: **an item that cannot start is still `placed`.**
 *
 * ═══ WHAT IS NOT HERE ═══
 *
 * `completed → cancelled` is absent, and so is every edge out of a terminal state. A published
 * result's item cannot reopen (A1); an order whose items are all `completed` is closed, and
 * "cancel it anyway" is a credit note, not a state change (E20).
 */
export type OrderItemTransition = { readonly from: OrderItemStatus; readonly to: OrderItemStatus };

export const ORDER_ITEM_TRANSITIONS: readonly OrderItemTransition[] = [
  /** The department picked the work up: the tube reached the bench, the patient reached the gantry. */
  { from: "placed", to: "in_progress" },
  /** The department finished. What "finished" means is the module's; that it is terminal is ours. */
  { from: "in_progress", to: "completed" },
  /** Called off before anything was consumed. No reason is required — nothing was spent. */
  { from: "placed", to: "cancelled" },
  /**
   * Called off AFTER the work started, and DD5 requires a reason for it — enforced by the guard in
   * `advance.ts` AND by `order_items_cancel_reason_ck` in the database, independently, because
   * O-4's money rule ("the charge stands if it was analysed") reads `cancelled_from` and would
   * otherwise have a row it cannot interpret.
   */
  { from: "in_progress", to: "cancelled" },
];

/** The two states from which an item is still LIVE work — the set the header's close counts. */
export const LIVE_ITEM_STATUSES: readonly OrderItemStatus[] = ["placed", "in_progress"];

export function isLegalItemTransition(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return ORDER_ITEM_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
