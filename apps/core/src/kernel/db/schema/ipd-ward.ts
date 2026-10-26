import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * WM-1 (#982, decision 0089) — THE WARD'S NURSES. One shift map per (ward, IST date, nursing shift): its staff and the
 * bed-to-nurse assignment rows, an acuity record per patient per shift, and one ratio-breach row per ward and shift.
 *
 * - `ipd_ward_shift_maps`: draft → published (by the in-charge) or carried_over (by the sweep at shift start, copied
 *   from the previous map). A late publish is allowed and marked late.
 * - `ipd_ward_shift_staff`: who is on the map (registered nurse, student paired with a nurse, in-charge, float nurse
 *   from her home ward) and when she ended her duty.
 * - `ipd_nurse_assignments`: the live row of a (map, bed) has `valid_to` null — at most one (partial unique index). A
 *   change closes the live row and adds a new one with its reason and who made it; a draft's rows are replaced whole.
 * - `ipd_patient_acuity`: APPEND-ONLY (trigger); the newest row of an admission's shift is its acuity.
 * - `ipd_ward_ratio_breaches`: at most one per (ward, date, shift) — one event and one supervisor notice per shift.
 */
export const ipdWardShiftMaps = pgTable(
  "ipd_ward_shift_maps",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    shiftDate: date("shift_date", { mode: "string" }).notNull(),
    shift: text("shift").notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Published after the deadline (30 minutes before the shift). */
    late: boolean("late").notNull().default(false),
    /** The map a carried-over (or copied) map came from. */
    carriedFromId: text("carried_from_id"),
    /** When the supervisor was told of the carry-over. */
    supervisorToldAt: timestamp("supervisor_told_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_ward_shift_maps_ux").on(t.wardId, t.shiftDate, t.shift),
    index("ipd_ward_shift_maps_date_idx").on(t.shiftDate, t.shift),
    check("ipd_ward_shift_maps_shift_ck", sql`${t.shift} in ('morning', 'evening', 'night')`),
    check("ipd_ward_shift_maps_status_ck", sql`${t.status} in ('draft', 'published', 'carried_over')`),
    check("ipd_ward_shift_maps_published_ck", sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`),
  ],
);

export const ipdWardShiftStaff = pgTable(
  "ipd_ward_shift_staff",
  {
    id: text("id").primaryKey(),
    mapId: text("map_id").notNull().references(() => ipdWardShiftMaps.id),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    /** A student's registered nurse. */
    pairedWithId: text("paired_with_id"),
    /** A float nurse's own ward, and why she was moved. */
    homeWardId: text("home_ward_id"),
    reason: text("reason"),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
  },
  (t) => [
    uniqueIndex("ipd_ward_shift_staff_ux").on(t.mapId, t.userId),
    index("ipd_ward_shift_staff_user_idx").on(t.userId),
    check("ipd_ward_shift_staff_kind_ck", sql`${t.kind} in ('rn', 'student', 'incharge', 'float')`),
    check("ipd_ward_shift_staff_float_ck", sql`(${t.kind} = 'float') = (${t.homeWardId} is not null)`),
  ],
);

export const ipdNurseAssignments = pgTable(
  "ipd_nurse_assignments",
  {
    id: text("id").primaryKey(),
    mapId: text("map_id").notNull().references(() => ipdWardShiftMaps.id),
    bedId: text("bed_id").notNull().references(() => resources.id),
    /** The admission on the bed when assigned; null on a draft row for a bed empty at the time. */
    admissionId: text("admission_id").references(() => ipdAdmissions.id),
    nurseId: text("nurse_id").notNull(),
    studentId: text("student_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    /** A reassignment's reason; null for the published map's own rows and a first assignment. */
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
  },
  (t) => [
    uniqueIndex("ipd_nurse_assignments_live_ux").on(t.mapId, t.bedId).where(sql`${t.validTo} is null`),
    index("ipd_nurse_assignments_nurse_idx").on(t.nurseId),
  ],
);

export const ipdPatientAcuity = pgTable(
  "ipd_patient_acuity",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    shiftDate: date("shift_date", { mode: "string" }).notNull(),
    shift: text("shift").notNull(),
    level: text("level").notNull(),
    ventilated: boolean("ventilated").notNull().default(false),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_patient_acuity_admission_idx").on(t.admissionId, t.shiftDate, t.shift),
    check("ipd_patient_acuity_level_ck", sql`${t.level} in ('self_care', 'partial_care', 'full_care')`),
    check("ipd_patient_acuity_shift_ck", sql`${t.shift} in ('morning', 'evening', 'night')`),
  ],
);

export const ipdWardRatioBreaches = pgTable(
  "ipd_ward_ratio_breaches",
  {
    id: text("id").primaryKey(),
    wardId: text("ward_id").notNull().references(() => resources.id),
    shiftDate: date("shift_date", { mode: "string" }).notNull(),
    shift: text("shift").notNull(),
    mapId: text("map_id").references(() => ipdWardShiftMaps.id),
    unit: text("unit").notNull(),
    patients: integer("patients").notNull(),
    ventilated: integer("ventilated").notNull(),
    rnsOnDuty: integer("rns_on_duty").notNull(),
    rnsNeeded: integer("rns_needed").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    /** When the supervisor notice went out; null = nobody reached yet (the sweep retries). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("ipd_ward_ratio_breaches_ux").on(t.wardId, t.shiftDate, t.shift)],
);
