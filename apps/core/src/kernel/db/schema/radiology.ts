import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { invoiceLines } from "./billing";
import { orderItems, orders } from "./orders";
import { patients } from "./patients";
import { resources } from "./resources";
import { services } from "./tariff";

/**
 * PLAN 18a T1 — RADIOLOGY & IMAGING, THE CORE. Six tables, and every one of them is an EXTENSION of
 * the order envelope keyed `order_item_id` — never a column on it (phase 0 §8.1, §6.3).
 *
 * ═══ WHY THESE TABLES ARE KERNEL-DIRECTORY AND NOT MODULE-DIRECTORY ═══
 *
 * They are not: `apps/core/src/kernel/db/schema/` is where EVERY table in this repository is
 * declared, kernel and module alike (`ot.ts`, `materials.ts`, `opd.ts` all live here). The
 * directory is the drizzle schema surface, not a statement about ownership — `schema/index.ts`'s
 * own comments record the dependency ORDER that makes the surface loadable. Ownership is declared
 * by the manifest that claims the kind (T2), and these tables are `modules/radiology`'s.
 *
 * ═══ ONE ITEM, ONE STUDY, AND THE STUDY NUMBERS ITSELF (DD3) ═══
 *
 * `order_item_id` is UNIQUE. An order for "CT chest + CT abdomen" is TWO items and TWO studies
 * under ONE `order_no`, and each study carries its own `accession_no` minted from the new `X`
 * episode series. `order_no` is never overloaded to name a study — phase 0 §6.7's rule, and the
 * reason 18b can put the accession in a DICOM tag with a 16-character limit.
 *
 * ═══ NO MONEY IS COMPOSED HERE (DD12) ═══
 *
 * `invoice_line_id` is a LINK to a line the counter raised and `authorised_by` records WHY a study
 * was allowed to start. `imaging_bill_decisions` is a QUEUE the counter works. Plans 14 and 15 each
 * had their CRITICAL finding in money summed from the wrong place; a module that composed its own
 * invoice would be a second place for the same number to be wrong in.
 */

/**
 * Inlines a closed vocabulary into DDL as a SQL literal list, refusing anything that is not a bare
 * snake_case token. Transcribed from `ot.ts:153` rather than imported: that copy is `ot.ts`-private
 * and exporting it would make one file's helper part of another file's contract for no benefit.
 *
 * The refusal is the point. drizzle-kit emits what it is given, so a value carrying a quote would
 * become a syntactically valid CHECK admitting something nobody wrote.
 */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CLOSED VOCABULARIES. Each is backed by a CHECK below, and each is exported because the
// module reads them rather than retyping them (§2.54: if a fact must be written twice, make
// something fail when the copies diverge — here there is only one copy and the CHECK is built
// from it).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The study's own lifecycle, and it MIRRORS the `imaging_study` workflow instance rather than
 * replacing it (DD7's pattern, `ot_cases` precedent). The instance is the state; this column is the
 * indexable projection the worklist reads, because a worklist that had to join
 * `workflow_instances` for "every study waiting on a CT today" would be a join per row.
 *
 * `rescheduled` is TERMINAL for the row it sits on: a reschedule writes a NEW study row and closes
 * this one, so the audit answer to "when was this moved, and off what slot" is two rows rather than
 * one row with a rewritten `scheduled_at`.
 */
export const IMAGING_STUDY_STATUSES = [
  "scheduled", "checked_in", "ready", "in_acquisition", "acquired", "reported", "published",
  "cancelled", "no_show", "rescheduled",
] as const;

/** `na` rather than null: "this study has no side" is a clinical statement, not a missing value. */
export const IMAGING_LATERALITIES = ["left", "right", "bilateral", "na"] as const;

/**
 * 18b's reconciliation column, written here so its queue has something to read (§1.3).
 * `no_pacs_images` is M1's ultrasound that produced no DICOM at all and still completed.
 */
export const IMAGE_SOURCES = ["pacs", "no_pacs_images", "outside"] as const;

/**
 * DD12a — WHY this study was allowed to start, and the four answers are not interchangeable.
 * `invoice` is money actually taken; `payer_branch` is a TPA/PMJAY/corporate patient whose
 * pre-authorisation object is Plan 46's and does not exist yet; `daycare` is a `D…` encounter whose
 * discharge bill composes it (Plan 15); `stat` is D3 — an emergency never waits on the cashier, and
 * the fact that it did not is recorded rather than inferred.
 */
export const IMAGING_AUTHORISATIONS = ["invoice", "payer_branch", "daycare", "stat"] as const;

/** DD7 — the ten gate kinds this slice ships. A later slice widens this list AND the CHECK (§6.3). */
export const IMAGING_GATE_KIND_VALUES = [
  "identity_two_factor", "pregnancy_screen", "contrast_consent", "renal_function",
  "prior_contrast_reaction", "mri_safety", "form_f", "chaperone_present", "laterality_confirm",
  "mlc_check",
] as const;

/** DD13 — the three governed definition kinds. */
export const IMAGING_DEFINITION_KIND_VALUES = ["study_types", "pregnancy_policy", "critical_categories"] as const;

/** DD15 — the report version chain's five states. `prelim` is O-11's UNVERIFIED draft. */
export const IMAGING_REPORT_STATUSES = ["prelim", "draft", "signed", "amended", "superseded"] as const;

/** The three-tier criticality the radiologist assigns. `red` is the one that pages a human. */
export const IMAGING_CRITICAL_CATEGORIES = ["red", "orange", "yellow"] as const;

/** DD12b — the four facts that can diverge from what was billed. */
export const IMAGING_BILL_DECISION_KINDS = [
  "contrast_not_given", "repeat_no_charge", "performed_then_cancelled", "acquired_unbilled",
] as const;

export type ImagingStudyStatus = (typeof IMAGING_STUDY_STATUSES)[number];
export type ImagingLaterality = (typeof IMAGING_LATERALITIES)[number];
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export type ImagingAuthorisation = (typeof IMAGING_AUTHORISATIONS)[number];
export type ImagingGateKind = (typeof IMAGING_GATE_KIND_VALUES)[number];
export type ImagingDefinitionKind = (typeof IMAGING_DEFINITION_KIND_VALUES)[number];
export type ImagingReportStatus = (typeof IMAGING_REPORT_STATUSES)[number];
export type ImagingCriticalCategory = (typeof IMAGING_CRITICAL_CATEGORIES)[number];
export type ImagingBillDecisionKind = (typeof IMAGING_BILL_DECISION_KINDS)[number];

/**
 * ═══ 1. THE STUDY — one per order item, and the slot is a UNIQUE INDEX (DD3, DD5) ═══
 *
 * **THE PARTIAL UNIQUE IS THE LOCK, AND IT IS DELIBERATELY NOT A `FOR UPDATE`.** B1's edge case is
 * two receptionists taking the last MRI slot in the same second. Plan 13's `assignResource` holds
 * ONE occupant at a time — the right shape for "on the table", the wrong shape for "booked at 14:30
 * on Thursday" — and a time-slot registry is Plan 22's. So the database refuses the second booking
 * by index violation, which needs no lock ordering, no retry loop and no reader agreeing to take
 * the same lock.
 *
 * **The `WHERE` clause is load-bearing in BOTH directions and T4 A1 proves both:** without it a
 * cancelled booking would hold its slot for ever (the clinic then books around a ghost); with the
 * whole predicate dropped, both receptionists win and one patient arrives to a busy machine.
 * `no_show` frees the slot for the same reason `cancelled` does — the machine is idle either way.
 *
 * `device_resource_id` and `scheduled_at` are NULLABLE, and that is the "awaiting slot" state the
 * `order.placed` consumer creates a study in (T3): Postgres treats NULLs as distinct in a unique
 * index, so any number of unslotted studies coexist and the first booking is what claims a machine.
 */
export const imagingStudies = pgTable(
  "imaging_studies",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /** ONE ITEM, ONE STUDY (DD3). UNIQUE, so a redelivered `order.placed` cannot create a second. */
    orderItemId: text("order_item_id").notNull().unique().references(() => orderItems.id),
    orderId: text("order_id").notNull().references(() => orders.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The episode NUMBER (`V…`, `D…`) copied from the envelope header — plain text, same as there. */
    encounterNo: text("encounter_no").notNull(),
    /** A `code` from the active `study_types` definition body (DD13). Text, because definitions are DATA. */
    studyTypeCode: text("study_type_code").notNull(),
    serviceId: text("service_id").notNull().references(() => services.id),
    /** DD3 — from `nextEpisodeNo('imaging_study', serviceDate)`; `X2608290001`, 11 chars, DICOM-safe. */
    accessionNo: text("accession_no").notNull().unique(),
    laterality: text("laterality").notNull().default("na"),
    /**
     * F55 — the booked LENGTH of the examination, snapshotted from the study type when the study is
     * BOOKED.
     *
     * Written at SCHEDULING, not at creation: an unbooked study carries the column default and has
     * no slot to overlap with anyway. `duration_min` was declared on every study type, validated by
     * the body schema and seeded with real values (10–45 minutes), and READ BY NOTHING: the slot unique was on an exact
     * `scheduled_at`, so the "slot" was a point rather than an interval and a 45-minute MRI took
     * two bookings fifteen minutes apart with no refusal at all. It is snapshotted onto the STUDY
     * rather than read through the book at query time because the exclusion constraint below has to
     * be able to compute the interval in SQL, and because a study booked under one version of the
     * book must keep the length it was booked for when a later version changes it.
     */
    durationMin: integer("duration_min").notNull().default(15),
    /**
     * COPIED from the order at creation rather than joined, and the reason is the worklist index
     * below: "every unread stat study" must be one index scan, and a join to `orders` for the sort
     * key would make the radiologist's list a sort over the whole table.
     */
    priority: text("priority").notNull(),
    status: text("status").notNull().default("scheduled"),
    /** THE state lives in the workflow instance; `status` above is its indexable projection. */
    workflowInstanceId: text("workflow_instance_id").notNull(),
    /**
     * SNAPSHOTTED from the study type at creation, exactly as `ot_case_gates.waivable` snapshots
     * from the criteria definition at booking — and for the same reason: a CHECK cannot read a
     * jsonb definition body, and a dose rule that changed when someone republished a definition
     * would retroactively make an already-acquired study illegal.
     */
    ionising: boolean("ionising").notNull().default(false),
    deviceResourceId: text("device_resource_id").references(() => resources.id),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    acquisitionStartedAt: timestamp("acquisition_started_at", { withTimezone: true }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    acquiredBy: text("acquired_by"),
    /**
     * E11 / phase 0 E13 — a downtime scan backfilled at 14:00 carries the PAPER instant in
     * `acquired_at` and this flag records that the two disagreed. Derived from the delta by
     * `recordAcquired`, never typed by a human.
     */
    lateEntry: boolean("late_entry").notNull().default(false),
    imageSource: text("image_source"),
    /** 18b writes this. Reserved here so its reconciliation queue has a column (§1.3, §6.2). */
    studyInstanceUid: text("study_instance_uid"),
    /**
     * ═══ THE DOSE FIELDS — 18c READS THEM, THIS PHASE ONLY REFUSES TO LOSE THEM (M4) ═══
     *
     * `numeric` rather than a float: a CTDIvol of 6.4 mGy compared against a DRL is a REGULATORY
     * number, and binary floating point is how the same reading prints two ways in two reports.
     * `dose_manual` records PROVENANCE — "no dose SR on this machine, a human read the console and
     * typed it" — and does NOT excuse the number. See the CHECK.
     */
    doseCtdivol: numeric("dose_ctdivol", { precision: 10, scale: 3 }),
    doseDlp: numeric("dose_dlp", { precision: 10, scale: 3 }),
    doseDap: numeric("dose_dap", { precision: 10, scale: 3 }),
    fluoroSeconds: integer("fluoro_seconds"),
    doseManual: boolean("dose_manual").notNull().default(false),
    contrastGiven: boolean("contrast_given").notNull().default(false),
    contrastAgent: text("contrast_agent"),
    contrastVolumeMl: numeric("contrast_volume_ml", { precision: 8, scale: 2 }),
    /** D6/C5/P10 — the repeat exposure. Set TOGETHER with its reason; see the CHECK. */
    repeatOfStudyId: text("repeat_of_study_id"),
    repeatReason: text("repeat_reason"),
    /** DD14's applicability rule, evaluated at PLACEMENT and frozen on the row (T3). */
    formFRequired: boolean("form_f_required").notNull().default(false),
    /** DD12a — a line the COUNTER raised. This module composes no invoice. */
    invoiceLineId: text("invoice_line_id").references(() => invoiceLines.id),
    authorisedBy: text("authorised_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * B1's LOCK. See the table header for why it is an index rather than a row lock, and why the
     * predicate has three names in it rather than two.
     */
    uniqueIndex("imaging_studies_slot_ux")
      .on(t.deviceResourceId, t.scheduledAt)
      .where(sql`${t.status} not in ('cancelled', 'rescheduled', 'no_show')`),
    /** The technologist's day and the radiologist's unread list, in one index (DD16). */
    index("imaging_studies_worklist_idx").on(t.status, t.priority, t.scheduledAt),
    /** 18b T2 — one DICOM study is one HMIS study. Partial: most rows have no UID (D3). */
    uniqueIndex("imaging_studies_study_uid_ux")
      .on(t.studyInstanceUid)
      .where(sql`${t.studyInstanceUid} is not null`),
    index("imaging_studies_patient_idx").on(t.patientId),
    index("imaging_studies_order_idx").on(t.orderId),
    check("imaging_studies_status_ck", inList(t.status, IMAGING_STUDY_STATUSES)),
    check("imaging_studies_laterality_ck", inList(t.laterality, IMAGING_LATERALITIES)),
    check("imaging_studies_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'stat')`),
    check("imaging_studies_image_source_ck", sql`${t.imageSource} is null or ${inList(t.imageSource, IMAGE_SOURCES)}`),
    check("imaging_studies_authorised_by_ck", sql`${t.authorisedBy} is null or ${inList(t.authorisedBy, IMAGING_AUTHORISATIONS)}`),
    /**
     * ═══ M4 — AN IONISING STUDY THAT WAS ACQUIRED CARRIES A DOSE NUMBER, FULL STOP ═══
     *
     * The plan's wording is *"at least one dose field is NOT NULL or `dose_manual` is set with a
     * value"*, and the reading that survives is the strict one: **`dose_manual` is a provenance
     * flag, not an excuse.** A machine with no dose SR is exactly the case M4 exists for — the
     * technologist reads the console and types the number — so `dose_manual = true` with every
     * number null is the defect this CHECK is named after, not the exemption from it.
     *
     * Gated on `acquired_at` because a SCHEDULED study has no dose yet and must be insertable.
     * `ionising` is a snapshot column for the reason the column's own comment gives: a CHECK cannot
     * read a definition body.
     */
    check(
      "imaging_studies_dose_ck",
      sql`${t.acquiredAt} is null or ${t.ionising} = false
          or ${t.doseCtdivol} is not null or ${t.doseDlp} is not null
          or ${t.doseDap} is not null or ${t.fluoroSeconds} is not null`,
    ),
    /** D6 — the pointer and the reason are one fact in two columns (`order_items_duplicate_ck`'s shape). */
    check(
      "imaging_studies_repeat_ck",
      sql`(${t.repeatOfStudyId} is null) = (${t.repeatReason} is null)`,
    ),
    /** A contrast agent nobody gave, or a volume with no agent, is a row 18a-iii cannot interpret. */
    check(
      "imaging_studies_contrast_ck",
      sql`${t.contrastGiven} = true or (${t.contrastAgent} is null and ${t.contrastVolumeMl} is null)`,
    ),
    /** An acquired study has images from SOMEWHERE, even if the answer is "this USG made none". */
    check(
      "imaging_studies_image_source_required_ck",
      sql`${t.acquiredAt} is null or ${t.imageSource} is not null`,
    ),
  ],
);

/**
 * ═══ 2. THE SAFETY GATES — `ot_case_gates` COLUMN FOR COLUMN (DD7) ═══
 *
 * A gate is a CHILD WORKFLOW INSTANCE (`imaging_gate`: `open → satisfied | waived | overridden`,
 * all three terminal, Class A). A boolean column would have no history, and E2's *"the waiver
 * carries both doctors"* would have nowhere to live.
 *
 * **`form_f` is in this table's CHECK like any other kind and is NOT waivable or overridable BY
 * CODE** — `waiveGate` and `overrideGate` refuse the kind before consulting any definition or any
 * role (T5 A2). That refusal is deliberately NOT expressed as a column here: a `waivable` flag
 * would put the statutory rule one UPDATE away from being false, and N2 says *"no emergency bypass
 * exists"*.
 */
export const imagingSafetyScreenings = pgTable(
  "imaging_safety_screenings",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    kind: text("kind").notNull(),
    workflowInstanceId: text("workflow_instance_id").notNull(),
    /** Snapshotted from the study type's gate declaration at CHECK-IN, `ot_case_gates`'s pattern. */
    waivable: boolean("waivable").notNull().default(false),
    /** Per-kind: the pregnancy declaration, the creatinine and its sample time, the MRI implant set. */
    evidence: jsonb("evidence"),
    satisfiedBy: text("satisfied_by"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    /** P1 — `{actorId, reason}`. The radiologist IS the second clinical opinion (DD7). */
    override: jsonb("override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("imaging_safety_screenings_study_kind_ux").on(t.studyId, t.kind),
    index("imaging_safety_screenings_instance_idx").on(t.workflowInstanceId),
    check("imaging_safety_screenings_kind_ck", inList(t.kind, IMAGING_GATE_KIND_VALUES)),
  ],
);

/**
 * ═══ 3. GOVERNED DEFINITIONS — `ot_definitions` COLUMN FOR COLUMN (DD13) ═══
 *
 * A study type is not a table an admin edits: the gate SET a study type opens is a CLINICAL RULE,
 * and clinical rules in this house are Class-A governed data published under an approval. That is
 * also how a radiologist adds a gate to CT-angiography without a deploy.
 */
export const imagingDefinitions = pgTable(
  "imaging_definitions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    status: text("status").notNull().default("draft"),
    draftedBy: text("drafted_by").notNull(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The GRANTED `imaging_definition_publish` approval. Plain text — approvals are another module. */
    approvalId: text("approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("imaging_definitions_kind_version_ux").on(t.kind, t.version),
    /** ONE ACTIVE VERSION PER KIND, as a database invariant. T4 A5's "not the newest draft". */
    uniqueIndex("imaging_definitions_one_active_ux").on(t.kind).where(sql`${t.status} = 'active'`),
    check("imaging_definitions_kind_ck", inList(t.kind, IMAGING_DEFINITION_KIND_VALUES)),
    check("imaging_definitions_status_ck", sql`${t.status} in ('draft', 'active', 'superseded')`),
    check("imaging_definitions_version_ck", sql`${t.version} > 0`),
    check(
      "imaging_definitions_published_ck",
      sql`${t.status} = 'draft' or (${t.publishedBy} is not null and ${t.publishedAt} is not null)`,
    ),
  ],
);

/**
 * ═══ 4. THE REPORT — AN IMMUTABLE VERSION CHAIN UNDER A FRESH SECOND FACTOR (DD15) ═══
 *
 * §11.6's *"amended reports versioned, never overwritten"* as three database facts rather than
 * three guards:
 *
 *   · `(study_id, version)` UNIQUE — no two rows claim the same version;
 *   · `(study_id) WHERE status = 'signed'` PARTIAL UNIQUE — **B10's "reported twice by two
 *     radiologists" is refused by the INDEX**, so the second sign loses whatever the application
 *     believed;
 *   · a trigger forbidding UPDATE of every column but `status` and `published_at`, and forbidding
 *     DELETE outright — because this is the table a courtroom reads.
 *
 * `amend` therefore INSERTS v(n+1) as `signed` and flips v(n) to `superseded` in one transaction:
 * the partial unique makes those two writes atomic-or-nothing without a lock, since a concurrent
 * amend would collide on it (T8 A2).
 */
export const imagingReports = pgTable(
  "imaging_reports",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    /** A section skeleton key from `templates.ts` — data, not a table of its own in this slice. */
    templateKey: text("template_key").notNull(),
    body: jsonb("body").notNull(),
    impression: text("impression"),
    /** A3 without DICOM: the human-entered side, compared to the ORDER ITEM's at sign (T8 A4). */
    laterality: text("laterality"),
    criticalCategory: text("critical_category"),
    signerId: text("signer_id"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** §11.19-D-27 — the instant the signer's second factor was fresh, stamped at sign. */
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
    amendmentReason: text("amendment_reason"),
    supersedesId: text("supersedes_id"),
    /**
     * F66 — `{approvedBy, reason}`: the medical superintendent who approved a DEMOGRAPHIC-tier
     * lockout hit on this version, and why. Null on every report that tripped nothing, which is
     * almost all of them. A coded-tier hit can be approved by nobody, so this column can never
     * explain one away — an inspector asking *"who let this phrase through"* gets a name or gets
     * the answer that nobody could have.
     */
    lockoutOverride: jsonb("lockout_override"),
    /** O-3's outsourced night read, when it comes. Plain text: a `counterparties.id`. */
    externalReporterId: text("external_reporter_id"),
    /**
     * RESERVED FOR 18b AND WRITTEN BY NOBODY YET (§6.8). The Drafter produces `draft` versions and
     * must record that a machine wrote them; the SIGNED document is always a human's, which is why
     * this column exists here rather than being invented by 18b on a table it does not own.
     */
    provenance: jsonb("provenance"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("imaging_reports_study_version_ux").on(t.studyId, t.version),
    /** B10, as an index. See the table header. */
    uniqueIndex("imaging_reports_one_signed_ux").on(t.studyId).where(sql`${t.status} = 'signed'`),
    index("imaging_reports_study_idx").on(t.studyId),
    check("imaging_reports_status_ck", inList(t.status, IMAGING_REPORT_STATUSES)),
    check("imaging_reports_version_ck", sql`${t.version} > 0`),
    check(
      "imaging_reports_critical_category_ck",
      sql`${t.criticalCategory} is null or ${inList(t.criticalCategory, IMAGING_CRITICAL_CATEGORIES)}`,
    ),
    check(
      "imaging_reports_laterality_ck",
      sql`${t.laterality} is null or ${inList(t.laterality, IMAGING_LATERALITIES)}`,
    ),
    /**
     * A SIGNED OR AMENDED ROW HAS A SIGNER, AN INSTANT AND A SECOND FACTOR — all three, or the row
     * is a claim nobody can stand behind. `superseded` is included because it WAS signed: a version
     * that lost its place in the chain still carries who signed it and when.
     */
    check(
      "imaging_reports_signed_shape_ck",
      sql`${t.status} in ('prelim', 'draft')
          or (${t.signerId} is not null and ${t.signedAt} is not null and ${t.secondFactorAt} is not null)`,
    ),
    /** An amendment says why. A superseding version with no reason is an edit pretending to be one. */
    check(
      "imaging_reports_amendment_ck",
      sql`${t.supersedesId} is null or ${t.amendmentReason} is not null`,
    ),
    /** O-11 — a prelim is never delivered and is therefore never published. */
    check(
      "imaging_reports_prelim_unpublished_ck",
      sql`${t.status} <> 'prelim' or ${t.publishedAt} is null`,
    ),
  ],
);

/**
 * ═══ 5. CRITICAL FINDINGS — the read-back, and who took it (DD15) ═══
 *
 * A `red` category writes a row here and emits `imaging.critical_flagged`. The SLA is record-only
 * on the workflow definition in this slice; the escalation ladder that chases an unacknowledged
 * critical at 02:00 is 18a-iii's, and it reads these rows.
 */
export const imagingCriticalFindings = pgTable(
  "imaging_critical_findings",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => imagingReports.id),
    category: text("category").notNull(),
    /** The clinician told, by id where known and by typed name where the phone was answered by a ward. */
    communicatedTo: text("communicated_to"),
    channel: text("channel"),
    /** THE READ-BACK — what the receiver repeated. A critical nobody read back was not communicated. */
    readBackText: text("read_back_text"),
    communicatedAt: timestamp("communicated_at", { withTimezone: true }),
    /**
     * F76 — the CLINICIAN who received the call and read the finding back. It is the answer to
     * *"did this reach a human"*, so it must not be the person who typed the row: `recorded_by`
     * below is who was at the keyboard, and at 02:10 that is usually the radiologist.
     */
    acknowledgedBy: text("acknowledged_by"),
    /** F76 — who entered the acknowledgement. Separate from who gave it, deliberately. */
    recordedBy: text("recorded_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_critical_findings_report_idx").on(t.reportId),
    check("imaging_critical_findings_category_ck", inList(t.category, IMAGING_CRITICAL_CATEGORIES)),
    /** An acknowledgement is a person and an instant; half of one is not an acknowledgement. */
    check(
      "imaging_critical_findings_ack_ck",
      sql`(${t.acknowledgedBy} is null) = (${t.acknowledgedAt} is null)`,
    ),
  ],
);

/**
 * ═══ 6. THE BILL-DECISION QUEUE — DD12b, and it is the leakage triangle's row source ═══
 *
 * At `study.acquired` the module writes a row here **only when a fact diverges from what was
 * billed**. That restraint is the design: T7 A5's mutant raises one on every acquisition, which
 * makes the queue the whole worklist and stops it being read — the failure mode every alerting
 * surface in this repository is written against.
 */
export const imagingBillDecisions = pgTable(
  "imaging_bill_decisions",
  {
    id: text("id").primaryKey(),
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    kind: text("kind").notNull(),
    detail: jsonb("detail"),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** What the counter DID — a credit note, a fresh charge, or "correct as billed". */
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_bill_decisions_study_idx").on(t.studyId),
    /** The counter's queue: everything unresolved, oldest first. */
    index("imaging_bill_decisions_open_idx").on(t.resolvedAt, t.raisedAt),
    check("imaging_bill_decisions_kind_ck", inList(t.kind, IMAGING_BILL_DECISION_KINDS)),
    /** A resolution is an actor, an instant and a word. Partial ones are how a queue rots. */
    check(
      "imaging_bill_decisions_resolved_ck",
      sql`(${t.resolvedBy} is null) = (${t.resolvedAt} is null)`,
    ),
    check(
      "imaging_bill_decisions_resolution_ck",
      sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`,
    ),
  ],
);
