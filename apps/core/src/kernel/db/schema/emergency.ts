import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { patients } from "./patients";

/**
 * ER lane 1 (#808, decision 0076) — THE EMERGENCY DEPARTMENT's truth (spec SPEC-emergency-2026-10-15 §1).
 *
 * The value lists are retyped from `packages/contracts/src/emergency/common.ts` because drizzle-kit loads this file
 * without the workspace packages; `modules/emergency/schema-parity.test.ts` holds the two equal.
 */
export const ER_EPISODE_STATE_VALUES = ["arrived", "triaged", "in_treatment", "disposition_decided", "departed", "brought_dead"] as const;
export const ER_OPEN_STATE_VALUES = ["arrived", "triaged", "in_treatment", "disposition_decided"] as const;
export const ER_ARRIVAL_MODE_VALUES = [
  "walk_in", "private_vehicle", "own_ambulance", "ambulance_108", "police", "referred_in", "inter_facility",
] as const;
export const ER_AGE_BAND_VALUES = ["infant", "child", "teen", "young_adult", "adult", "elderly"] as const;
const list = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));
const STATES = list(ER_EPISODE_STATE_VALUES);
const OPEN = list(ER_OPEN_STATE_VALUES);
const MODES = list(ER_ARRIVAL_MODE_VALUES);
const BANDS = list(ER_AGE_BAND_VALUES);

/**
 * One row per ARRIVAL: the ER episode (`ER26-000123`), mirrored from its `er_episode` workflow instance.
 *
 * - `arrived_at` is the GATE instant (seam E1), stamped once; `registered_at` is when the desk entered it. A
 *   registration typed 15 minutes after the patient came through the gate keeps the gate time.
 * - One open episode per patient: a partial unique index over the open states. A merge leaves `patient_id` on the
 *   unknown record; every reader resolves it through the patients merge chain.
 * - An unidentified patient's alias is a per-IST-year serial (`Unknown-0412`), unique in its year.
 * - No money column, ever (decision 0058): the ER bill is lane 6's, on billing's episode charge sink.
 */
export const erEpisodes = pgTable(
  "er_episodes",
  {
    id: text("id").primaryKey(),
    episodeNo: text("episode_no").notNull(),
    episodeYear: integer("episode_year").notNull(),
    episodeSerial: integer("episode_serial").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    workflowInstanceId: text("workflow_instance_id").notNull(),
    state: text("state").notNull(),
    arrivalMode: text("arrival_mode").notNull(),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
    registeredBy: text("registered_by").notNull(),
    preAlertId: text("pre_alert_id"),
    unidentified: boolean("unidentified").notNull().default(false),
    alias: text("alias"),
    aliasYear: integer("alias_year"),
    aliasSerial: integer("alias_serial"),
    ageBand: text("age_band"),
    marks: text("marks"),
    complaint: text("complaint"),
    broughtBy: jsonb("brought_by").$type<Record<string, unknown>>(),
    returnedWithin24h: boolean("returned_within_24h").notNull().default(false),
    previousEpisodeId: text("previous_episode_id"),
    paperSerial: text("paper_serial"),
    /** Brought dead: the examining doctor, the time of examination and the ECG strip (the MLC is lane 4's). */
    broughtDeadExaminedBy: text("brought_dead_examined_by"),
    broughtDeadExaminedAt: timestamp("brought_dead_examined_at", { withTimezone: true }),
    ecgStripRecorded: boolean("ecg_strip_recorded"),
    /** The identity link (`link_identity`): the `patient_merge_requests` row it filed and the true record. */
    identityMergeRequestId: text("identity_merge_request_id"),
    identityTruePatientId: text("identity_true_patient_id"),
    outcome: text("outcome"),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    provenance: text("provenance").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("er_episodes_no_ux").on(t.episodeNo),
    uniqueIndex("er_episodes_year_serial_ux").on(t.episodeYear, t.episodeSerial),
    uniqueIndex("er_episodes_open_patient_ux").on(t.patientId).where(sql`${t.state} in (${OPEN})`),
    uniqueIndex("er_episodes_alias_ux").on(t.aliasYear, t.aliasSerial).where(sql`${t.aliasSerial} is not null`),
    uniqueIndex("er_episodes_paper_serial_ux").on(t.paperSerial).where(sql`${t.paperSerial} is not null`),
    index("er_episodes_state_idx").on(t.state, t.arrivedAt),
    index("er_episodes_patient_idx").on(t.patientId, t.arrivedAt),
    check("er_episodes_state_ck", sql`${t.state} in (${STATES})`),
    check("er_episodes_mode_ck", sql`${t.arrivalMode} in (${MODES})`),
    check("er_episodes_band_ck", sql`${t.ageBand} is null or ${t.ageBand} in (${BANDS})`),
    check("er_episodes_alias_ck", sql`${t.unidentified} = (${t.alias} is not null)`),
    check("er_episodes_dead_ck", sql`(${t.state} = 'brought_dead') = (${t.broughtDeadExaminedAt} is not null)`),
  ],
);

/**
 * An ambulance or police call that says a patient is coming (spec §4.1): the board's "Expected" card. DECIDED (lane 1):
 * a row of its own, not an episode state — one call can bring several patients (`count`), each arrival claims one, and
 * a call that never arrives lapses after two hours without minting an ER number.
 */
export const erPreAlerts = pgTable(
  "er_pre_alerts",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
    mode: text("mode").notNull(),
    expectedAt: timestamp("expected_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
    arrivedCount: integer("arrived_count").notNull().default(0),
    sex: text("sex"),
    ageBand: text("age_band"),
    complaint: text("complaint"),
    caller: text("caller"),
    callerPhone: text("caller_phone"),
    vehicleNo: text("vehicle_no"),
    cancelReason: text("cancel_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("er_pre_alerts_expected_idx").on(t.expiresAt).where(sql`${t.state} = 'expected'`),
    check("er_pre_alerts_state_ck", sql`${t.state} in ('expected', 'arrived', 'cancelled')`),
    check("er_pre_alerts_count_ck", sql`${t.count} >= 1 and ${t.arrivedCount} >= 0 and ${t.arrivedCount} <= ${t.count}`),
  ],
);

/**
 * The ER band register (IPD's `ipd_bands`, for an episode): the QR and barcode carry the band SERIAL (`<ER no>-<n>`), a
 * scanner resolves it here, so a voided band no longer identifies anyone. One live band per episode.
 */
export const erBands = pgTable(
  "er_bands",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    serial: text("serial").notNull(),
    size: text("size").notNull(),
    site: text("site").notNull(),
    printerId: text("printer_id"),
    status: text("status").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    printedBy: text("printed_by").notNull(),
    printedAt: timestamp("printed_at", { withTimezone: true }).notNull(),
    voidReason: text("void_reason"),
    voidedBy: text("voided_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("er_bands_serial_ux").on(t.serial),
    uniqueIndex("er_bands_live_episode_ux").on(t.episodeId).where(sql`${t.status} = 'printed'`),
    check("er_bands_status_ck", sql`${t.status} in ('printed', 'void')`),
  ],
);
