import { sql } from "drizzle-orm";
import {
  bigserial, boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * OPD module tables (Plan 07). Kernel-located by the shipped one-migration-dir convention; ownership
 * is code discipline — only modules/opd touches them (spec §4). Text ids are ULIDs via newId() and are
 * NEVER an ordering key (ids.ts WARNING, ledger §3.26): arrival order is opd_queue_entries.seq (bigserial),
 * recency is a timestamp. Dates are IST calendar dates stored as 'YYYY-MM-DD' strings (mode: "string");
 * instants are timestamptz.
 *
 * Deliberately NO foreign key from any OPD table into users or workflow_instances (plain text ids — the
 * patient_merge_requests.approval_id precedent), so the twelve tables join exactly ONE truncate group
 * (the patients statement in test/helpers/db.ts).
 */

/** Single audited config row (id = 'main'), seeded by scripts/seed-opd.ts. Missing ⇒ every OPD write hard-fails (no fallbacks). */
export const opdConfig = pgTable("opd_config", {
  id: text("id").primaryKey(),
  slotMinutes: integer("slot_minutes").notNull().default(10), // owner decision: 10-minute slots
  followUpDefaultDays: integer("follow_up_default_days").notNull().default(7), // §11.1 default; owner: 7
  followUpExtensionDays: jsonb("follow_up_extension_days").notNull(), // number[] — the values a doctor may set: [15, 21, 30]
  extensionCapPerDoctorPerMonth: integer("extension_cap_per_doctor_per_month").notNull().default(30), // §11.19-C fix 14
  maxSkipsBeforeLeft: integer("max_skips_before_left").notNull().default(3),
  perkEveryNth: integer("perk_every_nth"), // E-32 bounded interleave; null = off. Plan 09 sets it.
  dangerRanges: jsonb("danger_ranges").notNull(), // DangerRangesConfig (modules/opd/config.ts) — age-banded thresholds + required fields
  letterhead: jsonb("letterhead").notNull(), // { name: string; addressLines: string[] } — printed on the e-Rx
  // RC-1 T2 / D3 — the counter flow the seat's lock pill wears. Two axes: SEQUENCE
  // (`queue_first` — today's shipped behaviour — or `bill_first`, served by the deferred queue
  // join) and TOKEN LANE (`token_first` or `token_on_payment` — printing and stamps only; token
  // allocation never moves with it, and the lane is meaningful only under `queue_first`).
  // Text + zod like every enum here: the same schemas guard read and write, no CHECK.
  counterSequence: text("counter_sequence").notNull().default("queue_first"),
  tokenLane: text("token_lane").notNull().default("token_first"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const opdDepartments = pgTable(
  "opd_departments",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // short stable code, e.g. 'MED', 'PED' — printed on token slips
    name: text("name").notNull(),
    // RC-1 T2 / D7 — wait v0 is `waitingCount × avgConsultMinutes`, minutes AND a clock time on
    // the seat. A future pace model replaces THIS COLUMN'S READ, not the wire shape.
    avgConsultMinutes: integer("avg_consult_minutes").notNull().default(6),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_departments_code_ux").on(t.code)],
);

/**
 * PLAN 13 T7 — **`opd_rooms` IS GONE.** It stood here from Plan 07 until 2026-08-27; `0032` copied
 * every row into `resources` with its id preserved and repointed both foreign keys, and `0033`
 * dropped the table after that migration had been deployed to production and verified.
 *
 * A room is a `resources` row of kind `'room'` (`schema/resources.ts`), reached through
 * `modules/opd/masters.ts`'s `listRooms`/`createRoom`/`updateRoom`, whose external shape is
 * unchanged — that is DD9, and it is why no controller, no contract and no screen moved with the
 * table. The absence is recorded rather than left as a gap because "where did the room table go" is
 * the first question a reader of this file will have.
 */

/** Doctor profile — a Plan 02 user (user_id, plain text, no FK) with one primary OPD department. */
export const opdDoctors = pgTable(
  "opd_doctors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(), // users.id — plain text (see header)
    displayName: text("display_name").notNull(), // shown on displays, slips, e-Rx
    registrationNo: text("registration_no"), // NMC/state council registration — printed on the e-Rx
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    specialty: text("specialty"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_doctors_user_ux").on(t.userId), index("opd_doctors_department_idx").on(t.departmentId)],
);

/** Weekly availability template. Times are IST 'HH:MM'. Slots are derived, never materialised (slots.ts). */
export const opdDoctorSchedules = pgTable(
  "opd_doctor_schedules",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    weekday: integer("weekday").notNull(), // 0 = Sunday … 6 = Saturday (IST calendar)
    startTime: text("start_time").notNull(), // 'HH:MM'
    endTime: text("end_time").notNull(), // 'HH:MM', exclusive
    // PLAN 13 T6 — REPOINTED at the registry. The value is UNCHANGED: room ids are ULIDs, so
    // `0032` preserved every one of them and only this foreign key's TARGET moved.
    roomId: text("room_id").notNull().references(() => resources.id),
    slotMinutes: integer("slot_minutes"), // null ⇒ opd_config.slot_minutes
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }), // null = open-ended
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opd_doctor_schedules_doctor_idx").on(t.doctorId)],
);

/** Planned leave (§11.5 cascade): blocks slots, marks affected bookings needs_rebooking. */
export const opdDoctorLeaves = pgTable(
  "opd_doctor_leaves",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }).notNull(), // inclusive
    reason: text("reason").notNull(),
    status: text("status").notNull().default("scheduled"), // 'scheduled' | 'cancelled'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [index("opd_doctor_leaves_doctor_idx").on(t.doctorId)],
);

export const opdAppointments = pgTable(
  "opd_appointments",
  {
    id: text("id").primaryKey(),
    // `A2608250042` — numbered on the SLOT's date, not the booking instant, so the day's list
    // reads 1..N in the order the desk will work it. A reschedule mints a NEW appointment row
    // (rescheduledToId/rescheduledFromId), which therefore takes a fresh number on its new date;
    // the old number is burned, which is fine because this series is not gapless.
    appointmentNo: text("appointment_no").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(), // IST calendar date of slot_start
    slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
    slotEnd: timestamp("slot_end", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"), // 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'needs_rebooking' | 'rescheduled'
    source: text("source").notNull().default("desk"), // 'desk' | 'phone' — the booking channel (self-booking arrives Plan 10)
    note: text("note"),
    encounterId: text("encounter_id"), // set on check-in; plain text (encounters FK appointments, not the reverse)
    rescheduledToId: text("rescheduled_to_id"),
    rescheduledFromId: text("rescheduled_from_id"),
    cancelReason: text("cancel_reason"),
    leaveId: text("leave_id"), // set when needs_rebooking was caused by a leave (cancelling that leave restores 'booked')
    bookedBy: text("booked_by").notNull(),
    bookedAt: timestamp("booked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * PLAN 07c T8 / DD13 — THE COMPOSITE `(actor, date)` INDEX THE PER-PERSON BRIEF NEEDS.
     *
     * Measured at kickoff: this table had NO index on its actor column, alone or paired with a
     * date, and neither did any of the other seven a brief touches. Every "what did I do" query was
     * a sequential scan, and at 2,000 visits/day a six-month window is millions of rows. The nightly
     * roll (`user_day_facts`) is what keeps the long windows off the primary tables — this index is
     * what keeps the ROLL itself cheap, since it runs once per active user per night.
     */
    index("opd_appointments_booked_by_at_idx").on(t.bookedBy, t.bookedAt),
    // ONE live booking per doctor-slot — the arbiter for the booking race (single loser code: slot_taken).
    uniqueIndex("opd_appointments_slot_ux")
      .on(t.doctorId, t.slotStart)
      .where(sql`${t.status} in ('booked', 'checked_in', 'needs_rebooking')`),
    uniqueIndex("opd_appointments_appointment_no_ux").on(t.appointmentNo),
    index("opd_appointments_doctor_date_idx").on(t.doctorId, t.serviceDate),
    index("opd_appointments_patient_idx").on(t.patientId),
    index("opd_appointments_status_idx").on(t.status),
  ],
);

/** One row per doctor per IST day: the token counter, the call counter, in/out status, the room. */
export const opdQueueSessions = pgTable(
  "opd_queue_sessions",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    // PLAN 13 T6 — REPOINTED at the registry, like the schedules FK above. NULLABLE here and NOT
    // NULL there, which is why the backfill's precondition guard is load-bearing (A11): an orphan
    // behind the NOT NULL one halts the migration rather than being migrated.
    roomId: text("room_id").references(() => resources.id), // from the day's schedule template; null if unscheduled
    status: text("status").notNull().default("not_started"), // 'not_started' | 'in' | 'out' | 'closed'
    nextToken: integer("next_token").notNull().default(1), // allocated by UPDATE … SET next_token = next_token + 1 RETURNING
    callsMade: integer("calls_made").notNull().default(0), // drives the E-32 every-Nth interleave
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * PLAN 07c T6 — WHO OPENED AND WHO CLOSED THE DOCTOR-DAY.
     *
     * Measured at kickoff: this table stamped WHEN and never WHO, and `setSessionStatus` — its only
     * writer — appended no event at all. So *"who opened Dr Rao's queue this morning"* was
     * unanswerable from any table and from the event log alike, and the consequence is bigger than a
     * missing audit column: **a session that never opened produces no waiting alert**, because
     * nobody can be waiting on a queue that does not exist yet. Silent lateness was the one thing a
     * supervisor's desk most needed to show and the one thing nothing in the system recorded.
     *
     * NULLABLE, and permanently so: every row written before this migration has no answer, and a
     * backfilled guess about who opened a queue three weeks ago would be worse than the gap. Null
     * means "not recorded", which is true.
     *
     * PLAIN TEXT, NO FOREIGN KEY — this file's own header rule, followed rather than re-litigated:
     * no OPD table references `users`, so the twelve of them stay in ONE truncate group in
     * `test/helpers/db.ts`. `opened_by` on `opd_encounters` is stored the same way.
     */
    openedBy: text("opened_by"),
    closedBy: text("closed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_queue_sessions_doctor_date_ux").on(t.doctorId, t.serviceDate)],
);

/**
 * The encounter spine (spec §6). type is an OPEN text enum ('opd' now; 'ipd' | 'er' | 'teleconsult' later) and every
 * clinical/assignment column is nullable so later encounter types need no redesign. status MIRRORS the workflow
 * instance's current state and is written ONLY by encounters.ts moveEncounter, in the same transaction as
 * transition() — the instance is the arbiter, this column is the read model.
 */
export const opdEncounters = pgTable(
  "opd_encounters",
  {
    id: text("id").primaryKey(),
    // The human-facing visit number — `V2608250147` (kernel/episodes/series.ts). ONE PER
    // ENCOUNTER, INCLUDING SAME-DAY RE-ENTRY: a patient sent back through the queue after lab
    // results re-enters on a new opd_queue_entries row that REUSES the token, and this encounter
    // — with this number — is still the visit those results belong to. Minting a second number
    // there would attach the result to a visit that never ordered it.
    visitNo: text("visit_no").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id), // canonical id at open; merged-loser history is found via listMergedLoserIds
    type: text("type").notNull().default("opd"),
    status: text("status").notNull().default("registered"), // opd_visit states: registered | waiting | in_consultation | awaiting_results | completed | abandoned
    workflowInstanceId: text("workflow_instance_id").notNull(), // workflow_instances.id — plain text (see header)
    departmentId: text("department_id").references(() => opdDepartments.id),
    doctorId: text("doctor_id").references(() => opdDoctors.id),
    appointmentId: text("appointment_id").references(() => opdAppointments.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    visitType: text("visit_type").notNull(), // 'new' | 'revisit' | 'renewal' — auto-detected at open (visit-type.ts); Plan 08's fee branch
    intendedPayer: text("intended_payer").notNull().default("self"), // 'self' | 'tpa' | 'pmjay' | 'corporate' (§6)
    referralSource: text("referral_source"), // 'self' | 'internal_doctor' | 'external_rmp' | 'camp' | 'other' — attribution capture (§6); Plan 09 uses it
    referrerName: text("referrer_name"),
    // Consultation record (T7) — nullable until the doctor writes it.
    chiefComplaint: text("chief_complaint"),
    diagnosis: text("diagnosis"),
    icd10Code: text("icd10_code"), // §11.19-E fix 31: capturable at consult, not only at MRD coding
    advice: text("advice"),
    admissionAdvised: boolean("admission_advised").notNull().default(false),
    /**
     * PLAN 07d T5 / DD4 — **ADVISED TESTS, WHICH ARE ADVICE AND NOT AN ORDER.**
     *
     * `AdvisedTest[]`: the priced services a doctor selected during the consultation, each carrying
     * the price AS OF THE MOMENT OF ADVICE. It creates no order, books no sample and returns no
     * result — there is no lab or radiology module in this system, no order table, no result table
     * and no accession (measured, §2). What it is instead is the thing an Indian hospital actually
     * does before a LIMS lands: the doctor writes the tests on the slip with what they cost, the
     * patient takes it to the counter, and somebody bills them.
     *
     * ═══ THE PRICE IS COPIED, NOT REFERENCED, AND THAT IS THE DECISION ═══
     *
     * A price stored beside the service id is a snapshot; a price looked up at print time is
     * whatever the tariff says today. E-9 is explicit that the slip carries the AS-OF date and the
     * counter reprices — so the snapshot is what makes the printed sheet honest about being a
     * quotation from a particular afternoon rather than a promise.
     *
     * A COLUMN, NOT A TABLE. DD7 forbids new tables and this respects it: the purpose of that rule
     * is to stop this phase building the ordering pipeline that belongs to Plan 17, and a list of
     * names and prices on the encounter is the opposite of an order. It is also what makes the
     * DEMAND SIGNAL real — DD4 says the selections tell Plan 17 which tests to carry first, and a
     * selection that was never persisted tells nobody anything.
     */
    advisedTests: jsonb("advised_tests"),
    referralTo: text("referral_to"),
    referralNote: text("referral_note"),
    followUpDays: integer("follow_up_days"), // stamped at completion: config default or an extension value
    followUpExtended: boolean("follow_up_extended").notNull().default(false),
    dangerFlagged: boolean("danger_flagged").notNull().default(false), // set by vitals; never auto-cleared in Plan 07
    consultStartedAt: timestamp("consult_started_at", { withTimezone: true }),
    consultCompletedAt: timestamp("consult_completed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    abandonReason: text("abandon_reason"),
    openedBy: text("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * PLAN 07c T8 / DD13 — THE COMPOSITE `(actor, date)` INDEX THE PER-PERSON BRIEF NEEDS.
     *
     * Measured at kickoff: this table had NO index on its actor column, alone or paired with a
     * date, and neither did any of the other seven a brief touches. Every "what did I do" query was
     * a sequential scan, and at 2,000 visits/day a six-month window is millions of rows. The nightly
     * roll (`user_day_facts`) is what keeps the long windows off the primary tables — this index is
     * what keeps the ROLL itself cheap, since it runs once per active user per night.
     */
    index("opd_encounters_opened_by_date_idx").on(t.openedBy, t.serviceDate),
    // Visit-type detection: newest completed consult of this patient in this department.
    uniqueIndex("opd_encounters_visit_no_ux").on(t.visitNo),
    index("opd_encounters_patient_dept_completed_idx").on(t.patientId, t.departmentId, t.consultCompletedAt),
    // Extension cap: this doctor's extended completions in an IST month.
    index("opd_encounters_doctor_completed_idx").on(t.doctorId, t.consultCompletedAt),
    index("opd_encounters_doctor_date_idx").on(t.doctorId, t.serviceDate),
    index("opd_encounters_patient_opened_idx").on(t.patientId, t.openedAt),
    index("opd_encounters_status_idx").on(t.status),
  ],
);

/** Queue rows. seq is the arrival order (bigserial — never the ULID id). One live row per encounter at a time. */
export const opdQueueEntries = pgTable(
  "opd_queue_entries",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    sessionId: text("session_id").notNull().references(() => opdQueueSessions.id),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    tokenNo: integer("token_no").notNull(), // per doctor-day; a re-entry row REUSES the token
    kind: text("kind").notNull(), // 'appointment' | 'walk_in'
    appointmentAt: timestamp("appointment_at", { withTimezone: true }), // slot_start for appointments; null for walk-ins
    status: text("status").notNull(), // 'waiting_vitals' | 'waiting' | 'called' | 'in_consult' | 'done' | 'left' | 'transferred' | 'cancelled'
    danger: boolean("danger").notNull().default(false), // class 0
    reEntry: boolean("re_entry").notNull().default(false), // class 1 (same-day return with results)
    perk: boolean("perk").notNull().default(false), // E-32 hook — Plan 09 sets it; never true in Plan 07
    eligibleAt: timestamp("eligible_at", { withTimezone: true }), // set when the row becomes 'waiting' (and reset on a skip)
    calledAt: timestamp("called_at", { withTimezone: true }),
    callCount: integer("call_count").notNull().default(0),
    skips: integer("skips").notNull().default(0),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opd_queue_entries_session_status_idx").on(t.sessionId, t.status),
    index("opd_queue_entries_encounter_idx").on(t.encounterId),
  ],
);

export const opdVitals = pgTable(
  "opd_vitals",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    heightCm: doublePrecision("height_cm"),
    weightKg: doublePrecision("weight_kg"), // §11.8: the pediatric weight context — required under 18
    sbp: integer("sbp"),
    dbp: integer("dbp"),
    pulse: integer("pulse"),
    rr: integer("rr"),
    spo2: integer("spo2"),
    tempC: doublePrecision("temp_c"),
    notes: text("notes"),
    ageYearsAtRecord: integer("age_years_at_record"), // null when DOB unknown (adult band applied)
    band: text("band").notNull(), // 'infant' | 'child_1_5' | 'child_6_12' | 'adult'
    dangerFlags: jsonb("danger_flags").notNull(), // DangerFlag[] — [] when normal
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * PLAN 07c T8 / DD13 — THE COMPOSITE `(actor, date)` INDEX THE PER-PERSON BRIEF NEEDS.
     *
     * Measured at kickoff: this table had NO index on its actor column, alone or paired with a
     * date, and neither did any of the other seven a brief touches. Every "what did I do" query was
     * a sequential scan, and at 2,000 visits/day a six-month window is millions of rows. The nightly
     * roll (`user_day_facts`) is what keeps the long windows off the primary tables — this index is
     * what keeps the ROLL itself cheap, since it runs once per active user per night.
     */
    index("opd_vitals_recorded_by_at_idx").on(t.recordedBy, t.recordedAt),
    index("opd_vitals_encounter_idx").on(t.encounterId),
    index("opd_vitals_patient_idx").on(t.patientId),
  ],
);

/** Versioned per encounter; a re-issue supersedes. document is a FHIR-shaped Bundle (fhir.ts). */
export const opdPrescriptions = pgTable(
  "opd_prescriptions",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    version: integer("version").notNull(), // 1, 2, … per encounter (allocated under a FOR UPDATE of the encounter row)
    lines: jsonb("lines").notNull(), // RxLine[]
    document: jsonb("document").notNull(), // FHIR Bundle
    allergyOverrides: jsonb("allergy_overrides").notNull(), // AllergyOverride[] — [] when none
    /**
     * PLAN 16a close remediation (independent review C4) — THE REASONS ARE THE RECORD.
     *
     * A doctor who prescribes through a SEVERE interaction is required to type why. Until these two
     * columns existed that justification lived only in the request body: length-checked, counted on
     * the KPI event, and then dropped. There was no medico-legal record of the decision and no way
     * to recover it — while `allergy_overrides` beside it kept exactly that record for the milder
     * warning. Both default to `[]` for every row written before this migration.
     */
    interactionOverrides: jsonb("interaction_overrides").notNull().default(sql`'[]'::jsonb`),
    duplicateOverrides: jsonb("duplicate_overrides").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("active"), // 'active' | 'superseded'
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * PLAN 07c T8 / DD13 — THE COMPOSITE `(actor, date)` INDEX THE PER-PERSON BRIEF NEEDS.
     *
     * Measured at kickoff: this table had NO index on its actor column, alone or paired with a
     * date, and neither did any of the other seven a brief touches. Every "what did I do" query was
     * a sequential scan, and at 2,000 visits/day a six-month window is millions of rows. The nightly
     * roll (`user_day_facts`) is what keeps the long windows off the primary tables — this index is
     * what keeps the ROLL itself cheap, since it runs once per active user per night.
     */
    index("opd_prescriptions_issued_by_at_idx").on(t.issuedBy, t.issuedAt),
    uniqueIndex("opd_prescriptions_encounter_version_ux").on(t.encounterId, t.version),
    index("opd_prescriptions_patient_idx").on(t.patientId),
  ],
);
