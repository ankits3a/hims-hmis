import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Actor } from "@hmis/contracts";
import { patients } from "./patients";
import { services } from "./tariff";

/**
 * PLAN 17 PHASE 0 T1 — THE P2 ORDER ENVELOPE. Three tables, and they are KERNEL tables for the
 * reason `resources` and `episode_series` are (§1.2, DD1).
 *
 * An Indian corporate hospital orders from ONE investigations screen: the consultant ticks CBC,
 * LFT and a chest X-ray on one sheet, the counter bills one slip, the ward sees one "pending
 * investigations" list per bed, the TPA desk pre-authorises one bundle, the patient's app shows one
 * "my tests" page. Every one of those is a CROSS-KIND READ over a common envelope. With
 * module-private tables each becomes a UNION across N modules, rewritten every time a kind is
 * added — blood bank, diet, nursing, transport. That is the `patients` argument (spec §6) applied
 * to the order: one table, every module references it, nobody copies it.
 *
 * ═══ WHAT IS ENVELOPE AND WHAT IS EXTENSION — FROZEN (§4.1, §8.1) ═══
 *
 * Everything below is ENVELOPE. A module that claimed a kind hangs its own pipeline off its OWN
 * tables keyed `order_item_id` and **never adds a column here**: specimens and their `S` numbers,
 * accession scans, sample rejection, analyzer worklists, results, verification, reference ranges,
 * reports and amendments, the publish interlock, collection site, study scheduling, device
 * resources, safety gates, Form F links, contrast, dispense lines and batches, TAT clocks.
 *
 * ═══ NO MONEY LIVES HERE (DD10) ═══
 *
 * `order_items.service_id` is the ONLY tariff link — no price, no payer, no interlock flag. Plans
 * 14 and 15 each had their CRITICAL finding in money summed from the wrong place; a price copied
 * onto an order would be a second place for the same number to be wrong in. The lab posts its
 * charge at accession and radiology at acquisition, each in its own plan, from `service_id` and the
 * encounter resolver's `intendedPayer`.
 */

/**
 * ═══ THE ACTOR NAMES, AND THE PIN THAT MAKES THIS COPY SAFE (spike S2) ═══
 *
 * There is no `actor_type` CHECK anywhere else in this repository — `events`, `workflow_transitions`
 * and `phi_access_log` all carry the column bare — so this is the FIRST place the `Actor` union is
 * written into SQL rather than the second. That removes §2.54's usual mismatch risk and leaves a
 * different one: a copy with nothing to reconcile it against, which goes stale the day a fifth
 * actor type is added and is discovered at an INSERT.
 *
 * The CHECK bodies below are written as SQL LITERALS, the house style of every other `check()` in
 * this directory — drizzle-kit emits what it is given and a computed list is one indirection away
 * from a migration nobody can read. `ACTOR_TYPE_NAMES` is the TypeScript-side copy, and the drift
 * is closed from BOTH ends:
 *
 *   · `ACTOR_TYPES_ARE_EXHAUSTIVE` is a `Record` over `Actor["type"]`, so widening the union in
 *     `packages/contracts` breaks `pnpm typecheck` HERE, at the schema, before a migration is
 *     written — not at a constraint violation months later.
 *   · `orders.test.ts` reads the two CHECKs' own definitions out of `pg_constraint` and compares
 *     them to `ACTOR_TYPE_NAMES`, so the SQL and the TypeScript cannot disagree silently either.
 *
 * §2.54's own prescription: if a fact must be written twice, make something fail when the copies
 * diverge.
 */
const ACTOR_TYPES_ARE_EXHAUSTIVE: Record<Actor["type"], true> = {
  user: true,
  agent: true,
  system: true,
  patient: true,
};

export const ACTOR_TYPE_NAMES: readonly Actor["type"][] = Object.keys(
  ACTOR_TYPES_ARE_EXHAUSTIVE,
) as Actor["type"][];


/** The envelope's own vocabularies. Closed here, in code, and each backed by a CHECK below. */
export const ORDER_STATUSES = ["open", "closed", "cancelled"] as const;
export const ORDER_ITEM_STATUSES = ["placed", "in_progress", "completed", "cancelled"] as const;
export const ORDER_PRIORITIES = ["routine", "urgent", "stat"] as const;
export const ORDER_AUTHORITIES = ["clinician", "external_prescription", "self", "protocol"] as const;
export const ORDER_ITEM_ORIGINS = ["direct", "addon", "reflex", "duplicate_confirmed"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];
export type OrderAuthority = (typeof ORDER_AUTHORITIES)[number];
export type OrderItemOrigin = (typeof ORDER_ITEM_ORIGINS)[number];

/**
 * ONE ORDER IS ONE KIND (DD2), and `order_group_id` is what joins the act.
 *
 * The series letter (`L` vs `R`), the department worklist, the billing branch and the SLA clock are
 * all PER KIND; an order mixing lab and imaging would have no number, no queue and no clock. So the
 * consult that orders CBC + chest X-ray writes TWO orders sharing one `order_group_id` — a ULID the
 * placing surface mints — and the doctor's sheet and the counter's slip still see one act. That is
 * what a corporate HIS does behind its single screen.
 *
 * **`kind` deliberately carries NO CHECK (DD3).** Resource kinds are closed at ten because a status
 * word is written into history forever and an eleventh kind could corrupt a vocabulary. An order
 * kind's vocabulary is the envelope's own four item states, identical for every kind, so there is
 * nothing an eleventh kind could corrupt. Kinds are instead claimed on the manifest seam and
 * refused at BOOT (`collectOrderKinds`) and at PLACEMENT (`placeOrder`'s `unknown_kind`).
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /** From `nextEpisodeNo(decl.seriesKey, serviceDate)` — `L2608290001`. Never minted here (DD7). */
    orderNo: text("order_no").notNull().unique(),
    /** The ULID the placing surface mints once per clinical act; several orders may share it. */
    orderGroupId: text("order_group_id").notNull(),
    kind: text("kind").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /**
     * The EPISODE NUMBER (`V…`, `D…`), not a row id — the shape `billing.invoices.encounter_id`
     * already uses, dispatched on its letter through the prefix registry (DD8). Plain text with no
     * FK on purpose: the registry is what decides which module can resolve it, and an FK would name
     * one of them.
     */
    encounterNo: text("encounter_no").notNull(),
    /**
     * The IST calendar day the order BELONGS to, resolved by the CALLER and never re-derived here
     * (spike S5). `istDate` lives in `modules/opd/time.ts` — the kernel could not call it without
     * importing a module — and `series.ts`'s own header forbids a second piece of code disagreeing
     * about the offset. A paper order backfilled at 14:00 carries the PAPER day (E13).
     */
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    priority: text("priority").notNull(),
    authority: text("authority").notNull(),
    orderedByType: text("ordered_by_type").notNull(),
    orderedById: text("ordered_by_id").notNull(),
    /**
     * THE RESPONSIBLE CLINICIAN, and it is a SEPARATE column from `ordered_by_id` on purpose (DD6).
     * An Indian hospital's medico-legal chain needs *the doctor who is responsible* distinct from
     * *the login that typed it* — a nurse keying a consultant's verbal order must not end up as the
     * ordering physician on a CT. Plain text holding a `users.id`, the `approvals.ts` actor-column
     * precedent (DD17): no FK anywhere in this phase points at `users`.
     */
    orderingClinicianId: text("ordering_clinician_id"),
    /** A `counterparties.id` — the outside referrer on a walk-in slip. Plain text, same precedent. */
    externalReferrerId: text("external_referrer_id"),
    /** A reflex rule id or standing-order id. Required when `authority = 'protocol'` (DD6). */
    protocolRef: text("protocol_ref"),
    /** Clinical justification — radiation justification for 18a. Required per kind declaration. */
    indication: text("indication"),
    status: text("status").notNull().default("open"),
    /**
     * THE CLINICAL INSTANT, which may PRECEDE `created_at` on a paper backfill (E13). The delta is
     * the claiming module's `late_entry` signal; the envelope only refuses to conflate the two.
     */
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // The ward's "what is pending for this patient" read, newest first (T5 `listOrdersForPatient`).
    index("orders_patient_placed_idx").on(t.patientId, t.placedAt.desc()),
    index("orders_encounter_no_idx").on(t.encounterNo),
    // The department worklist: "every open imaging order".
    index("orders_kind_status_idx").on(t.kind, t.status),
    // "The rest of this act" — the CBC beside the chest X-ray.
    index("orders_group_idx").on(t.orderGroupId),
    check("orders_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'stat')`),
    check("orders_authority_ck", sql`${t.authority} in ('clinician', 'external_prescription', 'self', 'protocol')`),
    check("orders_status_ck", sql`${t.status} in ('open', 'closed', 'cancelled')`),
    check("orders_ordered_by_type_ck", sql`${t.orderedByType} in ('user', 'agent', 'system', 'patient')`),
    /**
     * DD6's two `authority` couplings, as CHECKs rather than guards — a guard is one forgotten code
     * path away from a commission ledger with no referrer and a reflex order with no rule.
     * Written as biconditionals: an `external_referrer_id` on a `clinician` order is refused too,
     * because a referrer nobody can attribute is worse than none.
     */
    check(
      "orders_external_referrer_ck",
      sql`(${t.authority} = 'external_prescription') = (${t.externalReferrerId} is not null)`,
    ),
    check(
      "orders_protocol_ref_ck",
      sql`(${t.authority} = 'protocol') = (${t.protocolRef} is not null)`,
    ),
    /** A closed or cancelled header has a `closed_at`; an open one has none. */
    check(
      "orders_closed_at_ck",
      sql`(${t.status} = 'open') = (${t.closedAt} is null)`,
    ),
  ],
);

/**
 * ONE ITEM PER TEST, STUDY OR DRUG LINE, and the four states are the WHOLE envelope machine (DD4).
 *
 * `placed → in_progress → completed`, with `cancelled` reachable from `placed` and `in_progress`.
 * Not a workflow definition: definitions are DATA, owner-activated per deployment, and an envelope
 * whose terminal states could differ between two hospitals is not an envelope five plans can build
 * against. Every candidate fifth state — *accessioned*, *scheduled*, *checked_in*,
 * *resulted-unverified*, *dispensed* — is one kind's business and lives inside `in_progress` in
 * that module's own workflow definitions, which PROJECT onto this column by calling
 * `advanceOrderItem` at their milestones. An item that cannot start (consent missing, QC lockout)
 * is still `placed`.
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    /** The ONLY tariff link on the envelope (DD10) — the same key `advised_tests` already carries. */
    serviceId: text("service_id").notNull().references(() => services.id),
    status: text("status").notNull().default("placed"),
    origin: text("origin").notNull().default("direct"),
    /** The reflex rule's trigger, or the add-on's parent — which may live on ANOTHER order (E2). */
    parentItemId: text("parent_item_id"),
    /** D11: set TOGETHER or not at all. A duplicate nobody gave a reason for is not a decision. */
    duplicateOfItemId: text("duplicate_of_item_id"),
    duplicateReason: text("duplicate_reason"),
    /**
     * DD11 — HIV/NACO, PCPNDT-class USG, exposure-protocol source testing. The kernel reader omits
     * a restricted item unless the caller IS the ordering clinician or holds
     * `orders.read.restricted`; the claiming module's extension may be stricter, never looser.
     */
    restricted: boolean("restricted").notNull().default(false),
    /** DD5 — the state the item LEFT. `null` unless it was cancelled. */
    cancelledFrom: text("cancelled_from"),
    cancelReason: text("cancel_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    /**
     * T5's `findRecentItems` — 02 D11's cross-kind duplicate window ("this troponin was ordered
     * ninety minutes ago", "two doctors both asked for the CT"). `service_id` leads because the
     * window is always asked about ONE service; `created_at` follows so the range is a scan of the
     * index rather than a filter after it.
     */
    index("order_items_service_created_idx").on(t.serviceId, t.createdAt),
    check("order_items_status_ck", sql`${t.status} in ('placed', 'in_progress', 'completed', 'cancelled')`),
    check("order_items_origin_ck", sql`${t.origin} in ('direct', 'addon', 'reflex', 'duplicate_confirmed')`),
    /**
     * DD5, and it is a CHECK rather than a guard because O-4's money consequence depends on it:
     * billing must be able to read "was this cancelled after analysis started, and why" as ONE
     * column. `cancelled_from='in_progress'` without a reason is refused BY POSTGRES even if a
     * caller bypasses `advanceOrderItem` entirely — which is exactly what T4's A2 mutant proves.
     */
    check(
      "order_items_cancelled_from_ck",
      sql`${t.cancelledFrom} is null or ${t.cancelledFrom} in ('placed', 'in_progress')`,
    ),
    check(
      "order_items_cancel_reason_ck",
      sql`${t.cancelledFrom} is distinct from 'in_progress' or ${t.cancelReason} is not null`,
    ),
    /** D11 again: the pointer and the reason are one fact written in two columns. */
    check(
      "order_items_duplicate_ck",
      sql`(${t.duplicateOfItemId} is null) = (${t.duplicateReason} is null)`,
    ),
    /**
     * CLOSE REVIEW (MINOR 13) — `cancelled` AND `cancelled_from` ARE ONE FACT, so neither may exist
     * without the other. Before this, `insert … (status='cancelled')` with everything else null
     * passed every constraint, and 02 O-4's money rule — which decides whether the charge stands by
     * reading `cancelled_from` — would have had a row it cannot interpret.
     * `order_items_cancel_reason_ck` above does NOT cover it: that one fires only once
     * `cancelled_from` is already `'in_progress'`.
     */
    check(
      "order_items_cancelled_shape_ck",
      sql`(${t.status} = 'cancelled') = (${t.cancelledFrom} is not null)`,
    ),
  ],
);

/**
 * EVERY MOVE AN ITEM HAS EVER MADE, APPEND-ONLY AND ENFORCED BY THE DATABASE (DD12).
 *
 * `0043` and `0012` are the shape, verbatim: a trigger that RAISEs on UPDATE or DELETE. Enforcing
 * append-only in application code would leave the guarantee one forgotten code path away from being
 * false, and this is the table a medico-legal question is answered from — who started the test, who
 * cancelled it, and when.
 */
export const orderItemTransitions = pgTable(
  "order_item_transitions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => orderItems.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_item_transitions_item_idx").on(t.itemId, t.at),
    check("order_item_transitions_from_ck", sql`${t.fromStatus} in ('placed', 'in_progress', 'completed', 'cancelled')`),
    check("order_item_transitions_to_ck", sql`${t.toStatus} in ('placed', 'in_progress', 'completed', 'cancelled')`),
    check("order_item_transitions_actor_type_ck", sql`${t.actorType} in ('user', 'agent', 'system', 'patient')`),
  ],
);
