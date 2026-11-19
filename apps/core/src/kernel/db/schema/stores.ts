import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { grnLines, items, stockBatches, storeIndents, transferLines, transfers, vendors } from "./materials";
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
 * STORES S4b (#1114, decision 13, ruling 0101 Q5) — A CONDEMNATION OR LOSS PROPOSAL, written once. `kind` is
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
