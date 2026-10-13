import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { patients } from "./patients";

/**
 * E4.2 (#734) — ROUNDS (spec SPEC-ipd-core §4.5A, §4.9 E). Three tables, in a file of their own so the parallel IPD
 * lanes (nursing, diet) do not collide in `ipd.ts`.
 *
 * `ipd_rounds` — one row per signed round: the S/O/A/P note, bedside or remote, its source, and — for a resident's or
 * intern's round — the consultant's co-sign. `visit_outcome` is what the charges seam answered for a consultant's
 * bedside round (`charged`, `repeat`, `not_chargeable`, `rate_missing`) or `remote` / `draft`: an internal column, never
 * sent to a doctor (decision 0058). Rows are never deleted.
 *
 * `ipd_orders` — the doctor's inpatient orders. A drug order is the eMAR's input (E4.3): the eMAR owns `verification`
 * after `pending` and stamps `issued_at` at the first issue. A lab or imaging order is placed by the ordering door
 * (decision 0067) and this row records it with the department's own order id. Status: `active` → `stopped` (any time;
 * after issue the return is owed, `return_owed`) or `cancelled` (before issue only, with a reason). The database refuses
 * an antibiotic without a stop time and a drug order without a medicine.
 *
 * `ipd_consults` — a cross-consult: another consultant asked to see the patient; one open ask per (admission,
 * consultant). It puts the patient on that consultant's rounds list; their visits bill `cross_visit` by the charges
 * seam's own rule (not the admitting or covering consultant).
 */
export const ipdRounds = pgTable(
  "ipd_rounds",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    authorId: text("author_id").notNull(),
    /** `consultant` = an active doctor-master row at signing; anyone else is a `resident` (interns too). */
    authorKind: text("author_kind").notNull(),
    mode: text("mode").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
    soap: jsonb("soap").$type<{ subjective?: string; objective?: string; assessment?: string; plan?: string }>().notNull(),
    source: text("source").notNull(),
    provenance: text("provenance").notNull(),
    status: text("status").notNull(),
    visitOutcome: text("visit_outcome").notNull(),
    cosignedBy: text("cosigned_by"),
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }),
    cosignNote: text("cosign_note"),
    /** The discharge declaration this round started (fit for discharge from the plan bar), if any. */
    dischargeId: text("discharge_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_rounds_admission_seen_idx").on(t.admissionId, t.seenAt),
    index("ipd_rounds_awaiting_idx").on(t.admissionId).where(sql`${t.status} = 'awaiting_cosign'`),
    check("ipd_rounds_author_kind_ck", sql`${t.authorKind} in ('consultant', 'resident')`),
    check("ipd_rounds_mode_ck", sql`${t.mode} in ('bedside', 'remote_review')`),
    check("ipd_rounds_source_ck", sql`${t.source} in ('typed', 'voice', 'copilot_draft')`),
    check("ipd_rounds_status_ck", sql`${t.status} in ('signed', 'awaiting_cosign')`),
    check("ipd_rounds_visit_ck", sql`${t.visitOutcome} in ('charged', 'repeat', 'not_chargeable', 'rate_missing', 'remote', 'draft')`),
    // A resident's round is a draft until co-signed; a consultant's is never one.
    check("ipd_rounds_draft_ck", sql`(${t.authorKind} = 'consultant' and ${t.status} = 'signed' and ${t.cosignedBy} is null) or (${t.authorKind} = 'resident' and ((${t.status} = 'awaiting_cosign' and ${t.cosignedBy} is null) or (${t.status} = 'signed' and ${t.cosignedBy} is not null)))`),
    check("ipd_rounds_cosign_ck", sql`(${t.cosignedBy} is null) = (${t.cosignedAt} is null)`),
  ],
);

export const ipdOrders = pgTable(
  "ipd_orders",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /** The pharmacist's verification (drug orders); null for lab and imaging. eMAR owns every move after `pending`. */
    verification: text("verification"),
    medicineId: text("medicine_id"),
    /** The medicine's display name at ordering (brand + strength), kept so the order reads the same tomorrow. */
    medicineName: text("medicine_name"),
    doseValue: doublePrecision("dose_value"),
    doseUnit: text("dose_unit"),
    route: text("route"),
    frequency: text("frequency"),
    startAt: timestamp("start_at", { withTimezone: true }),
    stopAt: timestamp("stop_at", { withTimezone: true }),
    durationDays: integer("duration_days"),
    antibiotic: boolean("antibiotic").notNull().default(false),
    prn: jsonb("prn").$type<{ minIntervalMinutes: number; max24h: number }>(),
    weightBasedPerKg: boolean("weight_based_per_kg").notNull().default(false),
    /** Lab / imaging: the tariff service ids ordered, the department and the kernel order it placed. */
    serviceIds: jsonb("service_ids").$type<string[]>(),
    department: text("department"),
    departmentOrderId: text("department_order_id"),
    indication: text("indication"),
    note: text("note"),
    orderedBy: text("ordered_by").notNull(),
    orderedByKind: text("ordered_by_kind").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    roundId: text("round_id").references(() => ipdRounds.id),
    provenance: text("provenance").notNull(),
    /** Stamped by the eMAR at the first issue: from then on a cancel is refused and a stop owes a return. */
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stoppedBy: text("stopped_by"),
    stopReason: text("stop_reason"),
    returnOwed: boolean("return_owed").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("ipd_orders_admission_idx").on(t.admissionId, t.status),
    index("ipd_orders_verification_idx").on(t.verification).where(sql`${t.status} = 'active'`),
    check("ipd_orders_kind_ck", sql`${t.kind} in ('drug', 'lab', 'imaging')`),
    check("ipd_orders_status_ck", sql`${t.status} in ('active', 'stopped', 'cancelled')`),
    check("ipd_orders_verification_ck", sql`${t.verification} is null or ${t.verification} in ('pending', 'verified', 'rejected', 'query')`),
    check("ipd_orders_by_kind_ck", sql`${t.orderedByKind} in ('consultant', 'resident')`),
    check("ipd_orders_drug_ck", sql`${t.kind} <> 'drug' or (${t.medicineId} is not null and ${t.route} is not null and ${t.frequency} is not null and ${t.startAt} is not null and ${t.verification} is not null)`),
    check("ipd_orders_duration_ck", sql`${t.kind} <> 'drug' or ${t.stopAt} is not null or ${t.durationDays} is not null`),
    // §4.5A: an antibiotic order always carries its stop date — a database fact, not only the intent's check.
    check("ipd_orders_antibiotic_stop_ck", sql`not ${t.antibiotic} or ${t.stopAt} is not null`),
    check("ipd_orders_tests_ck", sql`${t.kind} = 'drug' or (${t.serviceIds} is not null and ${t.department} = ${t.kind})`),
    check("ipd_orders_stopped_ck", sql`(${t.status} = 'stopped') = (${t.stoppedAt} is not null and ${t.stopReason} is not null)`),
    check("ipd_orders_cancelled_ck", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`),
    check("ipd_orders_cancel_before_issue_ck", sql`${t.status} <> 'cancelled' or ${t.issuedAt} is null`),
  ],
);

export const ipdConsults = pgTable(
  "ipd_consults",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    consultantId: text("consultant_id").notNull(),
    question: text("question").notNull(),
    urgency: text("urgency").notNull(),
    status: text("status").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeNote: text("close_note"),
  },
  (t) => [
    uniqueIndex("ipd_consults_open_ux").on(t.admissionId, t.consultantId).where(sql`${t.status} = 'open'`),
    index("ipd_consults_consultant_idx").on(t.consultantId).where(sql`${t.status} = 'open'`),
    check("ipd_consults_urgency_ck", sql`${t.urgency} in ('routine', 'urgent')`),
    check("ipd_consults_status_ck", sql`${t.status} in ('open', 'closed')`),
    check("ipd_consults_closed_ck", sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  ],
);
