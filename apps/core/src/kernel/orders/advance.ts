import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { orderItemTransitions, orderItems, orders } from "../db/schema";
import { appendEvent } from "../events/append";
import { OrderError } from "./errors";
import { findOrderKindDecl } from "./kinds";
import { LIVE_ITEM_STATUSES, isLegalItemTransition } from "./transitions";
import {
  orderCancelled, orderClosed, orderItemCancelled, orderItemCompleted, orderItemStarted,
} from "./events";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../db/client";
import type { OrderItemStatus } from "../db/schema/orders";
import type { OrderKindDecl } from "./kinds";

export type AdvanceOrderItemOptions = {
  /** DD5 — REQUIRED when cancelling from `in_progress`. The CHECK refuses it too, independently. */
  reason?: string | null;
  /** Free text on the transitions row. Never a substitute for `reason`. */
  note?: string | null;
  /** The injected instant, the `createResource` convention. Defaults to now. */
  at?: Date;
};

export type AdvanceOrderItemResult = {
  itemId: string;
  from: OrderItemStatus;
  to: OrderItemStatus;
  /** `null` when the header stayed open — the usual case while siblings are still live. */
  headerClosedAs: "closed" | "cancelled" | null;
};

/**
 * PLAN 17 PHASE 0 T4 — MOVE ONE ITEM, WRITE ITS AUDIT ROW, AND CLOSE THE HEADER WHEN IT IS DONE.
 *
 * **`decls` is a parameter the plan's signature did not carry, and it is needed (finding F4).** The
 * plan writes `advanceOrderItem(tx, actor, itemId, to, opts)` and then rules that a `patient` actor
 * may cancel from `placed` "only on a `selfOrderable` kind" — which is a fact that lives on the
 * kind DECLARATION and can be read nowhere else. The alternatives were to look the declarations up
 * from a module-level global (the mutable-at-boot shape `kernel/resources/registry.ts` rejects) or
 * to drop the rule. It takes the parameter, in `placeOrder`'s position, so the two write paths have
 * the same shape.
 *
 * ═══ THE UPDATE IS A COMPARE-AND-SET, AND THAT IS THE WHOLE CONCURRENCY STORY ═══
 *
 * `WHERE id = ? AND status = <the state we validated against>` — `workflow/instances.ts:136-150`'s
 * pattern, transcribed with its reasoning: two concurrent transitions cannot both apply, no
 * optimistic-locking column is needed, and the loser fails fast having written nothing. Zero rows
 * updated is `stale_state`, and **the caller retries or reports — it never re-reads and overwrites.**
 *
 * E5 is why this is not a convenience: a cancellation racing the analyzer's start. Read-then-write
 * lets both succeed, and the item ends `cancelled` WITH a `started_at` while the analyzer runs a
 * tube nobody is going to pay for or report. The database is the only place that race can be
 * settled, so it is settled there.
 *
 * ═══ THE MODULE NEVER WRITES `order_items.status` ITSELF ═══
 *
 * The CONTRACT says so in as many words and both guarantees here depend on it: the transitions log
 * is append-only, so a status written around this function is a move with no audit row, and the CAS
 * is only single-winner if every writer takes the same path.
 */
export async function advanceOrderItem(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  itemId: string,
  to: OrderItemStatus,
  opts: AdvanceOrderItemOptions = {},
): Promise<AdvanceOrderItemResult> {
  const rows = await tx
    .select({
      status: orderItems.status,
      serviceId: orderItems.serviceId,
      orderId: orderItems.orderId,
      kind: orders.kind,
      headerStatus: orders.status,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orderItems.id, itemId));

  const item = rows[0];
  if (!item) throw new OrderError("unknown_item", `no order item ${itemId}`);
  const from = item.status as OrderItemStatus;

  assertActorMayAdvance(actor, decls, item.kind, from, to);

  if (!isLegalItemTransition(from, to)) {
    throw new OrderError(
      "illegal_transition",
      `an order item cannot move ${from} → ${to}`,
      { from, to },
    );
  }

  /**
   * DD5 / 02 §5 B6. The guard and `order_items_cancel_reason_ck` are TWO independent enforcements
   * of one rule and that is deliberate rather than redundant (A2): remove the guard and Postgres
   * still refuses; remove the CHECK and this still refuses. A caller reaching the table by another
   * route — a repair script, a future module — meets the second one.
   */
  const cancellingAfterStart = to === "cancelled" && from === "in_progress";
  if (cancellingAfterStart && !opts.reason) {
    throw new OrderError(
      "cancel_reason_required",
      "cancelling an item that had already started requires a reason — the charge decision " +
        "(02 O-4) is read from it",
    );
  }

  const at = opts.at ?? new Date();
  const updated = await tx
    .update(orderItems)
    .set({
      status: to,
      startedAt: to === "in_progress" ? at : undefined,
      completedAt: to === "completed" ? at : undefined,
      cancelledAt: to === "cancelled" ? at : undefined,
      cancelledFrom: to === "cancelled" ? from : undefined,
      cancelReason: to === "cancelled" ? (opts.reason ?? null) : undefined,
    })
    .where(and(eq(orderItems.id, itemId), eq(orderItems.status, from)))
    .returning({ id: orderItems.id });

  if (updated.length === 0) {
    throw new OrderError(
      "stale_state",
      `order item ${itemId} was moved concurrently — it is no longer ${from}`,
      { expected: from },
    );
  }

  /** EXACTLY ONE ROW PER SUCCESSFUL MOVE. Zero is no audit; two makes the immutability story lie. */
  await tx.insert(orderItemTransitions).values({
    id: newId(),
    itemId,
    fromStatus: from,
    toStatus: to,
    actorType: actor.type,
    actorId: actor.id,
    note: opts.note ?? null,
    at,
  });

  const move = { itemId, orderId: item.orderId, kind: item.kind, serviceId: item.serviceId, from, to };
  if (to === "in_progress") {
    await appendEvent(tx, orderItemStarted.make({ payload: move, actor, correlationId: item.orderId, occurredAt: at }));
  } else if (to === "completed") {
    await appendEvent(tx, orderItemCompleted.make({ payload: move, actor, correlationId: item.orderId, occurredAt: at }));
  } else {
    await appendEvent(tx, orderItemCancelled.make({
      payload: { ...move, cancelledFrom: from, reason: opts.reason ?? null },
      actor, correlationId: item.orderId, occurredAt: at,
    }));
  }

  const headerClosedAs = await closeHeaderIfDone(tx, actor, item.orderId, item.kind, at);
  return { itemId, from, to, headerClosedAs };
}

/**
 * ═══ THE HEADER CLOSES WHEN NO ITEM IS STILL LIVE — AND A CANCELLED SIBLING IS NOT LIVE (A4) ═══
 *
 * Counting ALL items instead of LIVE ones is the defect this shape exists to avoid: an order whose
 * one add-on was cancelled would never close, so it would sit on every "pending investigations"
 * list for ever and 22c-F would show a patient work that finished last month.
 *
 * The distinction between the two terminal words is the same distinction the two events carry:
 * **every item cancelled** is an order that was called off; **anything completed** is an order that
 * ran. A reports projection and a package's progress need different things from those two.
 *
 * The close is itself a CAS on `status = 'open'`, and zero rows is NOT an error: it means a
 * concurrent sibling's completion closed the header first, which is a correct outcome reached by
 * someone else. Raising there would turn "two tests finished at once" into a spurious failure.
 */
async function closeHeaderIfDone(
  tx: Tx,
  actor: Actor,
  orderId: string,
  kind: string,
  at: Date,
): Promise<"closed" | "cancelled" | null> {
  const siblings = await tx
    .select({ status: orderItems.status })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const live = siblings.filter((s) => LIVE_ITEM_STATUSES.includes(s.status as OrderItemStatus));
  if (live.length > 0) return null;

  const terminal = siblings.some((s) => s.status === "completed") ? "closed" : "cancelled";
  const closed = await tx
    .update(orders)
    .set({ status: terminal, closedAt: at })
    .where(and(eq(orders.id, orderId), eq(orders.status, "open")))
    .returning({ id: orders.id });
  if (closed.length === 0) return null;

  const def = terminal === "closed" ? orderClosed : orderCancelled;
  await appendEvent(tx, def.make({ payload: { orderId, kind }, actor, correlationId: orderId, occurredAt: at }));
  return terminal;
}

/**
 * ═══ WHO MAY MOVE AN ITEM — THE `placeOrder` SHAPE, AND A FIFTH ACTOR TYPE ARRIVES DENIED ═══
 *
 * A `switch` with no `default`, for `workflow/instances.ts`'s reason: an `if/else if` chain over a
 * union is not an exhaustiveness check, and when `patient` joined the union that chain's silent
 * fall-through was the TRUSTED branch.
 *
 * **WHOSE order a patient is cancelling is the CALLING SURFACE's question, not this one's.** The
 * kernel is handed an item id; that the id belongs to the authenticated patient is established by
 * the patient-scoped reader the surface used to find it (`listOrdersForPatient`, T5). Stated here
 * because it is the kind of boundary that looks like an omission from inside one file.
 */
function assertActorMayAdvance(
  actor: Actor,
  decls: readonly OrderKindDecl[],
  kind: string,
  from: OrderItemStatus,
  to: OrderItemStatus,
): void {
  switch (actor.type) {
    /** Copilot design law again: an agent narrates. It does not start, finish or cancel work. */
    case "agent":
      throw new OrderError(
        "actor_cannot_advance",
        "an agent actor may not move an order item — a drafter narrates, it does not work",
      );

    /**
     * A6 — A PATIENT MAY CANCEL, AND MAY NOT DO ANYTHING ELSE. Marking one's own test `in_progress`
     * or `completed` is a clinical claim, and the patient app's cancellation (26's check-up package)
     * is the only move a patient legitimately makes on this machine. `placed` only: once the sample
     * is at the bench, calling it off is a conversation with the department, not a button.
     */
    case "patient": {
      const decl = findOrderKindDecl(decls, kind);
      if (to !== "cancelled" || from !== "placed" || !decl?.selfOrderable) {
        throw new OrderError(
          "actor_cannot_advance",
          `a patient may only cancel a not-yet-started item of a self-orderable kind — ${from} → ${to} on "${kind}" is not that`,
        );
      }
      return;
    }

    // Staff and the application's own automated moves. `system` is what a reflex rule, an analyzer
    // interface and a scheduler use; `user` is every desk.
    case "user":
    case "system":
      return;
  }
}
