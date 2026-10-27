import { sql } from "drizzle-orm";
import { bigserial, boolean, check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./auth";
import { interfaces } from "./ops";
import { ipdAdmissions } from "./ipd";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * ICU IC-1 (#984, spec docs/specs/984-icu-core.md, decision 0090) — read and written only by `modules/icu`.
 *
 * NUMBERS ARE NEVER EVENTS. One gateway per ICU hall sends 5-second samples in 30-second batches; they land in
 * `icu_numerics` (PARTITIONED BY RANGE (observed_at), one partition per UTC day, created on demand and DROPPED once
 * older than 72 hours — the migration declares the partitioning by hand; drizzle only reads and writes it) and, one
 * value per minute, in `icu_numerics_minute` (kept with the medical record). The signed hourly chart is the legal
 * record. Events are written per request, link, gap, alarm and signed hour only.
 */

export const icuRequests = pgTable(
  "icu_requests",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    admissionId: text("admission_id").references(() => ipdAdmissions.id),
    source: text("source").notNull(),
    priorityClass: integer("priority_class").notNull(),
    /** The scores as asked: what the requester typed, the rest pre-filled from the latest vitals and labs. */
    triage: jsonb("triage").$type<Record<string, number>>().notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull(),
    /** The `ipd_icu_admission` approval the request asked at raise time; the admit desk passes it to the existing gate. */
    approvalId: text("approval_id"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    reviewAt: timestamp("review_at", { withTimezone: true }),
    monitoring: text("monitoring"),
  },
  (t) => [
    index("icu_requests_state_idx").on(t.state, t.requestedAt),
    uniqueIndex("icu_requests_open_ux").on(t.patientId).where(sql`${t.state} in ('pending', 'on_hold')`),
    check("icu_requests_source_ck", sql`${t.source} in ('er', 'ward', 'ot')`),
    check("icu_requests_priority_ck", sql`${t.priorityClass} between 1 and 4`),
    check("icu_requests_state_ck", sql`${t.state} in ('pending', 'on_hold', 'approved', 'refused', 'cancelled')`),
  ],
);

/** Append-only: every act on a request, with its reason and its name. */
export const icuRequestEvents = pgTable(
  "icu_request_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull().references(() => icuRequests.id),
    act: text("act").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("icu_request_events_request_idx").on(t.requestId, t.at),
    check("icu_request_events_act_ck", sql`${t.act} in ('raised', 'approved', 'refused', 'held', 'cancelled')`),
  ],
);

/** One gateway per ICU hall (decision 0090). Its liveness is the kernel interface it is bound to (heartbeat 30 s, stale 300 s). */
export const icuGateways = pgTable(
  "icu_gateways",
  {
    id: text("id").primaryKey(),
    hallId: text("hall_id").notNull().references(() => resources.id),
    name: text("name").notNull(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    interfaceId: text("interface_id").notNull().references(() => interfaces.id),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("icu_gateways_hall_ux").on(t.hallId).where(sql`${t.active}`),
    uniqueIndex("icu_gateways_interface_ux").on(t.interfaceId),
  ],
);

/** The maker's OBX code → HMIS parameter, per gateway. An unmapped code is quarantined, never dropped. */
export const icuGatewayCodes = pgTable(
  "icu_gateway_codes",
  {
    gatewayId: text("gateway_id").notNull().references(() => icuGateways.id),
    code: text("code").notNull(),
    param: text("param").notNull(),
    unit: text("unit"),
  },
  (t) => [primaryKey({ columns: [t.gatewayId, t.code] })],
);

/** The central station's bed label (its "slot") → the HMIS bed. */
export const icuSlots = pgTable(
  "icu_slots",
  {
    gatewayId: text("gateway_id").notNull().references(() => icuGateways.id),
    slot: text("slot").notNull(),
    bedId: text("bed_id").notNull().references(() => resources.id),
  },
  (t) => [primaryKey({ columns: [t.gatewayId, t.slot] }), uniqueIndex("icu_slots_bed_ux").on(t.bedId)],
);

/**
 * A device on a bed for one patient, made only by scanning the device and the patient's band. One open link per device
 * and one per (bed, type): the two partial unique indexes are the race guard. A device-day runs from `linked_at` to
 * `ended_at` (unlink, transfer, discharge, death).
 */
export const icuDeviceLinks = pgTable(
  "icu_device_links",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull().references(() => resources.id),
    deviceType: text("device_type").notNull(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
    linkedBy: text("linked_by").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("icu_device_links_device_open_ux").on(t.deviceId).where(sql`${t.endedAt} is null`),
    uniqueIndex("icu_device_links_bed_type_open_ux").on(t.bedId, t.deviceType).where(sql`${t.endedAt} is null`),
    index("icu_device_links_admission_idx").on(t.admissionId, t.linkedAt),
    check("icu_device_links_type_ck", sql`${t.deviceType} in ('monitor', 'ventilator', 'pump')`),
    check("icu_device_links_end_ck", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check("icu_device_links_reason_ck", sql`${t.endReason} is null or ${t.endReason} in ('unlinked', 'transfer', 'discharge', 'death', 'bed_change')`),
  ],
);

/** Lines and tubes in place (line-days). */
export const icuLines = pgTable(
  "icu_lines",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    site: text("site").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull(),
    insertedBy: text("inserted_by").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: text("removed_by"),
  },
  (t) => [
    index("icu_lines_admission_idx").on(t.admissionId),
    check("icu_lines_kind_ck", sql`${t.kind} in ('central_line', 'arterial_line', 'urinary_catheter', 'endotracheal_tube')`),
  ],
);

/** One row per batch the gateway sent; `outcome` is answered again on a replay of the same `batch_ref`. */
export const icuFeedBatches = pgTable(
  "icu_feed_batches",
  {
    id: text("id").primaryKey(),
    gatewayId: text("gateway_id").notNull().references(() => icuGateways.id),
    batchRef: text("batch_ref").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    skewMs: integer("skew_ms").notNull(),
    driftFlagged: boolean("drift_flagged").notNull(),
    outcome: jsonb("outcome").$type<{ accepted: number; quarantined: number }>().notNull(),
    /** Unmapped codes and unknown slots, kept for the code-map screen (nothing is dropped). */
    quarantine: jsonb("quarantine").$type<{ slot: string; code: string; why: string }[]>().notNull(),
  },
  (t) => [uniqueIndex("icu_feed_batches_ref_ux").on(t.gatewayId, t.batchRef), index("icu_feed_batches_received_idx").on(t.receivedAt)],
);

/**
 * The 5-second samples, 72 hours. PARTITIONED (see the file header). `link_id` / `admission_id` are null when the
 * sample could not be attributed (no confirmed link on the slot's bed at that instant): such a row never reaches a chart.
 */
export const icuNumerics = pgTable(
  "icu_numerics",
  {
    id: bigserial("id", { mode: "number" }).notNull(),
    gatewayId: text("gateway_id").notNull(),
    slot: text("slot").notNull(),
    bedId: text("bed_id"),
    linkId: text("link_id"),
    admissionId: text("admission_id"),
    param: text("param").notNull(),
    value: doublePrecision("value"),
    technical: text("technical"),
    deviceAt: timestamp("device_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.observedAt] }),
    index("icu_numerics_admission_idx").on(t.admissionId, t.param, t.observedAt),
    index("icu_numerics_bed_idx").on(t.bedId, t.observedAt),
  ],
);

/** One value per minute per parameter, attributed and non-technical only — kept with the medical record (trends). */
export const icuNumericsMinute = pgTable(
  "icu_numerics_minute",
  {
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    param: text("param").notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    value: doublePrecision("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.admissionId, t.param, t.minute] })],
);

/** One chart hour per admission. Only a SIGNED hour is the legal record. */
export const icuChartHours = pgTable(
  "icu_chart_hours",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    hourStart: timestamp("hour_start", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    mode: text("mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    vitalsId: text("vitals_id"),
  },
  (t) => [
    uniqueIndex("icu_chart_hours_ux").on(t.admissionId, t.hourStart),
    check("icu_chart_hours_state_ck", sql`${t.state} in ('draft', 'signed')`),
    check("icu_chart_hours_mode_ck", sql`${t.mode} in ('device', 'manual')`),
    check("icu_chart_hours_signed_ck", sql`(${t.state} = 'signed') = (${t.signedAt} is not null)`),
  ],
);

/**
 * APPEND-ONLY. A correction is a new row that `supersedes` the old one and carries a reason; the old row stays.
 * `happened_at` is when the observation was made, `entered_at` when it was written (a back-fill carries both).
 */
export const icuChartValues = pgTable(
  "icu_chart_values",
  {
    id: text("id").primaryKey(),
    hourId: text("hour_id").notNull().references(() => icuChartHours.id),
    param: text("param").notNull(),
    value: doublePrecision("value"),
    source: text("source").notNull(),
    technical: text("technical"),
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    enteredBy: text("entered_by"),
    supersedes: text("supersedes"),
    reason: text("reason"),
  },
  (t) => [
    index("icu_chart_values_hour_idx").on(t.hourId, t.param),
    uniqueIndex("icu_chart_values_supersedes_ux").on(t.supersedes),
    check("icu_chart_values_source_ck", sql`${t.source} in ('device', 'manual', 'correction')`),
    check("icu_chart_values_correction_ck", sql`(${t.source} = 'correction') = (${t.supersedes} is not null and ${t.reason} is not null)`),
    check("icu_chart_values_technical_ck", sql`${t.technical} is null or ${t.value} is null`),
  ],
);

/** A doctor's limit for one parameter: lasts 24 hours (D6). `monitor_set_*` is the nurse's tick "set on the monitor". */
export const icuAlarmLimits = pgTable(
  "icu_alarm_limits",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    param: text("param").notNull(),
    low: doublePrecision("low"),
    high: doublePrecision("high"),
    reason: text("reason"),
    orderedBy: text("ordered_by").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    monitorSetBy: text("monitor_set_by"),
    monitorSetAt: timestamp("monitor_set_at", { withTimezone: true }),
  },
  (t) => [
    index("icu_alarm_limits_admission_idx").on(t.admissionId, t.param),
    check("icu_alarm_limits_ttl_ck", sql`${t.expiresAt} = ${t.orderedAt} + interval '24 hours'`),
    check("icu_alarm_limits_some_ck", sql`${t.low} is not null or ${t.high} is not null`),
  ],
);

/**
 * An alarm is a task with a clock on a ladder. THERE IS NO SILENCE COLUMN: HMIS records who acknowledged an alarm and
 * never silences a device (the monitor sounds the real alarm).
 */
export const icuAlarms = pgTable(
  "icu_alarms",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    bedId: text("bed_id").notNull().references(() => resources.id),
    source: text("source").notNull(),
    severity: text("severity").notNull(),
    param: text("param"),
    message: text("message").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    rung: text("rung").notNull(),
    rungSince: timestamp("rung_since", { withTimezone: true }).notNull(),
    state: text("state").notNull(),
    ackBy: text("ack_by"),
    ackAt: timestamp("ack_at", { withTimezone: true }),
    ackNote: text("ack_note"),
    limitId: text("limit_id"),
  },
  (t) => [
    index("icu_alarms_open_idx").on(t.state, t.rungSince),
    index("icu_alarms_admission_idx").on(t.admissionId, t.raisedAt),
    check("icu_alarms_source_ck", sql`${t.source} in ('device', 'advisory')`),
    check("icu_alarms_severity_ck", sql`${t.severity} in ('life_threatening', 'high', 'medium', 'low', 'advisory')`),
    check("icu_alarms_rung_ck", sql`${t.rung} in ('bed_nurse', 'station', 'duty_doctor', 'intensivist')`),
    check("icu_alarms_state_ck", sql`${t.state} in ('open', 'acknowledged')`),
    check("icu_alarms_ack_ck", sql`(${t.state} = 'acknowledged') = (${t.ackAt} is not null)`),
  ],
);

export const icuAlarmEvents = pgTable(
  "icu_alarm_events",
  {
    id: text("id").primaryKey(),
    alarmId: text("alarm_id").references(() => icuAlarms.id),
    admissionId: text("admission_id").notNull(),
    act: text("act").notNull(),
    rung: text("rung"),
    actorId: text("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("icu_alarm_events_alarm_idx").on(t.alarmId, t.at),
    index("icu_alarm_events_storm_idx").on(t.admissionId, t.act, t.at),
    check("icu_alarm_events_act_ck", sql`${t.act} in ('raised', 'escalated', 'acknowledged', 'storm_flagged')`),
  ],
);

/** A hall's feed silence longer than 5 minutes (D7): opened and closed by the alarm sweep from the gateway's heartbeat. */
export const icuFeedGaps = pgTable(
  "icu_feed_gaps",
  {
    id: text("id").primaryKey(),
    gatewayId: text("gateway_id").notNull().references(() => icuGateways.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("icu_feed_gaps_open_ux").on(t.gatewayId).where(sql`${t.endedAt} is null`)],
);

export const icuBundles = pgTable(
  "icu_bundles",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: text("done_by"),
    checks: jsonb("checks").$type<string[]>(),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("icu_bundles_open_ux").on(t.admissionId, t.kind).where(sql`${t.doneAt} is null`),
    index("icu_bundles_due_idx").on(t.dueAt),
    check("icu_bundles_kind_ck", sql`${t.kind} in ('ventilator', 'central_line', 'catheter', 'sepsis_hour1', 'dvt', 'pressure')`),
  ],
);

export const icuVisitSlots = pgTable(
  "icu_visit_slots",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    visitorName: text("visitor_name").notNull(),
    relation: text("relation").notNull(),
    loggedBy: text("logged_by").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("icu_visit_slots_admission_idx").on(t.admissionId, t.startsAt), check("icu_visit_slots_span_ck", sql`${t.startsAt} < ${t.endsAt}`)],
);

/** The doctor's daily word to the family: words, never live numbers (the family link shows today's latest). */
export const icuFamilyUpdates = pgTable(
  "icu_family_updates",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    istDay: text("ist_day").notNull(),
    summary: text("summary").notNull(),
    givenTo: text("given_to").notNull(),
    relation: text("relation").notNull(),
    mode: text("mode").notNull(),
    givenBy: text("given_by").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("icu_family_updates_admission_idx").on(t.admissionId, t.givenAt),
    check("icu_family_updates_mode_ck", sql`${t.mode} in ('in_person', 'phone', 'video')`),
  ],
);
