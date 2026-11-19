import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { grnLines, grns, itemCategories, items, stockBatches, storeIndents, transferLines, transfers, vendors } from "./materials";
import { orgDepartments } from "./org";
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

/**
 * STORES S2c (#1119, decisions 1–5) — THE GATE PASS. One row per pass, written once at raise and never changed:
 * what leaves, where it goes and why. Its life (out, back, closed) is the append-only scan log below, never a
 * status column here, so nothing on a pass is ever edited.
 *
 *   · `returnable` (repair, calibration, refill, loan) names the source store, the party, the due-back day and its
 *     lines; the guard's exit scan moves the stock to the per-site `OUT-ON-PASS` store and an entry scan brings it
 *     back to the source (ledger `ref_type = 'gate_pass'`, `ref_id` = this id).
 *   · `non_returnable` stands on a dispatched supplier return or a posted write-off (`ref_type`, `ref_id`); its lines
 *     are copied from that record at raise. It moves no stock: the return or the write-off already did.
 *
 * `pass_no` is `MGP` + yymmdd + 4 digits (`kernel/episodes/series.ts`); the printed QR carries it and nothing else.
 */
export const STORES_GATE_PASS_KINDS = ["returnable", "non_returnable"] as const;
export const STORES_GATE_PASS_PURPOSES = ["repair", "calibration", "refill", "loan"] as const;

export const storesGatePasses = pgTable(
  "stores_gate_passes",
  {
    id: text("id").primaryKey(),
    passNo: text("pass_no").notNull(),
    kind: text("kind").notNull(),
    purpose: text("purpose"),
    sourceStoreId: text("source_store_id").notNull().references(() => resources.id),
    party: text("party").notNull(),
    /** The IST calendar day it is due back (returnable only). */
    dueBack: date("due_back", { mode: "string" }),
    refType: text("ref_type"),
    refId: text("ref_id"),
    note: text("note"),
    raisedBy: text("raised_by").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_gate_passes_pass_no_ux").on(t.passNo),
    index("stores_gate_passes_ref_idx").on(t.refType, t.refId),
    check("stores_gate_passes_kind_ck", sql`${t.kind} in ('returnable', 'non_returnable')`),
    check("stores_gate_passes_purpose_ck", sql`${t.purpose} is null or ${t.purpose} in ('repair', 'calibration', 'refill', 'loan')`),
    check("stores_gate_passes_ref_type_ck", sql`${t.refType} is null or ${t.refType} in ('supplier_return', 'write_off', 'scrap_sale')`),
    check(
      "stores_gate_passes_shape_ck",
      sql`(${t.kind} = 'returnable' and ${t.purpose} is not null and ${t.dueBack} is not null and ${t.refType} is null and ${t.refId} is null)
        or (${t.kind} = 'non_returnable' and ${t.purpose} is null and ${t.dueBack} is null and ${t.refType} is not null and ${t.refId} is not null)`,
    ),
  ],
);

/** The items and quantities a pass names, in the order raised. Written with the pass, never changed. */
export const storesGatePassLines = pgTable(
  "stores_gate_pass_lines",
  {
    passId: text("pass_id").notNull().references(() => storesGatePasses.id),
    lineIdx: integer("line_idx").notNull(),
    itemId: text("item_id").notNull().references(() => items.id),
    qty: integer("qty").notNull(),
    /** STORES S4 (#1114, decision 5) — the tagged units a returnable line names (one per base unit); null for an untagged line. */
    unitIds: text("unit_ids").array(),
  },
  (t) => [
    primaryKey({ columns: [t.passId, t.lineIdx] }),
    uniqueIndex("stores_gate_pass_lines_item_ux").on(t.passId, t.itemId),
    check("stores_gate_pass_lines_qty_ck", sql`${t.qty} > 0`),
  ],
);

/**
 * STORES S2c (#1119, decisions 4, 5) — THE GATE LOG: the guard's exit and entry scans and the keeper's close of a
 * pass that never left. APPEND-ONLY IN THE DATABASE (migration 0240 trigger `stores_gate_pass_scans_append_only`).
 *
 * A scan carries the phone's time (`phone_at`) and the person's idempotency key (`client_key`, unique per actor):
 * a second post of the same key records nothing. `occurred_at` is the phone's time unless it is in the future
 * (then the server's); `recorded_at` is the server's; `flag` marks a scan more than 12 h old (`late`) or from
 * the future (`future`). `lines` is what crossed the gate: `[{ itemId, batchId, qty }]` (an exit of a
 * non-returnable pass carries its lines with no batch: no stock moved).
 */
export const storesGatePassScans = pgTable(
  "stores_gate_pass_scans",
  {
    id: text("id").primaryKey(),
    passId: text("pass_id").notNull().references(() => storesGatePasses.id),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    /** `scan` (the QR), `typed` (its last four digits) or null (a close). */
    method: text("method"),
    clientKey: text("client_key"),
    lines: jsonb("lines").$type<{ itemId: string; batchId: string | null; qty: number }[]>().notNull(),
    reason: text("reason"),
    phoneAt: timestamp("phone_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    flag: text("flag"),
  },
  (t) => [
    index("stores_gate_pass_scans_pass_idx").on(t.passId, t.recordedAt),
    uniqueIndex("stores_gate_pass_scans_key_ux").on(t.actorId, t.clientKey).where(sql`${t.clientKey} is not null`),
    uniqueIndex("stores_gate_pass_scans_exit_ux").on(t.passId).where(sql`${t.kind} = 'exit'`),
    uniqueIndex("stores_gate_pass_scans_close_ux").on(t.passId).where(sql`${t.kind} = 'close'`),
    check("stores_gate_pass_scans_kind_ck", sql`${t.kind} in ('exit', 'entry', 'close')`),
    check("stores_gate_pass_scans_method_ck", sql`${t.method} is null or ${t.method} in ('scan', 'typed')`),
    check("stores_gate_pass_scans_flag_ck", sql`${t.flag} is null or ${t.flag} in ('late', 'future')`),
    check("stores_gate_pass_scans_close_ck", sql`${t.kind} <> 'close' or ${t.reason} is not null`),
  ],
);

/**
 * STORES S3 (#1113, decision 12) — THE CHASER'S MEMORY. One row per ticket and step: the internal nudge the
 * minute sweep sent (an approval waiting 45 min, a pick past its clock, a transit leg past 30 min). The unique key
 * is what makes "at most one nudge per ticket per step" true under two sweeps at once; the row records who was
 * told. Never a supplier, never a patient. Append-only by use: the sweep inserts `on conflict do nothing`.
 *
 * `step` is `approval`, `pick`, or `leg:<n>` (the n-th carrier hand-off, so every leg is chased once).
 */
export const storesNudges = pgTable(
  "stores_nudges",
  {
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    step: text("step").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    recipients: jsonb("recipients").$type<string[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.indentId, t.step] }),
    check("stores_nudges_step_ck", sql`${t.step} in ('approval', 'pick') or ${t.step} ~ '^leg:[0-9]+$'`),
  ],
);

/**
 * STORES S4 (#1114, decision 1) — THE TAG DECISION, one row per GRN line of a Stores item under a tag rule: the
 * rule, the unit cost before GST, the threshold it was judged against and the result (`tagged` or `counted`). Written
 * once, the first time Stores reads the line (`asset-rules.ts` `tagDecisionFor`), so a later change of the threshold
 * never rewrites the past. APPEND-ONLY IN THE DATABASE (migration 0242).
 */
export const STORES_TAG_RESULTS = ["tagged", "counted"] as const;

export const storesTagDecisions = pgTable(
  "stores_tag_decisions",
  {
    grnLineId: text("grn_line_id").primaryKey().references(() => grnLines.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    itemId: text("item_id").notNull().references(() => items.id),
    rule: text("rule").notNull(),
    unitCostPaise: bigint("unit_cost_paise", { mode: "number" }).notNull(),
    thresholdPaise: bigint("threshold_paise", { mode: "number" }).notNull(),
    result: text("result").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_tag_decisions_batch_ux").on(t.batchId),
    check("stores_tag_decisions_rule_ck", sql`${t.rule} in ('always', 'from_value')`),
    check("stores_tag_decisions_result_ck", sql`${t.result} in ('tagged', 'counted')`),
  ],
);

/**
 * STORES S4 (#1114, decisions 2, 3) — ONE ROW PER PHYSICAL UNIT, written once and never changed: the item, its first
 * tag (`AST` + yymm + 6 digits; the QR carries it and nothing else), serial, make, model, where it came from (a GRN
 * line or the go-live opening sweep), its batch (a tagged unit is one base unit of it in `stock_ledger`), the unit
 * cost before GST (null = "Cost unknown", an opening unit) and the supplier. Every later fact is a unit event.
 */
export const storesAssetUnits = pgTable(
  "stores_asset_units",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    tagNo: text("tag_no").notNull(),
    serial: text("serial"),
    make: text("make"),
    model: text("model"),
    origin: text("origin").notNull(),
    grnLineId: text("grn_line_id").references(() => grnLines.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    unitCostPaise: bigint("unit_cost_paise", { mode: "number" }),
    supplierId: text("supplier_id").references(() => vendors.id),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_asset_units_tag_ux").on(t.tagNo),
    uniqueIndex("stores_asset_units_serial_ux").using("btree", t.itemId, sql`lower(${t.serial})`).where(sql`${t.serial} is not null`),
    index("stores_asset_units_batch_idx").on(t.batchId),
    index("stores_asset_units_item_idx").on(t.itemId),
    check("stores_asset_units_origin_ck", sql`${t.origin} in ('grn', 'opening')`),
    check("stores_asset_units_origin_shape_ck", sql`(${t.origin} = 'grn') = (${t.grnLineId} is not null)`),
    check("stores_asset_units_cost_ck", sql`${t.unitCostPaise} is null or ${t.unitCostPaise} >= 0`),
  ],
);

/**
 * STORES S4 (#1114, decision 4) — EVERY FACT ABOUT A UNIT, in `seq` order. Place, holder, status and due dates are
 * DERIVED from these rows, never stored (programme I4): the latest place-bearing row (`store_id` set) is where the
 * unit is. `data` carries the kind's facts (a tag number, a date, a contract, a fault's line, before and after of a
 * correction). APPEND-ONLY IN THE DATABASE (migration 0242); a correction is a new row naming the one it corrects.
 * A tag number is bound once in the whole house: the unique index over `tagged` / `retagged` rows.
 */
export const STORES_UNIT_EVENT_KINDS = [
  "tagged", "placed", "moved", "installed", "out_on_pass", "back", "fault_reported", "repair_opened", "repair_closed", "warranty_set",
  "contract_set", "calibrated", "device_linked", "verified_seen", "tag_voided", "retagged", "condemn_proposed", "condemn_signed",
  "condemn_objected", "condemned", "disposed", "corrected", "loss_proposed", "written_off", "found", "seen_elsewhere", "transfer_proposed",
  "transferred", "regulator_paper",
] as const;

export const storesAssetUnitEvents = pgTable(
  "stores_asset_unit_events",
  {
    seq: bigserial("seq", { mode: "number" }),
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull().references(() => storesAssetUnits.id),
    kind: text("kind").notNull(),
    /** Set on a place-bearing row only: where the unit is from this row on. */
    storeId: text("store_id").references(() => resources.id),
    refType: text("ref_type"),
    refId: text("ref_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    actorId: text("actor_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_asset_unit_events_unit_idx").on(t.unitId, t.seq),
    index("stores_asset_unit_events_kind_idx").on(t.kind, t.occurredAt),
    index("stores_asset_unit_events_ref_idx").on(t.refType, t.refId),
    uniqueIndex("stores_asset_unit_events_tag_ux").using("btree", sql`(${t.data}->>'tagNo')`).where(sql`${t.kind} in ('tagged', 'retagged')`),
    check("stores_asset_unit_events_kind_ck", sql`${t.kind} in (${sql.raw(STORES_UNIT_EVENT_KINDS.map((k) => `'${k}'`).join(", "))})`),
  ],
);

/**
 * STORES S4 (#1114, decision 12) — A VERIFICATION ROUND: a `start` row and, later, a `close` row naming the same round,
 * with what the close found (`result`: not seen, wrong place). The scans are unit events (`verified_seen`, ref = the
 * round). APPEND-ONLY IN THE DATABASE (migration 0242).
 */
export const storesAssetVerifications = pgTable(
  "stores_asset_verifications",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id").notNull(),
    kind: text("kind").notNull(),
    departmentId: text("department_id").notNull(),
    actorId: text("actor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("stores_asset_verifications_round_kind_ux").on(t.roundId, t.kind),
    index("stores_asset_verifications_dept_idx").on(t.departmentId, t.at),
    check("stores_asset_verifications_kind_ck", sql`${t.kind} in ('start', 'close')`),
    check("stores_asset_verifications_start_ck", sql`${t.kind} <> 'start' or ${t.roundId} = ${t.id}`),
  ],
);

/**
 * STORES S4b (#1114, decision 13, ruling 0100 Q5) — A CONDEMNATION OR LOSS PROPOSAL, written once. `kind` is
 * `condemn` (the HOD or biomedical proposed it, with a reason from the list) or `loss` (a unit not seen 30 days after a
 * verification round, or lost on its way to a department: reason `lost`). The committee's seats are frozen on the row
 * (`seats`: `hod` for the user department, `accounts`, `materials`, and `biomedical` for medical equipment), as are
 * the cost it was judged on (null = "Cost unknown") and whether the owner must also approve (above ₹50,000 or cost
 * unknown). A fresh proposal after an objection is a NEW row naming the old one (`replaces_id`). Status is DERIVED
 * from the signatures, the steps and the approvals, never stored. APPEND-ONLY IN THE DATABASE (migration 0243).
 */
export const STORES_CONDEMNATION_REASONS = ["beyond_repair", "obsolete", "damaged", "lost"] as const;
export const STORES_COMMITTEE_SEATS = ["hod", "accounts", "materials", "biomedical"] as const;

export const storesCondemnations = pgTable(
  "stores_condemnations",
  {
    id: text("id").primaryKey(),
    condNo: text("cond_no").notNull(),
    unitId: text("unit_id").notNull().references(() => storesAssetUnits.id),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    /** The user department whose HOD holds a seat (null: the unit sits in a store, no user department). */
    departmentId: text("department_id"),
    seats: text("seats").array().notNull(),
    /** An IT unit that stored data needs a wipe or destruction certificate before it leaves (DPDP Act). */
    holdsData: boolean("holds_data").notNull().default(false),
    costPaise: bigint("cost_paise", { mode: "number" }),
    needsOwner: boolean("needs_owner").notNull(),
    replacesId: text("replaces_id"),
    roundId: text("round_id"),
    proposedBy: text("proposed_by").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_condemnations_no_ux").on(t.condNo),
    index("stores_condemnations_unit_idx").on(t.unitId, t.proposedAt),
    check("stores_condemnations_kind_ck", sql`${t.kind} in ('condemn', 'loss')`),
    check("stores_condemnations_reason_ck", sql`${t.reason} in ('beyond_repair', 'obsolete', 'damaged', 'lost')`),
    check("stores_condemnations_loss_ck", sql`${t.kind} <> 'loss' or ${t.reason} = 'lost'`),
  ],
);

/**
 * STORES S4b (#1114, decision 13) — EACH SEAT'S SIGNATURE OR OBJECTION, written once. One signature per seat and one
 * act per person on a proposal (one person never fills two seats); an objection carries its reason and stops the
 * proposal. APPEND-ONLY IN THE DATABASE (migration 0243).
 */
export const storesCondemnationSignatures = pgTable(
  "stores_condemnation_signatures",
  {
    id: text("id").primaryKey(),
    condemnationId: text("condemnation_id").notNull().references(() => storesCondemnations.id),
    seat: text("seat").notNull(),
    kind: text("kind").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_condemnation_signatures_seat_ux").on(t.condemnationId, t.seat),
    uniqueIndex("stores_condemnation_signatures_actor_ux").on(t.condemnationId, t.actorId),
    check("stores_condemnation_signatures_seat_ck", sql`${t.seat} in ('hod', 'accounts', 'materials', 'biomedical')`),
    check("stores_condemnation_signatures_kind_ck", sql`${t.kind} in ('sign', 'object')`),
    check("stores_condemnation_signatures_reason_ck", sql`${t.kind} <> 'object' or ${t.reason} is not null`),
  ],
);

/**
 * STORES S4b (#1114, decisions 13, 14) — WHAT HAPPENED AFTER THE SEATS, written once each: `raised` (every seat signed:
 * the unit's books moved to the `CONDEMNED` hold, the write-off raised with its superintendent approval, the owner's
 * approval asked when the row needs it), `approved` / `rejected` (read off those approvals), `posted` (the write-off
 * posted: a disposal or a loss). APPEND-ONLY IN THE DATABASE (migration 0243).
 */
export const storesCondemnationSteps = pgTable(
  "stores_condemnation_steps",
  {
    id: text("id").primaryKey(),
    condemnationId: text("condemnation_id").notNull().references(() => storesCondemnations.id),
    kind: text("kind").notNull(),
    writeOffId: text("write_off_id"),
    ownerApprovalId: text("owner_approval_id"),
    /** `raised`: where the unit's books stood before the hold (and the transfer when it was in transit). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    actorId: text("actor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_condemnation_steps_kind_ux").on(t.condemnationId, t.kind),
    check("stores_condemnation_steps_kind_ck", sql`${t.kind} in ('raised', 'approved', 'rejected', 'posted')`),
  ],
);

/**
 * STORES S4b (#1114, decision 14) — A CONDEMNED UNIT'S DISPOSAL, written once: scrap sale (buyer from the supplier
 * list, amount, accounts' receipt reference, the sale invoice number, the written bids above ₹25,000), buy-back (the
 * purchase order and the amount) or an authorised e-waste recycler (its certificate). The wipe certificate of a unit
 * that held data rides here. Tax on the sale is the accountant's: HMIS records the invoice number and the amount only.
 * APPEND-ONLY IN THE DATABASE (migration 0243).
 */
export const storesScrapSales = pgTable(
  "stores_scrap_sales",
  {
    id: text("id").primaryKey(),
    condemnationId: text("condemnation_id").notNull().references(() => storesCondemnations.id),
    unitId: text("unit_id").notNull().references(() => storesAssetUnits.id),
    method: text("method").notNull(),
    buyerId: text("buyer_id").notNull().references(() => vendors.id),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    invoiceNo: text("invoice_no").notNull(),
    receiptRef: text("receipt_ref"),
    bids: jsonb("bids").$type<{ vendorId: string; amountPaise: number }[]>().notNull().default(sql`'[]'::jsonb`),
    poRef: text("po_ref"),
    certificateNo: text("certificate_no"),
    wipeCertificateNo: text("wipe_certificate_no"),
    writeOffId: text("write_off_id").notNull(),
    recordedBy: text("recorded_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_scrap_sales_condemnation_ux").on(t.condemnationId),
    index("stores_scrap_sales_unit_idx").on(t.unitId),
    check("stores_scrap_sales_method_ck", sql`${t.method} in ('scrap_sale', 'buy_back', 'e_waste')`),
    check("stores_scrap_sales_amount_ck", sql`${t.amountPaise} >= 0`),
  ],
);

/* ═══════════════════════════════ STORES S5a (#1115): the front of the buying desk ═══════════════════════════════ */

export const STORES_PR_SOURCES = ["department", "central", "planner", "copilot"] as const;
export const STORES_PR_STAMP_KINDS = ["approved", "declined", "cancelled"] as const;
export const STORES_PR_STAMP_ROLES = ["hod", "ms", "delegate", "materials"] as const;
export const STORES_BANDS = ["A", "B", "C"] as const;

/**
 * STORES S5a (#1115, decision 1) — A PURCHASE REQUEST (`MPR` + yymmdd + 4 digits): a department's ask for a non-stock
 * or capital item, or the central store's shortfall. Written once; its decision is a `stores_purchase_request_stamps`
 * row and its status is DERIVED. APPEND-ONLY IN THE DATABASE (migration 0244).
 */
export const storesPurchaseRequests = pgTable(
  "stores_purchase_requests",
  {
    id: text("id").primaryKey(),
    prNo: text("pr_no").notNull(),
    source: text("source").notNull(),
    /** The asking department (null for the central store's and the planner's requests). */
    departmentId: text("department_id").references(() => orgDepartments.id),
    /** The shelf the goods go to when they arrive (S5b's delivery ticket); null when none was named. */
    shelfId: text("shelf_id").references(() => resources.id),
    priority: text("priority").notNull(),
    note: text("note"),
    raisedBy: text("raised_by").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_purchase_requests_no_ux").on(t.prNo),
    index("stores_purchase_requests_dept_idx").on(t.departmentId, t.raisedAt),
    check("stores_purchase_requests_source_ck", sql`${t.source} in ('department', 'central', 'planner', 'copilot')`),
    check("stores_purchase_requests_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'emergency')`),
    check("stores_purchase_requests_dept_ck", sql`${t.source} <> 'department' or ${t.departmentId} is not null`),
  ],
);

/**
 * STORES S5a (#1115, decisions 1, 2) — ONE LINE OF A PURCHASE REQUEST: an `items` row, always, and the estimate frozen
 * at raise (per base unit, paise, before GST) with where it came from: an open rate contract, the last paid receipt,
 * or the requester's own figure for a new item. `on_contract` lines order as band A and stay out of the split sums;
 * `equipment` (a "Medical equipment" line) carries the three short answers. APPEND-ONLY IN THE DATABASE (0244).
 */
export const storesPurchaseRequestLines = pgTable(
  "stores_purchase_request_lines",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id").notNull().references(() => storesPurchaseRequests.id),
    lineIdx: integer("line_idx").notNull(),
    itemId: text("item_id").notNull().references(() => items.id),
    categoryId: text("category_id").references(() => itemCategories.id),
    qtyBase: integer("qty_base").notNull(),
    unitEstimatePaise: bigint("unit_estimate_paise", { mode: "number" }).notNull(),
    estimateSource: text("estimate_source").notNull(),
    onContract: boolean("on_contract").notNull().default(false),
    equipment: boolean("equipment").notNull().default(false),
    answers: jsonb("answers").$type<{ why: string; replacesTag: string | null; usePerDay: string }>(),
  },
  (t) => [
    uniqueIndex("stores_purchase_request_lines_ux").on(t.prId, t.lineIdx),
    index("stores_purchase_request_lines_item_idx").on(t.itemId),
    check("stores_purchase_request_lines_qty_ck", sql`${t.qtyBase} > 0`),
    check("stores_purchase_request_lines_estimate_ck", sql`${t.unitEstimatePaise} >= 0`),
    check("stores_purchase_request_lines_source_ck", sql`${t.estimateSource} in ('contract', 'last', 'requester')`),
    check("stores_purchase_request_lines_answers_ck", sql`not ${t.equipment} or ${t.answers} is not null`),
  ],
);

/**
 * STORES S5a (#1115, decisions 1, 11, 15) — THE STAMP: approved, declined or cancelled, ONE per request (unique), by
 * whom, in which capacity (`hod` at the department, `ms` the stand-in, `delegate` for the named HOD inside a
 * delegation's window, `materials` for a central request), and "over budget" when the month was past 100 %.
 * WRITE-ONCE IN THE DATABASE (migration 0244).
 */
export const storesPurchaseRequestStamps = pgTable(
  "stores_purchase_request_stamps",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id").notNull().references(() => storesPurchaseRequests.id),
    kind: text("kind").notNull(),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    forRole: text("for_role"),
    onBehalfOf: text("on_behalf_of"),
    delegationId: text("delegation_id"),
    overBudget: boolean("over_budget").notNull().default(false),
    budgetPct: integer("budget_pct"),
  },
  (t) => [
    uniqueIndex("stores_purchase_request_stamps_pr_ux").on(t.prId),
    check("stores_purchase_request_stamps_kind_ck", sql`${t.kind} in ('approved', 'declined', 'cancelled')`),
    check("stores_purchase_request_stamps_role_ck", sql`${t.forRole} is null or ${t.forRole} in ('hod', 'ms', 'delegate', 'materials')`),
    check("stores_purchase_request_stamps_reason_ck", sql`${t.kind} <> 'declined' or ${t.reason} is not null`),
  ],
);

/**
 * STORES S5a (#1115, decision 3) — THE BUYER RAISES A BAND, never lowers it: the computed band (with the split check)
 * is the floor, and a row here can only lift it. APPEND-ONLY IN THE DATABASE (0244); the newest row wins.
 */
export const storesPrBandSettings = pgTable(
  "stores_pr_band_settings",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id").notNull().references(() => storesPurchaseRequests.id),
    band: text("band").notNull(),
    reason: text("reason").notNull(),
    setBy: text("set_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_pr_band_settings_pr_idx").on(t.prId, t.at),
    check("stores_pr_band_settings_band_ck", sql`${t.band} in ('A', 'B', 'C')`),
  ],
);

/**
 * STORES S5a (#1115, decision 15) — A DEPARTMENT'S MONTH BUDGET, set by finance (`stores.budget.manage`). Every change
 * is a new row; the newest row for (department, month) is the figure. APPEND-ONLY IN THE DATABASE (0244).
 */
export const storesDepartmentBudgets = pgTable(
  "stores_department_budgets",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    month: text("month").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    note: text("note"),
    setBy: text("set_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_department_budgets_dept_month_idx").on(t.departmentId, t.month, t.at),
    check("stores_department_budgets_month_ck", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("stores_department_budgets_amount_ck", sql`${t.amountPaise} >= 0`),
  ],
);

/**
 * STORES S5a (#1115, decision 15) — "OVER BUDGET" ON A TICKET'S STAMP. A ticket's stamp is the materials indent's own
 * (write-once there), so the mark rides beside it, once per ticket. APPEND-ONLY IN THE DATABASE (0244).
 */
export const storesOverBudgetMarks = pgTable(
  "stores_over_budget_marks",
  {
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
    departmentId: text("department_id").notNull(),
    month: text("month").notNull(),
    pct: integer("pct").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.refType, t.refId] }),
    check("stores_over_budget_marks_ref_ck", sql`${t.refType} in ('ticket')`),
  ],
);

/**
 * STORES S5a (#1115, decision 11) — A DATED DELEGATION of the HOD's request and ticket approval to a colleague, at most
 * 30 days, never to the requester or the buyer. A committee seat joins the scope in S5b; the PO tiers, the payment run
 * and any owner approval are never delegable (kernel approvals and money). APPEND-ONLY IN THE DATABASE (0244).
 */
export const storesDelegations = pgTable(
  "stores_delegations",
  {
    id: text("id").primaryKey(),
    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),
    scope: text("scope").notNull(),
    departmentId: text("department_id").references(() => orgDepartments.id),
    fromAt: timestamp("from_at", { withTimezone: true }).notNull(),
    toAt: timestamp("to_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** S5b (#1115, decision 11): the committee seat handed over (scope `committee_seat`); null for an HOD's approval. */
    seat: text("seat"),
  },
  (t) => [
    index("stores_delegations_to_idx").on(t.toUserId, t.toAt),
    check("stores_delegations_scope_ck", sql`${t.scope} in ('hod_approval', 'committee_seat')`),
    check("stores_delegations_seat_ck", sql`(${t.scope} = 'committee_seat') = (${t.seat} is not null)`),
    check("stores_delegations_window_ck", sql`${t.toAt} > ${t.fromAt} and ${t.toAt} <= ${t.fromAt} + interval '30 days'`),
    check("stores_delegations_self_ck", sql`${t.fromUserId} <> ${t.toUserId}`),
    check("stores_delegations_dept_ck", sql`${t.scope} <> 'hod_approval' or ${t.departmentId} is not null`),
  ],
);

/**
 * STORES S5a (#1115, decision 12) — A SUPPLIER APPROVED FOR A CATEGORY by the materials head: one of the "KYC
 * complete" conditions for an award and a Stores PO. APPEND-ONLY IN THE DATABASE (0244).
 */
export const storesVendorCategoryApprovals = pgTable(
  "stores_vendor_category_approvals",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    categoryId: text("category_id").notNull().references(() => itemCategories.id),
    approvedBy: text("approved_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("stores_vendor_category_approvals_ux").on(t.vendorId, t.categoryId)],
);

/* ═══════════════════════════════ STORES S5b (#1115): the buying desk by hand ═══════════════════════════════ */

/**
 * STORES S5b (#1115, decision 5 by hand) — THE BUYER'S OWN GROUP of approved request lines (by category and likely
 * supplier). Written once; which group a line sits in is the newest `stores_buy_group_moves` row for it (null = out).
 * The band is derived on read (the highest of its lines, and of its sum); it is frozen on the RFQ. APPEND-ONLY (0245).
 */
export const storesBuyGroups = pgTable(
  "stores_buy_groups",
  {
    id: text("id").primaryKey(),
    label: text("label"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);

/** STORES S5b (#1115) — a request line put into (or taken out of, `group_id` null) a group. APPEND-ONLY (0245). */
export const storesBuyGroupMoves = pgTable(
  "stores_buy_group_moves",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id").notNull().references(() => storesPurchaseRequests.id),
    lineIdx: integer("line_idx").notNull(),
    groupId: text("group_id").references(() => storesBuyGroups.id),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("stores_buy_group_moves_line_idx").on(t.prId, t.lineIdx, t.at), index("stores_buy_group_moves_group_idx").on(t.groupId)],
);

/**
 * STORES S5b (#1115, decision 6) — A REQUEST FOR QUOTATION (`RFQ` + yymmdd + 4 digits) for one group: the band frozen at
 * its making, the reply-by instant, the delivery place and date. Its life (sent, reply-by moved, closed) is
 * `stores_rfq_steps`; status is derived. APPEND-ONLY (0245).
 */
export const storesRfqs = pgTable(
  "stores_rfqs",
  {
    id: text("id").primaryKey(),
    rfqNo: text("rfq_no").notNull(),
    groupId: text("group_id").notNull().references(() => storesBuyGroups.id),
    band: text("band").notNull(),
    equipment: boolean("equipment").notNull().default(false),
    replyBy: timestamp("reply_by", { withTimezone: true }).notNull(),
    deliveryStoreId: text("delivery_store_id").notNull().references(() => resources.id),
    deliveryDate: date("delivery_date", { mode: "string" }),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_rfqs_no_ux").on(t.rfqNo),
    index("stores_rfqs_group_idx").on(t.groupId),
    check("stores_rfqs_band_ck", sql`${t.band} in ('A', 'B', 'C')`),
  ],
);

/** STORES S5b (#1115) — one item of an RFQ (the group's lines summed by item). APPEND-ONLY (0245). */
export const storesRfqLines = pgTable(
  "stores_rfq_lines",
  {
    id: text("id").primaryKey(),
    rfqId: text("rfq_id").notNull().references(() => storesRfqs.id),
    lineIdx: integer("line_idx").notNull(),
    itemId: text("item_id").notNull().references(() => items.id),
    qtyBase: integer("qty_base").notNull(),
  },
  (t) => [uniqueIndex("stores_rfq_lines_ux").on(t.rfqId, t.itemId), check("stores_rfq_lines_qty_ck", sql`${t.qtyBase} > 0`)],
);

/** STORES S5b (#1115, decisions 6, 12) — a supplier invited to an RFQ ("can quote" at the invitation). APPEND-ONLY (0245). */
export const storesRfqInvitees = pgTable(
  "stores_rfq_invitees",
  {
    id: text("id").primaryKey(),
    rfqId: text("rfq_id").notNull().references(() => storesRfqs.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    addedBy: text("added_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("stores_rfq_invitees_ux").on(t.rfqId, t.vendorId)],
);

/**
 * STORES S5b (#1115, decision 6) — AN RFQ'S LIFE: `sent` (who, when, how, to whom: a person's tap, never the agent),
 * `reply_by_moved` (once, before it passed, with a reason), `closed` (the others were told). APPEND-ONLY (0245).
 */
export const storesRfqSteps = pgTable(
  "stores_rfq_steps",
  {
    id: text("id").primaryKey(),
    rfqId: text("rfq_id").notNull().references(() => storesRfqs.id),
    kind: text("kind").notNull(),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    channel: text("channel"),
    vendorIds: jsonb("vendor_ids").$type<string[]>(),
    replyBy: timestamp("reply_by", { withTimezone: true }),
    reason: text("reason"),
  },
  (t) => [
    index("stores_rfq_steps_rfq_idx").on(t.rfqId, t.at),
    uniqueIndex("stores_rfq_steps_once_ux").on(t.rfqId, t.kind).where(sql`${t.kind} in ('reply_by_moved', 'closed')`),
    check("stores_rfq_steps_kind_ck", sql`${t.kind} in ('sent', 'reply_by_moved', 'closed')`),
    check("stores_rfq_steps_channel_ck", sql`${t.kind} <> 'sent' or ${t.channel} in ('email', 'print', 'hand')`),
    check("stores_rfq_steps_move_ck", sql`${t.kind} <> 'reply_by_moved' or (${t.replyBy} is not null and ${t.reason} is not null)`),
  ],
);

/**
 * STORES S5b (#1115, decision 7) — A QUOTE, APPEND-ONLY: a revision is a new version (`revised` before unsealing,
 * `negotiated` after it, L1 only and downward). An RFQ's quote names the RFQ; band A's one quote names only the group.
 * `late` = entered after the reply-by instant (a materials-head admission row lets it rank). APPEND-ONLY (0245).
 */
export const storesQuotes = pgTable(
  "stores_quotes",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => storesBuyGroups.id),
    rfqId: text("rfq_id").references(() => storesRfqs.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    version: integer("version").notNull(),
    kind: text("kind").notNull(),
    supplierRef: text("supplier_ref"),
    freightPaise: bigint("freight_paise", { mode: "number" }).notNull().default(0),
    otherPaise: bigint("other_paise", { mode: "number" }).notNull().default(0),
    paymentTermsDays: integer("payment_terms_days"),
    deliveryDays: integer("delivery_days"),
    warrantyMonths: integer("warranty_months"),
    documentKey: text("document_key"),
    late: boolean("late").notNull().default(false),
    enteredBy: text("entered_by").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_quotes_version_ux").on(t.groupId, t.vendorId, t.version),
    index("stores_quotes_rfq_idx").on(t.rfqId),
    check("stores_quotes_kind_ck", sql`${t.kind} in ('quote', 'revised', 'negotiated')`),
    check("stores_quotes_money_ck", sql`${t.freightPaise} >= 0 and ${t.otherPaise} >= 0 and ${t.version} >= 1`),
  ],
);

/** STORES S5b (#1115, decision 7) — one line of a quote: rate per base unit before GST, discount, GST rate; confirmed by a person. APPEND-ONLY (0245). */
export const storesQuoteLines = pgTable(
  "stores_quote_lines",
  {
    id: text("id").primaryKey(),
    quoteId: text("quote_id").notNull().references(() => storesQuotes.id),
    itemId: text("item_id").notNull().references(() => items.id),
    qtyBase: integer("qty_base").notNull(),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    gstRateBps: integer("gst_rate_bps").notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_quote_lines_ux").on(t.quoteId, t.itemId),
    check("stores_quote_lines_ck", sql`${t.qtyBase} > 0 and ${t.ratePaise} >= 0 and ${t.discountBps} between 0 and 10000 and ${t.gstRateBps} between 0 and 2800`),
  ],
);

/** STORES S5b (#1115, decision 7) — the materials head admits a late quote to the ranks, with a reason. APPEND-ONLY (0245). */
export const storesQuoteAdmissions = pgTable(
  "stores_quote_admissions",
  {
    id: text("id").primaryKey(),
    quoteId: text("quote_id").notNull().references(() => storesQuotes.id),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [uniqueIndex("stores_quote_admissions_ux").on(t.quoteId)],
);

/**
 * STORES S5b (#1115, flow 7) — TECHNICAL COMPLIANCE of a supplier's offer for equipment, marked by the user HOD and by
 * biomedical: Yes, or No with a reason. Once per (RFQ, supplier, role). APPEND-ONLY (0245).
 */
export const storesQuoteTechnical = pgTable(
  "stores_quote_technical",
  {
    id: text("id").primaryKey(),
    rfqId: text("rfq_id").notNull().references(() => storesRfqs.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    role: text("role").notNull(),
    compliant: boolean("compliant").notNull(),
    reason: text("reason"),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_quote_technical_ux").on(t.rfqId, t.vendorId, t.role),
    check("stores_quote_technical_role_ck", sql`${t.role} in ('hod', 'biomedical')`),
    check("stores_quote_technical_reason_ck", sql`${t.compliant} or ${t.reason} is not null`),
  ],
);

/**
 * STORES S5b (#1115, decision 9) — AN AWARD PROPOSAL, written once: whole or split by line, the reason when not L1,
 * the band (re-checked on its total) and the committee's seats frozen on the row. Status is derived from
 * `stores_award_signatures`. A proposal sent back stays; a fresh one is a new row naming it. APPEND-ONLY (0245).
 */
export const storesAwards = pgTable(
  "stores_awards",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => storesBuyGroups.id),
    rfqId: text("rfq_id").references(() => storesRfqs.id),
    band: text("band").notNull(),
    equipment: boolean("equipment").notNull().default(false),
    reason: text("reason"),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    seats: jsonb("seats").$type<{ seat: string; userIds: string[] }[]>().notNull(),
    replacesId: text("replaces_id"),
    proposedBy: text("proposed_by").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("stores_awards_group_idx").on(t.groupId), index("stores_awards_rfq_idx").on(t.rfqId), check("stores_awards_band_ck", sql`${t.band} in ('A', 'B', 'C')`)],
);

/** STORES S5b (#1115, decisions 4, 9) — what is awarded to whom at what rate: a quote's line or a rate contract's. APPEND-ONLY (0245). */
export const storesAwardLines = pgTable(
  "stores_award_lines",
  {
    id: text("id").primaryKey(),
    awardId: text("award_id").notNull().references(() => storesAwards.id),
    itemId: text("item_id").notNull().references(() => items.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    quoteId: text("quote_id").references(() => storesQuotes.id),
    rateId: text("rate_id"),
    qtyBase: integer("qty_base").notNull(),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    gstRateBps: integer("gst_rate_bps").notNull(),
    rank: integer("rank"),
  },
  (t) => [
    uniqueIndex("stores_award_lines_ux").on(t.awardId, t.itemId),
    check("stores_award_lines_source_ck", sql`(${t.quoteId} is null) <> (${t.rateId} is null)`),
    check("stores_award_lines_qty_ck", sql`${t.qtyBase} > 0 and ${t.ratePaise} >= 0`),
  ],
);

/**
 * STORES S5b (#1115, decisions 9, 11) — A SIGNATURE ON AN AWARD: `approve` (band A the buyer, band B the materials head),
 * `sign` (a committee seat, the owner last) or `object` (with a reason: the award goes back to the buyer). One act per
 * seat; a delegate's names the seat holder it acts for. WRITE-ONCE IN THE DATABASE (0245).
 */
export const storesAwardSignatures = pgTable(
  "stores_award_signatures",
  {
    id: text("id").primaryKey(),
    awardId: text("award_id").notNull().references(() => storesAwards.id),
    seat: text("seat").notNull(),
    kind: text("kind").notNull(),
    by: text("by").notNull(),
    onBehalfOf: text("on_behalf_of"),
    delegationId: text("delegation_id"),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_award_signatures_seat_ux").on(t.awardId, t.seat),
    check("stores_award_signatures_kind_ck", sql`${t.kind} in ('approve', 'sign', 'object')`),
    check("stores_award_signatures_seat_ck", sql`${t.seat} in ('buyer', 'materials_head', 'accounts_head', 'medical_superintendent', 'user_hod', 'biomedical', 'owner')`),
    check("stores_award_signatures_reason_ck", sql`${t.kind} <> 'object' or ${t.reason} is not null`),
  ],
);

/**
 * STORES S5b (#1115, decision 9; ruling 0100 Q3) — WHO SITS IN A COMMITTEE SEAT, from when (to when): set by the owner
 * or the materials head, each change a new row. The user HOD's seat is not a row: it is the department's HOD.
 * APPEND-ONLY (0245).
 */
export const storesCommitteeSeats = pgTable(
  "stores_committee_seats",
  {
    id: text("id").primaryKey(),
    seat: text("seat").notNull(),
    userId: text("user_id").notNull(),
    fromAt: timestamp("from_at", { withTimezone: true }).notNull(),
    toAt: timestamp("to_at", { withTimezone: true }),
    setBy: text("set_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_committee_seats_seat_idx").on(t.seat, t.at),
    check("stores_committee_seats_seat_ck", sql`${t.seat} in ('materials_head', 'accounts_head', 'medical_superintendent', 'biomedical')`),
    check("stores_committee_seats_window_ck", sql`${t.toAt} is null or ${t.toAt} > ${t.fromAt}`),
  ],
);

/**
 * STORES S5b (#1115, decision 10) — A DELIVERY TICKET RAISED FROM A DEPARTMENT REQUEST when its goods passed QC and
 * were posted: which GRN, which ticket, how many of the line. The sum per line is what was ticketed; a second GRN
 * tickets only the rest. APPEND-ONLY (0245).
 */
export const storesPrDeliveries = pgTable(
  "stores_pr_deliveries",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id").notNull().references(() => storesPurchaseRequests.id),
    lineIdx: integer("line_idx").notNull(),
    grnId: text("grn_id").notNull().references(() => grns.id),
    indentId: text("indent_id").notNull().references(() => storeIndents.id),
    qtyBase: integer("qty_base").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("stores_pr_deliveries_pr_idx").on(t.prId, t.lineIdx), check("stores_pr_deliveries_qty_ck", sql`${t.qtyBase} > 0`)],
);

// ═══════════════════════════════ S5c (#1115): the buyer agent, exceptions, advances ═══════════════════════════════

/**
 * STORES S5c (#1115, decision 5, "Audit by construction") — ONE DRAFT THE BUYER AGENT MADE: the nightly grouping preview
 * (`grouping`), an RFQ draft (`rfq_draft`), a quote read from a PDF (`quote_read`) or a PO draft (`po_draft`). A draft is
 * data, never an act: nothing is grouped, sent, quoted, ordered or awarded until a person confirms it, and that confirm
 * writes the record and its `copilot_acts` row (the confirming person) together. `department_ids` is what the
 * three-open-proposals-per-department cap counts (`central` stands for the store's own requests). `made_by` is the
 * agent (`system:stores-buyer-agent`) or, for a draft asked for at the desk, the person who asked. APPEND-ONLY (0246).
 */
export const storesAgentProposals = pgTable(
  "stores_agent_proposals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    departmentIds: jsonb("department_ids").$type<string[]>().notNull(),
    groupId: text("group_id").references(() => storesBuyGroups.id),
    rfqId: text("rfq_id").references(() => storesRfqs.id),
    vendorId: text("vendor_id").references(() => vendors.id),
    /** What the agent proposes (lines, suppliers, read lines with their source), as the desk shows it. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** The PDF a `quote_read` came from (document store key); the quote that is entered carries the same key. */
    documentKey: text("document_key"),
    madeBy: text("made_by").notNull(),
    madeAt: timestamp("made_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_agent_proposals_kind_idx").on(t.kind, t.madeAt),
    index("stores_agent_proposals_group_idx").on(t.groupId),
    check("stores_agent_proposals_kind_ck", sql`${t.kind} in ('grouping', 'rfq_draft', 'quote_read', 'po_draft')`),
  ],
);

/**
 * S5c — WHAT A PERSON DID WITH A DRAFT: `confirmed` (the record was written; `confirm_id` is its `copilot_acts` row),
 * `dismissed`, `superseded` (its lines moved on without it), and per line of a quote read `line_confirmed` /
 * `line_dropped` (the numbers the person confirmed, in `data`). One closing step per draft, one step per line.
 * APPEND-ONLY (0246).
 */
export const storesAgentProposalSteps = pgTable(
  "stores_agent_proposal_steps",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").notNull().references(() => storesAgentProposals.id),
    kind: text("kind").notNull(),
    lineIdx: integer("line_idx"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    confirmId: text("confirm_id"),
    resultRowId: text("result_row_id"),
    reason: text("reason"),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_agent_proposal_steps_proposal_idx").on(t.proposalId, t.at),
    uniqueIndex("stores_agent_proposal_steps_close_ux").on(t.proposalId).where(sql`${t.kind} in ('confirmed', 'dismissed', 'superseded')`),
    uniqueIndex("stores_agent_proposal_steps_line_ux").on(t.proposalId, t.lineIdx).where(sql`${t.kind} in ('line_confirmed', 'line_dropped')`),
    check("stores_agent_proposal_steps_kind_ck", sql`${t.kind} in ('confirmed', 'dismissed', 'superseded', 'line_confirmed', 'line_dropped')`),
    check("stores_agent_proposal_steps_line_ck", sql`(${t.kind} in ('line_confirmed', 'line_dropped')) = (${t.lineIdx} is not null)`),
  ],
);

/**
 * STORES S5c (#1115, edge cases 1 and 9; ruling 0100 Q4) — A PURCHASE OUTSIDE THE QUOTE BANDS. `single_source`: one
 * maker supplies it; a typed reason, the user HOD's certificate (`certified`), then the materials head's approval up to
 * ₹5 lakh or the owner's above (`approved`). `emergency`: an emergency request's one quote, approved by the medical
 * superintendent (`approved`), confirmed by the owner within 72 hours (`confirmed`). Either: `refused` ends it. The
 * value is frozen at the request (the group's estimate); `needs_owner` is decided then. APPEND-ONLY (0246).
 */
export const storesBuyExceptions = pgTable(
  "stores_buy_exceptions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    groupId: text("group_id").notNull().references(() => storesBuyGroups.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    reason: text("reason").notNull(),
    valuePaise: bigint("value_paise", { mode: "number" }).notNull(),
    needsOwner: boolean("needs_owner").notNull(),
    raisedBy: text("raised_by").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_buy_exceptions_group_idx").on(t.groupId),
    check("stores_buy_exceptions_kind_ck", sql`${t.kind} in ('single_source', 'emergency')`),
    check("stores_buy_exceptions_value_ck", sql`${t.valuePaise} >= 0 and length(${t.reason}) > 0`),
  ],
);

export const storesBuyExceptionSteps = pgTable(
  "stores_buy_exception_steps",
  {
    id: text("id").primaryKey(),
    exceptionId: text("exception_id").notNull().references(() => storesBuyExceptions.id),
    kind: text("kind").notNull(),
    /** In what capacity: `hod`, `materials_head`, `owner`, `medical_superintendent`. */
    asRole: text("as_role").notNull(),
    reason: text("reason"),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_buy_exception_steps_once_ux").on(t.exceptionId, t.kind),
    check("stores_buy_exception_steps_kind_ck", sql`${t.kind} in ('certified', 'approved', 'confirmed', 'refused')`),
    check("stores_buy_exception_steps_reason_ck", sql`${t.kind} <> 'refused' or ${t.reason} is not null`),
  ],
);

/**
 * STORES S5c (#1115, decision 11; ruling 0100 Q7) — AN ADVANCE ON AN EQUIPMENT PO: at most 30 % of the PO, against the
 * supplier's bank guarantee (number, bank, valid to, amount), approved by the owner (`stores_po_advance_steps`
 * `approved` | `refused`). Every PO with an award is "Pay after GRN" unless an APPROVED row names it. Paying the advance is
 * S6's (#1116); this row is what S6 reads. `po_id` is plain text (the `award_id` precedent). APPEND-ONLY (0246).
 */
export const storesPoAdvances = pgTable(
  "stores_po_advances",
  {
    id: text("id").primaryKey(),
    poId: text("po_id").notNull(),
    pctBps: integer("pct_bps").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    guaranteeNo: text("guarantee_no").notNull(),
    guaranteeBank: text("guarantee_bank").notNull(),
    guaranteeValidTo: date("guarantee_valid_to", { mode: "string" }).notNull(),
    guaranteePaise: bigint("guarantee_paise", { mode: "number" }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("stores_po_advances_po_idx").on(t.poId),
    check("stores_po_advances_pct_ck", sql`${t.pctBps} > 0 and ${t.pctBps} <= 3000`),
    check("stores_po_advances_money_ck", sql`${t.amountPaise} > 0 and ${t.guaranteePaise} >= ${t.amountPaise}`),
  ],
);

export const storesPoAdvanceSteps = pgTable(
  "stores_po_advance_steps",
  {
    id: text("id").primaryKey(),
    advanceId: text("advance_id").notNull().references(() => storesPoAdvances.id),
    kind: text("kind").notNull(),
    reason: text("reason"),
    by: text("by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("stores_po_advance_steps_once_ux").on(t.advanceId),
    check("stores_po_advance_steps_kind_ck", sql`${t.kind} in ('approved', 'refused')`),
    check("stores_po_advance_steps_reason_ck", sql`${t.kind} <> 'refused' or ${t.reason} is not null`),
  ],
);
