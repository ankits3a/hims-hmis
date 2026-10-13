import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { resources } from "./resources";

/**
 * E4.4 DIET (#736, decision 0072) — the diet order to the kitchen's meal list (modules/diet; SPEC-ipd-companions §7).
 *
 * `diet_meal_rounds` — the four meal rounds' cut-off and serve times (IST minutes after midnight), seeded by the
 * migration; the dietician edits them. `diet_orders` — one LIVE order per admission (partial unique), every order kept
 * with its provenance. `diet_npo` — nil by mouth, per PATIENT (an OT booking may precede the admission), with an
 * optional end; `source_ref` makes the OT booking's NPO one row per case. `diet_meal_lists` — one list per ward, IST
 * day and meal, built at the cut-off; `diet_meal_lines` — one tray per admission on it, withdrawn (never deleted)
 * when NPO, a transfer or the end of the stay takes it off. `diet_consults` — the dietician's queue.
 *
 * The literal lists are retyped from `packages/contracts/src/diet.ts` because drizzle-kit loads this file without the
 * workspace packages; `modules/diet/diet.test.ts` holds them equal.
 */
export const DIET_CODE_VALUES = [
  "normal", "soft", "liquid_clear", "liquid_full", "diabetic", "renal", "cardiac", "high_protein", "ryles_feed",
  "paediatric", "npo",
] as const;
export const DIET_MEAL_VALUES = ["breakfast", "lunch", "evening", "dinner"] as const;
export const DIET_SOURCE_VALUES = ["doctor", "dietician", "nurse", "ot_booking", "system"] as const;
export const DIET_WITHDRAW_VALUES = ["npo", "transferred", "discharged", "deceased", "lama", "absconded", "transferred_out"] as const;
const list = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

export const dietMealRounds = pgTable(
  "diet_meal_rounds",
  {
    meal: text("meal").primaryKey(),
    cutoffMinute: integer("cutoff_minute").notNull(),
    serveMinute: integer("serve_minute").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("diet_meal_rounds_meal_ck", sql`${t.meal} in (${list(DIET_MEAL_VALUES)})`),
    check("diet_meal_rounds_times_ck", sql`${t.cutoffMinute} >= 0 and ${t.serveMinute} < 1440 and ${t.cutoffMinute} < ${t.serveMinute}`),
  ],
);

export const dietOrders = pgTable(
  "diet_orders",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull(),
    code: text("code").notNull(),
    preference: text("preference").notNull(),
    tubeVolumeMl: integer("tube_volume_ml"),
    tubeEveryHours: integer("tube_every_hours"),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    source: text("source").notNull(),
    orderedBy: text("ordered_by").notNull(),
  },
  (t) => [
    uniqueIndex("diet_orders_live_ux").on(t.admissionId).where(sql`${t.endedAt} is null`),
    index("diet_orders_admission_idx").on(t.admissionId, t.startedAt),
    check("diet_orders_code_ck", sql`${t.code} in (${list(DIET_CODE_VALUES)}) and ${t.code} <> 'npo'`),
    check("diet_orders_preference_ck", sql`${t.preference} in ('veg', 'non_veg', 'jain')`),
    check("diet_orders_source_ck", sql`${t.source} in (${list(DIET_SOURCE_VALUES)})`),
    check("diet_orders_tube_ck", sql`(${t.code} = 'ryles_feed') = (${t.tubeVolumeMl} is not null and ${t.tubeEveryHours} is not null)`),
  ],
);

export const dietNpo = pgTable(
  "diet_npo",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull(),
    admissionId: text("admission_id").references(() => ipdAdmissions.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    /** `ot-case:<id>` for an OT booking's NPO: one row per case. */
    sourceRef: text("source_ref"),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: text("lifted_by"),
    liftReason: text("lift_reason"),
  },
  (t) => [
    uniqueIndex("diet_npo_source_ref_ux").on(t.sourceRef).where(sql`${t.sourceRef} is not null`),
    index("diet_npo_patient_idx").on(t.patientId, t.startsAt),
    check("diet_npo_source_ck", sql`${t.source} in (${list(DIET_SOURCE_VALUES)})`),
    check("diet_npo_window_ck", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
  ],
);

export const dietMealLists = pgTable(
  "diet_meal_lists",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    meal: text("meal").notNull(),
    serviceDate: text("service_date").notNull(),
    serveAt: timestamp("serve_at", { withTimezone: true }).notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
    builtBy: text("built_by").notNull(),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    printedBy: text("printed_by"),
    /** The newest print (a reprint after a change); `printed_at` keeps the first. */
    lastPrintedAt: timestamp("last_printed_at", { withTimezone: true }),
    /** A line changed after the newest print: dispatch is refused until the kitchen reprints. */
    changedSincePrint: boolean("changed_since_print").notNull().default(false),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchedBy: text("dispatched_by"),
    deliveryTaskId: text("delivery_task_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("diet_meal_lists_ward_meal_ux").on(t.wardId, t.serviceDate, t.meal),
    index("diet_meal_lists_serve_idx").on(t.serveAt),
    check("diet_meal_lists_meal_ck", sql`${t.meal} in (${list(DIET_MEAL_VALUES)})`),
  ],
);

export const dietMealLines = pgTable(
  "diet_meal_lines",
  {
    id: text("id").primaryKey(),
    listId: text("list_id").notNull().references(() => dietMealLists.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull(),
    bedId: text("bed_id"),
    bedCode: text("bed_code"),
    code: text("code").notNull(),
    preference: text("preference").notNull(),
    tube: text("tube"),
    /** No live order at the build: the kitchen sends a normal tray and the sheet flags it. */
    defaulted: boolean("defaulted").notNull().default(false),
    /** Added after the list was built (late admission, transfer in, NPO lifted). */
    late: boolean("late").notNull().default(false),
    state: text("state").notNull(),
    withdrawnReason: text("withdrawn_reason"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    served: text("served"),
    servedAt: timestamp("served_at", { withTimezone: true }),
    servedBy: text("served_by"),
    /** Last change after the list was printed (the reprint highlights these). */
    changedAt: timestamp("changed_at", { withTimezone: true }),
    /** On the trolley the kitchen dispatched: the load's delivery task covers it. */
    onLoad: boolean("on_load").notNull().default(false),
    /** A tray added or changed after dispatch travels on its own task. */
    trayTaskId: text("tray_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("diet_meal_lines_list_admission_ux").on(t.listId, t.admissionId),
    index("diet_meal_lines_admission_idx").on(t.admissionId),
    check("diet_meal_lines_state_ck", sql`${t.state} in ('active', 'withdrawn')`),
    check("diet_meal_lines_withdrawn_ck", sql`(${t.state} = 'withdrawn') = (${t.withdrawnReason} is not null)`),
    check("diet_meal_lines_reason_ck", sql`${t.withdrawnReason} is null or ${t.withdrawnReason} in (${list(DIET_WITHDRAW_VALUES)})`),
    check("diet_meal_lines_served_ck", sql`${t.served} is null or ${t.served} in ('delivered', 'refused')`),
  ],
);

export const dietConsults = pgTable(
  "diet_consults",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull(),
    source: text("source").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("diet_consults_open_ux").on(t.admissionId).where(sql`${t.state} = 'open'`),
    index("diet_consults_state_idx").on(t.state, t.requestedAt),
    check("diet_consults_state_ck", sql`${t.state} in ('open', 'done', 'cancelled')`),
    check("diet_consults_source_ck", sql`${t.source} in (${list(DIET_SOURCE_VALUES)})`),
  ],
);
