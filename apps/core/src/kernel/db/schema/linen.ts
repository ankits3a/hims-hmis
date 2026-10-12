import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";

/**
 * E2.4 LINEN (issue #728, decision 0072) — the item catalogue, par levels a supervisor set, the append-only movement
 * ledger, laundry batches, laundry short-delivery variances, condemn requests and ward counts. Read and written only by
 * `modules/linen`. No money column and no patient column anywhere: linen belongs to a ward (a `ward` resource).
 *
 * Computed par (beds × sets per bed by class × units per set) is never stored; `linen_par_levels` holds only a par a
 * supervisor set over it. On-hand is never stored either: it is the last `linen_ward_counts` row plus the ledger since.
 */
export const linenItems = pgTable(
  "linen_items",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    /** Pieces of this item in one bed set; 0 = not part of a ward bed's set (theatre linen). */
    unitsPerSet: integer("units_per_set").notNull().default(1),
    sort: integer("sort").notNull().default(100),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("linen_items_units_ck", sql`${t.unitsPerSet} >= 0`)],
);

/** A par a supervisor set for one ward and item, over the computed one. Deleting the row returns to computed. */
export const linenParLevels = pgTable(
  "linen_par_levels",
  {
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    par: integer("par").notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.wardResourceId, t.itemCode] }),
    check("linen_par_levels_par_ck", sql`${t.par} >= 0`),
  ],
);

export const linenLaundryBatches = pgTable(
  "linen_laundry_batches",
  {
    id: text("id").primaryKey(),
    batchNo: text("batch_no").notNull(),
    /** Infected linen goes in its own marked batch and is washed separately — never mixed. */
    infected: boolean("infected").notNull(),
    vendorName: text("vendor_name"),
    state: text("state").notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    sentBy: text("sent_by").notNull(),
    piecesSent: integer("pieces_sent").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: text("received_by"),
    piecesReceived: integer("pieces_received"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    uniqueIndex("linen_laundry_batches_no_uq").on(t.batchNo),
    uniqueIndex("linen_laundry_batches_idempotency_uq").on(t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    index("linen_laundry_batches_open_idx").on(t.state).where(sql`${t.state} = 'sent'`),
    index("linen_laundry_batches_sent_idx").on(t.sentAt),
    check("linen_laundry_batches_state_ck", sql`${t.state} in ('sent', 'received', 'short')`),
    check("linen_laundry_batches_pieces_ck", sql`${t.piecesSent} > 0 and coalesce(${t.piecesReceived}, 0) >= 0`),
    check("linen_laundry_batches_received_ck", sql`(${t.state} = 'sent') = (${t.receivedAt} is null)`),
  ],
);

export const linenCondemnRequests = pgTable(
  "linen_condemn_requests",
  {
    id: text("id").primaryKey(),
    /** Null = the linen store. */
    wardResourceId: text("ward_resource_id").references(() => resources.id),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    qty: integer("qty").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull().default("requested"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [
    index("linen_condemn_requests_open_idx").on(t.state).where(sql`${t.state} = 'requested'`),
    check("linen_condemn_requests_state_ck", sql`${t.state} in ('requested', 'approved', 'rejected')`),
    check("linen_condemn_requests_qty_ck", sql`${t.qty} > 0`),
    check("linen_condemn_requests_decided_ck", sql`(${t.state} = 'requested') = (${t.decidedAt} is null)`),
    // The four-eyes rule in the table too: a request is never decided by the person who raised it.
    check("linen_condemn_requests_four_eyes_ck", sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

/**
 * THE LEDGER — append-only (a trigger refuses UPDATE and DELETE). One row per item per act.
 *   issue_to_ward · return_soiled · return_infected · condemn — `ward_resource_id` is the ward (null = store for condemn)
 *   transfer_between_wards — from `ward_resource_id` to `to_ward_resource_id`
 *   laundry_out · laundry_in — `batch_id`, no ward (the soiled room and the store are the hospital's)
 */
export const linenMovements = pgTable(
  "linen_movements",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    qty: integer("qty").notNull(),
    wardResourceId: text("ward_resource_id").references(() => resources.id),
    toWardResourceId: text("to_ward_resource_id").references(() => resources.id),
    batchId: text("batch_id").references(() => linenLaundryBatches.id),
    condemnRequestId: text("condemn_request_id").references(() => linenCondemnRequests.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The phone's per-tap key: a double tap on Save is the same act. */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("linen_movements_ward_idx").on(t.wardResourceId, t.itemCode, t.at),
    index("linen_movements_to_ward_idx").on(t.toWardResourceId, t.itemCode, t.at).where(sql`${t.toWardResourceId} is not null`),
    index("linen_movements_batch_idx").on(t.batchId).where(sql`${t.batchId} is not null`),
    index("linen_movements_at_idx").on(t.kind, t.at),
    uniqueIndex("linen_movements_idempotency_uq").on(t.kind, t.wardResourceId, t.itemCode, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check("linen_movements_kind_ck", sql`${t.kind} in ('issue_to_ward', 'return_soiled', 'return_infected', 'laundry_out', 'laundry_in', 'condemn', 'transfer_between_wards')`),
    check("linen_movements_qty_ck", sql`${t.qty} > 0`),
    check("linen_movements_ward_ck", sql`(${t.kind} in ('issue_to_ward', 'return_soiled', 'return_infected', 'transfer_between_wards')) <= (${t.wardResourceId} is not null)`),
    check("linen_movements_transfer_ck", sql`(${t.kind} = 'transfer_between_wards') = (${t.toWardResourceId} is not null) and (${t.toWardResourceId} is null or ${t.toWardResourceId} <> ${t.wardResourceId})`),
    check("linen_movements_batch_ck", sql`(${t.kind} in ('laundry_out', 'laundry_in')) = (${t.batchId} is not null)`),
    check("linen_movements_condemn_ck", sql`(${t.kind} = 'condemn') = (${t.condemnRequestId} is not null)`),
    check("linen_movements_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system')`),
  ],
);

/** A laundry batch that came back short: one row per batch and item, written by the receipt. */
export const linenVariances = pgTable(
  "linen_variances",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("laundry_short"),
    batchId: text("batch_id").notNull().references(() => linenLaundryBatches.id),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    sent: integer("sent").notNull(),
    received: integer("received").notNull(),
    short: integer("short").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
  },
  (t) => [
    uniqueIndex("linen_variances_batch_item_uq").on(t.batchId, t.itemCode),
    index("linen_variances_at_idx").on(t.recordedAt),
    check("linen_variances_kind_ck", sql`${t.kind} in ('laundry_short')`),
    check("linen_variances_short_ck", sql`${t.short} > 0 and ${t.short} = ${t.sent} - ${t.received} and ${t.received} >= 0`),
  ],
);

/** What a ward counted on its shelves, per item. The newest row is the anchor of the ward's book balance. */
export const linenWardCounts = pgTable(
  "linen_ward_counts",
  {
    id: text("id").primaryKey(),
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    onHand: integer("on_hand").notNull(),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
    countedBy: text("counted_by").notNull(),
    source: text("source").notNull().default("person"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    index("linen_ward_counts_ward_idx").on(t.wardResourceId, t.itemCode, t.countedAt),
    uniqueIndex("linen_ward_counts_idempotency_uq").on(t.wardResourceId, t.itemCode, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check("linen_ward_counts_on_hand_ck", sql`${t.onHand} >= 0`),
    check("linen_ward_counts_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system')`),
  ],
);
