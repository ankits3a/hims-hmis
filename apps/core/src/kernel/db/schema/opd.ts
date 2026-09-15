import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, primaryKey,
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
    /**
     * ═══ FD-29 — THE DOCTOR ID THE PRESCRIPTION PRINTS (owner, 2026-09-06) ═══
     *
     * *"As a medical Institution with college, there's no need of mentioning Dr. Name and their
     * registration number. Only Dr. ID is required."* The A4 letterhead had been printing the name
     * and the council number because THIS COLUMN DID NOT EXIST — `DR-0114` appeared in five design
     * canvases and nowhere in the schema, and a sheet cannot print a field the system does not hold.
     *
     * MINTED, NOT REQUIRED OF THE ADMIN: `nextDoctorCode` assigns `DR-` + four digits at creation,
     * so no doctor is ever without one and no clerk has to invent a numbering scheme. It is
     * OVERRIDABLE through `updateDoctor` for a hospital that already issues faculty numbers of its
     * own — which a medical college does. Unique, because a shared id on a prescription identifies
     * nobody.
     *
     * NOT `registrationNo`, which stays: that is the NMC/state-council number, it is a different
     * fact about a different authority, and the e-Rx still prints it.
     */
    code: text("code").notNull(),
    registrationNo: text("registration_no"), // NMC/state council registration — printed on the e-Rx
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    specialty: text("specialty"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("opd_doctors_user_ux").on(t.userId),
    uniqueIndex("opd_doctors_code_ux").on(t.code),
    index("opd_doctors_department_idx").on(t.departmentId),
  ],
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
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-20 — THE TOKEN SERIES IS THE DEPARTMENT'S, NOT THE DOCTOR'S
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"the token number should be not according to the doctor but Department. For
 * Example it should be 'MED - 4', 'PED - 290'."*
 *
 * This is what `opd_departments.code` was always for — its own comment has said "e.g. 'MED', 'PED'
 * — printed on token slips" since it was written, and nothing printed them.
 *
 * ═══ WHY A TABLE AND NOT `opd_queue_sessions.next_token` ═══
 *
 * A session is a DOCTOR-DAY, so its counter restarts per doctor: three doctors sitting in Medicine
 * all issued a token 1, and the hall heard "number 4" called three times for three different
 * people. The counter has to live where the series does — one per department per day — and the
 * allocation is the same UPDATE … RETURNING pattern `allocateToken` already used, moved one level
 * out. `next_token` stays on the session: existing rows keep meaning what they meant, and nothing
 * reads it after this change.
 *
 * DAY-SCOPED, so Monday starts at 1 again. `service_date` is the IST calendar day the rest of this
 * schema already keys visits by, not a timestamp.
 */
export const opdDepartmentTokens = pgTable(
  "opd_department_tokens",
  {
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    /** Allocated by INSERT … ON CONFLICT DO UPDATE SET next_token = next_token + 1 RETURNING. */
    nextToken: integer("next_token").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.departmentId, t.serviceDate] })],
);

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
    /**
     * ═══ FD-7 T9 / OWNER RULING R4 — THE CHANNEL-PARTNER SLIP, GIVEN A HOME ═══
     *
     * `attributionCode` was a per-request parameter and nothing else — handed to `feeQuote` and to
     * `issueInvoice` on every call and stored nowhere in between. `charge-rules.ts` says in its own
     * comment that "the clerk attaches the slip during registration, long before billing is opened",
     * and there was no column for it to be attached TO, so the cashier had to re-type it or lose it.
     *
     * ON THE ENCOUNTER rather than the patient, because a slip is ONE PER VISIT (V6). It is the CODE
     * as presented, not a foreign key: `attribution_ids` is the partner's own issue book, the code
     * may be typed before anyone has looked it up, and billing is the surface that validates the
     * code binds to this patient (RC-2 review MAJOR 5). Storing an unvalidated string here and
     * validating it where the money is decided keeps the desk fast and the guard in one place.
     */
    attributionCode: text("attribution_code"),
    /**
     * ═══ FD-32 — PAY BEFORE VITALS, AND THE DOOR THAT OPENS ANYWAY (OWNER RULING 2026-09-13) ═══
     *
     * Owner: *"No patient should reach vitals desk until he has paid. However, in case of emergency
     * or VIP patient, the front desk could enable the patient to bypass the billing with a warning
     * sign/disclaimer/notification on each desk where the patient goes."*
     *
     * So the guard is not a lock — it is a door with a named person's hand on it. `feeBypassBy` is
     * that person, `feeBypassReason` is what they typed, and neither is nullable-by-accident: the
     * bypass exists only where all three are set together.
     *
     * ON THE ENCOUNTER AND NOT ON A CONFIG FLAG, deliberately. A hospital-wide "skip billing" switch
     * is a switch somebody leaves on; this is per-visit, per-patient, and carries the name of the
     * clerk who opened it to every desk downstream. The marker the owner asked for on the vitals
     * bay, the consultation and the OPD Order Desk is rendered FROM THESE COLUMNS, so the warning
     * and the authority that created it can never drift apart.
     *
     * It does NOT mean "free". The fee is still owed and the bill is still raised; what was waived
     * is the ORDER of the two, which is why nothing here touches the ledger.
     */
    feeBypassBy: text("fee_bypass_by"),
    feeBypassReason: text("fee_bypass_reason"),
    feeBypassAt: timestamp("fee_bypass_at", { withTimezone: true }),
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COMPLAINT VOCABULARY — MANY PHRASINGS, ONE MEANING, AND THE DOCTOR'S WORDS UNTOUCHED
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: *"how are we tackling 'chest pain', 'pain in chest', 'tight chest', 'heavy
 * chest', 'seene me dard', 'chhaati me dard'? Are we mapping different phrases with common meaning?
 * And is our system learning vocabulary of doctor?"*
 *
 * Measured before any of this: the answer was NO to both. The suggester read 64 English strings
 * built at module load from `knowledge.json` — zero Devanagari, zero romanised Hindi, no synonyms —
 * and nothing ever wrote to it. A doctor typing `seene me dard` five hundred times got no
 * suggestion on the five hundred and first.
 *
 * ═══ THE SHAPE IS THE ONE THIS LANE HAS USED THREE TIMES ═══
 *
 * Diagnosis keeps the doctor's words AND an ICD-10 code. An allergy keeps the words and an allergen
 * class. A prescription line keeps the words and a medicine id. In every case the free text is what
 * is stored and shown, and the code is what a machine may reason about. A complaint gets the same
 * treatment: `opd_encounters.chief_complaint` still holds exactly what the doctor typed — nothing
 * here changes that, and `TagField`'s law is untouched — and a CONCEPT is what the syndrome matcher
 * and the worklist read.
 *
 * ═══ THE CONCEPT IS NOT STORED ON THE ENCOUNTER, AND THAT IS DELIBERATE ═══
 *
 * It is RESOLVED from the term wherever it is needed. Storing it would freeze a mapping that is
 * still being learnt: map `seene me dard` next month and every note written before it would
 * silently disagree with every note written after. Resolution at read time means a mapping improves
 * the past as well as the future, which is what a vocabulary that is still growing requires.
 */
export const opdComplaintConcepts = pgTable(
  "opd_complaint_concepts",
  {
    /** A stable key, e.g. `chest_pain`. Referenced by terms and by nothing that a doctor types. */
    key: text("key").primaryKey(),
    /** What a human calls it on the mapping screen. Never shown in place of the doctor's words. */
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * One surface form. `chest pain`, `seene me dard` and `सीने में दर्द` are three rows of one concept.
 *
 * ═══ ROMANISED HINDI IS STORED, NOT TRANSLITERATED ═══
 *
 * There is no standard romanisation: `seene`, `sine` and `seenay` are all things a doctor types,
 * and an algorithm that mapped one would miss the others while inventing forms nobody uses. So each
 * spelling is a ROW, and the ones that matter are discovered from what doctors actually type
 * (`opd_complaint_term_usage`) rather than imagined in advance.
 */
export const opdComplaintTerms = pgTable(
  "opd_complaint_terms",
  {
    id: text("id").primaryKey(),
    conceptKey: text("concept_key").notNull().references(() => opdComplaintConcepts.key),
    term: text("term").notNull(),
    /** `en` | `hi` (Devanagari) | `hinglish` (Hindi in Latin letters). Shown on the mapping screen. */
    script: text("script").notNull(),
    /** `seed` — shipped; `mapped` — a human mapped it off the worklist. Never a machine alone. */
    source: text("source").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One surface form means ONE thing. Two concepts claiming `cough` is a coin toss at every keystroke. */
    uniqueIndex("opd_complaint_terms_term_ux").using("btree", sql`lower(${t.term})`),
    index("opd_complaint_terms_concept_idx").on(t.conceptKey),
    check("opd_complaint_terms_script_ck", sql`${t.script} in ('en', 'hi', 'hinglish')`),
    check("opd_complaint_terms_source_ck", sql`${t.source} in ('seed', 'mapped')`),
  ],
);

/**
 * ═══ WHAT THIS HOSPITAL ACTUALLY TYPES — THE LEARNING, AND IT NEEDS NO MODEL ═══
 *
 * `curation.ts` already states the philosophy this tree believes in: *the prescribing stream is the
 * worklist* — coverage grows along the path of actual use rather than by somebody trying to type an
 * entire pharmacopoeia in. The same move here. Every complaint tag on a COMPLETED consultation is
 * counted, and the suggester ranks by it.
 *
 * Two things follow, and the second is the one that answers the owner's question:
 *
 *   · A phrase a doctor uses is offered back to them, whether or not anyone has mapped it. That is
 *     the vocabulary learning, with no NLP at all — `seene me dard` is suggested on the 51st use
 *     because it was used fifty times, not because a machine understood it.
 *   · The most-used terms with NO concept become a ranked worklist. The synonym sets then grow from
 *     real use, most-frequent first, exactly as `unresolvedTop` grows the formulary.
 *
 * COUNTED ON COMPLETION, ONCE. The note autosaves on every blur, so counting there would inflate a
 * phrase by however many times the doctor tabbed out of the box. A completed consultation happens
 * once per encounter and is the honest unit.
 */
export const opdComplaintTermUsage = pgTable(
  "opd_complaint_term_usage",
  {
    /** Lower-cased surface form, exactly as the doctor committed it apart from case. */
    term: text("term").notNull(),
    /** Whose habit this is. The hospital's total is the sum across doctors. */
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.term, t.doctorId] }),
    /** The worklist reads "most used across the hospital", which is this index. */
    index("opd_complaint_term_usage_uses_idx").on(t.uses),
  ],
);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADVICE LIBRARY — THE ONE FIELD THE PATIENT READS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner's own idea, 2026-09-14: *"a prefilled template saved as a module."* Every other field on
 * the consult screen is read by staff. Advice is read by the patient, at home, tomorrow morning —
 * it prints on the e-Rx (`rx-print.tsx`) — and that is what shapes this table.
 *
 * ═══ WHO OWNS A TEMPLATE: THE HOSPITAL, AND ALSO EACH DOCTOR ═══
 *
 * Owner ruling: a shared library with the doctor's own favourites floated to the top. So
 * `owner_user_id` is NULL for a hospital row and the doctor's id for their own — one table, two
 * scopes, and the list a doctor sees is their rows first and then everyone's. A per-doctor-only
 * design was rejected for a measured reason and not a taste: the list is empty on day one and
 * every new doctor starts cold.
 *
 * ═══ BOTH SCRIPTS ARE STORED; THE DOCTOR CHOOSES WHICH ONE GOES ON THE SLIP ═══
 *
 * Owner ruling: *"Doctor chooses the language per template"* — each template offers its English and
 * its Hindi side by side and tapping inserts only the one tapped. So both live on the row and
 * NEITHER is a translation performed at print time.
 *
 * The i18n layer cannot help here and it is worth being exact about why: `rx.advice` translates the
 * LABEL, and `encounter.advice` is printed verbatim as the value. A patient who reads only
 * Devanagari gets nothing from a translated label above English prose. The script has to be in the
 * stored string, which is why it is in this table.
 *
 * Either column may be null and at least one must not be: a doctor's own template may be written
 * in one script only, and a half-filled row is more useful than no row. The field then offers one
 * button instead of two. What is refused is a row with no text in either script.
 */
export const opdAdviceTemplates = pgTable(
  "opd_advice_templates",
  {
    id: text("id").primaryKey(),
    /** NULL = the hospital's shared library. Otherwise the `users.id` who saved it. */
    ownerUserId: text("owner_user_id"),
    /** The short label on the chip — what the doctor scans for, never what is printed. */
    title: text("title").notNull(),
    /**
     * ═══ THE TYPED KEYWORD, AND WHY IT MUST NOT START INSIDE A WORD ═══
     *
     * Owner, 2026-09-14, asked for Raycast-style snippets: type `;rest` in the advice box and the
     * template expands where the caret is. Null for a template that is only ever TAPPED, which
     * every seeded row is.
     *
     * Expansion fires WHILE THE DOCTOR TYPES, so a keyword of `rest` would detonate inside "rest
     * and fluids", "arrest" and "restrict". `keywordProblem` (web `lib/snippets.ts`) requires a
     * leading `;`, `/` or `\` and the service refuses anything else — the check is on both sides
     * because the browser's is a courtesy and this one is the rule.
     *
     * Unique per owner, case-folded: two of a doctor's own snippets answering to `;uri` is a
     * coin toss about which one expands, and the doctor would never find out which.
     */
    keyword: text("keyword"),
    /**
     * BOTH ARE NULLABLE AND AT LEAST ONE MUST BE PRESENT — see the CHECK below.
     *
     * The first cut had `text_en NOT NULL`, which quietly asserted that every template is written
     * in English first. A doctor who writes their advice in Hindi — for a field the PATIENT reads,
     * in a hospital where most patients read Devanagari — would have had it stored in the English
     * column and offered back under an "English" button. The column would have been lying about
     * its own contents, and nothing would ever have said so.
     */
    textEn: text("text_en"),
    textHi: text("text_hi"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The list is read as "mine, then the hospital's", which is this index in that order. */
    index("opd_advice_templates_owner_idx").on(t.ownerUserId, t.title),
    /** A template with no text at all is not a template. One script is enough; none is not. */
    check("opd_advice_templates_text_ck", sql`${t.textEn} is not null or ${t.textHi} is not null`),
    /**
     * One keyword per owner, case-folded, and NULLs do not collide — Postgres treats them as
     * distinct, which is what lets every tapped-only template leave the column empty.
     */
    uniqueIndex("opd_advice_templates_keyword_ux")
      .on(t.ownerUserId, sql`lower(${t.keyword})`)
      .where(sql`${t.keyword} is not null`),
  ],
);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DIAGNOSES OF ONE ENCOUNTER — ONE ROW EACH, AND EACH ONE KEEPS ITS OWN CODE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: the diagnosis field takes SEVERAL tags — a primary diagnosis and the
 * comorbidities beside it, which is how an OPD note actually reads ("Acute URI · Type 2 DM · HTN").
 *
 * ═══ WHY THIS IS A TABLE WHEN CHIEF COMPLAINT IS NOT ═══
 *
 * `TagField` deliberately changed no schema for chief complaint: the tags join with " · " into the
 * column that was already there, and nothing downstream — the print, the e-Rx, the timeline, the
 * MRD coder's screen — learns a new shape. That works because a complaint is only ever WORDS.
 *
 * A diagnosis is words AND A CODE, and the two must stay married. Three tags of which the second
 * and third carry codes cannot be stored as two parallel " · " strings: the moment one tag is
 * free-typed the lists are different lengths and every reader has to guess the pairing. That is
 * the parallel-array defect this tree keeps finding, and here it would put one patient's ICD-10
 * code against another patient's diagnosis on a claim.
 *
 * So the structured truth lives here, one row per diagnosis, `seq` in the order the doctor wrote
 * them — and `opd_encounters.diagnosis` / `.icd10_code` are still written as the de-normalised
 * DISPLAY values, so every existing reader is untouched. Normalise for the data, de-normalise for
 * the document: the reader that needs the pairing joins this table, and the print does not have to.
 *
 * ═══ NO FOREIGN KEY TO `icd10_codes`, ON PURPOSE ═══
 *
 * `icd10_code` is nullable and unconstrained. A doctor may write a diagnosis this catalogue has
 * never heard of — the same law the drug field keeps — and a reference table able to REFUSE one
 * would turn a foreign standard's coverage into a clinical constraint. Null is the ordinary case
 * for a free-typed tag, not an error.
 */
export const opdEncounterDiagnoses = pgTable(
  "opd_encounter_diagnoses",
  {
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    /** 0-based, the order the doctor committed them. `seq` 0 is the primary diagnosis. */
    seq: integer("seq").notNull(),
    /** EXACTLY what the doctor committed — the field never rewrites the doctor's words. */
    text: text("text").notNull(),
    /** The catalogue code when the tag was PICKED; null when it was typed. */
    icd10Code: text("icd10_code"),
  },
  (t) => [
    primaryKey({ columns: [t.encounterId, t.seq] }),
    /** MRD and every claim count by code, so the code is the one thing read across encounters. */
    index("opd_encounter_diagnoses_code_idx").on(t.icd10Code),
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
    /**
     * ═══ THE PARKED CONSULTATION — the patient who stepped out mid-consultation ═══
     *
     * Owner, 2026-09-13: *"in between the patient decide to stop and he gets outside for 15
     * minutes … I need to have an option to park that patient on dashboard and call next patient."*
     *
     * Set when the doctor parks; null the rest of the time. **NOT A `status` VALUE, for the same
     * reason `bench_state` is not one** (D3, above): the row must stay `in_consult`, because that
     * is the value every callable filter in this module already excludes and the value that keeps
     * the encounter's own workflow state at `in_consultation` — a parked patient's half-written
     * note, prescription and vitals stay exactly where the doctor left them, and resuming is one
     * column write rather than a second consultation.
     *
     * It is what separates "with the doctor now" from "held aside, gone for a cup of tea", and
     * before it the two were the same row: the doctor called the next token, the previous patient
     * stayed `in_consult` and **no screen rendered `in_consult` rows at all**, so a patient who had
     * been half-seen vanished from the hall with their visit still open.
     *
     * `parked_by` is plain text and no FK — this file's header rule for actor columns.
     */
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    parkedBy: text("parked_by"),
    /**
     * ═══ THE SKIP, AND WHY IT NOW SAYS WHAT IT WAS FOR ═══
     *
     * Owner, 2026-09-13: *"doctors do not have any input box or pre-identified reason to select as
     * a reason to why the doctor has to skip the patient … it should be auditable. right?"*
     *
     * It should, and it was not. `skips` counted and `queue.skipped` recorded WHO and WHEN, and the
     * one question a skip exists to answer — why is this patient not being seen — was recorded
     * nowhere. Measured the same day in the owner's own data: one patient reached the three-skip cap
     * and left the queue with her visit still `waiting`, and no row in this database could say
     * whether she had gone to pay a bill or gone home.
     *
     * `skip_reason` is a CODED value from `SKIP_REASONS` (queue.ts) and never free text, for the
     * reason `unlock_reason` is: a coded reason can be counted, and "how many patients missed their
     * turn because billing was slow" is a question a hospital gets to ask. `skip_note` is the free
     * text that rides beside it, mandatory only under `other`.
     *
     * `pre_skip_eligible_at` IS THE UNDO, and it is the whole reason this is four columns and not
     * two. A skip moves `eligible_at` to now — that is what losing your turn MEANS here — so an undo
     * that did not restore it would hand the patient back a place at the end of the queue and call
     * it a correction. The column holds the turn the patient had before the most recent skip; one
     * undo restores it, and a second has nothing left to restore and says so.
     */
    skipReason: text("skip_reason"),
    skipNote: text("skip_note"),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    skippedBy: text("skipped_by"),
    preSkipEligibleAt: timestamp("pre_skip_eligible_at", { withTimezone: true }),
    /**
     * ═══ VD-1 T1 / D3 — THE BENCH, AND WHY IT IS NOT A STATUS ═══
     *
     * `null` | `'resting'` | `'away'`. Where a patient physically is between arriving at the bay
     * and having her vitals taken: on the rest chairs for a five-minute recheck, or stepped out
     * with her turn held.
     *
     * **THESE ARE NOT `status` VALUES AND NOT WORKFLOW STATES, AND BOTH halves matter.** Not
     * `status`, because the row must stay `waiting_vitals` — that is the value `listQueue`'s
     * callable filter excludes, and a resting patient who became callable is exactly the accident
     * this seat exists to prevent. Not a workflow state, because `opd_visit` is a **Class A**
     * definition (`workflow-def.ts`): a new state costs owner + medical-superintendent two-key
     * approval and a definition version, and the engine gates its transitions on ROLE KEYS rather
     * than permissions, so the bay's sub-states would have to be re-granted as definition data to
     * say something the queue already knows.
     *
     * The turn is held by the `seq` the row already has. Coming back from `away` is one column
     * write and no re-queue, which is the whole point: *"her turn was held, not lost."*
     */
    benchState: text("bench_state"),
    /** When a `resting` patient is due back. The recall lives on the bench in peripheral vision — a rest timer in a drawer is a forgotten patient. */
    recallAt: timestamp("recall_at", { withTimezone: true }),
    /**
     * ═══ VD-1 T1 / D4 — THE ESCALATION, AND THE ONE THING CANCEL MOVES ═══
     *
     * `'none' | 'recheck_demanded' | 'escalated' | 'cancelled'`. The danger protocol the owner
     * ruled on 31-Aug: ONE danger reading only demands the other arm now; a DOUBLE-CONFIRMED one
     * lets the agent set queue class 0 by itself, with ten seconds to cancel at the desk.
     *
     * **THIS IS A QUEUE FACT AND `opd_encounters.danger_flagged` IS A CLINICAL FACT, AND THE
     * SEPARATION IS THE WHOLE DESIGN.** Shipped behaviour flags danger on the first reading and
     * bumps the class with it, in one boolean, forever — so a cancel that had to move that boolean
     * would either be theatre (the next save re-raises it) or would delete a patient-safety flag.
     * It does neither: `danger_flagged` and the `vitals.danger_flagged` event fire on every danger
     * reading exactly as they do today, and what cancel reverts is `danger` on THIS row — whether
     * the board reorders and the doctor is called now. The doctor still gets the flag and both
     * takes. The signed-off autonomy ladder is the authority: *"ASKS (never alone): anything that
     * downgrades urgency."* The agent bumps; only a person un-bumps, with their name on it.
     *
     * `escalated_at` is the window, and it is a STORED INSTANT rather than a server timer (D8): a
     * `setTimeout` is lost on restart and unobservable in a test, while `escalated_at + 10s` is a
     * comparison any reader can make and any clock can fake. The countdown is the screen's.
     */
    escalation: text("escalation").notNull().default("none"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** The class the entry held before the bump, so cancel restores rather than guesses. */
    escalatedFromClass: integer("escalated_from_class"),
    /** Who cancelled. Plain text, no FK — this file's header rule. Null while the escalation stands. */
    escalationBy: text("escalation_by"),
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
    /**
     * ═══ VD-1 T1 / D1 — THE READING, AND WHY THE SCALARS ABOVE DO NOT MOVE ═══
     *
     * The scalar columns above hold ONE number per vital, which is everything the shipped desk
     * could say. The Bay One seat's atom is a **reading**: a value with a SOURCE (the nurse typed
     * it, a serial device sent it, she counted it for fifteen seconds), sometimes a SECOND TAKE
     * after five minutes on the rest chairs, and sometimes a value that was seen and deliberately
     * NOT put on the chart.
     *
     * `readings` carries that, keyed by vital: `{ takes: [...], source, held?: [...], note? }`.
     * `takes` holds every take in order; `held` holds values the sanity gates refused to chart
     * (T2's 45 % SpO₂); `note` holds the old value beside an unlocked carry-forward.
     *
     * **THE SCALARS KEEP THE OPERATIVE TAKE — THE LAST ONE — AND THAT IS THE DECISION.** Four
     * readers select these columns today (`vitals.ts`, `encounters.ts`, `history.ts`,
     * `prescriptions.ts`), the e-Rx prints `vitals[vitals.length - 1]`, and `evaluateVitals`
     * ranges over them. Storing the pair here instead of beside them would have required editing
     * all four to stay correct; storing it beside them requires editing none, and a reader that
     * has never heard of `readings` still prints the number the doctor should act on. After a
     * rest-and-recheck that is the SECOND reading, which is the clinically operative one — and
     * the first is not lost, it is in `takes`.
     *
     * **THE PAIR IS NEVER AVERAGED AND NEVER OVERWRITTEN.** That is the owner's DECIDED line, and
     * here it is a property of storage rather than of anybody's discipline: an average has nowhere
     * to be written, because `takes` is a list and the scalar is one of its members.
     */
    readings: jsonb("readings").notNull().default(sql`'{}'::jsonb`),
    /**
     * VD-1 T1 / D5 — MUAC (mid-upper-arm circumference), required under six and meaningless over
     * it. It is a first-class vital rather than a note because it is the ₹160 tape that finds
     * starvation: its SAM / MAM / green bands are `opd_config` data, and a number kept in prose
     * cannot be banded, trended or flagged.
     */
    muacCm: doublePrecision("muac_cm"),
    /**
     * VD-1 T1 — the questions asked at the bench and their answers: BP medicine taken this
     * morning, fasting, just climbed the stairs. `{ key, question, answer }[]`. They ride the
     * encounter to the doctor because a systolic of 158 means one thing after four flights of
     * stairs and another thing at rest, and the person who knows which is the one holding the cuff.
     */
    contextChips: jsonb("context_chips").notNull().default(sql`'[]'::jsonb`),
    /**
     * VD-1 T1 / D7 — the keys NOT measured today, carried forward from the last recorded reading.
     * Stored rather than derived because it is a claim about PROVENANCE: "this height is from
     * March" is a different fact from "this height is 151", and only the first one can be audited.
     * T2's lock refuses a different number for a carried key without a preset unlock reason.
     */
    carriedForward: jsonb("carried_forward").notNull().default(sql`'[]'::jsonb`),
    /**
     * ═══ VD-1 T1 / D2 — AN AMENDMENT IS THE NEXT ROW, NEVER AN EDIT ═══
     *
     * The owner ruled that a saved chart is amendable at this desk. This is the LIMS pattern,
     * inherited rather than re-derived — `lab_results.supersedes_result_id` and
     * `lab_reports.prior_version_id`, whose own header says *"there is no edit endpoint and there
     * must not be one"*.
     *
     * **AND IT IS WHAT SEPARATES AN AMENDMENT FROM A PAIR.** Both produce "two readings", and
     * nothing could tell them apart if both were rows. A rest-and-recheck pair is ONE row with two
     * takes; a correction is a NEW row naming its predecessor, whose `status` becomes
     * `superseded`. The field-level trail the owner ruled — old value, actor, clock — is the DIFF
     * between the two versions, computed at read time. There is no second audit table, because a
     * trail that can disagree with the record is worse than no trail.
     */
    supersedesVitalsId: text("supersedes_vitals_id"),
    amendmentReason: text("amendment_reason"),
    status: text("status").notNull().default("active"), // 'active' | 'superseded'
    /**
     * VD-1 T1 / D11 — a declared emergency save: BP + pulse + SpO₂ only, the rest of the required
     * set waived. DECLARED, never inferred from the numbers — a nurse decides a patient is
     * crashing, and a system that guessed would sometimes guess in the direction of accepting a
     * half-filled chart for somebody who was merely frightened.
     */
    emergency: boolean("emergency").notNull().default(false),
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
    /**
     * ═══ FD-31 — TYPED FROM A PAPER SLIP, AND BY WHOM (OWNER RULING 2026-09-12) ═══
     *
     * NULL is the ordinary prescription: the treating doctor entered it themselves and `issued_by`
     * is that doctor. NON-NULL means the OPD Order Desk typed it off a slip the doctor signed in
     * pen — `doctor_id` is still the prescriber of record, because the doctor DID prescribe; what
     * changed is only who operated the keyboard.
     *
     * A COLUMN AND NOT A DERIVED PREDICATE. "Transcribed" could be computed as `issued_by` not
     * matching the doctor's user id, but that is a join and a comparison at every reader, and the
     * pharmacy's bill gate must not depend on getting it right — one reader with the predicate
     * inverted would bill a transcription as if a doctor had keyed it. The precedent is one module
     * over: `orders.ordering_clinician_id` is a separate column from `ordered_by_id` for exactly
     * this reason, and its comment says so ("a nurse keying a consultant's verbal order is the
     * normal case").
     */
    transcribedBy: text("transcribed_by"),
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

/**
 * ═══ THE PAPER SLIP, TRANSCRIBED — AND INERT UNTIL A DOCTOR TOUCHES IT ═══
 *
 * Owner ruling, 2026-09-12: *"Go with draft then confirm, doctor taps to issue."*
 *
 * The problem it answers, in the owner's words: *"doctors have so tight schedule that they fail to
 * enter his observation on the operating system. They just write manually by pen on the
 * prescription slip."* A scribe at the OPD door transcribes what the doctor wrote; the doctor
 * issues it.
 *
 * ═══ WHY THIS IS A SEPARATE TABLE AND NOT A `status` ON `opd_prescriptions` ═══
 *
 * Because a draft must be UNREACHABLE by everything downstream, and a status column is a filter
 * that every reader has to remember. `pharmacy/queue.ts` enqueues a dispense from an
 * `opd_prescriptions` row; `verify.ts` loads one by id; the FHIR bundle, the QR and the printed
 * sheet all read that table. A draft sharing it would be one forgotten `WHERE status <> 'draft'`
 * away from being dispensed — and the forgetting would be silent. Here there is no such clause to
 * forget: nothing downstream joins this table at all, and a draft becomes real only by passing
 * through `issuePrescription`, which is where `requireTreatingDoctor` and every safety check live.
 *
 * ═══ NO `doctor_id` COLUMN, DELIBERATELY ═══
 *
 * A draft names no prescriber. The prescriber is decided at ISSUE time and only by the encounter's
 * own treating doctor being the actor — storing an intended one here would be a claim the scribe
 * is not authorised to make, and it would be the first stone of an on-behalf path. The encounter
 * already says whose patient this is.
 */
export const opdPrescriptionDrafts = pgTable(
  "opd_prescription_drafts",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** RxLine[] — the SAME shape `opd_prescriptions.lines` carries, so issuing is a hand-off. */
    lines: jsonb("lines").notNull(),
    /** What the scribe could not read, or what the doctor should look at. Free text, never a line. */
    note: text("note"),
    /** 'pending' | 'issued' | 'discarded'. One PENDING row per encounter (partial unique index). */
    status: text("status").notNull().default("pending"),
    draftedBy: text("drafted_by").notNull(),
    draftedAt: timestamp("drafted_at", { withTimezone: true }).notNull().defaultNow(),
    /** The doctor who issued or discarded it, and when. Null while pending. */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * The prescription this draft became. The whole medico-legal chain — *typed by Priya, issued by
     * Dr Rao* — is recoverable from here, which is why `opd_prescriptions` needs no new column:
     * `issued_by` there is the DOCTOR (it always was), and `drafted_by` here is the scribe.
     */
    issuedPrescriptionId: text("issued_prescription_id"),
  },
  (t) => [
    /**
     * ONE PENDING DRAFT PER ENCOUNTER, enforced by the database rather than by a read-then-write.
     * Two scribes at one door, or a double submit, would otherwise leave two pending slips and the
     * doctor would issue whichever they happened to be shown.
     */
    uniqueIndex("opd_rx_drafts_pending_ux").on(t.encounterId).where(sql`status = 'pending'`),
    index("opd_rx_drafts_patient_idx").on(t.patientId),
    index("opd_rx_drafts_drafted_by_at_idx").on(t.draftedBy, t.draftedAt),
  ],
);
