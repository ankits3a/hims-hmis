import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { invoiceLines, invoices } from "./billing";
import { counterparties } from "./partners";
import { patients } from "./patients";

/**
 * Plan 09 — the INSTRUMENT side: plans, issued instances, covered members, entitlement counters,
 * coupon definitions and their redemptions, and the holder-book import's own provenance tables.
 * `schema/partners.ts` holds the counterparty side; the two files share one migration (`0022`)
 * and, deliberately, no cycle — membership points at `counterparties`, never the reverse (DD1).
 *
 * Money is integer PAISE (bigint mode number — never floats), the Plan 04/06/08 precedent.
 *
 * ═══ THE CATALOG TABLES HOLD NO CODE, NO RATE AND NO PRICE (DD3, owner ruling O-9) ═══
 *
 * `membership_plans` and `coupon_definitions` are CONFIGURATION ROWS seeded at commissioning from
 * files the owner supplies out of git. Nothing in `apps/` may contain a plan code, a coupon code,
 * a partner code, a commission rate, a card price or a card number, and the property that makes
 * that checkable without committing the forbidden values is stated as its opposite: **a freshly
 * migrated database has EMPTY catalogs.** `modules/membership/catalogs-empty.test.ts` is that
 * check. The benefit terms themselves therefore live in `jsonb` columns rather than in typed
 * price columns — they are data whose SHAPE this repository fixes and whose VALUES it never sees.
 *
 * ═══ EVERY ACTOR COLUMN HERE IS PLAIN TEXT, NEVER AN FK INTO `users` (DD17) ═══
 *
 * `events.actor_id`, `approvals`' actor columns, `retention_legal_holds.created_by` and the whole
 * of `schema/ops.ts` are the shipped precedent, and the second reason is the load-bearing one: by
 * §3.35/§3.12 a table with no FK POINTING AT `users` has no claim on the users truncate statement
 * in `test/helpers/db.ts`, so seventeen new tables cost that helper exactly the edits their
 * patient/invoice FKs actually require and not one more. An actor may also be a system or an
 * agent, which has been true of the actor fabric since Plan 02.
 *
 * ═══ WHICH OF THESE TABLES ARE APPEND-ONLY, AND BY WHAT ═══
 *
 * `entitlement_movements` and `coupon_redemptions` carry `BEFORE UPDATE OR DELETE` triggers
 * (migration `0022`) that raise `partner_ledger_immutable` — Plan 09's OWN plpgsql function, not
 * billing's (Q2: a shared function would let one plan's migration change another plan's error
 * text). A consume and its restore are two rows; a redemption and its release are two rows. The
 * counters they move are DERIVED — `remaining = granted_qty − Σ delta` — which is exactly what
 * lets those triggers be total. Locking an immutable row is legal and billing already does it
 * (`lockInvoice`), so DD10's `FOR UPDATE` serializer and the trigger are not in tension.
 */

/**
 * THE PLAN CATALOG (DD3). One row per sellable instrument shape — a membership, a package, a
 * discount card. Seeded at commissioning; empty in this repository and in every fresh database.
 *
 * `benefits` and `entitlements` are the terms as DATA: the percentage benefits by service
 * category with their caps, and the counters a new instance is granted. `modules/membership`
 * parses them; nothing here fixes a number.
 *
 * `counterparty_id` is NULLABLE because a hospital-direct plan has no selling partner. The sale
 * lane is config-OFF for the whole of Phase 1 (`MEMBERSHIP_SALES_ENABLED`, DD14), so in this
 * phase every instance arrives through the partner holder-book import — but the schema does not
 * preclude the other shape, and O-3's reasoning (a proration formula with no caller is a formula
 * nobody can test) says to leave the column rather than the arithmetic.
 */
export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: text("id").primaryKey(), // ULID via newId()
    code: text("code").notNull(), // the partner's plan code — DATA, seeded, never a constant
    title: text("title").notNull(),
    kind: text("kind").notNull(), // 'membership'|'package'|'card'
    counterpartyId: text("counterparty_id").references(() => counterparties.id),
    benefits: jsonb("benefits").notNull(), // percentage benefits by category, with caps
    entitlements: jsonb("entitlements").notNull(), // the counters a new instance is granted
    /** O-3/O-5: the family cap is the control, and an over-cap add refuses through it. */
    familyCap: integer("family_cap").notNull().default(1),
    validityDays: integer("validity_days").notNull(),
    /** DD16 — the E-32 queue perk `opd_queue_entries.perk` already exists to carry. */
    queuePerk: boolean("queue_perk").notNull().default(false),
    status: text("status").notNull().default("active"), // 'active'|'retired'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("membership_plans_code_ux").on(t.code)],
);

/**
 * THE COUPON CATALOG (DD3). Also configuration, also empty here.
 *
 * The validity predicate T2 writes reads every column below: a date window, a weekday mask, an
 * IST time-of-day window, a minimum bill and a percentage cap. They are COLUMNS rather than one
 * opaque blob because the coupon-rules tests discriminate on each of them separately (K3, K4,
 * K7, K8) and a blob would make every one of those a jsonb-shape assertion instead.
 */
export const couponDefinitions = pgTable(
  "coupon_definitions",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // DATA, seeded
    title: text("title").notNull(),
    counterpartyId: text("counterparty_id").references(() => counterparties.id),
    planId: text("plan_id").references(() => membershipPlans.id), // a coupon bundled with a plan
    benefit: jsonb("benefit").notNull(), // { kind: 'percent'|'flat', … } — shape fixed here, value seeded
    scope: jsonb("scope").notNull(), // eligible service categories / service ids
    minBillPaise: bigint("min_bill_paise", { mode: "number" }).notNull().default(0), // K4
    capPaise: bigint("cap_paise", { mode: "number" }), // K3 — the cap applies to the ASK (B4)
    /** DD10: denormalised onto every redemption at insert, so the partial unique index can see it. */
    singleUse: boolean("single_use").notNull().default(true),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(), // K7 — evaluated at the IST day boundary
    /** K8: bit 0 = Monday … bit 6 = Sunday. 127 = every day. */
    weekdayMask: integer("weekday_mask").notNull().default(127),
    /** K8: minutes from IST midnight, inclusive start / inclusive end. Null = all day. */
    windowStartMinute: integer("window_start_minute"),
    windowEndMinute: integer("window_end_minute"),
    status: text("status").notNull().default("active"), // 'active'|'retired'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("coupon_definitions_code_ux").on(t.code)],
);

/**
 * ONE IMPORTED HOLDER-BOOK DROP (T5). Provenance for every instance it produced: which file,
 * which column map, who ran it and what it did.
 *
 * `(counterparty_id, file_hash)` is unique so a re-sent file is RECOGNISED rather than
 * re-imported — the second guard behind E1's real idempotency key, which is the partner's own
 * sale reference on `membership_instances`.
 */
export const holderBookImports = pgTable(
  "holder_book_imports",
  {
    id: text("id").primaryKey(),
    counterpartyId: text("counterparty_id").notNull().references(() => counterparties.id),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    columnMapVersion: text("column_map_version").notNull(), // I-*: versioned maps per drop, never positional
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsAccepted: integer("rows_accepted").notNull().default(0),
    rowsQuarantined: integer("rows_quarantined").notNull().default(0),
    importedBy: text("imported_by").notNull(), // plain text, DD17
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("holder_book_imports_file_ux").on(t.counterpartyId, t.fileHash)],
);

/**
 * AN ISSUED INSTRUMENT — the card a person presents at the counter.
 *
 * `card_code` IS DELIBERATELY NOT UNIQUE, and that is E1's lesson written into the schema rather
 * than left to the importer: a partner reissues a card number to a different holder, so a unique
 * index on it would refuse the correct row. The idempotency key is the partner's own sale
 * reference — `(counterparty_id, partner_sale_ref)`, unique where the reference exists — and the
 * card code carries an ordinary index because recognition resolves it against the validity window
 * rather than against uniqueness.
 *
 * `patient_id` IS NULLABLE ON PURPOSE (T5/E3). An imported holder who fuzzy-matches an existing
 * patient is NEVER auto-linked: the instance lands with a null patient and a `patient_match_queue`
 * row for a human. `origin = 'grace'` is O-1's grace-honored instance, which `verified = false`
 * keeps out of accrual until a real book row arrives and matches it (C-17).
 *
 * `activated_at` is what the volume kicker counts (O-6) — the ACTIVATION instant, never the sale
 * date, which is what makes book-stuffing before a threshold cut-off unprofitable by construction.
 */
export const membershipInstances = pgTable(
  "membership_instances",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => membershipPlans.id),
    counterpartyId: text("counterparty_id").references(() => counterparties.id),
    cardCode: text("card_code").notNull(), // see header: NOT unique, by measurement
    patientId: text("patient_id").references(() => patients.id), // null until a human links it
    holderName: text("holder_name").notNull(),
    holderPhone: text("holder_phone"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"), // 'active'|'expired'|'suspended'|'cancelled'
    origin: text("origin").notNull(), // 'import'|'counter'|'grace' (O-1)
    /** C-17 — verify before accrual eligibility. A grace-honored instance accrues NOTHING. */
    verified: boolean("verified").notNull().default(false),
    partnerSaleRef: text("partner_sale_ref"), // E1's idempotency key, with counterparty_id
    importId: text("import_id").references(() => holderBookImports.id),
    importRowNo: integer("import_row_no"),
    /** O-5 — honoured to cap, flagged loudly: which members overflowed and from which row. */
    capOverflow: jsonb("cap_overflow"),
    activatedAt: timestamp("activated_at", { withTimezone: true }), // O-6 — the kicker's instant
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Arrival order. ULID ids cannot carry it (§3.26) — the database does.
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    index("membership_instances_card_code_idx").on(t.cardCode),
    index("membership_instances_patient_idx").on(t.patientId),
    uniqueIndex("membership_instances_sale_ref_ux")
      .on(t.counterpartyId, t.partnerSaleRef)
      .where(sql`${t.partnerSaleRef} is not null`),
  ],
);

/**
 * THE PEOPLE AN INSTANCE COVERS (O-3, O-5). `member_no` is the file's own row order, which is
 * what makes "honour to the cap" deterministic: two imports of the same drop honour the same
 * people. `honoured = false` is O-5's overflow — the member is RECORDED rather than dropped,
 * because the paying family's data error belongs in the reconcile queue and not in a silence.
 */
export const coveredMembers = pgTable(
  "covered_members",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => membershipInstances.id),
    memberNo: integer("member_no").notNull(), // file order — O-5's determinism
    name: text("name").notNull(),
    relation: text("relation"),
    phone: text("phone"),
    patientId: text("patient_id").references(() => patients.id), // null until matched (E3)
    honoured: boolean("honoured").notNull().default(true), // false = over cap, recorded loudly
    sourceRowNo: integer("source_row_no"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(), // O-3 mid-year add
  },
  (t) => [
    uniqueIndex("covered_members_instance_no_ux").on(t.instanceId, t.memberNo),
    index("covered_members_patient_idx").on(t.patientId),
  ],
);

/**
 * THE GRANT half of DD10. `granted_qty` is what the plan gave; REMAINING IS COMPUTED from the
 * movement log below and is deliberately not a column — a stored remaining would be a second
 * authority on the same number, and the one thing an append-only ledger must never need is an
 * UPDATE.
 */
export const entitlementCounters = pgTable(
  "entitlement_counters",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => membershipInstances.id),
    benefitKey: text("benefit_key").notNull(), // from the plan's own `entitlements` config
    /**
     * ═══ FD-7 T6 / OWNER RULING R3 — WHAT ONE UNIT OF THIS COUNTER IS ═══
     *
     * `'count'` (the default, and every counter that existed before migration 0058) or `'paise'`.
     * The owner ruled that packages draw down BOTH ways, chosen per package: a membership granting
     * eight consultations counts visits, a ₹10,000 prepaid package counts money.
     *
     * It is ONE column rather than two tables because the movement log does not care: `delta` is a
     * signed integer either way, `remaining = granted_qty + Σ delta` holds either way, and
     * `restoreEntitlements` negates `-movement.delta` without knowing which lane it is in — which is
     * why the reversal path needed no change at all for the value lane.
     */
    unit: text("unit").notNull().default("count"), // 'count' | 'paise'
    /** In this counter's UNIT: whole visits when `unit = 'count'`, paise when `unit = 'paise'`. */
    grantedQty: integer("granted_qty").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(), // O-2: the bundle's own validity
    state: text("state").notNull().default("active"), // 'active'|'void'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("entitlement_counters_instance_benefit_ux").on(t.instanceId, t.benefitKey)],
);

/**
 * THE MOVEMENT LOG — append-only by trigger (DD5), signed (DD10). A consume is `-n`; a restore is
 * `+n` naming the movement it negates. Nothing is ever updated, which is why C1's reversibility
 * and D6's "restore is a NEGATING ROW" are the same statement.
 *
 * `invoice_id` / `invoice_line_id` are REAL foreign keys: a consumption that named an invoice line
 * which never existed would be a benefit nobody can audit, and C2's proportional restore is
 * defined per LINE. Both are nullable — an administrative void has no invoice.
 *
 * `lapsed_restore` is C5: a restore after the counter's own validity has lapsed HAPPENS ANYWAY and
 * is flagged, because refusing it would silently keep money the patient received no value for.
 */
export const entitlementMovements = pgTable(
  "entitlement_movements",
  {
    id: text("id").primaryKey(),
    counterId: text("counter_id").notNull().references(() => entitlementCounters.id),
    delta: integer("delta").notNull(), // signed: negative consumes, positive restores
    kind: text("kind").notNull(), // 'consume'|'restore'
    invoiceId: text("invoice_id").references(() => invoices.id),
    invoiceLineId: text("invoice_line_id").references(() => invoiceLines.id),
    /** Plain-text self-reference — nothing is ever updated (the `allocations.reversal_of_id` shape). */
    reversalOfId: text("reversal_of_id"),
    lapsedRestore: boolean("lapsed_restore").notNull().default(false), // C5, surfaced in the queue
    reason: text("reason"),
    actorId: text("actor_id").notNull(), // plain text, DD17
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    index("entitlement_movements_counter_idx").on(t.counterId),
    index("entitlement_movements_invoice_idx").on(t.invoiceId),
  ],
);

/**
 * COUPON REDEMPTIONS — append-only by trigger (DD5), with DD10's partial unique index as the belt
 * behind the `FOR UPDATE` braces.
 *
 * ═══ WHY `cycle_no` EXISTS, BECAUSE IT IS THE ONE COLUMN THE PLAN DOES NOT NAME ═══
 *
 * Three plan rulings meet on this table and, as literally written, they are over-determined:
 * DD5 makes it append-only, DD10 puts a partial unique index on
 * `(coupon_id) WHERE single_use AND state = 'redeemed'`, and O-4 requires that a coupon RELEASED
 * when its sale was corrected can be redeemed again — "a coupon redemption that survived the
 * cancellation of the very sale it was consumed against would be the one asymmetry in the model".
 * A release cannot UPDATE the redeemed row (the trigger refuses), so it must be a second row; but
 * then the first row is still `state = 'redeemed'` and an index keyed on `coupon_id` alone would
 * refuse the re-redemption O-4 exists to permit.
 *
 * `cycle_no` is the narrowest resolution: it is the number of releases that have already happened
 * for this coupon, so a second redemption WITHOUT a release lands on the same cycle and is refused
 * by the index (which is D3's mutant, unchanged), while a redemption AFTER a release lands on the
 * next cycle and is allowed. Nothing is updated, the index still fires without the lock, and the
 * lock still turns a raw `23505` into a clean typed refusal — DD10's two halves both keep their
 * jobs. Recorded here at length because a reader who knows DD10 will otherwise read the extra
 * column as drift.
 *
 * `single_use` is denormalised at insert, exactly as DD10 says: the index cannot reach through the
 * FK to `coupon_definitions`, and the flag that was true when the coupon was redeemed is the flag
 * that should govern the redemption.
 */
export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: text("id").primaryKey(),
    couponId: text("coupon_id").notNull().references(() => couponDefinitions.id),
    /** The release cycle — see the header. 0 for a coupon that has never been released. */
    cycleNo: integer("cycle_no").notNull().default(0),
    state: text("state").notNull(), // 'redeemed'|'released'
    singleUse: boolean("single_use").notNull(), // denormalised at insert (DD10)
    patientId: text("patient_id").notNull().references(() => patients.id),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    instanceId: text("instance_id").references(() => membershipInstances.id), // a bundled coupon
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull().default(0),
    /** The redemption a release negates. Plain self-reference; nothing is ever updated. */
    releasedOfId: text("released_of_id"),
    reason: text("reason"),
    actorId: text("actor_id").notNull(), // plain text, DD17
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    index("coupon_redemptions_coupon_idx").on(t.couponId),
    index("coupon_redemptions_invoice_idx").on(t.invoiceId),
    // DD10's belt. The lock is the mechanism; THIS is what survives a future writer who forgets
    // the lock, and the spike measured it firing 10/10 with the lock removed (§3 Q6).
    uniqueIndex("coupon_redemptions_single_use_uq")
      .on(t.couponId, t.cycleNo)
      .where(sql`${t.singleUse} and ${t.state} = 'redeemed'`),
  ],
);

/**
 * QUARANTINED IMPORT ROWS (T5's whole-row quarantine, and T7's statement lines when it lands).
 *
 * WHOLE ROWS, NEVER LAST-WINS: two rows sharing a key quarantine BOTH, with the reason, and
 * neither is applied (E2). The row is kept verbatim in `raw` so a human can see what the partner
 * actually sent rather than what the parser made of it.
 *
 * `batch_id` IS PLAIN TEXT WITH NO FOREIGN KEY, deliberately: it names a `holder_book_imports.id`
 * today and a partner statement's own reference when T7 imports one, and a column that must point
 * at two different parents cannot carry an FK to either. That also leaves this table with no
 * foreign key in either direction, so by §3.35/§3.12 it takes its OWN truncate statement in
 * `test/helpers/db.ts` — the `search_audit` / `auth_throttle` precedent, for the same reason.
 */
export const importQuarantine = pgTable(
  "import_quarantine",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // 'holder_book'|'partner_statement'
    batchId: text("batch_id").notNull(), // plain text — see header
    rowNo: integer("row_no").notNull(),
    reason: text("reason").notNull(), // 'duplicate_key'|'inverted_validity'|'unknown_columns'|…
    raw: jsonb("raw").notNull(), // the row as received, verbatim
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [index("import_quarantine_batch_idx").on(t.batchId)],
);

/**
 * THE RECONCILE QUEUE — the one place a human decides something the importer refused to guess.
 *
 * `candidates` holds SCORED CANDIDATES and nothing else. E3 is the rule it exists to make
 * structural: a fuzzy patient match NEVER auto-links, whatever the score, because a wrong link is
 * a clinical record attached to the wrong person and it is invisible to the person it happened to.
 * The link is `resolved_patient_id`, written by a human's decision, and the FK means that decision
 * can never name a patient who does not exist.
 *
 * The queue also carries DD11's merge duplicates and O-5's cap overflows: three different reasons,
 * one worklist, because a desk that has to remember which screen shows which exception uses none
 * of them.
 */
export const patientMatchQueue = pgTable(
  "patient_match_queue",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull().references(() => membershipInstances.id),
    memberId: text("member_id").references(() => coveredMembers.id), // set when the subject is a covered member
    reason: text("reason").notNull(), // 'fuzzy_match'|'merge_duplicate'|'cap_overflow'|'lapsed_restore'
    candidates: jsonb("candidates").notNull(), // [{ patientId, score, why }] — never a link
    state: text("state").notNull().default("open"), // 'open'|'resolved'|'dismissed'
    resolvedPatientId: text("resolved_patient_id").references(() => patients.id),
    resolvedBy: text("resolved_by"), // plain text, DD17
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigserial("seq", { mode: "number" }),
  },
  (t) => [
    index("patient_match_queue_state_idx").on(t.state),
    index("patient_match_queue_instance_idx").on(t.instanceId),
  ],
);
