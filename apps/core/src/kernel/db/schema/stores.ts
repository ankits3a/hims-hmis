import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { items, storeIndents, transferLines, transfers } from "./materials";
import { resources } from "./resources";

/**
 * STORES S1 (#1111, decision 0099) — the non-drug Stores module's own table.
 *
 * Stores owns NO stock quantity: every quantity is a `stock_ledger` row posted through materials, and
 * every item is an `items` row (the one-ledger rule, `docs/specs/stores-programme.md` §3). What it
 * owns here is the one thing materials has no home for: a person's "Not in the list" request, which
 * the materials head resolves by creating the item or pointing to an existing one.
 *
 * `status` is `open` until resolved; `created` and `use_existing` both name the item the requester
 * should use (`resolved_item_id`), and the requester is sent exactly one notice either way.
 */
export const STORES_ITEM_REQUEST_STATUS_VALUES = ["open", "created", "use_existing"] as const;

export const storesItemRequests = pgTable(
  "stores_item_requests",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note"),
    requestedBy: text("requested_by").notNull(),
    shelfId: text("shelf_id").references(() => resources.id),
    departmentId: text("department_id"),
    status: text("status").notNull().default("open"),
    resolvedItemId: text("resolved_item_id").references(() => items.id),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stores_item_requests_status_idx").on(t.status, t.createdAt),
    check("stores_item_requests_status_ck", sql`${t.status} in ('open', 'created', 'use_existing')`),
    check(
      "stores_item_requests_resolution_ck",
      sql`(${t.status} = 'open') = (${t.resolvedItemId} is null and ${t.resolvedAt} is null)`,
    ),
  ],
);

/**
 * STORES S2a (#1112, decisions 1, 2, 5) — WHAT A STORES TICKET ADDS TO THE MATERIALS INDENT. The ticket IS the
 * indent (one requisition paper for the house); this row carries what pharmacy's indent has no use for: the
 * department and shelf it was raised for, the priority and its reason, needed-by, deliver-to, the channel, the
 * night-store routing, and the link to the ticket it re-raises or re-asks, whose first raise time is the clock
 * (`clock_from`). Written once at raise; nothing updates it (a re-raise is a NEW ticket that names the first).
 */
export const STORES_TICKET_PRIORITY_VALUES = ["routine", "urgent", "emergency"] as const;
export const STORES_TICKET_CHANNEL_VALUES = ["phone", "web", "copilot", "agent"] as const;

export const storesTicketDetails = pgTable(
  "stores_ticket_details",
  {
    indentId: text("indent_id").primaryKey().references(() => storeIndents.id),
    departmentId: text("department_id").notNull(),
    shelfId: text("shelf_id").notNull().references(() => resources.id),
    priority: text("priority").notNull(),
    channel: text("channel").notNull().default("web"),
    neededBy: timestamp("needed_by", { withTimezone: true }),
    deliverTo: text("deliver_to"),
    emergencyReason: text("emergency_reason"),
    night: boolean("night").notNull().default(false),
    originIndentId: text("origin_indent_id").references(() => storeIndents.id),
    originKind: text("origin_kind"),
    clockFrom: timestamp("clock_from", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stores_ticket_details_dept_idx").on(t.departmentId),
    index("stores_ticket_details_shelf_idx").on(t.shelfId),
    uniqueIndex("stores_ticket_details_reraise_ux").on(t.originIndentId).where(sql`${t.originKind} = 're_raise'`),
    // S2b (#1112, decision 6): a ticket's short part is re-asked once.
    uniqueIndex("stores_ticket_details_reask_ux").on(t.originIndentId).where(sql`${t.originKind} = 're_ask'`),
    check("stores_ticket_details_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'emergency')`),
    check("stores_ticket_details_channel_ck", sql`${t.channel} in ('phone', 'web', 'copilot', 'agent')`),
    check("stores_ticket_details_emergency_ck", sql`${t.priority} <> 'emergency' or ${t.emergencyReason} is not null`),
    check("stores_ticket_details_origin_ck", sql`(${t.originIndentId} is null) = (${t.originKind} is null) and (${t.originKind} is null or ${t.originKind} in ('re_raise', 're_ask'))`),
  ],
);

/**
 * STORES S2a (#1112, decision 6) — THE PICKING CLAIM: one picker per ticket. Each claim is a row (insert only);
 * the live claim is the newest, and it lapses 30 minutes after it was taken (`tickets.ts` `CLAIM_IDLE_MS`). The
 * timeline reads every claim as a step.
 */
export const storesPickingClaims = pgTable(
  "stores_picking_claims",
  {
    id: text("id").primaryKey(),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    claimedBy: text("claimed_by").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("stores_picking_claims_indent_idx").on(t.indentId, t.claimedAt)],
);

/**
 * STORES S2b (#1112, decision 7) — THE CUSTODY CHAIN: one row per hand of the goods between the issuer and the
 * receiver, keyed on the transfer. `take` (issuer → porter, the porter's scan), `hand_over` (porter → porter, the
 * incoming porter's scan), `take_over` (the source keeper or the materials head, with a reason, naming the holder
 * they took it from) and `return_accepted` (holder → the source keeper, goods brought back). The current holder is
 * the newest row's `to_user_id`, or the issuer when there is none. The ledger is untouched by every row here.
 *
 * APPEND-ONLY IN THE DATABASE (migration 0239 trigger `stores_custody_handoffs_append_only`). A scan carries the
 * phone's time (`phone_at`); `occurred_at` is that time unless it is in the future (then the server's), and
 * `recorded_at` is the server's. `flag` marks a scan more than 12 h old (`late`) or from the future (`future`).
 */
export const STORES_HANDOFF_KINDS = ["take", "hand_over", "take_over", "return_accepted"] as const;

export const storesCustodyHandoffs = pgTable(
  "stores_custody_handoffs",
  {
    id: text("id").primaryKey(),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    transferId: text("transfer_id").notNull().references(() => transfers.id),
    kind: text("kind").notNull(),
    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),
    /** `scan` (the label's number), `typed` (its last four digits) or `forced` (a take-over). */
    method: text("method").notNull(),
    reason: text("reason"),
    phoneAt: timestamp("phone_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    flag: text("flag"),
  },
  (t) => [
    index("stores_custody_handoffs_transfer_idx").on(t.transferId, t.occurredAt),
    index("stores_custody_handoffs_indent_idx").on(t.indentId),
    check("stores_custody_handoffs_kind_ck", sql`${t.kind} in ('take', 'hand_over', 'take_over', 'return_accepted')`),
    check("stores_custody_handoffs_method_ck", sql`${t.method} in ('scan', 'typed', 'forced', 'counter')`),
    check("stores_custody_handoffs_flag_ck", sql`${t.flag} is null or ${t.flag} in ('late', 'future')`),
    check("stores_custody_handoffs_forced_ck", sql`${t.kind} <> 'take_over' or ${t.reason} is not null`),
    check("stores_custody_handoffs_two_people_ck", sql`${t.fromUserId} <> ${t.toUserId}`),
  ],
);

/**
 * STORES S2b (#1112, decision 14) — THE CLIENT IDEMPOTENCY KEYS. A phone posts a scan or a receipt with its own
 * key; the second post of the same key by the same person records nothing and answers the first's result.
 */
export const storesClientKeys = pgTable(
  "stores_client_keys",
  {
    actorId: text("actor_id").notNull(),
    clientKey: text("client_key").notNull(),
    act: text("act").notNull(),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.actorId, t.clientKey], name: "stores_client_keys_pk" })],
);

/** S2b (decision 14): a keeper confirms a late (or future-dated) scan once. */
export const storesScanConfirmations = pgTable(
  "stores_scan_confirmations",
  {
    /** The confirmed scan: a hand-off's id, or a transfer's id for its delivery's scan (pre-merge review M1). No foreign key: either table. */
    handoffId: text("handoff_id").primaryKey(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  },
);

/**
 * STORES S2b (#1112, decision 8) — THE RECEIVER'S ANSWER, per transfer line (one batch of one ticket line):
 * accepted, short, wrong and damaged, which add up to what was issued. Only `accepted` is received (and charged);
 * the rest stays in IN-TRANSIT until it is sent back (wrong, damaged) or resolved (short). Written once.
 */
export const storesDeliveryLines = pgTable(
  "stores_delivery_lines",
  {
    transferLineId: text("transfer_line_id").primaryKey().references(() => transferLines.id),
    transferId: text("transfer_id").notNull().references(() => transfers.id),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    lineIdx: integer("line_idx").notNull(),
    itemId: text("item_id").notNull().references(() => items.id),
    accepted: integer("accepted").notNull(),
    short: integer("short").notNull(),
    wrong: integer("wrong").notNull(),
    damaged: integer("damaged").notNull(),
    receivedBy: text("received_by").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    atCounter: boolean("at_counter").notNull(),
    /** The phone's time of the receipt scan, kept as evidence; `received_at` is the time the receipt counts at. */
    phoneAt: timestamp("phone_at", { withTimezone: true }),
    /** `late` or `future` when the phone's time was not used (decision 14): the source keeper confirms it. */
    flag: text("flag"),
  },
  (t) => [
    index("stores_delivery_lines_indent_idx").on(t.indentId),
    check("stores_delivery_lines_flag_ck", sql`${t.flag} is null or ${t.flag} in ('late', 'future')`),
    check("stores_delivery_lines_qty_ck", sql`${t.accepted} >= 0 and ${t.short} >= 0 and ${t.wrong} >= 0 and ${t.damaged} >= 0`),
  ],
);

/**
 * STORES S2b (#1112, decisions 8, 9) — WHAT BECAME OF A QUANTITY LEFT IN IN-TRANSIT, per transfer line:
 *   · `sent_back` — wrong and damaged lines on their way back (the source keeper accepts: wrong → source,
 *     damaged → quarantine);
 *   · `undelivered` — nobody signed; the porter brings the whole transfer back and the source keeper accepts;
 *   · `found` / `returned` / `lost` — the materials head's resolution of a short. `lost` is an adjustment request
 *     to the stock-adjustment approver (`approval_id`) and posts nothing until it is granted.
 * `status` is `pending` until the stock moved (`posted`, with the act's time) or the approval was refused.
 */
export const storesTransitResolutions = pgTable(
  "stores_transit_resolutions",
  {
    id: text("id").primaryKey(),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    transferId: text("transfer_id").notNull().references(() => transfers.id),
    transferLineId: text("transfer_line_id").notNull().references(() => transferLines.id),
    kind: text("kind").notNull(),
    qty: integer("qty").notNull(),
    /** Where it went (`returned` / `sent_back` / `undelivered`): the source, or the quarantine store for a damaged line. */
    toResourceId: text("to_resource_id"),
    approvalId: text("approval_id"),
    status: text("status").notNull(),
    note: text("note"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    postedBy: text("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [
    index("stores_transit_resolutions_indent_idx").on(t.indentId),
    uniqueIndex("stores_transit_resolutions_short_ux").on(t.transferLineId).where(sql`${t.kind} in ('found', 'returned', 'lost') and ${t.status} <> 'refused'`),
    uniqueIndex("stores_transit_resolutions_back_ux").on(t.transferLineId, t.kind, t.toResourceId).where(sql`${t.kind} in ('sent_back', 'undelivered')`),
    check("stores_transit_resolutions_kind_ck", sql`${t.kind} in ('sent_back', 'undelivered', 'found', 'returned', 'lost')`),
    check("stores_transit_resolutions_status_ck", sql`${t.status} in ('pending', 'posted', 'refused')`),
    check("stores_transit_resolutions_qty_ck", sql`${t.qty} > 0`),
    check("stores_transit_resolutions_lost_ck", sql`(${t.kind} = 'lost') = (${t.approvalId} is not null)`),
    check("stores_transit_resolutions_posted_ck", sql`(${t.status} = 'posted') = (${t.postedAt} is not null) and (${t.postedAt} is null) = (${t.postedBy} is null)`),
  ],
);
