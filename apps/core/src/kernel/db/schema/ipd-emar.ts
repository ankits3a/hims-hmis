import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { ipdOrders } from "./ipd-rounds";
import { patients } from "./patients";

/**
 * E4.3 (#735) — THE eMAR (spec SPEC-ipd-core §4.6). A file of its own so the parallel IPD lanes do not collide.
 *
 * APPEND-ONLY by trigger (`ipd_emar_forbid_mutation`, migration `ipd_emar`): `ipd_emar_verifications`, `ipd_emar_issues`,
 * `ipd_emar_labels`, `ipd_emar_returns`, `ipd_emar_acts`, `ipd_emar_infusion_events`, `ipd_emar_narcotic_register`. A
 * wrong record is corrected by a NEW act (`entered_in_error` / `medication_incident`) naming it — never deleted.
 *
 * MUTABLE PROJECTIONS (each move is also an act row): `ipd_emar_doses` (the slot's status, locked FOR UPDATE by every act
 * on it — the lock is what makes two nurses giving one dose record exactly one; `(dose_id, slot_seq)` unique is the
 * backstop), `ipd_emar_verbal_orders` (the signature), `ipd_emar_second_checks` (spent once), `ipd_emar_allergy_flags`
 * (resolved once). No money column anywhere (decision 0058): an issue and a return count units.
 */

export const ipdEmarVerifications = pgTable(
  "ipd_emar_verifications",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    decision: text("decision").notNull(),
    /** The pharmacist's four ticks. */
    checks: jsonb("checks").$type<Record<string, boolean>>().notNull(),
    /** What the server's checks found, as shown. */
    findings: jsonb("findings").$type<{ check: string; severity: string; words: string }[]>().notNull(),
    note: text("note"),
    verifiedBy: text("verified_by").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_emar_verifications_order_idx").on(t.orderId),
    check("ipd_emar_verifications_decision_ck", sql`${t.decision} in ('verified', 'rejected', 'query')`),
  ],
);

export const ipdEmarIssues = pgTable(
  "ipd_emar_issues",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The materials item and batch the stock left (null for the patient's own medicine). */
    itemId: text("item_id"),
    storeId: text("store_id"),
    /** Every batch the issue took, FEFO: `[{ batchId, qty, ledgerEntryId }]`. */
    batches: jsonb("batches").$type<{ batchId: string; qty: number; ledgerEntryId: string }[]>().notNull(),
    units: integer("units").notNull(),
    stripSize: integer("strip_size").notNull(),
    ownMedicine: boolean("own_medicine").notNull(),
    ownBatchNo: text("own_batch_no"),
    ownExpiry: text("own_expiry"),
    printerId: text("printer_id"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_emar_issues_order_idx").on(t.orderId),
    index("ipd_emar_issues_admission_idx").on(t.admissionId),
    check("ipd_emar_issues_units_ck", sql`${t.units} > 0 and ${t.stripSize} > 0`),
    check("ipd_emar_issues_own_ck", sql`not ${t.ownMedicine} or (${t.ownBatchNo} is not null and ${t.ownExpiry} is not null and ${t.itemId} is null)`),
  ],
);

export const ipdEmarLabels = pgTable(
  "ipd_emar_labels",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => ipdEmarIssues.id),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    /** What the QR / barcode carries: `EML-<id>`. */
    code: text("code").notNull(),
    seq: integer("seq").notNull(),
    units: integer("units").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_emar_labels_code_ux").on(t.code),
    index("ipd_emar_labels_issue_idx").on(t.issueId),
  ],
);

export const ipdEmarReturns = pgTable(
  "ipd_emar_returns",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => ipdEmarIssues.id),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    units: integer("units").notNull(),
    /** Units taken off what the patient owes for (own medicine: 0 — it was never charged). */
    creditedUnits: integer("credited_units").notNull(),
    reason: text("reason").notNull(),
    batches: jsonb("batches").$type<{ batchId: string; qty: number; ledgerEntryId: string }[]>().notNull(),
    returnedBy: text("returned_by").notNull(),
    returnedAt: timestamp("returned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_emar_returns_issue_idx").on(t.issueId),
    check("ipd_emar_returns_units_ck", sql`${t.units} > 0 and ${t.creditedUnits} >= 0 and ${t.creditedUnits} <= ${t.units}`),
  ],
);

export const ipdEmarDoses = pgTable(
  "ipd_emar_doses",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    windowMinutes: integer("window_minutes").notNull(),
    prn: boolean("prn").notNull().default(false),
    status: text("status").notNull(),
    /** Held for NPO / off the ward: offered again on return (`reoffered_at` opens a new window). */
    reoffer: boolean("reoffer").notNull().default(false),
    reofferedAt: timestamp("reoffered_at", { withTimezone: true }),
    /** Bumped by every outcome act; `(dose_id, slot_seq)` on the acts is unique. */
    slotSeq: integer("slot_seq").notNull().default(0),
    lastActId: text("last_act_id"),
    missAlertedAt: timestamp("miss_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_emar_doses_slot_ux").on(t.orderId, t.dueAt),
    index("ipd_emar_doses_admission_idx").on(t.admissionId, t.dueAt),
    index("ipd_emar_doses_open_idx").on(t.dueAt).where(sql`${t.status} = 'scheduled'`),
    check("ipd_emar_doses_status_ck", sql`${t.status} in ('scheduled', 'given', 'held', 'missed', 'refused', 'cancelled')`),
    check("ipd_emar_doses_window_ck", sql`${t.windowMinutes} > 0`),
  ],
);

export const ipdEmarActs = pgTable(
  "ipd_emar_acts",
  {
    id: text("id").primaryKey(),
    doseId: text("dose_id").notNull().references(() => ipdEmarDoses.id),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    kind: text("kind").notNull(),
    /** The slot's sequence number this outcome took (null on a correction). */
    slotSeq: integer("slot_seq"),
    /** The clinical time (given at, held at); `recorded_at` is the server's. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    actorId: text("actor_id").notNull(),
    provenance: text("provenance").notNull(),
    reason: text("reason"),
    note: text("note"),
    patientCheck: text("patient_check"),
    overrideReason: text("override_reason"),
    wristbandCode: text("wristband_code"),
    labelId: text("label_id"),
    secondNurseId: text("second_nurse_id"),
    weightKg: doublePrecision("weight_kg"),
    late: boolean("late").notNull().default(false),
    lasaConfirmed: boolean("lasa_confirmed").notNull().default(false),
    /** A correction names the act it corrects; one correction per act. */
    correctsActId: text("corrects_act_id"),
    incidentId: text("incident_id"),
    wardId: text("ward_id"),
  },
  (t) => [
    uniqueIndex("ipd_emar_acts_slot_ux").on(t.doseId, t.slotSeq).where(sql`${t.slotSeq} is not null`),
    uniqueIndex("ipd_emar_acts_correction_ux").on(t.correctsActId).where(sql`${t.correctsActId} is not null`),
    index("ipd_emar_acts_order_idx").on(t.orderId, t.at),
    index("ipd_emar_acts_admission_idx").on(t.admissionId, t.at),
    check("ipd_emar_acts_kind_ck", sql`${t.kind} in ('given', 'held', 'missed', 'refused', 'reoffered', 'cancelled', 'entered_in_error', 'medication_incident')`),
    check("ipd_emar_acts_given_ck", sql`${t.kind} <> 'given' or (${t.patientCheck} in ('scan', 'override') and ${t.labelId} is not null)`),
    check("ipd_emar_acts_override_ck", sql`coalesce(${t.patientCheck}, '') <> 'override' or (${t.overrideReason} is not null and ${t.note} is not null)`),
    check("ipd_emar_acts_correction_ck", sql`(${t.kind} in ('entered_in_error', 'medication_incident')) = (${t.correctsActId} is not null)`),
  ],
);

export const ipdEmarInfusionEvents = pgTable(
  "ipd_emar_infusion_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    event: text("event").notNull(),
    rateMlPerHour: doublePrecision("rate_ml_per_hour"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    actorId: text("actor_id").notNull(),
    secondNurseId: text("second_nurse_id"),
  },
  (t) => [
    index("ipd_emar_infusion_order_idx").on(t.orderId, t.at),
    check("ipd_emar_infusion_event_ck", sql`${t.event} in ('start', 'rate_change', 'pause', 'resume', 'stop')`),
  ],
);

export const ipdEmarNarcoticRegister = pgTable(
  "ipd_emar_narcotic_register",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    qty: doublePrecision("qty").notNull(),
    unit: text("unit").notNull(),
    issueId: text("issue_id"),
    actId: text("act_id"),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
    witnessId: text("witness_id"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_emar_narcotic_order_idx").on(t.orderId, t.at),
    check("ipd_emar_narcotic_kind_ck", sql`${t.kind} in ('received', 'given', 'wasted', 'returned')`),
    // A wastage is always witnessed by somebody else (§4.6).
    check("ipd_emar_narcotic_witness_ck", sql`${t.kind} <> 'wasted' or (${t.witnessId} is not null and ${t.witnessId} <> ${t.actorId})`),
  ],
);

export const ipdEmarVerbalOrders = pgTable(
  "ipd_emar_verbal_orders",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    recordedBy: text("recorded_by").notNull(),
    fromDoctorId: text("from_doctor_id").notNull(),
    readBack: boolean("read_back").notNull(),
    emergency: text("emergency").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    signBy: timestamp("sign_by", { withTimezone: true }).notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedBy: text("signed_by"),
    nudgedAt: timestamp("nudged_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_emar_verbal_order_ux").on(t.orderId),
    check("ipd_emar_verbal_read_back_ck", sql`${t.readBack}`),
  ],
);

export const ipdEmarSecondChecks = pgTable(
  "ipd_emar_second_checks",
  {
    id: text("id").primaryKey(),
    /** The second nurse (who typed their PIN) and the nurse the proof is for. */
    checkerId: text("checker_id").notNull(),
    forUserId: text("for_user_id").notNull(),
    purpose: text("purpose").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [check("ipd_emar_second_checks_self_ck", sql`${t.checkerId} <> ${t.forUserId}`)],
);

export const ipdEmarAllergyFlags = pgTable(
  "ipd_emar_allergy_flags",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ipdOrders.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    allergyId: text("allergy_id").notNull(),
    substances: jsonb("substances").$type<string[]>().notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    uniqueIndex("ipd_emar_allergy_flags_ux").on(t.orderId, t.allergyId),
    index("ipd_emar_allergy_flags_open_idx").on(t.admissionId).where(sql`${t.resolvedAt} is null`),
  ],
);
