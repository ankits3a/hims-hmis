import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * WM-2 (#983, decisions 0089 and 0091) — WARD SAFETY, STOCK AND QUALITY.
 *
 * - `ipd_risk_scores`: the daily Morse / Braden safety round (APPEND-ONLY by trigger); the admission assessment stays the
 *   first score.
 * - `ipd_care_plans` + `ipd_care_checks`: a fall or pressure care plan started by a score over the ward's threshold,
 *   ended (`ended_at`) by a score under it; each timed check is a row. The next check is due one interval after the
 *   later of the plan's start and the last check.
 * - `ipd_restraints` + `ipd_restraint_checks` + `ipd_restraint_alerts`: an episode is a doctor's order (status
 *   `ordered`), started by a nurse (`active`), ended or lapsed (24 h without a doctor's review). One alert row per
 *   missed 2-hourly check (unique per restraint and due instant).
 * - `ipd_lines` + `ipd_line_reviews`: catheter, central line, cannula — insertion, site, due removal, removal; one
 *   doctor's "still needed?" review per line per IST day.
 * - `ipd_crash_carts` + `ipd_crash_cart_checks`; `ipd_ward_incidents` (a recorded event the nursing superintendent sees).
 * - `ipd_narcotic_key_holds`: who holds the ward's narcotic keys (never an agency or student nurse).
 * - `ipd_ward_stores` + `ipd_ward_stock_par`: the ward's materials store, its supply store, par per item.
 * - `ipd_ward_stock_uses`: one row per ward-stock item recorded on a patient, with its outcome and whether it was charged.
 * - `ipd_safety_events`: falls, pressure injuries, medication errors and line infections; present-on-admission flagged.
 */

export const ipdRiskScores = pgTable(
  "ipd_risk_scores",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    morse: integer("morse").notNull(),
    braden: integer("braden").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull(),
    scoredBy: text("scored_by").notNull(),
  },
  (t) => [index("ipd_risk_scores_admission_idx").on(t.admissionId, t.scoredAt)],
);

export const ipdCarePlans = pgTable(
  "ipd_care_plans",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    kind: text("kind").notNull(),
    /** The score that started it (Morse for a fall plan, Braden for a pressure plan). */
    score: integer("score").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    startedBy: text("started_by").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
  },
  (t) => [
    // One live plan of a kind per admission.
    uniqueIndex("ipd_care_plans_live_ux").on(t.admissionId, t.kind).where(sql`${t.endedAt} is null`),
    check("ipd_care_plans_kind_ck", sql`${t.kind} in ('fall', 'pressure')`),
  ],
);

export const ipdCareChecks = pgTable(
  "ipd_care_checks",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => ipdCarePlans.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull(),
    doneBy: text("done_by").notNull(),
    /** The instant this check was due (so a late check is visible). */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    note: text("note"),
  },
  (t) => [index("ipd_care_checks_plan_idx").on(t.planId, t.doneAt)],
);

export const ipdRestraints = pgTable(
  "ipd_restraints",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    wardId: text("ward_id").references(() => resources.id),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    psychiatric: boolean("psychiatric").notNull().default(false),
    status: text("status").notNull(),
    orderedBy: text("ordered_by").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    /** The doctor's last sign (the order, then each review) + 24 h. */
    reviewDueAt: timestamp("review_due_at", { withTimezone: true }).notNull(),
    lastReviewedBy: text("last_reviewed_by"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    startedBy: text("started_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    lapsedAt: timestamp("lapsed_at", { withTimezone: true }),
    familyToldName: text("family_told_name"),
    familyToldRelation: text("family_told_relation"),
    familyToldAt: timestamp("family_told_at", { withTimezone: true }),
    familyToldBy: text("family_told_by"),
    nominatedRepresentative: boolean("nominated_representative").notNull().default(false),
  },
  (t) => [
    index("ipd_restraints_admission_idx").on(t.admissionId),
    index("ipd_restraints_ordered_idx").on(t.orderedAt),
    check("ipd_restraints_kind_ck", sql`${t.kind} in ('physical', 'chemical', 'seclusion')`),
    check("ipd_restraints_status_ck", sql`${t.status} in ('ordered', 'active', 'ended', 'lapsed')`),
    check("ipd_restraints_active_ck", sql`${t.status} <> 'active' or ${t.startedAt} is not null`),
    check("ipd_restraints_ordered_ck", sql`${t.status} <> 'ordered' or ${t.startedAt} is null`),
  ],
);

export const ipdRestraintChecks = pgTable(
  "ipd_restraint_checks",
  {
    id: text("id").primaryKey(),
    restraintId: text("restraint_id").notNull().references(() => ipdRestraints.id),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull(),
    doneBy: text("done_by").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    circulation: boolean("circulation").notNull(),
    skin: boolean("skin").notNull(),
    hydration: boolean("hydration").notNull(),
    toileting: boolean("toileting").notNull(),
    note: text("note"),
  },
  (t) => [index("ipd_restraint_checks_restraint_idx").on(t.restraintId, t.doneAt)],
);

/** One row per missed check (restraint, due instant): one alert, never twice. */
export const ipdRestraintAlerts = pgTable(
  "ipd_restraint_alerts",
  {
    id: text("id").primaryKey(),
    restraintId: text("restraint_id").notNull().references(() => ipdRestraints.id),
    kind: text("kind").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    notified: integer("notified").notNull().default(0),
  },
  (t) => [
    uniqueIndex("ipd_restraint_alerts_ux").on(t.restraintId, t.kind, t.dueAt),
    check("ipd_restraint_alerts_kind_ck", sql`${t.kind} in ('check_missed', 'lapsed')`),
  ],
);

export const ipdLines = pgTable(
  "ipd_lines",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The ward the patient was on at insertion: the line's days count there. */
    wardId: text("ward_id").references(() => resources.id),
    kind: text("kind").notNull(),
    site: text("site").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull(),
    insertedBy: text("inserted_by").notNull(),
    dueRemovalAt: timestamp("due_removal_at", { withTimezone: true }).notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: text("removed_by"),
    removedReason: text("removed_reason"),
  },
  (t) => [
    index("ipd_lines_admission_idx").on(t.admissionId),
    index("ipd_lines_ward_idx").on(t.wardId, t.insertedAt),
    check("ipd_lines_kind_ck", sql`${t.kind} in ('urinary_catheter', 'central_line', 'cannula')`),
    check("ipd_lines_removed_ck", sql`${t.removedAt} is null or ${t.removedAt} >= ${t.insertedAt}`),
  ],
);

export const ipdLineReviews = pgTable(
  "ipd_line_reviews",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => ipdLines.id),
    reviewDate: date("review_date", { mode: "string" }).notNull(),
    decision: text("decision").notNull(),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("ipd_line_reviews_ux").on(t.lineId, t.reviewDate),
    check("ipd_line_reviews_decision_ck", sql`${t.decision} in ('keep', 'remove')`),
  ],
);

export const ipdCrashCarts = pgTable(
  "ipd_crash_carts",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    code: text("code").notNull(),
    contents: jsonb("contents").$type<{ item: string; qty: number }[]>().notNull(),
    sealNo: text("seal_no").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_crash_carts_code_ux").on(t.wardId, t.code),
    check("ipd_crash_carts_status_ck", sql`${t.status} in ('ready', 'needs_restock')`),
  ],
);

export const ipdCrashCartChecks = pgTable(
  "ipd_crash_cart_checks",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id").notNull().references(() => ipdCrashCarts.id),
    kind: text("kind").notNull(),
    sealNo: text("seal_no"),
    previousSealNo: text("previous_seal_no"),
    recount: jsonb("recount").$type<{ item: string; qty: number }[]>(),
    shiftDate: date("shift_date", { mode: "string" }).notNull(),
    shift: text("shift").notNull(),
    byUser: text("by_user").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    note: text("note"),
  },
  (t) => [
    index("ipd_crash_cart_checks_cart_idx").on(t.cartId, t.at),
    check("ipd_crash_cart_checks_kind_ck", sql`${t.kind} in ('check', 'used')`),
  ],
);

export const ipdWardIncidents = pgTable(
  "ipd_ward_incidents",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    kind: text("kind").notNull(),
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
    text: text("text").notNull(),
    raisedBy: text("raised_by").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ipd_ward_incidents_ward_idx").on(t.wardId, t.raisedAt)],
);

export const ipdNarcoticKeyHolds = pgTable(
  "ipd_narcotic_key_holds",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    userId: text("user_id").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("ipd_narcotic_key_holds_live_ux").on(t.wardId).where(sql`${t.releasedAt} is null`)],
);

export const ipdWardStores = pgTable("ipd_ward_stores", {
  wardId: text("ward_id").primaryKey().references(() => resources.id),
  storeId: text("store_id").notNull().references(() => resources.id),
  supplyStoreId: text("supply_store_id").notNull().references(() => resources.id),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const ipdWardStockPar = pgTable(
  "ipd_ward_stock_par",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    itemId: text("item_id").notNull(),
    par: integer("par").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_ward_stock_par_ux").on(t.wardId, t.itemId),
    check("ipd_ward_stock_par_ck", sql`${t.par} >= 0`),
  ],
);

export const ipdWardStockUses = pgTable(
  "ipd_ward_stock_uses",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    wardId: text("ward_id").notNull().references(() => resources.id),
    itemId: text("item_id").notNull(),
    batchId: text("batch_id").notNull(),
    qty: integer("qty").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    staffError: boolean("staff_error").notNull().default(false),
    inPackage: boolean("in_package").notNull().default(false),
    waivedBy: text("waived_by"),
    waivedReason: text("waived_reason"),
    charged: boolean("charged").notNull(),
    /** Why not charged: refused, staff_error, waived, in_package, price_missing (a bill-desk exception). */
    notChargedWhy: text("not_charged_why"),
    recordedBy: text("recorded_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_ward_stock_uses_admission_idx").on(t.admissionId),
    check("ipd_ward_stock_uses_outcome_ck", sql`${t.outcome} in ('used', 'issued', 'wasted', 'refused')`),
    check("ipd_ward_stock_uses_qty_ck", sql`${t.qty} > 0`),
    check("ipd_ward_stock_uses_waste_ck", sql`${t.outcome} <> 'wasted' or ${t.reason} is not null`),
  ],
);

export const ipdSafetyEvents = pgTable(
  "ipd_safety_events",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    wardId: text("ward_id").references(() => resources.id),
    kind: text("kind").notNull(),
    presentOnAdmission: boolean("present_on_admission").notNull().default(false),
    lineId: text("line_id").references(() => ipdLines.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    note: text("note"),
  },
  (t) => [
    index("ipd_safety_events_ward_idx").on(t.wardId, t.occurredAt),
    check("ipd_safety_events_kind_ck", sql`${t.kind} in ('fall', 'pressure_injury', 'medication_error', 'line_infection')`),
    check("ipd_safety_events_line_ck", sql`(${t.kind} = 'line_infection') = (${t.lineId} is not null)`),
  ],
);
