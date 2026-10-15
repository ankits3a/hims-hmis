import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";
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
    /* ═══ ER lane 2 (#809) — triage, the bay, the doctor and the clocks (mirrors of `er_triage_entries`) ═══ */
    esi: integer("esi"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    lastTriageAt: timestamp("last_triage_at", { withTimezone: true }),
    /** Null for ESI 1 and once a doctor has seen the patient. A worse vital set pulls it to now. */
    retriageDueAt: timestamp("retriage_due_at", { withTimezone: true }),
    /** The last early-warning score (kind, value, band) — the second signal beside the level. */
    ewsKind: text("ews_kind"),
    ewsValue: integer("ews_value"),
    ewsBand: text("ews_band"),
    /** The bay: an emergency-class bed of the registry, occupied with occupant type `er_episode`. */
    bayId: text("bay_id").references(() => resources.id),
    doctorId: text("doctor_id"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    /** The take (seam E2): the specialty at triage and the unit on take at the GATE instant. */
    takeDepartmentId: text("take_department_id"),
    takeTeamId: text("take_team_id"),
    takeSource: text("take_source"),
    /** The re-triage clock's task (raised once per due instant) and the climb (once per due instant). */
    retriageTaskId: text("retriage_task_id"),
    retriageTaskDueAt: timestamp("retriage_task_due_at", { withTimezone: true }),
    retriageClimbedDueAt: timestamp("retriage_climbed_due_at", { withTimezone: true }),
    /* ═══ ER lane 3 (#810) — "stabilised", a clinical word only (lane 6 reads it; lane 5 copies it to the admission) ═══ */
    stabilisedAt: timestamp("stabilised_at", { withTimezone: true }),
    stabilisedBy: text("stabilised_by"),
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
    check("er_episodes_esi_ck", sql`${t.esi} is null or ${t.esi} between 1 and 5`),
    // One ER patient per bay (the kernel's occupant triad is the arbiter; this is the backstop on the ER side).
    uniqueIndex("er_episodes_open_bay_ux").on(t.bayId).where(sql`${t.bayId} is not null and ${t.state} in (${OPEN})`),
    index("er_episodes_retriage_due_idx").on(t.retriageDueAt).where(sql`${t.state} = 'triaged' and ${t.retriageDueAt} is not null`),
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
    /** Lane 2 (#809, E9): the OPD red flag's patient and the rule that fired. */
    patientId: text("patient_id").references(() => patients.id),
    redFlagKey: text("red_flag_key"),
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

/**
 * ER lane 2 (#809) — every triage, re-triage and vital set. The intents only ever insert here (no update path): a wrong
 * entry is followed by a corrected one. The level is the person's; `algorithm_level` is what the ESI decision points gave; a level less
 * urgent than either the algorithm's or the last one carries its `reason` (refused without).
 */
export const erTriageEntries = pgTable(
  "er_triage_entries",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    kind: text("kind").notNull(),
    level: integer("level"),
    algorithmLevel: integer("algorithm_level"),
    decision: jsonb("decision").$type<Record<string, unknown>>(),
    reason: text("reason"),
    vitals: jsonb("vitals").$type<Record<string, unknown>>(),
    ewsKind: text("ews_kind"),
    ewsValue: integer("ews_value"),
    ewsBand: text("ews_band"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    provenance: text("provenance").notNull(),
  },
  (t) => [
    index("er_triage_entries_episode_idx").on(t.episodeId, t.recordedAt),
    check("er_triage_entries_kind_ck", sql`${t.kind} in ('triage', 're_triage', 'vitals')`),
    check("er_triage_entries_level_ck", sql`(${t.kind} = 'vitals') = (${t.level} is null)`),
  ],
);

/* ═══════════════════════════════ ER lane 3 (#810) — care ═══════════════════════════════ */

/** Notes. A resident's note is a `draft` until a senior co-signs it; a signed note is never edited (an addendum is). */
export const erNotes = pgTable(
  "er_notes",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    authorId: text("author_id").notNull(),
    status: text("status").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    cosignedBy: text("cosigned_by"),
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }),
    addendum: text("addendum"),
    provenance: text("provenance").notNull(),
  },
  (t) => [
    index("er_notes_episode_idx").on(t.episodeId, t.recordedAt),
    check("er_notes_status_ck", sql`${t.status} in ('signed', 'draft')`),
    check("er_notes_cosign_ck", sql`(${t.cosignedBy} is null) = (${t.cosignedAt} is null)`),
  ],
);

/**
 * The ER satellite issue (crash cart, emergency drugs) to one patient, and the medication record's order half. A verbal
 * order (resus) is read back at issue and signed by the ordering doctor within 2 hours.
 */
export const erMedIssues = pgTable(
  "er_med_issues",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    itemId: text("item_id"),
    ownMedicine: text("own_medicine"),
    name: text("name").notNull(),
    doseWords: text("dose_words").notNull(),
    route: text("route").notNull(),
    units: integer("units").notNull(),
    highAlert: boolean("high_alert").notNull(),
    storeId: text("store_id"),
    batches: jsonb("batches").$type<Record<string, unknown>[]>().notNull(),
    orderedBy: text("ordered_by").notNull(),
    verbal: boolean("verbal").notNull(),
    verbalSignedAt: timestamp("verbal_signed_at", { withTimezone: true }),
    verbalNoticeAt: timestamp("verbal_notice_at", { withTimezone: true }),
    allergyOverride: text("allergy_override"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("er_med_issues_episode_idx").on(t.episodeId, t.issuedAt),
    index("er_med_issues_verbal_idx").on(t.issuedAt).where(sql`${t.verbal} and ${t.verbalSignedAt} is null`),
    check("er_med_issues_source_ck", sql`(${t.itemId} is null) <> (${t.ownMedicine} is null)`),
  ],
);

/** One dose record per issue: given, held or refused; a high-alert drug given names the second checker. */
export const erDoses = pgTable(
  "er_doses",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => erMedIssues.id),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    secondCheckBy: text("second_check_by"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("er_doses_issue_ux").on(t.issueId),
    check("er_doses_outcome_ck", sql`${t.outcome} in ('given', 'held', 'refused')`),
  ],
);

export const erProcedures = pgTable(
  "er_procedures",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    name: text("name").notNull(),
    serviceId: text("service_id"),
    performedBy: text("performed_by").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
    consentId: text("consent_id"),
    notes: text("notes"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("er_procedures_episode_idx").on(t.episodeId, t.performedAt)],
);

export const erConsents = pgTable(
  "er_consents",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    kind: text("kind").notNull(),
    about: text("about").notNull(),
    signedBy: text("signed_by").notNull(),
    signerName: text("signer_name"),
    relation: text("relation"),
    method: text("method").notNull(),
    witnessName: text("witness_name"),
    secondDoctorId: text("second_doctor_id"),
    language: text("language"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("er_consents_episode_idx").on(t.episodeId),
    check("er_consents_emergency_ck", sql`(${t.signedBy} = 'emergency') = (${t.secondDoctorId} is not null)`),
  ],
);

/** A specialty call: who was called (the roster's rungs for the unit on take at the gate), answered, seen. */
export const erSpecialtyCalls = pgTable(
  "er_specialty_calls",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    departmentId: text("department_id").notNull(),
    departmentCode: text("department_code").notNull(),
    urgency: text("urgency").notNull(),
    reason: text("reason").notNull(),
    takeTeamId: text("take_team_id"),
    takeSource: text("take_source").notNull(),
    callees: jsonb("callees").$type<{ userId: string; name: string }[]>().notNull(),
    calledBy: text("called_by").notNull(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull(),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    seenBy: text("seen_by"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    climbedAt: timestamp("climbed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("er_specialty_calls_open_ux").on(t.episodeId, t.departmentId).where(sql`${t.seenAt} is null`),
    index("er_specialty_calls_unanswered_idx").on(t.calledAt).where(sql`${t.answeredAt} is null and ${t.climbedAt} is null`),
    check("er_specialty_calls_urgency_ck", sql`${t.urgency} in ('immediate', 'urgent', 'routine')`),
  ],
);

/**
 * The `ER` episode's charge lines — what the ordering door, the ER satellite issue and the procedures post to the ER
 * episode's charge sink (billing `registerEpisodeChargeSink`, prefix `ER`). Priced from the active tariff where a
 * service is priced; a missing rate or an un-priced item is recorded (`rate_missing`, `rate_pending`) for lane 6's bill
 * desk. No clinical screen reads this table (decision 0058).
 */
export const erChargeLines = pgTable(
  "er_charge_lines",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    source: text("source").notNull(),
    department: text("department"),
    orderId: text("order_id"),
    orderItemId: text("order_item_id"),
    issueId: text("issue_id"),
    procedureId: text("procedure_id"),
    serviceId: text("service_id"),
    itemId: text("item_id"),
    qty: integer("qty").notNull(),
    amountPaise: integer("amount_paise"),
    status: text("status").notNull(),
    postedBy: text("posted_by").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reverseReason: text("reverse_reason"),
  },
  (t) => [
    uniqueIndex("er_charge_lines_order_item_ux").on(t.orderItemId).where(sql`${t.orderItemId} is not null`),
    index("er_charge_lines_episode_idx").on(t.episodeId),
    check("er_charge_lines_source_ck", sql`${t.source} in ('er.order', 'er.issue', 'er.procedure')`),
    check("er_charge_lines_status_ck", sql`${t.status} in ('posted', 'rate_missing', 'rate_pending', 'reversed')`),
    check("er_charge_lines_amount_ck", sql`(${t.status} = 'posted') = (${t.amountPaise} is not null)`),
  ],
);

/** A critical result on an ER episode, told to the ER doctor of record once, and climbed once while unacknowledged. */
export const erCriticalAlerts = pgTable(
  "er_critical_alerts",
  {
    id: text("id").primaryKey(),
    callId: text("call_id").notNull(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull(),
    notifiedUserIds: jsonb("notified_user_ids").$type<string[]>().notNull(),
    climbedAt: timestamp("climbed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("er_critical_alerts_call_ux").on(t.callId)],
);

/* ═══════════════════════════════ ER lane 4 (#811) — the medico-legal case ═══════════════════════════════ */

/**
 * The MLC register: one case per ER episode, serial `MLC26-000123` per IST year. IMMUTABLE — a trigger in the
 * migration refuses every UPDATE and DELETE (`er_mlc_append_only`); a correction is an addendum (`er_mlc_addenda`), the
 * obligations' clocks live in `er_mlc_obligations`. Opened by a doctor, or by rule at arrival (an unidentified patient, a
 * body brought dead). Retyped value lists: `ER_MLC_CATEGORY_VALUES` mirrors the contract (schema-parity test).
 */
export const ER_MLC_CATEGORY_VALUES = [
  "assault", "road_accident", "burns", "acid_attack", "poisoning", "hanging", "drowning", "fall_from_height", "bite_dispute",
  "unknown_unconscious", "sexual_assault", "brought_dead", "death_within_24h_injury", "police_brought", "other",
] as const;
const MLC_CATEGORIES_SQL = list(ER_MLC_CATEGORY_VALUES);

export const erMlcs = pgTable(
  "er_mlcs",
  {
    id: text("id").primaryKey(),
    mlcNo: text("mlc_no").notNull(),
    mlcYear: integer("mlc_year").notNull(),
    mlcSerial: integer("mlc_serial").notNull(),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    category: text("category").notNull(),
    informant: jsonb("informant").$type<{ name: string; relation: string; phone?: string; words: string }>(),
    injuries: jsonb("injuries").$type<{ site: string; kind: string; sizeCm?: string; description?: string }[]>().notNull(),
    pocso: boolean("pocso").notNull(),
    freeByLaw: boolean("free_by_law").notNull(),
    openedBy: text("opened_by").notNull(),
    openedByRule: boolean("opened_by_rule").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    late: boolean("late").notNull(),
    provenance: text("provenance").notNull(),
  },
  (t) => [
    uniqueIndex("er_mlcs_no_ux").on(t.mlcNo),
    uniqueIndex("er_mlcs_serial_ux").on(t.mlcYear, t.mlcSerial),
    uniqueIndex("er_mlcs_episode_ux").on(t.episodeId),
    index("er_mlcs_opened_idx").on(t.openedAt),
    check("er_mlcs_category_ck", sql`${t.category} in (${MLC_CATEGORIES_SQL})`),
  ],
);

/**
 * The two obligations of every MLC (spec §3.7): `police_intimation` due 1 h after opening (a task at the due instant,
 * then one climb), `faculty_countersign` due in 24 h (breached → one notice on the ladder; still owed after a death).
 * The ONE mutable MLC table: the clock's bookkeeping (met, task, climb, breach), each stamped once.
 */
export const erMlcObligations = pgTable(
  "er_mlc_obligations",
  {
    id: text("id").primaryKey(),
    mlcId: text("mlc_id").notNull().references(() => erMlcs.id),
    kind: text("kind").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    metAt: timestamp("met_at", { withTimezone: true }),
    metBy: text("met_by"),
    taskId: text("task_id"),
    climbedAt: timestamp("climbed_at", { withTimezone: true }),
    breachedAt: timestamp("breached_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("er_mlc_obligations_kind_ux").on(t.mlcId, t.kind),
    index("er_mlc_obligations_owed_idx").on(t.dueAt).where(sql`${t.metAt} is null`),
    check("er_mlc_obligations_kind_ck", sql`${t.kind} in ('police_intimation', 'faculty_countersign')`),
    check("er_mlc_obligations_met_ck", sql`(${t.metAt} is null) = (${t.metBy} is null)`),
  ],
);

/** A correction or addition to an MLC, by a doctor. Append-only (trigger). */
export const erMlcAddenda = pgTable(
  "er_mlc_addenda",
  {
    id: text("id").primaryKey(),
    mlcId: text("mlc_id").notNull().references(() => erMlcs.id),
    text: text("text").notNull(),
    category: text("category"),
    examinationRefused: boolean("examination_refused").notNull(),
    injuries: jsonb("injuries").$type<{ site: string; kind: string; sizeCm?: string; description?: string }[]>().notNull(),
    authorId: text("author_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("er_mlc_addenda_mlc_idx").on(t.mlcId, t.at),
    check("er_mlc_addenda_category_ck", sql`${t.category} is null or ${t.category} in (${MLC_CATEGORIES_SQL})`),
  ],
);

/** The police intimation (one per case): mode, station, the receiving officer, GD entry number. Append-only (trigger). */
export const erMlcIntimations = pgTable(
  "er_mlc_intimations",
  {
    id: text("id").primaryKey(),
    mlcId: text("mlc_id").notNull().references(() => erMlcs.id),
    mode: text("mode").notNull(),
    station: text("station").notNull(),
    receiverName: text("receiver_name").notNull(),
    receiverRank: text("receiver_rank"),
    gdEntryNo: text("gd_entry_no"),
    intimatedAt: timestamp("intimated_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("er_mlc_intimations_mlc_ux").on(t.mlcId),
    check("er_mlc_intimations_mode_ck", sql`${t.mode} in ('written', 'phone_then_written', 'police_present')`),
  ],
);

/**
 * The custody log: belongings lists and the evidence chain, one numbered link per act, each signed by the recorder and
 * a second person (PIN). Append-only (trigger): a seal moves collected → stored → handed over by NEW links.
 */
export const erMlcCustody = pgTable(
  "er_mlc_custody",
  {
    id: text("id").primaryKey(),
    mlcId: text("mlc_id").notNull().references(() => erMlcs.id),
    link: integer("link").notNull(),
    kind: text("kind").notNull(),
    evidenceKind: text("evidence_kind"),
    description: text("description"),
    sealNo: text("seal_no"),
    action: text("action").notNull(),
    items: jsonb("items").$type<{ description: string; qty: number }[]>(),
    keptIn: jsonb("kept_in").$type<{ kind: string; ref: string }>(),
    receiver: jsonb("receiver").$type<{ name: string; rank: string; station: string }>(),
    recordedBy: text("recorded_by").notNull(),
    witnessedBy: text("witnessed_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("er_mlc_custody_link_ux").on(t.mlcId, t.link),
    index("er_mlc_custody_seal_idx").on(t.mlcId, t.sealNo),
    check("er_mlc_custody_kind_ck", sql`${t.kind} in ('belongings', 'evidence')`),
    check("er_mlc_custody_action_ck", sql`(${t.kind} = 'belongings' and ${t.action} = 'listed') or (${t.kind} = 'evidence' and ${t.action} in ('collected', 'stored', 'handed_over') and ${t.sealNo} is not null)`),
    check("er_mlc_custody_receiver_ck", sql`(${t.action} = 'handed_over') = (${t.receiver} is not null)`),
    check("er_mlc_custody_witness_ck", sql`${t.witnessedBy} <> ${t.recordedBy}`),
  ],
);
