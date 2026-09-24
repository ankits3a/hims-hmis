import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { invoiceLines, invoices } from "./billing";
import { formularyMedicines } from "./formulary";
import { items, stockBatches, stockLedger, stockReservations } from "./materials";
import { opdEncounters, opdPrescriptions } from "./opd";
import { orderItems, orders } from "./orders";
import { patients } from "./patients";
import { resources } from "./resources";
import { services } from "./tariff";

/**
 * PLAN 16c T1 — THE OPD DISPENSE COUNTER'S FOUR TABLES.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * No `pharmacy_batches`, no stock, no movements. Plan 14 §4A.2 ruled ONE stock ledger, in
 * `materials`, and 16c keeps it: a dispense line carries `batch_id`, `reservation_id` and
 * `ledger_entry_id` as REFERENCES into that ledger and writes none of those tables itself. The
 * pick is a reservation the ledger holds, the hand-over is a `consume` row the ledger writes, and
 * the balance is the ledger's to compute. A pharmacy that kept its own copy of the balance would
 * be the exact silent-loss shape Plan 14's close review found and fixed.
 *
 * ═══ THE QUEUE ROW EXISTS BEFORE THE ORDER DOES (D10/D11) ═══
 *
 * A dispense is QUEUED by the `prescription.issued` consumer (or by the first scan of an Rx nobody
 * queued) before a pharmacist has claimed it, and the `medication` order — with its `P` number —
 * is placed AT THE VERIFY (D1 as executed: the counter places it, but only once every line's
 * service is settled by resolution, substitution or decline — T3). So `order_id` and
 * `dispense_no` are nullable, and `pharmacy_dispenses_claimed_has_order_ck` makes "verified
 * without an order" impossible rather than merely unlikely. One live dispense per `(prescription, version)`: the partial unique index
 * below is what makes two counters' concurrent claims collapse to one (T3 A1), and it excludes
 * `cancelled` so a cancelled dispense can be re-queued.
 *
 * ═══ THE H1 REGISTER IS APPEND-ONLY, IN THE DATABASE (R-4) ═══
 *
 * Rule 65(3) of the Drugs and Cosmetics Rules requires a register of every Schedule H1 supply —
 * patient, prescriber, drug, quantity — retained three years and produced to the inspector. It is
 * written at hand-over and never edited: migration `0056` carries a trigger that refuses UPDATE and
 * DELETE on the table outright (the `lab_results_immutable` shape), so there is no edit endpoint
 * and this is why there cannot be one.
 */

const CLOSED_STATUSES = ["queued", "claimed", "verified", "picked", "billed", "handed_over", "cancelled"] as const;
export type PharmacyDispenseStatus = (typeof CLOSED_STATUSES)[number];
export const PHARMACY_DISPENSE_STATUSES = CLOSED_STATUSES;

/**
 * DD3 — a drug item's bridge to the tariff service it is billed as. One row per saleable item;
 * `service_id` is unique because two items billing as one service would make the invoice line's
 * `service_name` a lie about what left the shelf. The service is created by `registerSaleItem`
 * through `tariff/index.ts` in the same transaction (category per S2, `regulated: false` — the
 * law arrives per batch as `capUnitPaise`).
 */
export const pharmacySaleItems = pgTable(
  "pharmacy_sale_items",
  {
    itemId: text("item_id").primaryKey().references(() => items.id),
    serviceId: text("service_id").notNull().references(() => services.id),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pharmacy_sale_items_service_ux").on(t.serviceId)],
);

export const pharmacyDispenses = pgTable(
  "pharmacy_dispenses",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /** The `P` number (EPISODE_SERIES `pharmacy_dispense`), minted with the order at the claim. */
    dispenseNo: text("dispense_no"),
    orderId: text("order_id").references(() => orders.id),
    prescriptionId: text("prescription_id").notNull().references(() => opdPrescriptions.id),
    prescriptionVersion: integer("prescription_version").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    /** The materials store the counter picks from — `PHARM-OPD` (config). A registry resource of kind `store`. */
    storeResourceId: text("store_resource_id").references(() => resources.id),
    status: text("status").notNull().default("queued"),
    /** D8 — the `pharmacy_dispense` definition's instance, started at the claim. Plain text, the `opd_encounters` precedent. */
    workflowInstanceId: text("workflow_instance_id"),
    /** Set when any line is Schedule H/H1: hand-over then needs `pharmacy.dispense.scheduled` (D7). */
    scheduled: boolean("scheduled").notNull().default(false),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    pickedBy: text("picked_by"),
    pickedAt: timestamp("picked_at", { withTimezone: true }),
    /**
     * ═══ FD-31 — THE PHARMACIST SAW THE SLIP (OWNER RULING 2026-09-12) ═══
     *
     * Owner: *"the pharmacist will cross confirm the prescription slip (either the photo capture of
     * prescription or physical prescription slip) before generating the medicine bill."*
     *
     * Set only on a dispense whose prescription was TRANSCRIBED (`opd_prescriptions.transcribed_by`
     * is not null). On a doctor-entered Rx there is nothing to cross-confirm — the prescriber
     * operated the keyboard — and demanding the ceremony there would train a pharmacist to click it
     * without looking, which is how a real control becomes a habit. `billDispense` refuses while it
     * is null on a transcribed one; the WINDOW is the bill, per the owner's sentence, not the claim.
     */
    slipConfirmedBy: text("slip_confirmed_by"),
    slipConfirmedAt: timestamp("slip_confirmed_at", { withTimezone: true }),
    invoiceId: text("invoice_id").references(() => invoices.id),
    billedAt: timestamp("billed_at", { withTimezone: true }),
    handedOverBy: text("handed_over_by"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    /** D7 — how the person at the window was confirmed for a scheduled hand-over: `token` | `phone_last4`. */
    identityConfirmedVia: text("identity_confirmed_via"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pharmacy_dispenses_no_ux").on(t.dispenseNo),
    uniqueIndex("pharmacy_dispenses_live_rx_ux")
      .on(t.prescriptionId, t.prescriptionVersion)
      .where(sql`${t.status} <> 'cancelled'`),
    index("pharmacy_dispenses_status_idx").on(t.status, t.createdAt),
    index("pharmacy_dispenses_patient_idx").on(t.patientId),
    index("pharmacy_dispenses_encounter_idx").on(t.encounterId),
    check("pharmacy_dispenses_status_ck", sql`${t.status} in ('queued', 'claimed', 'verified', 'picked', 'billed', 'handed_over', 'cancelled')`),
    check(
      "pharmacy_dispenses_claimed_has_order_ck",
      sql`${t.status} not in ('verified', 'picked', 'billed', 'handed_over') or (${t.orderId} is not null and ${t.dispenseNo} is not null and ${t.storeResourceId} is not null)`,
    ),
    check("pharmacy_dispenses_identity_ck", sql`${t.identityConfirmedVia} is null or ${t.identityConfirmedVia} in ('token', 'phone_last4')`),
  ],
);

export const pharmacyDispenseLines = pgTable(
  "pharmacy_dispense_lines",
  {
    id: text("id").primaryKey(),
    dispenseId: text("dispense_id").notNull().references(() => pharmacyDispenses.id),
    lineIdx: integer("line_idx").notNull(),
    /** The `RxLine` as the doctor issued it — the counter reads it, never rewrites it. */
    rxLine: jsonb("rx_line").notNull(),
    orderedMedicineId: text("ordered_medicine_id").references(() => formularyMedicines.id),
    dispensedMedicineId: text("dispensed_medicine_id").references(() => formularyMedicines.id),
    /** D6: `none` (as prescribed) | `resolved` (free text → one medicine) | `generic` (same salts, strength, route; consent). */
    substitutionType: text("substitution_type").notNull().default("none"),
    consentBy: text("consent_by"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    itemId: text("item_id").references(() => items.id),
    /** In the item's BASE unit (tablets, ml), never packs — `toBase`/`fromBase` are the only converters (Plan 14 DD7). */
    qtyBase: integer("qty_base"),
    batchId: text("batch_id").references(() => stockBatches.id),
    reservationId: text("reservation_id").references(() => stockReservations.id),
    ledgerEntryId: text("ledger_entry_id").references(() => stockLedger.id),
    /** T4 — the pharmacist took a later batch than FEFO offered; named, never silent (`dispense.picked` carries it too). */
    fefoOverride: boolean("fefo_override").notNull().default(false),
    /** T4 — why the quantity picked is less than verified (short stock) — a partial dispense's reason. */
    pickNote: text("pick_note"),
    orderItemId: text("order_item_id").references(() => orderItems.id),
    invoiceLineId: text("invoice_line_id").references(() => invoiceLines.id),
    unitPaise: bigint("unit_paise", { mode: "number" }),
    /** R-1: which bound won at the bill — `batch_mrp` | `ceiling` | `tariff`. Recorded on the line, not re-derived. */
    priceWinner: text("price_winner"),
    /** Mirrored from the dispensed medicine at verify so the gate reads one column: `H` | `H1` | `X` | `OTC` | null. */
    scheduleFlag: text("schedule_flag"),
    status: text("status").notNull().default("open"),
    declinedReason: text("declined_reason"),
    declinedBy: text("declined_by"),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pharmacy_dispense_lines_idx_ux").on(t.dispenseId, t.lineIdx),
    index("pharmacy_dispense_lines_batch_idx").on(t.batchId),
    check("pharmacy_dispense_lines_status_ck", sql`${t.status} in ('open', 'declined')`),
    check("pharmacy_dispense_lines_substitution_ck", sql`${t.substitutionType} in ('none', 'resolved', 'generic')`),
    check("pharmacy_dispense_lines_generic_consent_ck", sql`${t.substitutionType} <> 'generic' or ${t.consentBy} is not null`),
    check("pharmacy_dispense_lines_qty_ck", sql`${t.qtyBase} is null or ${t.qtyBase} > 0`),
    check("pharmacy_dispense_lines_winner_ck", sql`${t.priceWinner} is null or ${t.priceWinner} in ('batch_mrp', 'ceiling', 'tariff')`),
    check("pharmacy_dispense_lines_schedule_ck", sql`${t.scheduleFlag} is null or ${t.scheduleFlag} in ('H', 'H1', 'X', 'OTC')`),
    check("pharmacy_dispense_lines_declined_ck", sql`${t.status} <> 'declined' or ${t.declinedReason} is not null`),
  ],
);

/**
 * R-4 — the Schedule H1 register, Rule 65(3) fields, one row per H1 line handed over. Names and
 * addresses are COPIED at write time: the register must read the same in three years whatever the
 * patient record has since become (a merge, a correction, an alias), and the FK to the line is for
 * the auditor's join, not for the register's meaning.
 */
export const pharmacyRegH1 = pgTable(
  "pharmacy_reg_h1",
  {
    seq: bigserial("seq", { mode: "number" }).notNull(),
    id: text("id").primaryKey(),
    /** The counter's line, or (P19) null when `retail_line_id` names a walk-in sale's line. Exactly one is set. */
    dispenseLineId: text("dispense_line_id").references(() => pharmacyDispenseLines.id),
    retailLineId: text("retail_line_id").references(() => pharmacyRetailSaleLines.id),
    dispensedAt: timestamp("dispensed_at", { withTimezone: true }).notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    patientName: text("patient_name").notNull(),
    patientAddress: text("patient_address"),
    prescriberName: text("prescriber_name").notNull(),
    prescriberRegNo: text("prescriber_reg_no"),
    /**
     * PHARMACY P19 — Rule 65(3) asks for the prescriber's name AND ADDRESS. A walk-in's prescriber
     * practises elsewhere, so the address is copied from the prescription. Null on counter rows,
     * whose prescriber practises at this hospital.
     */
    prescriberAddress: text("prescriber_address"),
    drugName: text("drug_name").notNull(),
    medicineId: text("medicine_id").references(() => formularyMedicines.id),
    batchNo: text("batch_no").notNull(),
    qtyBase: integer("qty_base").notNull(),
    unit: text("unit").notNull(),
    recordedBy: text("recorded_by").notNull(),
    /**
     * PHARMACY P2 — the state council registration number of the pharmacist who handed the drug
     * over, as it stood at that moment. Null on rows written before the register existed.
     */
    pharmacistRegNo: text("pharmacist_reg_no"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pharmacy_reg_h1_dispensed_idx").on(t.dispensedAt),
    check("pharmacy_reg_h1_qty_ck", sql`${t.qtyBase} > 0`),
    check("pharmacy_reg_h1_one_source_ck", sql`(${t.dispenseLineId} is null) <> (${t.retailLineId} is null)`),
  ],
);

/**
 * PHARMACY P2 — THE REGISTER OF PHARMACISTS: WHO MAY DO WHAT THE PHARMACY ACT RESERVES.
 *
 * The Pharmacy Act 1948 §42 reserves dispensing to a registered pharmacist. A ROLE says what a
 * login may touch; it says nothing about whether the person holds a state pharmacy council
 * registration, and on this deployment `pharmacy` is also held by a login that is not a pharmacist.
 * This table is that fact. Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p2-pharmacist-register.md`.
 *
 * ═══ A ROW IS NEVER EDITED ═══
 *
 * A renewal ends the current row and records a new one, and a mistake is ended with a reason, so the
 * register shows its own history. `ended_*` are the only columns ever written after the insert, and
 * all three are written together or not at all.
 *
 * ═══ ONE CURRENT ROW PER PERSON, AND PER CERTIFICATE ═══
 *
 * Two partial unique indexes over the rows not yet ended: a person cannot hold two current
 * registrations here, and one council's number cannot be current on two people.
 */
export const pharmacyPharmacistRegistrations = pgTable(
  "pharmacy_pharmacist_registrations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    /** The state pharmacy council that issued it, as written on the certificate. */
    council: text("council").notNull(),
    registrationNo: text("registration_no").notNull(),
    /** Councils renew periodically; null for a registration with no end date on the certificate. */
    validUntil: date("valid_until", { mode: "string" }),
    recordedBy: text("recorded_by").notNull().references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by").references(() => users.id),
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("pharmacy_pharmacist_reg_current_user_ux").on(t.userId).where(sql`${t.endedAt} is null`),
    uniqueIndex("pharmacy_pharmacist_reg_current_no_ux")
      .using("btree", sql`lower(${t.council})`, sql`lower(${t.registrationNo})`)
      .where(sql`${t.endedAt} is null`),
    check("pharmacy_pharmacist_reg_ended_ck",
      sql`(${t.endedAt} is null) = (${t.endedBy} is null) and (${t.endedAt} is null) = (${t.endReason} is null)`),
    check("pharmacy_pharmacist_reg_not_self_ck", sql`${t.recordedBy} <> ${t.userId}`),
    check("pharmacy_pharmacist_reg_text_ck", sql`btrim(${t.council}) <> '' and btrim(${t.registrationNo}) <> ''`),
  ],
);

/**
 * ═══ PHARMACY P19 — WALK-IN RETAIL SALES ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`. A walk-in sale is
 * not a dispense: it has no visit and no prescriber in this hospital, so it places no order. It
 * shares the ledger, the price rule, billing and the H1 register with the counter.
 *
 * The licence (R-2): no sale to the public without a current Form 20/21 licence for the retail
 * store. A row is never edited; a renewal or a correction is a new row and the latest row is the
 * licence.
 */
export const pharmacyRetailLicences = pgTable(
  "pharmacy_retail_licences",
  {
    id: text("id").primaryKey(),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    /** Form 20: retail sale of drugs other than those in Schedules C, C1 and X. */
    form20No: text("form20_no").notNull(),
    /** Form 21: retail sale of drugs in Schedules C and C1, other than Schedule X. */
    form21No: text("form21_no").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }).notNull(),
    /** The registered pharmacist named on the licence, as printed. */
    pharmacistInCharge: text("pharmacist_in_charge").notNull(),
    note: text("note"),
    recordedBy: text("recorded_by").notNull().references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pharmacy_retail_licences_store_idx").on(t.storeResourceId, t.recordedAt),
    check("pharmacy_retail_licences_dates_ck", sql`${t.validTo} >= ${t.validFrom}`),
    check("pharmacy_retail_licences_text_ck",
      sql`btrim(${t.form20No}) <> '' and btrim(${t.form21No}) <> '' and btrim(${t.pharmacistInCharge}) <> ''`),
  ],
);

/**
 * One walk-in sale: sold, billed and handed over in one act. The outside prescription's fields are
 * present exactly when a line is Schedule H or H1 (`scheduled`).
 *
 * PHARMACY P20 — the same record holds a PAPER DISPENSE entered after an outage (`channel`
 * `downtime`): the medicine left on paper, at either counter, while the screens were dark, and it
 * can no longer be attached to an order. Its `sold_at` is the time written on the sheet, `sold_by`
 * is the pharmacist who handed it over, `entered_by` is who typed it in, and the kit sheet it was
 * written on is named, once. A walk-in sale needs the retail licence; an OPD counter sheet does not.
 */
export const pharmacyRetailSales = pgTable(
  "pharmacy_retail_sales",
  {
    id: text("id").primaryKey(),
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    /** `walk_in` (P19) or `downtime` (P20). */
    channel: text("channel").notNull().default("walk_in"),
    licenceId: text("licence_id").references(() => pharmacyRetailLicences.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The customer was registered by this sale. */
    registeredHere: boolean("registered_here").notNull().default(false),
    scheduled: boolean("scheduled").notNull(),
    rxPrescriberName: text("rx_prescriber_name"),
    rxPrescriberRegNo: text("rx_prescriber_reg_no"),
    rxPrescriberAddress: text("rx_prescriber_address"),
    rxDate: date("rx_date", { mode: "string" }),
    /** The photo, filed on the customer's record as `outside_prescription`. */
    rxDocumentId: text("rx_document_id"),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    /** The seller's council registration number when a scheduled line was sold (P2). */
    pharmacistRegNo: text("pharmacist_reg_no"),
    soldBy: text("sold_by").notNull().references(() => users.id),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    /** P20 — who entered the row; the seller for a walk-in sale. */
    enteredBy: text("entered_by").references(() => users.id),
    /** P20 — the downtime kit sheet (a `receipt` form) the paper dispense was written on. */
    downtimeKitId: text("downtime_kit_id"),
    downtimeSerial: integer("downtime_serial"),
    downtimeDesk: text("downtime_desk"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pharmacy_retail_sales_invoice_ux").on(t.invoiceId),
    uniqueIndex("pharmacy_retail_sales_sheet_ux").on(t.downtimeKitId, t.downtimeSerial).where(sql`${t.downtimeKitId} is not null`),
    check("pharmacy_retail_sales_channel_ck", sql`${t.channel} in ('walk_in', 'downtime')`),
    check("pharmacy_retail_sales_licence_ck", sql`${t.channel} <> 'walk_in' or ${t.licenceId} is not null`),
    check(
      "pharmacy_retail_sales_sheet_ck",
      sql`(${t.channel} = 'downtime') = (${t.downtimeKitId} is not null and ${t.downtimeSerial} is not null and ${t.downtimeDesk} is not null and ${t.enteredBy} is not null)`,
    ),
    index("pharmacy_retail_sales_sold_idx").on(t.soldAt),
    index("pharmacy_retail_sales_patient_idx").on(t.patientId),
    check(
      "pharmacy_retail_sales_rx_ck",
      sql`not ${t.scheduled} or (${t.rxPrescriberName} is not null and ${t.rxPrescriberRegNo} is not null and ${t.rxPrescriberAddress} is not null and ${t.rxDate} is not null and ${t.rxDocumentId} is not null and ${t.pharmacistRegNo} is not null)`,
    ),
  ],
);

export const pharmacyRetailSaleLines = pgTable(
  "pharmacy_retail_sale_lines",
  {
    id: text("id").primaryKey(),
    saleId: text("sale_id").notNull().references(() => pharmacyRetailSales.id),
    lineIdx: integer("line_idx").notNull(),
    medicineId: text("medicine_id").notNull().references(() => formularyMedicines.id),
    itemId: text("item_id").notNull().references(() => items.id),
    batchId: text("batch_id").notNull().references(() => stockBatches.id),
    qtyBase: integer("qty_base").notNull(),
    ledgerEntryId: text("ledger_entry_id").notNull().references(() => stockLedger.id),
    invoiceLineId: text("invoice_line_id").notNull().references(() => invoiceLines.id),
    unitPaise: bigint("unit_paise", { mode: "number" }).notNull(),
    priceWinner: text("price_winner").notNull(),
    scheduleFlag: text("schedule_flag"),
    fefoOverride: boolean("fefo_override").notNull().default(false),
  },
  (t) => [
    uniqueIndex("pharmacy_retail_sale_lines_idx_ux").on(t.saleId, t.lineIdx),
    index("pharmacy_retail_sale_lines_batch_idx").on(t.batchId),
    check("pharmacy_retail_sale_lines_qty_ck", sql`${t.qtyBase} > 0`),
    check("pharmacy_retail_sale_lines_winner_ck", sql`${t.priceWinner} in ('batch_mrp', 'ceiling', 'tariff')`),
    check("pharmacy_retail_sale_lines_schedule_ck", sql`${t.scheduleFlag} is null or ${t.scheduleFlag} in ('H', 'H1', 'OTC')`),
  ],
);

/**
 * ═══ PD-D18 — WHERE THE DRUG IS, PER COUNTER'S STORE ═══
 *
 * The pharmacist's slowest act is the walk to the shelf, and nothing recorded where to walk: `items`
 * has no bin, and a bin is not an item's fact anyway — the same strip sits on rack 3 at the OPD
 * counter and in a drawer at the retail one. So it is keyed by (store, item), set by whoever manages
 * the counter's items (`pharmacy.sale_items.manage`), and printed on the line beside the batch.
 *
 * A LABEL, not a structure: "R-12", "rack 3 · shelf 2", "fridge". A counter that later wants aisles
 * and bays can parse its own labels; a schema that guessed the hierarchy would be wrong for most.
 * Clearing a location deletes the row — "unknown" is the absence of a row, never an empty string.
 */
export const pharmacyShelfLocations = pgTable(
  "pharmacy_shelf_locations",
  {
    id: text("id").primaryKey(), // ULID via newId()
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    itemId: text("item_id").notNull().references(() => items.id),
    location: text("location").notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pharmacy_shelf_locations_store_item_ux").on(t.storeResourceId, t.itemId),
    check("pharmacy_shelf_locations_label_ck", sql`length(btrim(${t.location})) between 1 and 24 and ${t.location} = btrim(${t.location})`),
  ],
);

/**
 * ═══ PD-9 — THE PRESCRIBER AUTHORISES WHAT THE CHECK WOULD REFUSE (owner ruling 2026-09-19) ═══
 *
 * "The doctor must authorise dispensing against a recorded allergy." The check refuses a line the
 * four books stop and no prescriber override covers (an allergy recorded after the issue is the
 * common case). The counter used to be able only to send the patient back. Now the pharmacist ASKS
 * the prescribing doctor — by name, not a role — and the doctor authorises or declines with a reason;
 * an authorisation clears exactly that refusal on exactly that line, and nothing else.
 *
 * Addressed to a PERSON (`prescriber_user_id`), because the ruling is "the doctor", not "a doctor":
 * the generic approvals engine routes to a role, which would let any doctor decide. The hit is named
 * by `book` + `about` (the allergy's substance, the pair, the moiety, the ruling) — so a substitute
 * or a reading carrying the same substance on the same line is covered, and a different one is not.
 * `decided_by <> requested_by` is the lab's `same_actor` rule, held by the database.
 */
export const pharmacyAuthorisations = pgTable(
  "pharmacy_authorisations",
  {
    id: text("id").primaryKey(), // ULID via newId()
    dispenseId: text("dispense_id").notNull().references(() => pharmacyDispenses.id),
    lineIdx: integer("line_idx").notNull(),
    book: text("book").notNull(),
    about: text("about").notNull(),
    prescriberUserId: text("prescriber_user_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    requestNote: text("request_note"),
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
  },
  (t) => [
    index("pharmacy_authorisations_prescriber_idx").on(t.prescriberUserId, t.status),
    uniqueIndex("pharmacy_authorisations_one_open_ux").on(t.dispenseId, t.lineIdx, t.book, t.about).where(sql`${t.status} = 'pending'`),
    check("pharmacy_authorisations_book_ck", sql`${t.book} in ('allergy', 'interaction', 'duplicate', 'drug_disease')`),
    check("pharmacy_authorisations_status_ck", sql`${t.status} in ('pending', 'authorised', 'declined')`),
    check("pharmacy_authorisations_decided_ck", sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null and ${t.decisionReason} is null)`),
    check("pharmacy_authorisations_reason_ck", sql`${t.decisionReason} is null or length(btrim(${t.decisionReason})) >= 3`),
    check("pharmacy_authorisations_same_actor_ck", sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

/**
 * ═══ PHARMACY P1 — THE SHORT BOOK: "OUT OF X", SAID AT THE COUNTER AND KEPT ═══
 *
 * The approved parity plan (2026-09-24, P1): a pharmacist who turns a patient away for want of a
 * drug says so in one key (`N`), or the counter agent drafts it from "Pan 40 khatam", and the line
 * lands here with who and when. `/pharmacy/reorder` reads the open rows first; P2's purchase-order
 * draft will read them too. A row is an OBSERVATION, not a stock figure: stock stays in materials.
 *
 * `item_id` when the drug is one the counter knows, else only the name as said — a drug the
 * hospital has never stocked is exactly what a short book is for. One OPEN row per drug per store
 * (by item, or by the lower-cased name when there is no item): a second pharmacist noting the same
 * shortage is told it is already noted, rather than doubling the reorder list.
 *
 * Resolved once, with how: `ordered`, `received`, or `dismissed`. The resolved columns move together.
 */
export const pharmacyShortBook = pgTable(
  "pharmacy_short_book",
  {
    id: text("id").primaryKey(), // ULID via newId()
    storeResourceId: text("store_resource_id").notNull().references(() => resources.id),
    itemId: text("item_id").references(() => items.id),
    drugName: text("drug_name").notNull(),
    qtyWanted: integer("qty_wanted"),
    source: text("source").notNull(),
    /** The ticket the shortage was met on, when it was met on one. */
    dispenseId: text("dispense_id").references(() => pharmacyDispenses.id),
    notedBy: text("noted_by").notNull(),
    notedAt: timestamp("noted_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
  },
  (t) => [
    index("pharmacy_short_book_open_idx").on(t.storeResourceId, t.resolvedAt),
    uniqueIndex("pharmacy_short_book_open_item_ux").on(t.storeResourceId, t.itemId).where(sql`${t.resolvedAt} is null and ${t.itemId} is not null`),
    uniqueIndex("pharmacy_short_book_open_name_ux").on(t.storeResourceId, sql`lower(${t.drugName})`).where(sql`${t.resolvedAt} is null and ${t.itemId} is null`),
    check("pharmacy_short_book_name_ck", sql`length(btrim(${t.drugName})) between 2 and 120`),
    check("pharmacy_short_book_qty_ck", sql`${t.qtyWanted} is null or ${t.qtyWanted} > 0`),
    check("pharmacy_short_book_source_ck", sql`${t.source} in ('desk', 'agent', 'reorder')`),
    check("pharmacy_short_book_resolution_ck", sql`${t.resolution} is null or ${t.resolution} in ('ordered', 'received', 'dismissed')`),
    check("pharmacy_short_book_resolved_ck", sql`(${t.resolvedAt} is null) = (${t.resolvedBy} is null) and (${t.resolvedAt} is null) = (${t.resolution} is null)`),
  ],
);
