import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";

/**
 * E2.4 LINEN (issue #728, decision 0072) — the item catalogue, par levels a supervisor set, the append-only movement
 * ledger, laundry batches, laundry short-delivery variances, condemn requests and ward counts. Read and written only by
 * `modules/linen`. No money column and no patient column anywhere: linen belongs to a ward (a `ward` resource).
 *
 * Computed par (beds × sets per bed by class × units per set) is never stored; `linen_par_levels` holds only a par a
 * supervisor set over it. On-hand is never stored either: it is the last `linen_ward_counts` row plus the ledger since.
 *
 * LD-1 (#978, decision 0087) adds the laundry floor: a stream per item, rounds signed by the runner and the ward, sealed
 * bags, holds, the plant's machines and wash cycles, quality check, beds waiting for linen, and piece identity (empty
 * until the tags arrive). Still no money and no patient: a hold names a bed, never a person.
 */
/** The wash streams: each travels and washes apart (theatre sets go to CSSD; baby linen never with adult linen). */
export const LINEN_STREAM_SQL = sql.raw("'ward', 'theatre', 'baby', 'mop', 'kitchen', 'uniform'");
export const linenItems = pgTable(
  "linen_items",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    /** Pieces of this item in one bed set; 0 = not part of a ward bed's set (theatre linen). */
    unitsPerSet: integer("units_per_set").notNull().default(1),
    sort: integer("sort").notNull().default(100),
    active: boolean("active").notNull().default(true),
    /** LD-1: the stream it is washed in. */
    stream: text("stream").notNull().default("ward"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("linen_items_units_ck", sql`${t.unitsPerSet} >= 0`),
    check("linen_items_stream_ck", sql`${t.stream} in (${LINEN_STREAM_SQL})`),
  ],
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
    /** LD-1: every line of a batch is of one stream. */
    stream: text("stream").notNull().default("ward"),
    /** LD-1: washed in the hospital's plant or sent to the vendor. */
    mode: text("mode").notNull().default("vendor"),
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
    // In the plant a batch waits (sent), washes, may go back to rewash, then waits at quality check (qc).
    check("linen_laundry_batches_state_ck", sql`${t.state} in ('sent', 'washing', 'rewash', 'qc', 'received', 'short')`),
    check("linen_laundry_batches_pieces_ck", sql`${t.piecesSent} > 0 and coalesce(${t.piecesReceived}, 0) >= 0`),
    check("linen_laundry_batches_received_ck", sql`(${t.state} in ('sent', 'washing', 'rewash', 'qc')) = (${t.receivedAt} is null)`),
    check("linen_laundry_batches_stream_ck", sql`${t.stream} in (${LINEN_STREAM_SQL})`),
    check("linen_laundry_batches_mode_ck", sql`${t.mode} in ('in_house', 'vendor')`),
    check("linen_laundry_batches_plant_ck", sql`${t.mode} = 'in_house' or ${t.state} in ('sent', 'received', 'short')`),
    // The key a wash cycle's batches point at: a cycle and its batches agree on infected and stream (D2, D7).
    unique("linen_laundry_batches_cycle_key_uq").on(t.id, t.infected, t.stream),
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
    /** LD-1: the signed round a pickup or delivery belongs to. */
    roundId: text("round_id").references(() => linenRounds.id),
    /** LD-1: the sealed bag the pieces travelled in. */
    bagId: text("bag_id").references(() => linenBags.id),
    /** LD-1: one tagged piece (a row of one); null while linen is counted by hand. */
    pieceId: text("piece_id").references(() => linenPieces.id),
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
    check("linen_movements_kind_ck", sql`${t.kind} in ('issue_to_ward', 'return_soiled', 'return_infected', 'laundry_out', 'laundry_in', 'condemn', 'transfer_between_wards', 'qc_rewash', 'qc_mend', 'mend_return', 'issue_to_cssd', 'hold_handed_over')`),
    check("linen_movements_qty_ck", sql`${t.qty} > 0`),
    check("linen_movements_ward_ck", sql`(${t.kind} in ('issue_to_ward', 'return_soiled', 'return_infected', 'transfer_between_wards', 'hold_handed_over')) <= (${t.wardResourceId} is not null)`),
    check("linen_movements_transfer_ck", sql`(${t.kind} = 'transfer_between_wards') = (${t.toWardResourceId} is not null) and (${t.toWardResourceId} is null or ${t.toWardResourceId} <> ${t.wardResourceId})`),
    check("linen_movements_batch_ck", sql`(${t.kind} in ('laundry_out', 'laundry_in', 'qc_rewash', 'qc_mend', 'issue_to_cssd')) = (${t.batchId} is not null)`),
    check("linen_movements_piece_ck", sql`${t.pieceId} is null or ${t.qty} = 1`),
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

/* ═══════════════════════════════ LD-1 — the laundry floor (#978) ═══════════════════════════════ */

/** A tagged piece (barcode or RFID). Empty until the owner's tags arrive (decision 0087); hand counts need no row. */
export const linenPieces = pgTable(
  "linen_pieces",
  {
    id: text("id").primaryKey(),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    tagUid: text("tag_uid").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("linen_pieces_tag_uq").on(t.tagUid)],
);

/**
 * A pickup or delivery at one ward. Signed means the runner signed and EITHER the ward signed (a PIN, never the runner)
 * OR it is runner-only with a reason (D1). A round the clock raised has its slot; an on-call round has none.
 */
export const linenRounds = pgTable(
  "linen_rounds",
  {
    id: text("id").primaryKey(),
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("open"),
    slotAt: timestamp("slot_at", { withTimezone: true }),
    taskId: text("task_id"),
    runnerId: text("runner_id"),
    wardSignedBy: text("ward_signed_by"),
    runnerOnlyReason: text("runner_only_reason"),
    pieces: integer("pieces").notNull().default(0),
    bags: integer("bags").notNull().default(0),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("linen_rounds_slot_uq").on(t.wardResourceId, t.kind, t.slotAt).where(sql`${t.slotAt} is not null`),
    index("linen_rounds_open_idx").on(t.state).where(sql`${t.state} = 'open'`),
    check("linen_rounds_kind_ck", sql`${t.kind} in ('pickup', 'delivery')`),
    check("linen_rounds_state_ck", sql`${t.state} in ('open', 'signed', 'skipped')`),
    check("linen_rounds_signed_ck", sql`(${t.state} = 'signed') = (${t.signedAt} is not null and ${t.runnerId} is not null)`),
    check("linen_rounds_one_ward_sign_ck", sql`${t.state} <> 'signed' or ((${t.wardSignedBy} is null) <> (${t.runnerOnlyReason} is null))`),
    check("linen_rounds_not_self_ck", sql`${t.wardSignedBy} is null or ${t.wardSignedBy} <> ${t.runnerId}`),
    check("linen_rounds_counts_ck", sql`${t.pieces} >= 0 and ${t.bags} >= 0`),
  ],
);

/**
 * A sealed bag. The ward declares what is in it when it seals it; nobody after that counts it by piece — the runner and
 * the soiled room see a tag and a weight (D1). Infected linen always travels this way; held linen is bagged at its bed.
 */
export const linenBags = pgTable(
  "linen_bags",
  {
    id: text("id").primaryKey(),
    tag: text("tag").notNull(),
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    bedResourceId: text("bed_resource_id").references(() => resources.id),
    infected: boolean("infected").notNull(),
    /** What the ward declared: [{ itemCode, qty }]. Read by the ledger only. */
    lines: jsonb("lines").$type<{ itemCode: string; qty: number }[]>().notNull(),
    state: text("state").notNull().default("sealed"),
    weightGrams: integer("weight_grams"),
    sealedBy: text("sealed_by").notNull(),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull(),
    roundId: text("round_id").references(() => linenRounds.id),
    batchId: text("batch_id").references(() => linenLaundryBatches.id),
  },
  (t) => [
    // A tag is reused once its bag has left the floor.
    uniqueIndex("linen_bags_live_tag_uq").on(t.tag).where(sql`${t.state} in ('sealed', 'picked')`),
    index("linen_bags_bed_idx").on(t.bedResourceId).where(sql`${t.bedResourceId} is not null`),
    check("linen_bags_state_ck", sql`${t.state} in ('sealed', 'picked', 'sent', 'handed_over')`),
    check("linen_bags_weight_ck", sql`${t.weightGrams} is null or ${t.weightGrams} > 0`),
    check("linen_bags_picked_ck", sql`${t.state} = 'handed_over' or ((${t.state} = 'sealed') = (${t.roundId} is null))`),
    check("linen_bags_sent_ck", sql`(${t.state} = 'sent') = (${t.batchId} is not null)`),
  ],
);

/**
 * Linen blocked from the laundry (D4): an MLC patient's (evidence, released to the police), a chemotherapy patient's
 * within 48 hours of a dose (released by the clock), a radioactive-iodine patient's (released by the RSO). It names the
 * bed, never the patient.
 */
export const linenHolds = pgTable(
  "linen_holds",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    bedResourceId: text("bed_resource_id").notNull().references(() => resources.id),
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    note: text("note"),
    releaseAfter: timestamp("release_after", { withTimezone: true }),
    state: text("state").notNull().default("active"),
    placedBy: text("placed_by").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    policeName: text("police_name"),
    policeRank: text("police_rank"),
    policeStation: text("police_station"),
  },
  (t) => [
    index("linen_holds_active_idx").on(t.bedResourceId).where(sql`${t.state} = 'active'`),
    check("linen_holds_kind_ck", sql`${t.kind} in ('mlc', 'chemo', 'radioactive')`),
    check("linen_holds_state_ck", sql`${t.state} in ('active', 'released', 'handed_over')`),
    check("linen_holds_released_ck", sql`(${t.state} = 'active') = (${t.releasedAt} is null)`),
    // Each kind is released only its own way.
    check("linen_holds_mlc_ck", sql`(${t.state} = 'handed_over') = (${t.kind} = 'mlc' and ${t.state} <> 'active')`),
    check("linen_holds_police_ck", sql`(${t.state} = 'handed_over') = (${t.policeName} is not null and ${t.policeRank} is not null and ${t.policeStation} is not null)`),
    check("linen_holds_chemo_ck", sql`(${t.kind} = 'chemo') = (${t.releaseAfter} is not null)`),
  ],
);

/** A washer, dryer, calender or boiler of the plant. Laundry keeps its own list until maintenance has an asset register. */
export const linenMachines = pgTable(
  "linen_machines",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** Where it stands (the laundry room): a breakdown raises a maintenance ticket at this place. */
    placeResourceId: text("place_resource_id").references(() => resources.id),
    state: text("state").notNull().default("up"),
    downReason: text("down_reason"),
    ticketId: text("ticket_id"),
    active: boolean("active").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("linen_machines_code_uq").on(t.code),
    check("linen_machines_kind_ck", sql`${t.kind} in ('washer', 'dryer', 'calender', 'boiler')`),
    check("linen_machines_state_ck", sql`${t.state} in ('up', 'down')`),
    check("linen_machines_down_ck", sql`(${t.state} = 'down') = (${t.downReason} is not null)`),
  ],
);

/**
 * One wash cycle: its machine, program, the temperature reached, the time held at it, and the chemical dosed. A cycle
 * is infected or not and of one stream; `linen_cycle_batches` points at both keys, so a mixed load cannot be written.
 */
export const linenWashCycles = pgTable(
  "linen_wash_cycles",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull().references(() => linenMachines.id),
    program: text("program").notNull(),
    infected: boolean("infected").notNull(),
    stream: text("stream").notNull(),
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedBy: text("finished_by"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    tempC: integer("temp_c"),
    holdMin: integer("hold_min"),
    chemical: text("chemical"),
    /** Null for an ordinary cycle; for an infected one, whether it met the disinfection rule. */
    disinfected: boolean("disinfected"),
  },
  (t) => [
    unique("linen_wash_cycles_key_uq").on(t.id, t.infected, t.stream),
    uniqueIndex("linen_wash_cycles_running_uq").on(t.machineId).where(sql`${t.finishedAt} is null`),
    check("linen_wash_cycles_stream_ck", sql`${t.stream} in (${LINEN_STREAM_SQL})`),
    check("linen_wash_cycles_finished_ck", sql`(${t.finishedAt} is null) = (${t.tempC} is null) and (${t.finishedAt} is null) = (${t.holdMin} is null)`),
    check("linen_wash_cycles_reading_ck", sql`${t.tempC} is null or (${t.tempC} between 0 and 120 and ${t.holdMin} between 0 and 180)`),
  ],
);

export const linenCycleBatches = pgTable(
  "linen_cycle_batches",
  {
    cycleId: text("cycle_id").notNull(),
    batchId: text("batch_id").notNull(),
    infected: boolean("infected").notNull(),
    stream: text("stream").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cycleId, t.batchId] }),
    foreignKey({ name: "linen_cycle_batches_cycle_fk", columns: [t.cycleId, t.infected, t.stream], foreignColumns: [linenWashCycles.id, linenWashCycles.infected, linenWashCycles.stream] }),
    foreignKey({ name: "linen_cycle_batches_batch_fk", columns: [t.batchId, t.infected, t.stream], foreignColumns: [linenLaundryBatches.id, linenLaundryBatches.infected, linenLaundryBatches.stream] }),
    index("linen_cycle_batches_batch_idx").on(t.batchId),
  ],
);

/** What quality check made of a batch, per item: pass, rewash, mend, condemn (the last waits for a second person). */
export const linenQcResults = pgTable(
  "linen_qc_results",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => linenLaundryBatches.id),
    itemCode: text("item_code").notNull().references(() => linenItems.code),
    pass: integer("pass").notNull(),
    rewash: integer("rewash").notNull(),
    mend: integer("mend").notNull(),
    condemn: integer("condemn").notNull(),
    condemnRequestId: text("condemn_request_id").references(() => linenCondemnRequests.id),
    checkedBy: text("checked_by").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("linen_qc_results_batch_item_uq").on(t.batchId, t.itemCode),
    check("linen_qc_results_counts_ck", sql`${t.pass} >= 0 and ${t.rewash} >= 0 and ${t.mend} >= 0 and ${t.condemn} >= 0`),
    check("linen_qc_results_condemn_ck", sql`(${t.condemn} > 0) = (${t.condemnRequestId} is not null)`),
  ],
);

/** A bed that is clean but not made: its ward's shelf is short of a set (D3). Cleared by the top-up that fills it. */
export const linenBedWaits = pgTable(
  "linen_bed_waits",
  {
    id: text("id").primaryKey(),
    bedResourceId: text("bed_resource_id").notNull().references(() => resources.id),
    wardResourceId: text("ward_resource_id").notNull().references(() => resources.id),
    /** The pieces the shelf lacked for one set when the bed was cleaned: { itemCode: qty }. */
    short: jsonb("short").$type<Record<string, number>>().notNull(),
    rush: boolean("rush").notNull().default(true),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    raisedBy: text("raised_by").notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by"),
  },
  (t) => [
    uniqueIndex("linen_bed_waits_open_uq").on(t.bedResourceId).where(sql`${t.clearedAt} is null`),
    index("linen_bed_waits_ward_idx").on(t.wardResourceId).where(sql`${t.clearedAt} is null`),
    check("linen_bed_waits_cleared_ck", sql`(${t.clearedAt} is null) = (${t.clearedBy} is null)`),
  ],
);
