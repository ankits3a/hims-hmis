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

/**
 * ER review 2 (2026-10-15, DECIDED) — `return_er_med`: one per issue. `returned` = an UNOPENED unit back to ER-SAT and
 * its charge reversed; `wasted` = an OPENED unit, no stock movement (the issue took it), the charge stands unless the
 * bill desk waives it; a high-alert or controlled drug's wastage names a PIN-confirmed witness.
 */
export const erMedReturns = pgTable(
  "er_med_returns",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => erMedIssues.id),
    episodeId: text("episode_id").notNull().references(() => erEpisodes.id),
    kind: text("kind").notNull(),
    units: integer("units").notNull(),
    reason: text("reason").notNull(),
    witnessedBy: text("witnessed_by"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("er_med_returns_issue_ux").on(t.issueId),
    check("er_med_returns_kind_ck", sql`${t.kind} in ('returned', 'wasted')`),
    check("er_med_returns_units_ck", sql`${t.units} > 0`),
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
    /** ER review 2 (2026-10-15): what the called doctor said when answering ("coming in 10 min"). */
    answerNote: text("answer_note"),
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
