import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import { ORDER_ITEM_STATUSES } from "../db/schema/orders";

/**
 * PLAN 17 PHASE 0 — the order envelope's event catalog (§4.2).
 *
 * ═══ THIS FILE IS A FILES-LIST CORRECTION, DISCLOSED RATHER THAN SLIPPED IN (finding F3) ═══
 *
 * §4.2 names six events and no task's Files list names a file to put them in — T3 needs
 * `order.placed`, T4 needs the four `order_item.*` and `order.closed`/`order.cancelled`, and T6's
 * parity test pins that the names exist. Defining them inside `place.ts` and `advance.ts` would
 * split one catalog across two files and give T6 two places to import from. The house pattern is
 * one `events.ts` per kernel concern — `kernel/retention/events.ts`, `kernel/ops/events.ts`,
 * `kernel/resources/events.ts` — and this follows it.
 *
 * `defineEvent` runs the `entity.verb_past` lint (`NAME_RE`, envelope.ts:64) at MODULE LOAD, so an
 * illegal name here is an import-time throw rather than a test failure — which is why T6's parity
 * test asserts the names it can see rather than re-implementing the regex.
 *
 * ═══ NO KIND IS CLAIMED TODAY, SO NONE OF THESE HAS FIRED ═══
 *
 * Until a manifest claims a kind, `placeOrder` refuses everything with `unknown_kind` and this
 * catalog is inert. The subscribers §4.2 names — 17 T2's collection queue, 18a's worklist, 24a's
 * home-collection filter and quarantine, 26's package progress, 22c-F's reports projection — all
 * arrive with their own plans, and each one subscribes through its own manifest.
 *
 * ═══ EVERY PAYLOAD CARRIES `kind`, AND THAT IS THE ONE DESIGN DECISION HERE ═══
 *
 * A subscriber is per-module and the envelope is cross-kind, so the FIRST thing every consumer does
 * is ask "is this mine". Without `kind` in the payload, 24a's home-collection consumer would have
 * to read the `orders` row back to find out whether an item cancellation concerns a lab tube — one
 * query per event, on the dispatch path, to answer a question the writer already knew.
 */
const ORDERS = "orders";

const itemStatus = z.enum(ORDER_ITEM_STATUSES);

/**
 * AN ORDER WAS PLACED. The subscriber is whichever manifest claimed `kind` — this is the signal
 * that starts a department's own pipeline (a collection queue, a modality worklist).
 *
 * `itemIds` is the whole item set rather than a count: a consumer that must create one row per
 * ordered test would otherwise re-read them, and the ORDER of the array is the order the placing
 * surface listed them in, which is the order a phlebotomist's list should read.
 */
export const orderPlaced = defineEvent(
  "order.placed",
  ORDERS,
  z.object({
    orderId: z.string().min(1),
    orderNo: z.string().min(1),
    kind: z.string().min(1),
    patientId: z.string().min(1),
    encounterNo: z.string().min(1),
    groupId: z.string().min(1),
    itemIds: z.array(z.string().min(1)).min(1),
  }),
);

/**
 * The three item moves, one definition each rather than one `order_item.moved` with a `to` field.
 *
 * A single event would make every consumer filter on a payload field to find the transition it
 * cares about, and `buildSubscriptionBus` matches on the NAME — so 24a's quarantine consumer, which
 * cares only about cancellation, would receive and discard every start and completion in the
 * hospital. Three names let a subscription be as narrow as the concern.
 *
 * `from` is carried on all three because "what state did this leave" is what the consumer usually
 * needs and cannot re-derive after the fact; `cancelledFrom` and `reason` are present only on the
 * cancellation and are the DD5 pair O-4's money rule reads.
 */
const itemMove = {
  itemId: z.string().min(1),
  orderId: z.string().min(1),
  kind: z.string().min(1),
  serviceId: z.string().min(1),
  from: itemStatus,
  to: itemStatus,
};

export const orderItemStarted = defineEvent("order_item.started", ORDERS, z.object(itemMove));
export const orderItemCompleted = defineEvent("order_item.completed", ORDERS, z.object(itemMove));
export const orderItemCancelled = defineEvent(
  "order_item.cancelled",
  ORDERS,
  z.object({ ...itemMove, cancelledFrom: itemStatus, reason: z.string().nullable() }),
);

/**
 * The header reached a terminal state, and the two names are separate for the reason the item's
 * three are: "every test is done" and "the whole order was called off" are different facts to a
 * reports projection (22c-F) and to a package's progress (26).
 */
export const orderClosed = defineEvent(
  "order.closed",
  ORDERS,
  z.object({ orderId: z.string().min(1), kind: z.string().min(1) }),
);
export const orderCancelled = defineEvent(
  "order.cancelled",
  ORDERS,
  z.object({ orderId: z.string().min(1), kind: z.string().min(1) }),
);

/** Every name this catalog defines, for T6's parity pin and for a subscriber census later. */
export const ORDER_EVENT_NAMES: readonly string[] = [
  orderPlaced.name, orderItemStarted.name, orderItemCompleted.name, orderItemCancelled.name,
  orderClosed.name, orderCancelled.name,
];
