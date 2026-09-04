import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { resources } from "./resources";
import { patients } from "./patients";
import { users } from "./auth";

/**
 * PLAN 18c T1 — THE AERB REGISTERS. Their own module (`aerb`), for the same reason `pcpndt` is its
 * own: **the inspector reads ONE register, and the department that held the tube must not have to
 * install radiology to write to it.**
 *
 * ═══ WHY A SEPARATE MODULE, WHICH IS THE ONE STRUCTURAL DECISION IN THIS FILE (D1) ═══
 *
 * The Atomic Energy (Radiation Protection) Rules 2004 licence EQUIPMENT, not departments. The C-arm
 * in the cath lab (63), the LINAC in radiation oncology (64), the mobile X-ray a ward nurse wheels
 * to a bedside and the CT in the imaging suite all owe the same rows to the same file, and the same
 * radiographer's TLD badge covers them all. A table inside `modules/radiology` would make Plan 63
 * import a department to file a licence — which is exactly the coupling 18a's DD1 refused for the
 * PCPNDT register, with the same shape of consequence: two registers, and an inspector who is shown
 * one of them.
 *
 * The brainstorm's §4 sketch spelled these permissions `radiology.aerb.*`. They are `aerb.*` here,
 * and the deviation is deliberate and recorded in the phase doc's D1: INDEX §5 row 14 gives the
 * reason in its own words — *one register for one inspector*.
 *
 * ═══ WHAT THIS FILE DOES NOT DO ═══
 *
 * It reads nothing of radiology's. `radiation_dose_register` (T3) is written BY radiology through
 * `recordDose`, carrying the facts and the DRL comparison the caller already computed, rather than
 * joining `imaging_studies` from here. That is what keeps the dependency running one way.
 */

/** See `radiology.ts` for why this is transcribed rather than imported. */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

/**
 * eLORA issues two different things for diagnostic X-ray equipment and the difference is not
 * cosmetic: a plain radiography unit is REGISTERED, while CT, fluoroscopy, mammography and
 * interventional units are LICENSED (and a licence carries conditions — QA periodicity, the RSO,
 * the approved layout). Both are "the paper that lets this machine emit", so both live in this
 * table and `assertDeviceLicensed` treats them identically; the column exists so the register
 * PRINTS the truth to the inspector, who asks for them by name.
 */
export const AERB_LICENCE_TYPES = ["licence", "registration"] as const;

/**
 * `surrendered` is terminal and is how a decommissioned unit leaves the register without leaving
 * the record — AERB requires the decommissioning itself to be documented, so the row stays and the
 * two `decommission_*` columns fill in. `suspended` is the reversible one (a condition breached, a
 * renewal in flight).
 */
export const AERB_LICENCE_STATUSES = ["active", "suspended", "surrendered"] as const;

/**
 * The two roles the Rules name for a diagnostic facility. The RSO is approved by AERB for the
 * institution; the medical physicist is the qualified expert who performs and certifies the QA
 * (T2's records point at one). O-13 names the humans; this table holds the appointment.
 */
export const AERB_PERSON_ROLES = ["rso", "physicist"] as const;

export type AerbLicenceType = (typeof AERB_LICENCE_TYPES)[number];
export type AerbLicenceStatus = (typeof AERB_LICENCE_STATUSES)[number];
export type AerbPersonRole = (typeof AERB_PERSON_ROLES)[number];

/**
 * ═══ 1. THE EQUIPMENT LICENCE — and this phase SEEDS NONE OF IT ═══
 *
 * The licence number, the eLORA reference and the validity dates are LAW: they come off a document
 * the hospital holds, exactly as `pcpndt_registrations` does. There is no seed and no placeholder,
 * so **an ionising study on a machine nobody has filed a licence for is refused** — which is the
 * correct behaviour of a hospital that has not filed, rather than a default that lets an
 * unlicensed CT scan a patient because the row was convenient to invent.
 *
 * `rso_user_id` is PLAIN TEXT holding a `users.id`, the `pcpndt_registrations.incharge_user_id`
 * precedent: it is a stewardship record, not an access-control fact (the permission that lets
 * someone file a licence is `aerb.registers.manage`, held by a role), and an FK here would make
 * deactivating a leaver's account a foreign-key problem on a statutory row.
 */
export const aerbLicences = pgTable(
  "aerb_licences",
  {
    id: text("id").primaryKey(),
    /**
     * The registry row radiology schedules and acquires against — which is what makes "was this
     * machine licensed on the day of that scan" answerable by a join rather than by a file cabinet.
     */
    deviceResourceId: text("device_resource_id").notNull().references(() => resources.id),
    licenceType: text("licence_type").notNull(),
    /**
     * As printed on the document.
     *
     * CLOSE REVIEW — this was `.unique()` across EVERY row, surrendered ones included, and eLORA
     * renewals routinely keep the number. So the ordinary act of renewing a CT's licence —
     * surrender the old row, file the new one — hit the constraint and came back a 500, and the
     * register had no route that could record it at all. The rule that was meant is *two machines
     * cannot share a live number*, which is a partial index below.
     */
    licenceNo: text("licence_no").notNull(),
    /** The eLORA portal's own reference for the application/consent. */
    eloraRef: text("elora_ref"),
    /** Type approval of the equipment model, and the approval of the room's shielding layout. */
    typeApprovalRef: text("type_approval_ref"),
    layoutApprovalRef: text("layout_approval_ref"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    /** T5's compliance calendar reads this; T1's gate reads it against the scan day. */
    validTo: date("valid_to", { mode: "string" }).notNull(),
    rsoUserId: text("rso_user_id"),
    status: text("status").notNull().default("active"),
    decommissionedAt: timestamp("decommissioned_at", { withTimezone: true }),
    decommissionRef: text("decommission_ref"),
    remarks: text("remarks"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * ONE ACTIVE LICENCE PER DEVICE — the `pcpndt_registered_machines_device_active_ux` shape, and
     * for the identical reason. Without it a machine could carry two active rows and
     * `activeLicenceFor` would return whichever Postgres happened to read first: §2.54's mechanism
     * with a regulator on the other end of it. A RENEWAL is therefore a status change on the old
     * row and a new row, never two live ones.
     */
    uniqueIndex("aerb_licences_device_active_ux")
      .on(t.deviceResourceId)
      .where(sql`${t.status} = 'active'`),
    /** Two machines cannot hold the same live licence number. A surrendered row may reuse it. */
    uniqueIndex("aerb_licences_no_active_ux")
      .on(t.licenceNo)
      .where(sql`${t.status} = 'active'`),
    /** The calendar's query: what expires, and when. */
    index("aerb_licences_status_validity_idx").on(t.status, t.validTo),
    check("aerb_licences_type_ck", inList(t.licenceType, AERB_LICENCE_TYPES)),
    check("aerb_licences_status_ck", inList(t.status, AERB_LICENCE_STATUSES)),
    /** A validity window that ends before it begins is a typo on a legal document. */
    check("aerb_licences_validity_ck", sql`${t.validTo} >= ${t.validFrom}`),
    /**
     * A decommissioned machine is `surrendered`, and a `surrendered` row carries the date. The
     * CHECK is the half that stops "we retired it" from being a status somebody set on a Tuesday
     * with nothing to show an inspector.
     */
    check(
      "aerb_licences_decommission_ck",
      sql`(${t.status} = 'surrendered') = (${t.decommissionedAt} is not null)`,
    ),
  ],
);

/**
 * ═══ 2. THE APPOINTED PEOPLE — the RSO and the medical physicist ═══
 *
 * `user_id` IS a foreign key here, unlike the licence's `rso_user_id` — because this row answers
 * "is there an approved RSO in post", which the QA register (T2) and the badge programme (T4) both
 * ask about a LOGIN, and a dangling id there is an appointment attributed to nobody.
 *
 * `valid_to` is nullable: an appointment runs until it is ended. AERB approvals of an RSO do carry
 * validity, so the column exists and the calendar reads it; a hospital whose approval letter names
 * no expiry leaves it null rather than inventing one.
 */
export const aerbPersons = pgTable(
  "aerb_persons",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    personRole: text("person_role").notNull(),
    /** AERB's approval reference for this person in this role at this institution. */
    approvalRef: text("approval_ref"),
    qualification: text("qualification").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One live appointment per person per role. A radiographer who is RSO cannot hold two open RSO
     * appointments; the same human MAY be both RSO and physicist where the approvals say so, which
     * is why the role is part of the key rather than the user alone.
     */
    uniqueIndex("aerb_persons_user_role_active_ux")
      .on(t.userId, t.personRole)
      .where(sql`${t.active} = true`),
    index("aerb_persons_role_idx").on(t.personRole, t.active),
    check("aerb_persons_role_ck", inList(t.personRole, AERB_PERSON_ROLES)),
    check("aerb_persons_validity_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/**
 * ═══ 3. THE QUALITY-ASSURANCE REGISTER — and the one register in this file that BLOCKS ═══
 *
 * A licence condition for diagnostic X-ray equipment is periodic quality-assurance testing by an
 * approved agency, and the inspector asks for the reports. This table is those reports, and D4 is
 * what it does with them:
 *
 *   · a **FAIL** puts the machine into `qa_blocked` in the same transaction, through the resource
 *     registry — 18a declared that status and honoured it in the scheduler and at acquisition, and
 *     left nothing in the tree able to SET it. This is the writer it was waiting for.
 *   · a **PASS** releases a blocked machine back to `available`.
 *   · an **OVERDUE** `next_due_on` is a calendar row and a compliance breach on the inspector's
 *     print — and **never an automatic block**, because a machine that blocks itself at midnight
 *     strands the night trauma CT and no Indian corporate hospital runs it that way. The RSO
 *     blocks; the calendar tells them to.
 *
 * `values` is jsonb rather than columns because the measured quantities differ per test type — kVp
 * accuracy, HVL, output repeatability, AEC consistency, a mammography phantom score — and a table
 * with a column per quantity would be a new migration every time the agency's protocol changed.
 * What is NOT in jsonb is the thing the system acts on: `result`.
 */
export const QA_RESULTS = ["pass", "fail", "conditional"] as const;
export type QaResult = (typeof QA_RESULTS)[number];

export const qaRecords = pgTable(
  "aerb_qa_records",
  {
    id: text("id").primaryKey(),
    deviceResourceId: text("device_resource_id").notNull().references(() => resources.id),
    /** The agency's own protocol name — "AERB annual QA", "post-repair verification", "daily KV". */
    qaType: text("qa_type").notNull(),
    result: text("result").notNull(),
    /** Who performed it: the medical physicist or the agency's engineer, recorded as free text
     *  because an external agency's engineer has no login here. `recordedBy` is the HMIS actor. */
    performedBy: text("performed_by").notNull(),
    performedOn: date("performed_on", { mode: "string" }).notNull(),
    agencyRef: text("agency_ref"),
    values: jsonb("values").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** What the licence condition says comes next. The calendar (T5) reads this column. */
    nextDueOn: date("next_due_on", { mode: "string" }),
    /**
     * TRUE when THIS record drove the machine into `qa_blocked`. It is a record of what the system
     * did, not a duplicate of the device's current status — the device may since have been released
     * by a later pass, and an inspector asking "was it stopped?" must get the answer for the day of
     * the failure rather than for today.
     */
    blockApplied: boolean("block_applied").notNull().default(false),
    /** Set on the FAILING record when a later pass releases the machine (D4's loop, closed). */
    releasedByRecordId: text("released_by_record_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    remarks: text("remarks"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The device's QA history, newest first — the inspector's actual question. */
    index("aerb_qa_records_device_idx").on(t.deviceResourceId, t.performedOn),
    /** The calendar's query: what is due, and when. */
    index("aerb_qa_records_due_idx").on(t.nextDueOn),
    check("aerb_qa_records_result_ck", inList(t.result, QA_RESULTS)),
    /**
     * A record cannot claim it released a machine without saying when, or the other way round —
     * the `aerb_licences_decommission_ck` shape, and the same reason: half a fact is not a record.
     */
    check(
      "aerb_qa_records_release_ck",
      sql`(${t.releasedByRecordId} is null) = (${t.releasedAt} is null)`,
    ),
    /**
     * Only a FAIL can have applied a block. A `pass` row claiming one is a lie about the machine.
     *
     * CLOSE REVIEW — this was `result <> 'pass'`, which is "not a pass" and not "a fail": it
     * admitted a `conditional` row claiming a block. `recordQa` never writes that combination, but
     * the constraint is the half that is supposed to hold if the writer is ever weakened, which is
     * the reason the dose register's own index gives for itself.
     */
    check(
      "aerb_qa_records_block_ck",
      sql`${t.blockApplied} = false or ${t.result} = 'fail'`,
    ),
  ],
);

/**
 * ═══ 4. THE PATIENT DOSE REGISTER — a TABLE its sources write, not a projection it reads (D5) ═══
 *
 * The obvious build is a view over `imaging_studies.dose_*`. It is the wrong one, and the reason is
 * the whole of D1: the cath lab (63) records a fluoroscopy dose against a `Procedure`, radiation
 * oncology (64) against a fraction, and neither is an imaging study. A register that JOINED
 * radiology's table would have one source for ever and would make the second one a schema change.
 *
 * So the sources CALL `recordDose` with the facts, and this module never reads `imaging_studies` —
 * which is also what keeps the dependency running one way.
 *
 * ═══ THE UNITS ARE STATED HERE, ONCE, BECAUSE 18b LEFT THEM UNSTATED ═══
 *
 * 18b's close review found DAP rendered with a unit the tree never named, and ruled the unit 18c's.
 * They are: **CTDIvol mGy · DLP mGy·cm · DAP Gy·cm² · fluoroscopy time in seconds.** `aerb/units.ts`
 * carries them as constants and every screen renders them beside the number; nothing infers one.
 *
 * ═══ `over_drl` IS A STORED FACT, NOT A COMPUTED ONE ═══
 *
 * The comparison is made by the CALLER — radiology, which holds the published diagnostic reference
 * levels — and stored with the row, because a DRL republished next year must not retroactively
 * change what an examination in March was compared against. `imaging_studies.ionising` is
 * snapshotted for exactly the same reason and says so in its own comment.
 */
export const DOSE_SOURCES = ["imaging", "cath_lab", "radiotherapy"] as const;
export type DoseSource = (typeof DOSE_SOURCES)[number];

export const doseRegister = pgTable(
  "radiation_dose_register",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    /**
     * The source's own row id — an imaging study, a cath-lab procedure, an RT fraction. PLAIN TEXT
     * and NOT a foreign key, the `pcpndt_form_f.study_id` decision and the same reasoning: an FK
     * would name one consumer and lock the other two out.
     */
    sourceRef: text("source_ref").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    deviceResourceId: text("device_resource_id").references(() => resources.id),
    modality: text("modality").notNull(),
    /** The examination's code in its own department's book — `CT-HEAD`, and later a cath procedure. */
    procedureCode: text("procedure_code").notNull(),
    /** mGy · mGy·cm · Gy·cm² · seconds. See `units.ts`; nothing here infers a unit. */
    doseCtdivol: numeric("dose_ctdivol", { precision: 10, scale: 3 }),
    doseDlp: numeric("dose_dlp", { precision: 10, scale: 3 }),
    doseDap: numeric("dose_dap", { precision: 10, scale: 3 }),
    fluoroSeconds: integer("fluoro_seconds"),
    /** PROVENANCE: a human read the console because the machine emits no dose SR. 18a's word. */
    doseManual: boolean("dose_manual").notNull().default(false),
    /** Which quantity the DRL was set on, the level itself, and the verdict — all three or none. */
    drlQuantity: text("drl_quantity"),
    drlValue: numeric("drl_value", { precision: 10, scale: 3 }),
    /** NULL means "no published DRL for this examination" — which is NOT the same as "under". */
    overDrl: boolean("over_drl"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * ONE ROW PER SOURCE EVENT. A double-clicked acquisition, a retried transaction or a replayed
     * consumer must not put a patient's dose in the register twice — 18a refuses a second
     * `recordAcquired` with `already_acquired` and its own comment says the mutant "counts the dose
     * twice"; this index is the half that holds even if that guard is ever weakened.
     */
    uniqueIndex("radiation_dose_register_source_ux").on(t.source, t.sourceRef),
    /** D8's cumulative read: this patient, this window. */
    index("radiation_dose_register_patient_idx").on(t.patientId, t.occurredAt),
    /** The RSO's book, and the over-DRL review. */
    index("radiation_dose_register_occurred_idx").on(t.occurredAt),
    check("radiation_dose_register_source_ck", inList(t.source, DOSE_SOURCES)),
    /**
     * A register row with no number in it is a row that cannot answer the question the register
     * exists for. 18a's `imaging_studies_dose_ck` says the same thing about the study, and says
     * `dose_manual` is a provenance flag rather than an excuse.
     */
    check(
      "radiation_dose_register_dose_ck",
      sql`${t.doseCtdivol} is not null or ${t.doseDlp} is not null
          or ${t.doseDap} is not null or ${t.fluoroSeconds} is not null`,
    ),
    /**
     * The comparison travels whole or not at all: quantity, level and verdict together. A row with
     * `over_drl = true` and no level is a verdict nobody can check.
     */
    check(
      "radiation_dose_register_drl_ck",
      sql`(${t.drlQuantity} is null and ${t.drlValue} is null and ${t.overDrl} is null)
          or (${t.drlQuantity} is not null and ${t.drlValue} is not null and ${t.overDrl} is not null)`,
    ),
  ],
);

/**
 * ═══ 5. THE TLD BADGE PROGRAMME — occupational monitoring, and the ONE register about STAFF ═══
 *
 * Everything else in this file is about a machine or a patient. This is about the radiographer:
 * a thermoluminescent dosimeter badge worn for a period, sent to an accredited laboratory, and a
 * reading that comes back weeks later.
 *
 * **`tld_badge_reads` is deliberately not keyed on the person.** It is keyed on the BADGE, which is
 * issued to a person and can be re-issued: a badge lost and replaced starts a new row, and a badge
 * handed to a new joiner after a leaver returned it must not carry the leaver's readings into the
 * new person's cumulative. `aerb_tld_badges.user_id` is what connects them, per issue.
 *
 * ═══ THE GAP IS THE POINT (the brainstorm's negative space) ═══
 *
 * *"A badge period with no read"* — the badge that was never sent, the reading that never came
 * back, the technologist who has not worn one. A register that only lists the readings it HAS
 * cannot show any of those, so `tldGaps` reads the badges against the periods and the screen leads
 * with what is missing. It is the same argument the licence gap makes one register over.
 */
export const TLD_BADGE_STATUSES = ["active", "returned", "lost"] as const;
export type TldBadgeStatus = (typeof TLD_BADGE_STATUSES)[number];

export const aerbTldBadges = pgTable(
  "aerb_tld_badges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    /** As printed on the badge and as the laboratory reports it. */
    badgeNo: text("badge_no").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    returnedOn: date("returned_on", { mode: "string" }),
    status: text("status").notNull().default("active"),
    remarks: text("remarks"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * ONE ACTIVE BADGE PER PERSON. A worker wearing two badges has two partial pictures of one
     * exposure and neither is their dose — the `aerb_licences_device_active_ux` shape, third time.
     */
    uniqueIndex("aerb_tld_badges_user_active_ux").on(t.userId).where(sql`${t.status} = 'active'`),
    /** A badge NUMBER is reusable across time but not concurrently: the laboratory reports by it. */
    uniqueIndex("aerb_tld_badges_no_active_ux").on(t.badgeNo).where(sql`${t.status} = 'active'`),
    index("aerb_tld_badges_user_idx").on(t.userId, t.issuedOn),
    check("aerb_tld_badges_status_ck", inList(t.status, TLD_BADGE_STATUSES)),
    /** A returned or lost badge carries the date it stopped being worn; an active one does not. */
    check(
      "aerb_tld_badges_returned_ck",
      sql`(${t.status} = 'active') = (${t.returnedOn} is null)`,
    ),
    check("aerb_tld_badges_dates_ck", sql`${t.returnedOn} is null or ${t.returnedOn} >= ${t.issuedOn}`),
  ],
);

/**
 * One laboratory report for one badge over one wearing period.
 *
 * **Hp(10) and Hp(0.07) are different depths, not two names for one number**: Hp(10) is the deep
 * dose that the effective-dose limits are compared against, Hp(0.07) the shallow (skin) dose with
 * its own, far higher limit. Storing one and calling it "the dose" is how a skin reading gets
 * compared against a whole-body limit.
 */
export const aerbTldReads = pgTable(
  "aerb_tld_reads",
  {
    id: text("id").primaryKey(),
    badgeId: text("badge_id").notNull().references(() => aerbTldBadges.id),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    /** mSv. Deep dose — the one the annual limits are about. */
    hp10Msv: numeric("hp10_msv", { precision: 8, scale: 3 }).notNull(),
    /** mSv. Shallow (skin) dose, its own limit and NOT interchangeable with the above. */
    hp007Msv: numeric("hp007_msv", { precision: 8, scale: 3 }),
    reportedOn: date("reported_on", { mode: "string" }).notNull(),
    /** The accredited laboratory's own reference for the report. */
    labRef: text("lab_ref"),
    /**
     * TRUE when this reading met or exceeded the INVESTIGATION level in force when it was entered
     * — a stored verdict, like `over_drl`, because a hospital that lowers its investigation level
     * next year must not retroactively turn last year's readings into incidents.
     */
    investigationFlag: boolean("investigation_flag").notNull().default(false),
    /** The level it was compared against, in mSv for THIS period. Travels with the verdict. */
    investigationLevelMsv: numeric("investigation_level_msv", { precision: 8, scale: 3 }),
    remarks: text("remarks"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** ONE READING PER BADGE PER PERIOD. A re-entered report is a correction, not a second dose. */
    uniqueIndex("aerb_tld_reads_badge_period_ux").on(t.badgeId, t.periodStart, t.periodEnd),
    index("aerb_tld_reads_period_idx").on(t.periodStart, t.periodEnd),
    check("aerb_tld_reads_period_ck", sql`${t.periodEnd} >= ${t.periodStart}`),
    /** A dose is not negative. A laboratory reporting one has reported an error. */
    check("aerb_tld_reads_hp10_ck", sql`${t.hp10Msv} >= 0`),
    check("aerb_tld_reads_hp007_ck", sql`${t.hp007Msv} is null or ${t.hp007Msv} >= 0`),
    /** The comparison travels whole: a flag with no level is a verdict nobody can check. */
    check(
      "aerb_tld_reads_investigation_ck",
      sql`${t.investigationFlag} = false or ${t.investigationLevelMsv} is not null`,
    ),
  ],
);

/**
 * ═══ 6. THE ONE SETTINGS ROW — and it holds exactly what is POLICY rather than LAW ═══
 *
 * The statutory limits are constants in `aerb/limits.ts` with the Rules cited beside them, and no
 * screen may edit them: a hospital that could type its own annual dose limit would be a hospital
 * whose register proves nothing. The **investigation level** is the opposite — it is institutional
 * policy, set by the RSO, and a hospital choosing a more conservative one must not need a deploy.
 */
export const aerbSettings = pgTable(
  "aerb_settings",
  {
    /** Always `main`, the `registration_config` precedent — one hospital, one policy. */
    id: text("id").primaryKey(),
    /**
     * mSv per MONTH, pro-rated to whatever period a badge was worn for. Default 1.0, the common
     * Indian corporate-hospital figure; R3 is the owner's to lower.
     */
    investigationLevelMsvPerMonth: numeric("investigation_level_msv_per_month", { precision: 8, scale: 3 })
      .notNull().default("1.000"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("aerb_settings_level_ck", sql`${t.investigationLevelMsvPerMonth} > 0`),
  ],
);
