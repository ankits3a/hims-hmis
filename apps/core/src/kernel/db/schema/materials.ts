import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text,
  timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { formularyMedicines } from "./formulary";
import { resources } from "./resources";

/**
 * PLAN 14 T1 — MATERIALS: the first tables in this system that know a box of anything EXISTS.
 *
 * ═══ WHAT WAS TRUE BEFORE THIS FILE ═══
 *
 * OPD prescribes against a formulary (16a) and bills against a tariff (06/08), and nothing anywhere
 * recorded that a strip of a drug was on a shelf, which shelf, which batch, when it expires, what
 * MRP is printed on it, or WHO OWNS IT. `grep -rli vendor apps/core/src --include=*.ts` returned
 * zero non-test files at kickoff. Plan 15's mini-OT cannot exist without this: its central money
 * event is an implant scanned on use, and a scan-on-use needs a consignment lot to deploy FROM and
 * a ledger to write TO.
 *
 * ═══ THE SIXTEEN TABLES, AND WHY THEY ARE ONE FAMILY ═══
 *
 * Four masters (`items`, `item_uoms`, `item_barcodes`, `item_price_regulations`), three vendor
 * tables (`vendors`, `vendor_documents`, `vendor_bank_changes`), two batch tables (`stock_batches`,
 * `consignment_lots`), three ledger tables (`stock_ledger`, `stock_balances`, `stock_reservations`),
 * and two document pairs (`transfers`/`transfer_lines`, `grns`/`grn_lines`). Built per module, this
 * is ledger §2.54's mechanism applied to the most-copied table family in any hospital system —
 * pharmacy, the lab, the OT and the ward would each grow their own and the four would disagree by
 * the end of the first quarter. One ledger, in `materials`; every other module is a CALLER (§ 4A
 * item 2).
 *
 * ═══ AN ITEM IS NOT A MEDICINE (DD3) ═══
 *
 * `items.formulary_medicine_id` is a NULLABLE FK into `formulary_medicines` with a CHECK that makes
 * it exactly-iff: `(class = 'drug') = (formulary_medicine_id IS NOT NULL)`. Composition, salts,
 * strength and the schedule flag stay in the formulary and are NEVER copied here — that is 16a's
 * whole reason for existing, and a second copy of a drug's moiety list is a second answer to
 * "is this patient allergic to it". Non-drug classes (a glove, an implant, a reagent) have no
 * medicine and MUST NOT invent one; the CHECK enforces both directions because a `consumable` that
 * points at a medicine is the same defect wearing the other mask.
 *
 * **Packs are UoM rows, not items** (§ 4A item 1, PROVISIONAL). Brand × strength × form is the
 * formulary's grain and it is the item's grain; a box of 10 strips of 10 tablets is two
 * `item_uoms` rows over one item, and a pack barcode is an `item_barcodes` row carrying
 * `pack_uom`. If Plan 16 needs pack-level PRICING it already has `item_price_regulations.mrp_uom`.
 *
 * ═══ QUANTITIES ARE INTEGERS IN THE BASE UOM; MONEY IS INTEGER PAISE (DD7) ═══
 *
 * Every `qty_*` column in this file is `integer` and every one of them is in the ITEM'S BASE UNIT.
 * A GRN line captured as "3 boxes" stores `qty_in_uom = 3`, `uom = 'box'`, `qty_base = 300`, and the
 * multiplication happens ONCE, in `uom.ts`, from the item's OWN `item_uoms` table (T3, A2). There is
 * no float anywhere in this family and there is no "quantity in whatever unit the caller had".
 *
 * **`mrp_paise` NEVER travels without `mrp_uom`.** An MRP is printed on a PACK: ₹85 is the strip's
 * price, not the tablet's, and a system that stores the number without the unit has to divide by a
 * multiplier somewhere, in a rounding step nobody audited, to compare it with a per-tablet landed
 * cost. `stock_batches`, `grn_lines` and `item_price_regulations` all carry the pair. `landed_cost_paise`
 * is per BASE unit, always, and the two are compared only after `uom.ts` has put them in one unit
 * (16a DD5: one constant, one owner; ledger §2.93: verify a formula where its operands DIFFER).
 *
 * ═══ OWNERSHIP IS ON THE BATCH, AND IT IS IMMUTABLE (DD5) ═══
 *
 * Spec §11.19-D fix 7 puts the ownership dimension on stock LOCATIONS. This file puts it on
 * `stock_batches.ownership` instead, and the difference is load-bearing: a batch never changes hands
 * without leaving the ledger and re-entering as a different batch. A consignment implant bought
 * outright is a GRN of an OWNED batch, not a flag flip — the flag flip loses the event that the
 * money hung on. Balances are per `(resource, batch)`, so "ownership per location" is a JOIN and
 * fix 7's leakage triangle is a QUERY rather than a column. Immutability has no trigger behind it:
 * it is enforced by there being no write path that touches the column (T5, A11), which is the same
 * thing `resource_status_history`'s append-only property means.
 *
 * The unique key is `(item_id, lower(batch_no), OWNERSHIP)` and the third element is the one that
 * matters: the same physical batch number can arrive twice, once on a purchase challan and once on
 * a consignment challan, and those are two different piles of stock with two different owners and
 * two different money consequences.
 *
 * ═══ THE LEDGER IS APPEND-ONLY AND THE BALANCE CANNOT GO NEGATIVE (DD6) ═══
 *
 * `stock_ledger` has no update path and no delete path anywhere in the codebase. `stock_balances` is
 * the materialised read model — billing, pharmacy and the board query it — and it is written in the
 * SAME transaction that appends the ledger row, after locking the affected rows
 * `order by resource_id, batch_id for update` (the `receipts.ts:637` shape: set-then-rows, never
 * row-then-set). The CHECK below it is the half that survives a caller who forgets:
 * `qty_on_hand >= 0 AND qty_reserved <= qty_on_hand AND qty_frozen <= qty_on_hand`, defending the
 * invariant against EVERY write path including raw SQL in a future migration.
 *
 * **Negative stock is refused in this phase, full stop**, and that is chosen rather than defaulted.
 * A dispense recorded before its GRN during a downtime window is a real case (doc 16 H1) and it is
 * 16c's, with 11c's downtime kit. `occurred_at` MAY precede `recorded_at` — that is the downtime
 * convention and both columns exist for it — but the balance check applies in RECORDED order,
 * because that is the order the rows actually arrived and the only order a lock can serialise.
 *
 * **`seq` IS THE ORDERING KEY** on `stock_ledger`, not `id` and not `occurred_at`. `id` is a ULID
 * and ULIDs are never an ordering key (`ids.ts` WARNING, ledger §3.26); `occurred_at` is injected
 * and two rows can carry the same instant, or an earlier one than the row before them.
 *
 * ═══ VENDORS ARE NOT COUNTERPARTIES (DD4) ═══
 *
 * `counterparties` (Plan 09) has a CHECK closing `payee_class` to three COMMISSION classes, its
 * agreements are attribution and payout terms and its SoD pairs are payout-preparer/approver. A
 * supplier of gloves is none of those things: its SoD pairs are PO-approver/GRN-receiver and
 * custodian/counter, its documents are drug licences and Udyam certificates, and its lifecycle has
 * `blacklisted`. One table carrying both would be `patient_merge_requests.approval_id` again — a
 * column meaning two things. The seam is NAMED rather than built: when 14b exports payment vouchers
 * to Tally, a mapper derives the payee ledger name from either table, and a `payees` view can unify
 * them then.
 *
 * **Bank details are a JSONB object and every read path outside `vendor_bank_changes` masks the
 * account number to its last four** (T4, A7 — doc 09 §7's DPDP class: financial-sensitive, masked
 * in UI, change-controlled). The full new object lives on the change row, behind an owner approval.
 *
 * ═══ IDS ARE ULIDs; `seq` IS FOR ORDERING; MONEY IS `bigint` ═══
 *
 * `bigint(..., { mode: "number" })` for paise, the `regulated_prices` precedent. `integer` for
 * quantities: a hospital that moves more than two billion base units of one item in one movement has
 * a different problem than this column.
 */

/** The audit shape every master in this repo carries — `opd_departments`' columns, same names. */
const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * THE TEN ITEM CLASSES, and the list `items_class_ck` enforces.
 *
 * Exported so T3's logic and its tests read the same array the constraint was built from rather
 * than a transcription of it (16a F3: a closed set ships as a CHECK, because an out-of-set value
 * reads to every downstream reader in the SAFE-LOOKING direction — "not a drug", "not batched").
 *
 * `BATCH_MANDATORY_CLASSES` is deliberately NOT here: it is a `materials/config.ts` constant read by
 * exactly one logic file (the GRN gate, DD8 rule 3), because it is a POLICY that a CA or a licensing
 * change may move, and this is a CONSTRAINT that a migration must move.
 */
export const ITEM_CLASS_VALUES = [
  "drug", "consumable", "consumable_dated", "reagent", "implant", "stationery", "linen", "gas",
  "asset", "service",
] as const;

/** DD5's four. `owned` is the default nothing states; the other three all have a counterparty. */
export const OWNERSHIP_VALUES = ["owned", "consignment", "loaner", "donated"] as const;

/**
 * DD6's five reasons, and 14c's sixth: `adjust`, a count's variance written off or on after a second
 * person approved it (`stock_adjustments`). Every ledger row is one of them and the sign is the
 * reason's business.
 */
export const LEDGER_REASON_VALUES = ["grn", "issue", "receive", "consume", "return", "adjust"] as const;

// ═══════════════════════════════════ THE ITEM MASTER ═══════════════════════════════════

/**
 * WHAT A THING IS. One row per purchasable/consumable/stockable article.
 *
 * `class` decides almost everything downstream: whether a medicine is required (the CHECK below),
 * whether batch and expiry are mandatory at the GRN gate (DD8 rule 3, from `config.ts`), and
 * whether MRP is mandatory (rule 6). It is a CHECK rather than a convention for 16a F3's reason.
 *
 * `base_uom` is a STRING and not an FK into `item_uoms`, and that is not laziness: `item_uoms` rows
 * reference the item, so an FK the other way is a cycle, and the invariant that actually matters —
 * "exactly one UoM row has multiplier 1 and its name is `base_uom`" — is not expressible as a
 * foreign key in either direction. It is enforced at the write path and asserted (T3, A3).
 *
 * `shelf_life_days` is nullable and its absence is a FACT: a stationery item has no shelf life, and
 * DD8 rule 5's `min(6 months, 75% of shelf_life)` falls back to the six-month bound when it is null.
 */
export const items = pgTable(
  "items",
  {
    id: text("id").primaryKey(), // ULID via newId() — never an ordering key
    code: text("code").notNull(),
    name: text("name").notNull(),
    class: text("class").notNull(),
    /**
     * DD3. NULLABLE FK, and the CHECK below makes it exactly-iff with `class = 'drug'`. Production
     * held ZERO `formulary_medicines` at kickoff (Spike Q2), so on the live box no drug-class item
     * can be registered until the owner's platinumrx mining track (16a spec D2) lands one. That is a
     * named dependency and not a defect of this table: the alternative — a drug item with no
     * medicine — is precisely what 16a exists to make impossible.
     */
    formularyMedicineId: text("formulary_medicine_id").references(() => formularyMedicines.id),
    hsnCode: text("hsn_code"),
    gstRateBps: integer("gst_rate_bps"), // basis points: 12% is 1200. No float, ever.
    baseUom: text("base_uom").notNull(), // see the header — not an FK, and cannot be
    batchTracked: boolean("batch_tracked").notNull(),
    serialTracked: boolean("serial_tracked").notNull().default(false),
    storageClass: text("storage_class").notNull().default("ambient"),
    shelfLifeDays: integer("shelf_life_days"), // null = no shelf life; DD8 rule 5 falls back
    abcClass: text("abc_class"), // consumption-value class — 14b's replenishment reads it
    vedClass: text("ved_class"), // vital/essential/desirable — 14b's, same
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    /** A code is read off a label and case is not identity — the `formulary_salts_name_lower_ux` precedent. */
    uniqueIndex("items_code_lower_ux").using("btree", sql`lower(${t.code})`),
    index("items_class_active_idx").on(t.class, t.active),
    index("items_formulary_medicine_idx").on(t.formularyMedicineId),
    check("items_class_ck", sql`${t.class} in ('drug', 'consumable', 'consumable_dated', 'reagent', 'implant', 'stationery', 'linen', 'gas', 'asset', 'service')`),
    check("items_storage_class_ck", sql`${t.storageClass} in ('ambient', 'cold_2_8', 'frozen', 'narcotic', 'flammable')`),
    /**
     * DD3, AND IT IS ONE OF THE FIVE CHECKS `materials.test.ts` READS OUT OF `pg_constraint` BY
     * NAME. The generator can silently fail to emit a CHECK; an assertion built from the drizzle
     * objects would pass for a migration that was never generated. What is pinned is what POSTGRES
     * HAS (§2.88).
     *
     * Written as an equality of two booleans rather than as two implications, because that is the
     * shape that cannot be half-implemented — T3's mutant A1 is exactly a validator that checks one
     * direction, and this constraint refuses both.
     */
    check("items_class_formulary_ck", sql`(${t.class} = 'drug') = (${t.formularyMedicineId} is not null)`),
  ],
);

/**
 * THE ONLY PLACE A MULTIPLIER LIVES. `to_base_multiplier` is how many BASE units one of this UoM is.
 *
 * Exactly one row per item has multiplier 1, and its `uom` equals `items.base_uom` — the invariant
 * the header of `items` explains cannot be a foreign key. `toBase(uoms, uom, qty)` (T3, `uom.ts`) is
 * the ONE function that applies a multiplier, and A2's mutant is a `toBase` that returns `qty * 10`
 * for anything non-base: it survives every fixture whose box happens to hold ten (§2.102), which is
 * why T3's discriminating input is TWO items whose `box` differs.
 */
export const itemUoms = pgTable(
  "item_uoms",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    uom: text("uom").notNull(),
    toBaseMultiplier: integer("to_base_multiplier").notNull(),
    isPurchaseUom: boolean("is_purchase_uom").notNull().default(false),
    isIssueUom: boolean("is_issue_uom").notNull().default(false),
  },
  (t) => [
    uniqueIndex("item_uoms_item_uom_lower_ux").using("btree", t.itemId, sql`lower(${t.uom})`),
    check("item_uoms_multiplier_ck", sql`${t.toBaseMultiplier} > 0`),
  ],
);

/**
 * The barcode on the pack. GLOBALLY unique on `lower(code)` — a scanner does not know which item it
 * is about to read, so a code that resolves to two items resolves to neither.
 *
 * `vendor_id` carries NO foreign key, deliberately: `vendors` is declared below this table, and more
 * to the point a vendor-specific barcode may name a supplier who is later blacklisted without the
 * barcode ceasing to be a fact about the carton. T3 validates the id at the write path.
 */
export const itemBarcodes = pgTable(
  "item_barcodes",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    code: text("code").notNull(),
    packUom: text("pack_uom").notNull(), // WHICH pack this barcode is on — a box code is not a strip code
    vendorId: text("vendor_id"), // no FK — see the header
  },
  (t) => [
    uniqueIndex("item_barcodes_code_lower_ux").using("btree", sql`lower(${t.code})`),
    index("item_barcodes_item_idx").on(t.itemId),
  ],
);

/**
 * The `regulated_prices` shape (schema/tariff.ts:75-95) keyed by ITEM instead of by SERVICE, and it
 * is a deliberate SECOND table rather than a widened first one (DD8, § 4A item 4): `regulated_prices`
 * is per SERVICE, this is per ITEM, and a drug is both. The bridge belongs to whichever phase first
 * BILLS an item, and this phase does not.
 *
 * APPEND-ONLY, exactly as `regulated_prices` is: an NPPA gazette revision is a NEW effective-dated
 * row, never an UPDATE, because the row history IS the change-control trail.
 *
 * **`seq` and the tie-break are the point of this table.** Two rows can share an `effective_from` —
 * a correction issued the same day as the thing it corrects — and `order by effective_from desc`
 * alone returns EITHER. `effectiveRegulation` orders by `(effective_from desc, seq desc)`, and T3's
 * A4 mutant is a query that drops the second key.
 */
export const itemPriceRegulations = pgTable(
  "item_price_regulations",
  {
    seq: bigserial("seq", { mode: "number" }), // the tie-break — see the header
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    mrpDefaultPaise: bigint("mrp_default_paise", { mode: "number" }),
    mrpUom: text("mrp_uom"), // NEVER travels without the paise — see the file header
    ceilingPaise: bigint("ceiling_paise", { mode: "number" }), // DPCO/NPPA notified ceiling
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    gazetteRef: text("gazette_ref"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_price_regulations_item_idx").on(t.itemId, t.effectiveFrom)],
);

// ═══════════════════════════════════ THE VENDOR MASTER ═══════════════════════════════════

/**
 * WHO SUPPLIED IT. See the file header for why this is not `counterparties`.
 *
 * `status` is a four-value CHECK and `blacklisted` is a TERMINAL-ish state with a CLOCK:
 * `blacklist_until = now + 3 years` (**O-11 RULED**), and `reinstateVendor` before that instant is
 * refused (T4, A5). The clock is what makes the mutant interesting — a reinstate that checks only
 * `status === 'blacklisted'` passes every single-leg fixture.
 *
 * `bank` is JSONB and NOTHING but `applyBankChange` writes it (T4, A6). `first_payment_allowed_at`
 * is written at the same moment and exists NOW rather than in 14c, so that 14c's payment run READS
 * the cooling-off instead of re-deriving it from the change row — two derivations of one date is
 * §2.54's mechanism pointed at money.
 *
 * `class_flags` is JSONB rather than four booleans because the set grows (doc 09 §3 already implies
 * `blood_bank` and `aerb`), and because nothing in this phase BRANCHES on more than
 * `drugLicensed` — a column per flag would be four migrations for one predicate.
 */
export const vendors = pgTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    legalName: text("legal_name").notNull(),
    tradeName: text("trade_name"),
    gstin: text("gstin"),
    gstinVerifiedAt: timestamp("gstin_verified_at", { withTimezone: true }),
    pan: text("pan"),
    msmeUdyamNo: text("msme_udyam_no"),
    msmeClass: text("msme_class"), // micro | small | medium — 14b's MSME clock (R-099) reads it
    paymentTermsDays: integer("payment_terms_days"),
    classFlags: jsonb("class_flags").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    /** MASKED on every read path outside `vendor_bank_changes` (T4, A7). Written ONLY by `applyBankChange`. */
    bank: jsonb("bank").$type<Record<string, unknown>>(),
    firstPaymentAllowedAt: timestamp("first_payment_allowed_at", { withTimezone: true }), // DD10 — 14c reads it
    status: text("status").notNull().default("draft"),
    blacklistUntil: timestamp("blacklist_until", { withTimezone: true }),
    blacklistReason: text("blacklist_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("vendors_code_lower_ux").using("btree", sql`lower(${t.code})`),
    index("vendors_status_idx").on(t.status),
    check("vendors_status_ck", sql`${t.status} in ('draft', 'active', 'suspended', 'blacklisted')`),
  ],
);

/**
 * The paperwork a vendor's class obliges. `valid_to` is NULLABLE and null means OPEN-ENDED, which is
 * the honest reading of a PAN certificate — and it is why `hasValidDocument(tx, vendorId, type, onDate)`
 * (T4) must test `valid_to IS NULL OR valid_to >= onDate` rather than a bare comparison. T6's A16
 * mutant is exactly a check that ignores `valid_to` altogether, and its discriminating input is a
 * consignment agreement that expired THE DAY BEFORE the challan date — a vendor with no document at
 * all cannot tell the two implementations apart.
 */
export const vendorDocuments = pgTable(
  "vendor_documents",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    type: text("type").notNull(),
    number: text("number").notNull(),
    validFrom: date("valid_from", { mode: "string" }),
    validTo: date("valid_to", { mode: "string" }), // null = open-ended — see the header
    fileRef: text("file_ref"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vendor_documents_vendor_type_idx").on(t.vendorId, t.type),
    check("vendor_documents_type_ck", sql`${t.type} in ('drug_licence_20b', 'drug_licence_21b', 'gst_certificate', 'pan', 'cancelled_cheque', 'udyam', 'dpdp_processor_agreement', 'consignment_agreement', 'iso', 'aerb_type_approval')`),
  ],
);

/**
 * THE ONLY TABLE THAT HOLDS AN UNMASKED ACCOUNT NUMBER, and the whole of the change-control trail
 * for one (DD10, **O-6 RULED**: owner approval always, 7-day cooling-off).
 *
 * `approval_id` is PLAIN TEXT and not an FK, the `patient_merge_requests.approval_id` precedent:
 * the approval is written by the approvals engine in its own transaction and this row is created
 * beside it, so an FK would order two writes that have no ordering.
 *
 * `old_masked`/`new_masked` are what a screen renders; `new_bank` is what `applyBankChange` copies
 * onto the vendor once the approval is GRANTED. `cooling_off_until` is stamped from the GRANT
 * instant, not from the request instant — a request that sat unapproved for a month must not
 * shorten the window it exists to create.
 */
export const vendorBankChanges = pgTable(
  "vendor_bank_changes",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    oldMasked: text("old_masked"), // null when the vendor had no bank at all
    newMasked: text("new_masked").notNull(),
    newBank: jsonb("new_bank").$type<Record<string, unknown>>().notNull(),
    requestedBy: text("requested_by").notNull(),
    approvalId: text("approval_id").notNull(), // plain text — see the header
    status: text("status").notNull().default("pending"),
    coolingOffUntil: timestamp("cooling_off_until", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vendor_bank_changes_vendor_idx").on(t.vendorId),
    check("vendor_bank_changes_status_ck", sql`${t.status} in ('pending', 'applied', 'rejected')`),
  ],
);

// ═══════════════════════════════════ BATCHES AND LOTS ═══════════════════════════════════

/**
 * A PHYSICAL PILE OF ONE ITEM WITH ONE EXPIRY AND ONE OWNER. The grain the whole ledger keys on.
 *
 * See the file header for why `ownership` is here and why it is in the unique key.
 *
 * `recall_status` is `none | frozen` and freezing is ONE ACTION at EVERY location (DD14): the batch
 * row flips and every `stock_balances` row of that batch gets `qty_frozen = qty_on_hand` in the same
 * transaction, under the DD6 lock. A12's mutant freezes only the store the caller passed, and only a
 * fixture holding one batch in THREE stores can tell them apart.
 *
 * `expiry_notified_thresholds` is a JSONB array of the day-thresholds already announced for this
 * batch, and it is what makes `sweepBatchExpiry` idempotent per `(batch, threshold)` rather than
 * per run (DD14). A daily job that re-emits at 90 days every morning for a month is a job an
 * operator mutes.
 *
 * `grn_line_id` and `consignment_lot_id` carry NO foreign keys, and that is a CYCLE, not an
 * oversight: `grn_lines.batch_id` points HERE (set at post) and `consignment_lots.batch_id` points
 * HERE, so an FK in the other direction would make two mutually-referencing pairs that no single
 * INSERT order can satisfy. The back-references are ids the reader resolves, and T6 writes them.
 */
export const stockBatches = pgTable(
  "stock_batches",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    batchNo: text("batch_no").notNull(),
    mfgDate: date("mfg_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }), // null only for classes DD8 rule 3 exempts
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    mrpUom: text("mrp_uom"), // NEVER travels without the paise — see the file header
    landedCostPaise: bigint("landed_cost_paise", { mode: "number" }).notNull(), // PER BASE UNIT
    vendorId: text("vendor_id").references(() => vendors.id),
    grnLineId: text("grn_line_id"), // no FK — see the header (cycle)
    ownership: text("ownership").notNull(),
    consignmentLotId: text("consignment_lot_id"), // no FK — see the header (cycle)
    recallStatus: text("recall_status").notNull().default("none"),
    expiryNotifiedThresholds: jsonb("expiry_notified_thresholds").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** DD5 — OWNERSHIP IS IN THE KEY. One batch number, two owners, two piles. */
    uniqueIndex("stock_batches_item_batch_ownership_ux").using("btree", t.itemId, sql`lower(${t.batchNo})`, t.ownership),
    index("stock_batches_item_expiry_idx").on(t.itemId, t.expiryDate), // FEFO reads this
    index("stock_batches_recall_idx").on(t.recallStatus),
    /** One of the five CHECKs `materials.test.ts` reads out of `pg_constraint` BY NAME. */
    check("stock_batches_ownership_ck", sql`${t.ownership} in ('owned', 'consignment', 'loaner', 'donated')`),
    check("stock_batches_recall_status_ck", sql`${t.recallStatus} in ('none', 'frozen')`),
  ],
);

/**
 * ONE ROW PER (CHALLAN, ITEM, BATCH) OF CONSIGNMENT STOCK — the thing Plan 15 deploys FROM (DD5).
 *
 * `deemed_supply_deadline` is `challan_date + 180 days` under §31(7) of the CGST Act, COMPUTED AT
 * INSERT AND NEVER RECOMPUTED. That is the whole reason it is a stored column rather than a view:
 * the 180 days runs from the challan, and a config change to `DEEMED_SUPPLY_DAYS` next year must not
 * silently move a deadline that a tax position already depends on. T6's acceptance checks the
 * arithmetic across a month boundary AND a leap day, because `+180` is exactly the formula §2.93
 * says to verify where its operands differ.
 *
 * `agreement_document_id` is NOT NULL and it is **O-8 RULED**: no signed agreement on file, no
 * consignment GRN. The FK is what makes that structural instead of a check somebody can forget.
 *
 * The 150-day aging flag, the vendor statement reconciliation and the auto-PO are 14c's. What lives
 * here is the counter triple and its CHECK, so that a deployment beyond the lot is refused by the
 * DATABASE as well as by the consumer (T7, A20).
 */
export const consignmentLots = pgTable(
  "consignment_lots",
  {
    id: text("id").primaryKey(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    agreementDocumentId: text("agreement_document_id").notNull().references(() => vendorDocuments.id),
    challanNo: text("challan_no").notNull(),
    challanDate: date("challan_date", { mode: "string" }).notNull(),
    itemId: text("item_id").notNull().references(() => items.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    qtyReceived: integer("qty_received").notNull().default(0),
    qtyDeployed: integer("qty_deployed").notNull().default(0),
    qtyReturned: integer("qty_returned").notNull().default(0),
    deemedSupplyDeadline: date("deemed_supply_deadline", { mode: "string" }).notNull(),
    status: text("status").notNull().default("open"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("consignment_lots_vendor_idx").on(t.vendorId, t.challanDate),
    index("consignment_lots_batch_idx").on(t.batchId),
    index("consignment_lots_deadline_idx").on(t.deemedSupplyDeadline), // 14c's 150-day aging sweep
    check("consignment_lots_status_ck", sql`${t.status} in ('open', 'reconciled', 'closed')`),
    /**
     * One of the five CHECKs `materials.test.ts` reads out of `pg_constraint` BY NAME, and the one
     * that makes A20 a DATABASE property rather than only a consumer property.
     */
    check("consignment_lots_qty_ck", sql`${t.qtyDeployed} + ${t.qtyReturned} <= ${t.qtyReceived}`),
  ],
);

// ═══════════════════════════════════ THE LEDGER ═══════════════════════════════════

/**
 * EVERY MOVEMENT THAT HAS EVER HAPPENED. Append-only; see the file header.
 *
 * `qty_delta` is SIGNED and its CHECK is `<> 0` — a movement of zero is not a movement, it is a bug
 * that would otherwise sit in the history looking like an event. Sign convention: POSITIVE into the
 * resource, NEGATIVE out of it, so a transfer is TWO rows (out of the source, into `IN-TRANSIT`) and
 * then two more at receive. `postMovement` (T5) is the ONLY writer.
 *
 * `patient_id` / `encounter_id` are nullable and PLAIN TEXT — a `consume` row for an implant carries
 * both, a `grn` row carries neither, and no FK can point at two parents (the file header's
 * `occupant_ref` reasoning, one table over).
 *
 * `event_id` is nullable and is how the consumption consumer's idempotency claim is TRACEABLE from
 * the ledger side: given a duplicated `consignment.deployed`, the one row that was written names the
 * event that wrote it (T7, A19).
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    seq: bigserial("seq", { mode: "number" }), // THE ordering key — see the file header
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    itemId: text("item_id").notNull().references(() => items.id),
    qtyDelta: integer("qty_delta").notNull(), // signed — see the header
    reason: text("reason").notNull(),
    refType: text("ref_type"), // 'grn' | 'transfer' | 'consignment_deployment' | …
    refId: text("ref_id"),
    eventId: text("event_id"),
    patientId: text("patient_id"), // plain text — see the header
    encounterId: text("encounter_id"),
    costCenter: text("cost_center"),
    actorId: text("actor_id").notNull(), // plain text — the `approvals.ts` precedent
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // MAY precede recordedAt
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_ledger_resource_batch_idx").on(t.resourceId, t.batchId, t.seq),
    index("stock_ledger_item_idx").on(t.itemId, t.seq),
    index("stock_ledger_encounter_idx").on(t.encounterId), // `consumptionsFor(encounterId)` (T7)
    /** One of the five CHECKs `materials.test.ts` reads out of `pg_constraint` BY NAME. */
    check("stock_ledger_qty_delta_ck", sql`${t.qtyDelta} <> 0`),
    check("stock_ledger_reason_ck", sql`${t.reason} in ('grn', 'issue', 'receive', 'consume', 'return', 'adjust')`),
  ],
);

/**
 * THE READ MODEL, materialised in the same transaction as the ledger row (DD6). PK is
 * `(resource_id, batch_id)`, which is also the LOCK ORDER `postMovement` takes rows in — A9's
 * deadlock property is that ordering, and its mutant is a `postMovement` that locks in the CALLER'S
 * line order.
 *
 * The CHECK is the invariant's last line of defence and it is written as one constraint over three
 * clauses on purpose: three separate CHECKs would let a future migration drop the middle one without
 * anything reading differently until a reservation went wrong.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    resourceId: text("resource_id").notNull().references(() => resources.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    itemId: text("item_id").notNull().references(() => items.id),
    qtyOnHand: integer("qty_on_hand").notNull().default(0),
    qtyReserved: integer("qty_reserved").notNull().default(0),
    qtyFrozen: integer("qty_frozen").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.resourceId, t.batchId], name: "stock_balances_pk" }),
    index("stock_balances_item_idx").on(t.itemId),
    /** One of the five CHECKs `materials.test.ts` reads out of `pg_constraint` BY NAME. */
    check(
      "stock_balances_non_negative_ck",
      sql`${t.qtyOnHand} >= 0 and ${t.qtyReserved} <= ${t.qtyOnHand} and ${t.qtyFrozen} <= ${t.qtyOnHand}`,
    ),
  ],
);

/**
 * A HOLD ON STOCK THAT HAS NOT MOVED YET — the pharmacy seam (DD14 of Plan 13's posture: functions
 * with tests and NO route until the first caller mounts one).
 *
 * `expires_at` is nullable because an OT case's hold has no natural expiry and a counter's does.
 * Nothing in this phase sweeps them; 16c will.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    qty: integer("qty").notNull(),
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("held"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_reservations_resource_batch_idx").on(t.resourceId, t.batchId),
    index("stock_reservations_ref_idx").on(t.refType, t.refId),
    check("stock_reservations_qty_ck", sql`${t.qty} > 0`),
    check("stock_reservations_status_ck", sql`${t.status} in ('held', 'consumed', 'released')`),
  ],
);

// ═══════════════════════════════════ TWO-SIDED MOVEMENT ═══════════════════════════════════

/**
 * AN ISSUE THAT HAS NOT BEEN RECEIVED YET. DD9: issue moves stock into a REAL `IN-TRANSIT` store
 * (a registry resource of kind `store`, created lazily by `ensureTransitStore`), and receive moves
 * it out. A shortfall STAYS IN TRANSIT and the header goes to `discrepancy` — it is never silently
 * written down, and `material.discrepancy_flagged` fires in the same transaction (§11.10:
 * "discrepancies surface same-hour").
 *
 * Resolution — return to source, or write off — is 14c's variance machinery. In this phase a
 * discrepancy is VISIBLE and nothing hides it, which is the safe direction and the whole of what
 * A18 asserts.
 */
export const transfers = pgTable(
  "transfers",
  {
    id: text("id").primaryKey(),
    fromResourceId: text("from_resource_id").notNull().references(() => resources.id),
    toResourceId: text("to_resource_id").notNull().references(() => resources.id),
    status: text("status").notNull().default("in_transit"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    receivedBy: text("received_by"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [
    index("transfers_from_idx").on(t.fromResourceId, t.status),
    index("transfers_to_idx").on(t.toResourceId, t.status),
    check("transfers_status_ck", sql`${t.status} in ('in_transit', 'received', 'discrepancy')`),
  ],
);

/** One batch quantity on one transfer. `qty_received` is NULL until the other side signs. */
export const transferLines = pgTable(
  "transfer_lines",
  {
    id: text("id").primaryKey(),
    transferId: text("transfer_id").notNull().references(() => transfers.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    qtyIssued: integer("qty_issued").notNull(),
    qtyReceived: integer("qty_received"), // null = not yet received
    discrepancyReason: text("discrepancy_reason"),
  },
  (t) => [
    index("transfer_lines_transfer_idx").on(t.transferId),
    check("transfer_lines_qty_issued_ck", sql`${t.qtyIssued} > 0`),
  ],
);

// ═══════════════════════════ BUYING (PHARMACY PARITY P2) ═══════════════════════════

/**
 * PARITY P2 — THE LEVELS A STORE KEEPS AN ITEM AT. One row per item per store, in BASE units.
 *
 *   - `min_base`: the safety stock. Below it the item is short whatever the forecast says.
 *   - `reorder_base`: the reorder level. At or below it the reorder list suggests an order.
 *   - `max_base`: the order-up-to level. The suggestion is `max − (on hand + on order)`.
 *
 * A row, not three columns on `items`: the OPD counter and the main store keep one drug at
 * different levels. Written by whoever raises purchase orders (`materials.po.raise`).
 */
export const itemStockLevels = pgTable(
  "item_stock_levels",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => items.id),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    minBase: integer("min_base").notNull(),
    reorderBase: integer("reorder_base").notNull(),
    maxBase: integer("max_base").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("item_stock_levels_item_store_ux").on(t.itemId, t.storeResourceId),
    index("item_stock_levels_store_idx").on(t.storeResourceId),
    check("item_stock_levels_order_ck", sql`0 <= ${t.minBase} and ${t.minBase} <= ${t.reorderBase} and ${t.reorderBase} < ${t.maxBase}`),
  ],
);

/**
 * PARITY P2 — A PURCHASE ORDER: one vendor, one receiving store, many lines.
 *
 *   draft → pending_approval → approved → sent → part_received → received
 *                 └→ draft (rejected, with the reason)     draft/pending/approved/sent → cancelled
 *
 *   - `po_no` from `EPISODE_SERIES.purchase_order` (`PO2609240001`), the GRN's grammar.
 *   - `source`: `agent` when the counter agent drafted it from the reorder list and the short book,
 *     `manual` when a person started it. Either way nothing leaves a draft without a person.
 *   - `approval_id` / `approval_tier`: the `kernel/approvals` request filed at submit, and which of
 *     the two types it went to (`head` up to the configured limit, `owner` above it).
 *   - Totals are kept on the header in paise and recomputed on every write of the lines.
 *   - `approved_by` is who granted the approval. The GRN refuses them as its receiver
 *     (`po_approver_grn_receiver`).
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: text("id").primaryKey(),
    poNo: text("po_no").notNull(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    status: text("status").notNull(),
    source: text("source").notNull(),
    expectedDate: date("expected_date", { mode: "string" }),
    terms: text("terms"),
    note: text("note"),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull().default(0),
    gstPaise: bigint("gst_paise", { mode: "number" }).notNull().default(0),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    approvalId: text("approval_id"), // plain text, the `grns.approval_id` precedent
    approvalTier: text("approval_tier"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionNote: text("rejection_note"),
    sentBy: text("sent_by"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("purchase_orders_po_no_ux").on(t.poNo),
    index("purchase_orders_vendor_idx").on(t.vendorId, t.status),
    index("purchase_orders_status_idx").on(t.status, t.expectedDate),
    check("purchase_orders_status_ck", sql`${t.status} in ('draft', 'pending_approval', 'approved', 'sent', 'part_received', 'received', 'cancelled')`),
    check("purchase_orders_source_ck", sql`${t.source} in ('manual', 'agent')`),
    check("purchase_orders_tier_ck", sql`${t.approvalTier} is null or ${t.approvalTier} in ('head', 'owner')`),
    check("purchase_orders_totals_ck", sql`${t.subtotalPaise} >= 0 and ${t.gstPaise} >= 0 and ${t.totalPaise} = ${t.subtotalPaise} + ${t.gstPaise}`),
    check("purchase_orders_approved_ck", sql`(${t.approvedAt} is null) = (${t.approvedBy} is null) and (${t.status} not in ('approved', 'sent', 'part_received', 'received') or ${t.approvedBy} is not null)`),
    check("purchase_orders_cancelled_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.cancelledAt} is null) = (${t.cancelReason} is null)`),
  ],
);

/**
 * One line of a purchase order, in the PACK the vendor sells (`uom`, `multiplier` base units each,
 * copied from `item_uoms` when the line is written so a later change to the pack cannot move an
 * order already placed).
 *
 *   - `qty_packs` ordered and paid for; `free_packs` promised free (the scheme).
 *   - `rate_paise`: the PTR per pack before GST. `line_total_paise = qty_packs × rate_paise`.
 *   - `mrp_paise`: the MRP per pack the buyer expects printed; the GRN gate checks what arrives.
 *   - `received_base` / `free_received_base`: what posted GRNs accepted against this line, in base
 *     units. `received_base` may pass `qty_packs × multiplier` by the configured tolerance, no more.
 *   - One line per item per order.
 */
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: text("id").primaryKey(),
    purchaseOrderId: text("purchase_order_id").notNull().references(() => purchaseOrders.id),
    itemId: text("item_id").notNull().references(() => items.id),
    uom: text("uom").notNull(),
    multiplier: integer("multiplier").notNull(),
    qtyPacks: integer("qty_packs").notNull(),
    freePacks: integer("free_packs").notNull().default(0),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    lineTotalPaise: bigint("line_total_paise", { mode: "number" }).notNull(),
    receivedBase: integer("received_base").notNull().default(0),
    freeReceivedBase: integer("free_received_base").notNull().default(0),
  },
  (t) => [
    uniqueIndex("purchase_order_lines_item_ux").on(t.purchaseOrderId, t.itemId),
    check("purchase_order_lines_qty_ck", sql`${t.qtyPacks} > 0 and ${t.freePacks} >= 0 and ${t.multiplier} > 0`),
    check("purchase_order_lines_money_ck", sql`${t.ratePaise} >= 0 and ${t.gstRateBps} >= 0 and ${t.lineTotalPaise} = ${t.qtyPacks} * ${t.ratePaise}`),
    check("purchase_order_lines_received_ck", sql`${t.receivedBase} >= 0 and ${t.freeReceivedBase} >= 0`),
  ],
);

// ═══════════════════════════════════ THE GRN GATE ═══════════════════════════════════

/**
 * GOODS RECEIVED. Two-stage on purpose (DD8): `captured_by` records what came off the lorry so the
 * lorry can leave, `qc_by` records the verdict when the pharmacist arrives. **Capture and QC may be
 * the same user in this phase** — the SoD pairs S10 names are PO-approver/receiver and
 * custodian/counter, neither of which exists until 14b/14c, and inventing a third pair here would be
 * a rule nobody ruled.
 *
 * `grn_no` comes from `EPISODE_SERIES.grn` (T1, `series.ts`) rather than a private counter: one
 * daily-number grammar for the whole house is the reason that table exists.
 *
 * `po_ref` stays free text; parity P2 adds `purchase_order_id`, the real link, beside it.
 * `approval_id` carries no FK for the `vendor_bank_changes` reason.
 */
export const grns = pgTable(
  "grns",
  {
    id: text("id").primaryKey(),
    grnNo: text("grn_no").notNull(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    source: text("source").notNull(),
    poRef: text("po_ref"), // free text as the challan printed it; `purchase_order_id` is the link
    /** PARITY P2 — the order this delivery is received against, when there is one. */
    purchaseOrderId: text("purchase_order_id").references(() => purchaseOrders.id),
    challanNo: text("challan_no").notNull(),
    challanDate: date("challan_date", { mode: "string" }).notNull(),
    invoiceNo: text("invoice_no"),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    status: text("status").notNull().default("draft"),
    capturedBy: text("captured_by").notNull(),
    qcBy: text("qc_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    approvalId: text("approval_id"), // near-expiry acceptance — plain text, see `vendor_bank_changes`
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("grns_grn_no_ux").on(t.grnNo),
    index("grns_vendor_idx").on(t.vendorId, t.challanDate),
    index("grns_store_status_idx").on(t.storeResourceId, t.status),
    index("grns_purchase_order_idx").on(t.purchaseOrderId),
    check("grns_source_ck", sql`${t.source} in ('challan', 'consignment_challan', 'donation')`),
    check("grns_status_ck", sql`${t.status} in ('draft', 'gate_qc', 'accepted', 'partially_accepted', 'rejected', 'posted')`),
  ],
);

/**
 * ONE LINE OF ONE GRN, and the row DD7's conversion is captured on: `qty_in_uom` + `uom` is what the
 * storekeeper typed, `qty_base` is what the ledger will move, and `uom.ts` is the ONE place the
 * multiplier between them is applied.
 *
 * `unit_cost_paise` is PER BASE UNIT (landed cost per tablet, not per box). `mrp_paise` is per
 * `mrp_uom`, the pack the price is printed on. Rule 6 compares them, and it compares them ONLY after
 * `uom.ts` has put them in one unit — and the comparison is `<`, not `<=` (A15), so an MRP EQUAL to
 * cost passes and a free-goods line (cost 0) never trips it.
 *
 * `batch_id` is NULL until post: the batch row is found-or-created at `postGrn` (A14), so a GRN that
 * never posts leaves no batch behind.
 */
export const grnLines = pgTable(
  "grn_lines",
  {
    id: text("id").primaryKey(),
    grnId: text("grn_id").notNull().references(() => grns.id),
    itemId: text("item_id").notNull().references(() => items.id),
    uom: text("uom").notNull(),
    qtyInUom: integer("qty_in_uom").notNull(),
    qtyBase: integer("qty_base").notNull(),
    batchNo: text("batch_no"),
    mfgDate: date("mfg_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }),
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    mrpUom: text("mrp_uom"), // NEVER travels without the paise — see the file header
    unitCostPaise: bigint("unit_cost_paise", { mode: "number" }).notNull(), // PER BASE UNIT
    freeGoods: boolean("free_goods").notNull().default(false),
    qtyAcceptedBase: integer("qty_accepted_base").notNull().default(0),
    qtyRejectedBase: integer("qty_rejected_base").notNull().default(0),
    rejectReason: text("reject_reason"), // the RuleCode that fired — the screen renders its locale string
    nearExpiry: boolean("near_expiry").notNull().default(false),
    tempLogRef: text("temp_log_ref"), // cold-chain: the data-logger file for a 2-8 line
    batchId: text("batch_id").references(() => stockBatches.id), // null until post — see the header
  },
  (t) => [
    index("grn_lines_grn_idx").on(t.grnId),
    index("grn_lines_item_idx").on(t.itemId),
    check("grn_lines_qty_in_uom_ck", sql`${t.qtyInUom} > 0`),
    check("grn_lines_qty_base_ck", sql`${t.qtyBase} > 0`),
  ],
);

// ═══════════════════════════ PAYING (PHARMACY PARITY P3) ═══════════════════════════

/**
 * PARITY P3 — A SUPPLIER'S BILL (the purchase invoice), matched three ways: PO ↔ GRN ↔ bill.
 *
 *   draft ─match→ matched ─accept→ accepted ─pay→ part_paid ─pay→ paid
 *            └──→ held_for_match ─accept the difference (reason)→ accepted
 *   draft / matched / held_for_match / accepted (nothing paid or in a run) ─cancel→ cancelled
 *
 *   - `bill_no` is OURS, from `EPISODE_SERIES.supplier_bill` (`MSB…`) — the stable voucher number
 *     P5's Tally export carries. `vendor_bill_no` is the vendor's, as printed; `vendor_bill_key` is it
 *     upper-cased with spaces, `-` and `/` removed, and a live bill is unique per vendor, key and
 *     Indian financial year (`fy`, `2026-27`) — the duplicate the partial index refuses.
 *   - Money in paise. `total = taxable + cgst + sgst + igst + round_off`; an inter-state bill carries
 *     IGST only, an intra-state bill CGST + SGST only. `expected_total_paise` is what the GRN
 *     received at the PO's rate would have cost, GST included — the match's yardstick.
 *   - `acceptance_date` is the MSME clock's start (the day the goods were accepted: the earliest
 *     linked GRN's posting, IST); `due_date` is stamped at acceptance and never recomputed.
 *   - `paid_paise` is the sum of recorded payments against it (`supplier_payment_run_lines`).
 */
export const supplierBills = pgTable(
  "supplier_bills",
  {
    id: text("id").primaryKey(),
    billNo: text("bill_no").notNull(),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    vendorBillNo: text("vendor_bill_no").notNull(),
    vendorBillKey: text("vendor_bill_key").notNull(),
    billDate: date("bill_date", { mode: "string" }).notNull(),
    fy: text("fy").notNull(),
    purchaseOrderId: text("purchase_order_id").references(() => purchaseOrders.id),
    status: text("status").notNull(),
    interState: boolean("inter_state").notNull().default(false),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull().default(0),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull().default(0),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull().default(0),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull().default(0),
    roundOffPaise: integer("round_off_paise").notNull().default(0),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    expectedTotalPaise: bigint("expected_total_paise", { mode: "number" }).notNull().default(0),
    heldReason: text("held_reason"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    differenceAcceptedBy: text("difference_accepted_by"),
    differenceReason: text("difference_reason"),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptanceDate: date("acceptance_date", { mode: "string" }),
    msme: boolean("msme").notNull().default(false),
    termsDays: integer("terms_days"),
    dueDate: date("due_date", { mode: "string" }),
    paidPaise: bigint("paid_paise", { mode: "number" }).notNull().default(0),
    note: text("note"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("supplier_bills_bill_no_ux").on(t.billNo),
    uniqueIndex("supplier_bills_vendor_key_fy_ux").on(t.vendorId, t.vendorBillKey, t.fy).where(sql`${t.status} <> 'cancelled'`),
    index("supplier_bills_vendor_idx").on(t.vendorId, t.status),
    index("supplier_bills_status_due_idx").on(t.status, t.dueDate),
    check("supplier_bills_status_ck", sql`${t.status} in ('draft', 'matched', 'held_for_match', 'accepted', 'part_paid', 'paid', 'cancelled')`),
    check("supplier_bills_money_ck", sql`${t.taxablePaise} >= 0 and ${t.cgstPaise} >= 0 and ${t.sgstPaise} >= 0 and ${t.igstPaise} >= 0 and ${t.roundOffPaise} between -99 and 99 and ${t.totalPaise} = ${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} + ${t.roundOffPaise}`),
    check("supplier_bills_tax_kind_ck", sql`(${t.interState} and ${t.cgstPaise} = 0 and ${t.sgstPaise} = 0) or (not ${t.interState} and ${t.igstPaise} = 0)`),
    check("supplier_bills_paid_ck", sql`${t.paidPaise} >= 0 and ${t.paidPaise} <= ${t.totalPaise}`),
    check("supplier_bills_accepted_ck", sql`${t.status} not in ('accepted', 'part_paid', 'paid') or (${t.acceptedBy} is not null and ${t.dueDate} is not null)`),
    check("supplier_bills_difference_ck", sql`(${t.differenceAcceptedBy} is null) = (${t.differenceReason} is null)`),
    check("supplier_bills_cancelled_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.cancelledAt} is null) = (${t.cancelReason} is null)`),
  ],
);

/**
 * One line of a supplier's bill: one item from one GRN, in the pack the vendor billed.
 *
 *   - `qty_packs × rate_paise = taxable_paise`; GST at `gst_rate_bps`, half up per line, split into
 *     CGST + SGST (intra-state) or IGST (inter-state) as the header says.
 *   - `expected_base` is what that GRN ACCEPTED of the item (paid quantity, free goods apart);
 *     `expected_rate_paise` the PO line's rate per this pack (the GRN's cost when there is no PO);
 *     `expected_taxable_paise = expected_base / multiplier × expected rate`, and `expected_gst_rate_bps`
 *     the PO's (or the item's) rate.
 *   - `mismatch` lists why the line is outside the match, `null` when it is inside it.
 */
export const supplierBillLines = pgTable(
  "supplier_bill_lines",
  {
    id: text("id").primaryKey(),
    billId: text("bill_id").notNull().references(() => supplierBills.id),
    grnId: text("grn_id").notNull().references(() => grns.id),
    itemId: text("item_id").notNull().references(() => items.id),
    uom: text("uom").notNull(),
    multiplier: integer("multiplier").notNull(),
    qtyPacks: integer("qty_packs").notNull(),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull().default(0),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull().default(0),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull().default(0),
    expectedBase: integer("expected_base").notNull(),
    expectedRatePaise: bigint("expected_rate_paise", { mode: "number" }).notNull(),
    expectedTaxablePaise: bigint("expected_taxable_paise", { mode: "number" }).notNull(),
    expectedGstRateBps: integer("expected_gst_rate_bps").notNull(),
    mismatch: text("mismatch"),
  },
  (t) => [
    uniqueIndex("supplier_bill_lines_grn_item_ux").on(t.billId, t.grnId, t.itemId),
    index("supplier_bill_lines_grn_idx").on(t.grnId),
    check("supplier_bill_lines_qty_ck", sql`${t.qtyPacks} >= 0 and ${t.multiplier} > 0 and ${t.expectedBase} >= 0`),
    check("supplier_bill_lines_money_ck", sql`${t.ratePaise} >= 0 and ${t.gstRateBps} >= 0 and ${t.taxablePaise} = ${t.qtyPacks} * ${t.ratePaise}`),
  ],
);

/**
 * PARITY P3 — A PAYMENT RUN: the bills a person proposes to pay now, authorised by the owner.
 *
 *   draft ─submit→ pending_authorisation ─authorise→ authorised ─every vendor recorded→ completed
 *                        └─reject→ draft (with the reason)   draft/pending/authorised, nothing paid ─cancel→ cancelled
 *
 *   - `run_no` from `EPISODE_SERIES.payment_run` (`MPR…`). `created_by` is the PREPARER, and only the
 *     preparer submits it, so the kernel's requester ≠ approver is the preparer ≠ authoriser rule.
 *   - `approval_id`: the `materials_payment_run_approval` request (approver `owner`).
 *   - `authorised_by` may not record a payment on it (`payment_authoriser_recorder`).
 */
export const supplierPaymentRuns = pgTable(
  "supplier_payment_runs",
  {
    id: text("id").primaryKey(),
    runNo: text("run_no").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    note: text("note"),
    approvalId: text("approval_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    authorisedBy: text("authorised_by"),
    authorisedAt: timestamp("authorised_at", { withTimezone: true }),
    rejectionNote: text("rejection_note"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("supplier_payment_runs_run_no_ux").on(t.runNo),
    index("supplier_payment_runs_status_idx").on(t.status),
    check("supplier_payment_runs_status_ck", sql`${t.status} in ('draft', 'pending_authorisation', 'authorised', 'completed', 'cancelled')`),
    check("supplier_payment_runs_source_ck", sql`${t.source} in ('manual', 'agent')`),
    check("supplier_payment_runs_total_ck", sql`${t.totalPaise} >= 0`),
    check("supplier_payment_runs_authorised_ck", sql`(${t.authorisedAt} is null) = (${t.authorisedBy} is null) and (${t.status} not in ('authorised', 'completed') or ${t.authorisedBy} is not null)`),
    check("supplier_payment_runs_cancelled_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.cancelledAt} is null) = (${t.cancelReason} is null)`),
  ],
);

/**
 * A money voucher: one vendor paid on one run, by one mode, on one date (`payment_no` from
 * `EPISODE_SERIES.supplier_payment`, `MPV…`). A bank mode carries its reference (UTR, cheque no.);
 * cash never carries more than the §40A(3) limit per vendor per day — checked in the act, summed
 * over every cash payment to that vendor that day.
 */
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: text("id").primaryKey(),
    paymentNo: text("payment_no").notNull(),
    runId: text("run_id").notNull().references(() => supplierPaymentRuns.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    mode: text("mode").notNull(),
    reference: text("reference"),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("supplier_payments_payment_no_ux").on(t.paymentNo),
    uniqueIndex("supplier_payments_run_vendor_ux").on(t.runId, t.vendorId),
    index("supplier_payments_vendor_idx").on(t.vendorId, t.paidOn),
    check("supplier_payments_mode_ck", sql`${t.mode} in ('neft', 'rtgs', 'upi', 'cheque', 'cash')`),
    check("supplier_payments_reference_ck", sql`${t.mode} = 'cash' or ${t.reference} is not null`),
    check("supplier_payments_amount_ck", sql`${t.amountPaise} > 0`),
  ],
);

/**
 * One bill on a payment run: `pay_paise` now, `credit_paise` offset by the vendor's credit notes
 * (RESERVED for P4 — always 0 here; `Payable = Total − Credit`). `payment_id` is set when the
 * vendor's payment is recorded; until then the amount is RESERVED against the bill, so no two
 * open runs can pay the same rupee.
 */
export const supplierPaymentRunLines = pgTable(
  "supplier_payment_run_lines",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => supplierPaymentRuns.id),
    billId: text("bill_id").notNull().references(() => supplierBills.id),
    vendorId: text("vendor_id").notNull().references(() => vendors.id),
    payPaise: bigint("pay_paise", { mode: "number" }).notNull(),
    creditPaise: bigint("credit_paise", { mode: "number" }).notNull().default(0),
    paymentId: text("payment_id").references(() => supplierPayments.id),
  },
  (t) => [
    uniqueIndex("supplier_payment_run_lines_bill_ux").on(t.runId, t.billId),
    index("supplier_payment_run_lines_bill_idx").on(t.billId),
    check("supplier_payment_run_lines_money_ck", sql`${t.payPaise} > 0 and ${t.creditPaise} >= 0`),
  ],
);

// ═══════════════════════════════════ COUNTS (PLAN 14c, FIRST SLICE) ═══════════════════════════════════

/**
 * A BLIND STOCK COUNT OF ONE STORE. Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-counts.md`,
 * doc 09 §3.9.
 *
 *   - `counter_user_id` is chosen by the system from holders of `materials.counts.perform` who did not
 *     schedule the count and do not keep the store (S10's custodian / counter pair). The CHECK keeps
 *     the scheduler off the sheet whatever the code does.
 *   - `frozen_at` is the instant the system's figures were copied onto the lines. `counted_at` is the
 *     instant the sheet describes, which may be earlier than the submission (K8: a count on paper
 *     during an outage), and never earlier than the freeze.
 *   - `recount_of` links H7's automatic blind recount to the count whose lines it re-counts, and
 *     `recount_id` on the original points forward to it.
 *   - One count BEING COUNTED per store, by partial unique index: two sheets on one shelf at once is
 *     how a count goes wrong. A submitted count awaiting review does not block its own recount.
 *   - User ids are plain text, the `stock_ledger.actor_id` precedent.
 *   - No adjustment column: writing a variance off needs two keys, and runbook O1 is open.
 */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    status: text("status").notNull(),
    scheduledBy: text("scheduled_by").notNull(),
    counterUserId: text("counter_user_id").notNull(),
    recountOf: text("recount_of"),
    recountId: text("recount_id"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull(),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeNote: text("close_note"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_counts_resource_idx").on(t.resourceId, t.frozenAt),
    uniqueIndex("stock_counts_one_counting_uq").on(t.resourceId).where(sql`${t.status} = 'counting'`),
    check("stock_counts_status_ck", sql`${t.status} in ('counting', 'submitted', 'closed', 'cancelled')`),
    check("stock_counts_sod_ck", sql`${t.counterUserId} <> ${t.scheduledBy}`),
    check("stock_counts_counted_ck", sql`(${t.countedAt} is null) = (${t.submittedAt} is null) and (${t.countedAt} is null or ${t.countedAt} >= ${t.frozenAt})`),
    check("stock_counts_closed_ck", sql`(${t.status} = 'closed') = (${t.closedAt} is not null) and (${t.closedAt} is null) = (${t.closedBy} is null)`),
    check("stock_counts_cancelled_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.cancelledAt} is null) = (${t.cancelReason} is null)`),
  ],
);

/**
 * One batch on a count sheet. `system_qty` is `qty_on_hand` at the freeze; the counter never reads
 * it. At submission `moved_qty` is the ledger's net movement between the freeze and `counted_at`,
 * and `variance_qty = counted_qty − (system_qty + moved_qty)`. So a sale during the count is not
 * the counter's variance. `variance_paise` is the variance at the batch's landed cost per base unit.
 * `flag`: `match`, `variance`, or `recount` (H7's threshold).
 */
export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: text("id").primaryKey(),
    countId: text("count_id").notNull().references(() => stockCounts.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    itemId: text("item_id").notNull().references(() => items.id),
    systemQty: integer("system_qty").notNull(),
    countedQty: integer("counted_qty"),
    movedQty: integer("moved_qty"),
    varianceQty: integer("variance_qty"),
    variancePaise: bigint("variance_paise", { mode: "number" }),
    flag: text("flag"),
  },
  (t) => [
    uniqueIndex("stock_count_lines_batch_uq").on(t.countId, t.batchId),
    check("stock_count_lines_counted_ck", sql`${t.countedQty} is null or ${t.countedQty} >= 0`),
    check("stock_count_lines_flag_ck", sql`${t.flag} is null or ${t.flag} in ('match', 'variance', 'recount')`),
    check("stock_count_lines_settled_ck", sql`(${t.countedQty} is null) = (${t.flag} is null) and (${t.flag} is null) = (${t.varianceQty} is null)`),
  ],
);

/**
 * 14c, SECOND SLICE — A COUNT'S VARIANCE, WRITTEN OFF (OR ON) WITH A SECOND KEY.
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-adjustments.md`.
 *
 * One row per count line whose variance is to be booked. Rows requested together share one approval
 * (`materials_stock_adjustment`, decided by the medical superintendent), and nothing is posted until
 * it is granted. Posting writes one `adjust` ledger row per line (`ledger_entry_id`) and never
 * updates an earlier one. A count line is booked at most once; a refused request frees it.
 *   - `qty_delta`: the variance being booked: negative writes stock off, positive books found stock.
 *   - `value_paise`: that quantity at the batch's landed cost, for the approver and the report.
 *   - `reason_code`: `shrinkage` (unexplained loss), `damage`, `expiry`, `entry_error`, `found`.
 *   - `status`: `requested` → `posted`, or `refused` when the approval was rejected.
 */
export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    countId: text("count_id").notNull().references(() => stockCounts.id),
    countLineId: text("count_line_id").notNull().references(() => stockCountLines.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    itemId: text("item_id").notNull().references(() => items.id),
    qtyDelta: integer("qty_delta").notNull(),
    valuePaise: bigint("value_paise", { mode: "number" }).notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    approvalId: text("approval_id").notNull(),
    status: text("status").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    postedBy: text("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    ledgerEntryId: text("ledger_entry_id"),
  },
  (t) => [
    // A line is booked at most once; a refused request leaves it free to be asked again.
    uniqueIndex("stock_adjustments_line_live_uq").on(t.countLineId).where(sql`${t.status} <> 'refused'`),
    index("stock_adjustments_approval_idx").on(t.approvalId),
    check("stock_adjustments_qty_ck", sql`${t.qtyDelta} <> 0`),
    check("stock_adjustments_status_ck", sql`${t.status} in ('requested', 'posted', 'refused')`),
    check("stock_adjustments_reason_ck", sql`${t.reasonCode} in ('shrinkage', 'damage', 'expiry', 'entry_error', 'found')`),
    check("stock_adjustments_posted_ck", sql`(${t.status} = 'posted') = (${t.ledgerEntryId} is not null) and (${t.postedAt} is null) = (${t.postedBy} is null) and (${t.status} = 'posted') = (${t.postedAt} is not null)`),
    check("stock_adjustments_found_ck", sql`(${t.reasonCode} = 'found') = (${t.qtyDelta} > 0) or ${t.reasonCode} = 'entry_error'`),
  ],
);
