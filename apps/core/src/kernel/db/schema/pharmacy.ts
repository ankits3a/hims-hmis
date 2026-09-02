import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
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
    dispenseLineId: text("dispense_line_id").notNull().references(() => pharmacyDispenseLines.id),
    dispensedAt: timestamp("dispensed_at", { withTimezone: true }).notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    patientName: text("patient_name").notNull(),
    patientAddress: text("patient_address"),
    prescriberName: text("prescriber_name").notNull(),
    prescriberRegNo: text("prescriber_reg_no"),
    drugName: text("drug_name").notNull(),
    medicineId: text("medicine_id").references(() => formularyMedicines.id),
    batchNo: text("batch_no").notNull(),
    qtyBase: integer("qty_base").notNull(),
    unit: text("unit").notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pharmacy_reg_h1_dispensed_idx").on(t.dispensedAt),
    check("pharmacy_reg_h1_qty_ck", sql`${t.qtyBase} > 0`),
  ],
);
