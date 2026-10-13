import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { resources } from "./resources";
import { tasks } from "./tasks";

/**
 * E1.6 TRANSPORT (issue #723, decision 0072) — what a transport task carries beyond the engine's row: how the patient
 * goes (mode, oxygen, monitor, isolation), whether an escort is required and who it is, the oxygen-cylinder check and
 * the wristband handover. One row per transport task (`task_id` unique). The task's own `place_resource_id` is the
 * FROM place and its `patient_id` the patient; this row adds the TO place. Read and written only by `modules/transport`.
 *
 * Linked by `task_id`, not by the engine's `source_ref`: a `source_ref` skips the engine's ten-minute merge window,
 * and a repeated request for the same patient's move must merge into the first (spec §2).
 */
export const transportRequests = pgTable(
  "transport_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id),
    kind: text("kind").notNull(),
    admissionId: text("admission_id").references(() => ipdAdmissions.id),
    fromResourceId: text("from_resource_id").references(() => resources.id),
    toResourceId: text("to_resource_id").references(() => resources.id),
    toNote: text("to_note"),
    mode: text("mode"),
    oxygen: boolean("oxygen").notNull().default(false),
    monitor: boolean("monitor").notNull().default(false),
    isolation: text("isolation").notNull().default("none"),
    reason: text("reason"),
    escortRequired: boolean("escort_required").notNull().default(false),
    /** critical_care_bed | high_risk_flag | requested — why the escort is required. */
    escortReason: text("escort_reason"),
    escortUserId: text("escort_user_id"),
    escortAddedBy: text("escort_added_by"),
    escortAddedAt: timestamp("escort_added_at", { withTimezone: true }),
    oxygenCheckedBy: text("oxygen_checked_by"),
    oxygenCheckedAt: timestamp("oxygen_checked_at", { withTimezone: true }),
    handoverBandSerial: text("handover_band_serial"),
    handoverAt: timestamp("handover_at", { withTimezone: true }),
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("transport_requests_task_ux").on(t.taskId),
    index("transport_requests_admission_idx").on(t.admissionId),
    check("transport_requests_kind_ck", sql`${t.kind} in ('patient_move', 'sample_run', 'document_run')`),
    check("transport_requests_mode_ck", sql`${t.mode} is null or ${t.mode} in ('wheelchair', 'stretcher', 'bed', 'walking')`),
    check("transport_requests_isolation_ck", sql`${t.isolation} in ('none', 'contact', 'droplet', 'airborne')`),
    check("transport_requests_reason_ck", sql`${t.reason} is null or ${t.reason} in ('admit', 'transfer', 'imaging', 'ot', 'discharge', 'other')`),
    check("transport_requests_escort_reason_ck", sql`${t.escortReason} is null or ${t.escortReason} in ('critical_care_bed', 'high_risk_flag', 'requested')`),
    check("transport_requests_move_admission_ck", sql`${t.kind} <> 'patient_move' or ${t.admissionId} is not null`),
    check("transport_requests_to_ck", sql`${t.toResourceId} is not null or char_length(${t.toNote}) > 0`),
    check("transport_requests_to_note_ck", sql`${t.toNote} is null or char_length(${t.toNote}) <= 120`),
  ],
);
