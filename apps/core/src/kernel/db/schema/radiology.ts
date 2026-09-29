import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { invoiceLines } from "./billing";
import { orderItems, orders } from "./orders";
import { patientAllergies, patients } from "./patients";
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

/**
 * DD13 — the three governed definition kinds, and 18b T3's fourth: where the images are viewed.
 * 18c T3 added the DRL book; 18-S RS6 adds `imaging_protocols`, the protocol book the room console
 * reads (technique, contrast per kg, breath-hold script) — authored by the HOD, never seeded.
 * 18-S RS8a adds the reading room's two books: `report_templates` (the structured templates with
 * their coded categories) and `report_signatories` (who may sign an imaging report, with the
 * qualification and council number the print carries — ruling 4). Both are authored by the HOD and
 * approved by the medical superintendent; neither is seeded active.
 */
export const IMAGING_DEFINITION_KIND_VALUES = ["study_types", "pregnancy_policy", "critical_categories", "pacs_settings", "dose_reference_levels", "imaging_protocols", "report_templates", "report_signatories"] as const;

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
    /**
     * 18-S RS12 — Average Glandular Dose (mGy), the quantity a mammography unit reports and the one
     * AERB asks for on a mammogram. Before RS12 a unit that showed only AGD could not be recorded.
     */
    doseAgd: numeric("dose_agd", { precision: 10, scale: 3 }),
    /**
     * 18-S RS12b — reference-point air kerma Ka,r (mGy), the interventional unit's cumulative
     * skin-dose proxy (IEC 60601-2-43; DICOM 113725 Dose (RP) Total). Kept beside DAP and fluoro
     * time, never INSTEAD of them: it is not one of the quantities `imaging_studies_dose_ck` counts,
     * because no unit reports Ka,r without DAP and fluoro time, and the 3 Gy / 5 Gy skin-dose
     * triggers (`ir.ts`) read it after Send.
     */
    doseKar: numeric("dose_ka_r", { precision: 10, scale: 3 }),
    doseManual: boolean("dose_manual").notNull().default(false),
    /**
     * ═══ 18-S RS12 — THE IMAGES ARRIVED IN THE ARCHIVE ═══
     *
     * Written only by `pacs.ts` from an Orthanc arrival notice that matched this study by accession
     * (then by UID) AND by the patient's UHID — never by a name. NULL means no archive has told us
     * it holds this study, which is not the same as "no images": a CR with no DICOM link is
     * `no_pacs_images` and still has a film. The counts are the archive's, refreshed on every
     * notice for the same UID (a late series grows them); they are facts about the PACS, not a
     * workflow state, so nothing here moves the study.
     */
    imagesArrivedAt: timestamp("images_arrived_at", { withTimezone: true }),
    imageSeriesCount: integer("image_series_count"),
    imageInstanceCount: integer("image_instance_count"),
    contrastGiven: boolean("contrast_given").notNull().default(false),
    contrastAgent: text("contrast_agent"),
    contrastVolumeMl: numeric("contrast_volume_ml", { precision: 8, scale: 2 }),
    /** D6/C5/P10 — the repeat exposure. Set TOGETHER with its reason; see the CHECK. */
    repeatOfStudyId: text("repeat_of_study_id"),
    repeatReason: text("repeat_reason"),
    /** DD14's applicability rule, evaluated at PLACEMENT and frozen on the row (T3). */
    formFRequired: boolean("form_f_required").notNull().default(false),
    /**
     * ═══ PLAN 18a-iii T3 / D4 — THE BEDSIDE. A PORTABLE STUDY IS THE SAME STUDY WITH A PLACE ═══
     *
     * *"It hangs off the existing `imaging_studies` row with a bedside location and the ward's
     * request; there is no parallel table and no second workflow definition."* The temptation is a
     * `portable_studies` table, and it would fork every report, bill, worklist and register query in
     * this module — two shapes for one examination, and every later reader having to remember both.
     *
     * NULL means the study was performed where the machine lives. Non-null means the machine was
     * taken to the patient, and the string is the ward and bed a porter and a technologist need.
     * `scheduleStudy` refuses to write it for a device that does not carry `attributes.portable`.
     *
     * **The gate set does not change and that is the point.** `deriveGateSet` reads the study TYPE
     * and `form_f_required`, and nothing else — so a portable USG on a ward opens `form_f` and
     * `chaperone_present` exactly as it would in the department, and `assertFormFRecorded` still
     * demands a RECORDED form before the exposure. §11.19-C-6 widened Form F to cover precisely this
     * case, and it holds here by construction rather than by a second rule.
     */
    bedsideLocation: text("bedside_location"),
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
          or ${t.doseDap} is not null or ${t.fluoroSeconds} is not null
          or ${t.doseAgd} is not null`,
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
    /**
     * 18-S RS8a / ruling 4 — WHO SIGNED, AS A PERSON, AS THEY WERE ON THE DAY: name, qualification,
     * designation, council registration number, Doctor ID, and the signature marker (the second
     * factor's instant, the authenticator it came from, and a SHA-256 of the signed content).
     * Written on the INSERT of a signed version and never after — the append-only trigger already
     * covers every column but `status` and `published_at`, so a later rename or a new council
     * number cannot rewrite a report already handed to a patient. NULL on drafts and prelims, and on
     * every version signed before RS8a (no backfill: those were signed without it).
     */
    signer: jsonb("signer"),
    /**
     * 18-S RS8a — the deterministic pre-sign checks as they ran at THIS signature: which checks,
     * every warning they raised and that the signer acknowledged each one. A refusal never reaches
     * a row. NULL on drafts, prelims and on versions signed before RS8a.
     */
    signChecks: jsonb("sign_checks"),
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
    /**
     * ═══ 18a-iii T5 / D7 — WHEN THE CHASER ESCALATED THIS ONE, AND WHY IT IS NOT A STATUS ═══
     *
     * This table's own header left the note: *"the escalation ladder that chases an unacknowledged
     * critical at 02:00 is 18a-iii's, and it reads these rows."* This is the mark it writes.
     *
     * It exists because a sweep with no memory alerts every cycle. `sweepCriticalChaser` runs every
     * minute — a sweep coarser than the window it enforces cannot enforce it — and an unacknowledged
     * red finding would otherwise put a row in front of a human sixty times an hour, which is how an
     * alert surface becomes one nobody reads.
     *
     * **It is a record that an escalation happened, NOT a state of the finding.** D7 is explicit
     * that the chasers escalate to a human and never to a status: nothing reads this column to
     * decide what a finding IS, `acknowledgedAt` remains the only answer to "was this closed", and a
     * chased finding is exactly as unacknowledged as it was a minute earlier.
     */
    chasedAt: timestamp("chased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_critical_findings_report_idx").on(t.reportId),
    /** The chaser's own query: everything unacknowledged and unchased, oldest first. */
    index("imaging_critical_findings_chase_idx")
      .on(t.acknowledgedAt, t.chasedAt, t.createdAt),
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

/**
 * ═══ PLAN 18b T3 — `imaging_image_views`: SOMEBODY LOOKED AT THE IMAGES (D6) ═══
 *
 * 18a §6.2 reserved `image.viewed` as "a NEW event on 18b's tables". This is the table. A row is
 * written when a reader opens the study's images through the viewer door, BEFORE the URL is handed
 * back, so the negative-space report brainstorm §14 names — "a radiologist shift with zero
 * `image.viewed` events (reading outside the system or not at all)" — is one query here. The PHI
 * disclosure itself is logged on `imaging.study` (the images are the study); this table answers
 * WHO OPENED WHAT WHEN, which the PHI log answers only per surface.
 *
 * `url_host` is the viewer's host and never the full URL: the URL carries the accession number,
 * and an audit table that stored it would be a second place a study identifier lives.
 */
export const IMAGE_VIEW_CHANNELS = ["external_pacs"] as const;
export type ImageViewChannel = (typeof IMAGE_VIEW_CHANNELS)[number];

export const imagingImageViews = pgTable(
  "imaging_image_views",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    viewerId: text("viewer_id").notNull(),
    via: text("via").notNull(),
    urlHost: text("url_host").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_image_views_study_idx").on(t.studyId, t.viewedAt),
    index("imaging_image_views_viewer_idx").on(t.viewerId, t.viewedAt),
    check("imaging_image_views_via_ck", inList(t.via, IMAGE_VIEW_CHANNELS)),
  ],
);

/**
 * ═══ PLAN 18-S RS12 — THE ARCHIVE'S INBOX: studies the PACS holds that no order could claim ═══
 *
 * An Orthanc arrival notice is matched to a study by ACCESSION, then by Study Instance UID, and in
 * both cases only when the DICOM PatientID is that study's patient's UHID (`pacs.ts`). Everything
 * else lands here, one row per DICOM study (UNIQUE on the UID — a re-sent notice updates the row,
 * never adds one), and waits for a human: the technologist who knows who was on the table, or the
 * radiologist. **Nothing here is ever attached by a patient NAME** — two Sunita Devis in one day is
 * the ordinary case, and a wrong-patient image is the error this whole queue exists to stop.
 *
 * `awaiting_acquisition` is the reason the machine usually resolves itself: the images reached the
 * archive before the room pressed Send, and `recordAcquired` attaches them on the SAME accession
 * and UHID check (never a looser one) when it runs; a re-sent notice that now matches on that rule
 * attaches likewise. Every other resolution — and every rejection — is a human's.
 *
 * The DICOM patient name and ID are kept because a reconciler cannot decide without them; they are
 * the modality's strings, not a patient record, and the inbox read logs a PHI line per candidate.
 */
export const UNMATCHED_STUDY_REASONS = [
  "no_match", "patient_mismatch", "uid_mismatch", "awaiting_acquisition", "study_closed", "outside_study", "no_identifiers",
] as const;
export type UnmatchedStudyReason = (typeof UNMATCHED_STUDY_REASONS)[number];
export const UNMATCHED_STUDY_STATUSES = ["open", "attached", "rejected"] as const;

export const imagingUnmatchedStudies = pgTable(
  "imaging_unmatched_studies",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyInstanceUid: text("study_instance_uid").notNull().unique(),
    accessionNumber: text("accession_number"),
    dicomPatientId: text("dicom_patient_id"),
    dicomPatientName: text("dicom_patient_name"),
    modality: text("modality"),
    /** DICOM StudyDate as the modality stamped it (its clock, not ours). */
    studyDate: date("study_date"),
    seriesCount: integer("series_count").notNull().default(0),
    instanceCount: integer("instance_count").notNull().default(0),
    /** The archive's own id for the study (Orthanc's), so the reconciler can open it there. */
    archiveRef: text("archive_ref"),
    reason: text("reason").notNull(),
    /** The study the accession named, when one did — shown beside the row, never attached by itself. */
    candidateStudyId: text("candidate_study_id").references(() => imagingStudies.id),
    status: text("status").notNull().default("open"),
    resolvedStudyId: text("resolved_study_id").references(() => imagingStudies.id),
    /** NULL only for the machine's own `awaiting_acquisition` attach at Send. */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_unmatched_studies_status_idx").on(t.status, t.receivedAt),
    index("imaging_unmatched_studies_accession_idx").on(t.accessionNumber),
    check("imaging_unmatched_studies_reason_ck", inList(t.reason, UNMATCHED_STUDY_REASONS)),
    check("imaging_unmatched_studies_status_ck", inList(t.status, UNMATCHED_STUDY_STATUSES)),
    /** Open means unresolved, and a resolution carries its instant — one fact in two columns. */
    check("imaging_unmatched_studies_resolved_ck", sql`(${t.status} = 'open') = (${t.resolvedAt} is null)`),
    check("imaging_unmatched_studies_attached_ck", sql`${t.status} <> 'attached' or ${t.resolvedStudyId} is not null`),
    /**
     * A human's resolution names the human and the reason. The machine resolves only by ATTACHING,
     * and only on the same accession + UHID rule a fresh notice is matched by (`resolvedBy` NULL);
     * it never rejects.
     */
    check(
      "imaging_unmatched_studies_human_ck",
      sql`${t.status} = 'open' or (${t.resolvedBy} is not null and ${t.resolutionReason} is not null)
          or (${t.status} = 'attached' and ${t.resolvedBy} is null)`,
    ),
  ],
);

/**
 * ═══ PLAN 18-S RS12 — EVERY RADIATION DOSE SR THE ARCHIVE FORWARDED, AND WHAT BECAME OF IT ═══
 *
 * One row per SR instance (UNIQUE on its SOP Instance UID — the idempotency key: Orthanc's change
 * feed is at-least-once). The register is written only through aerb's `recordDose`, from
 * `recordAcquired`, so the DRL comparison runs exactly once per examination; this table is the
 * receipt, and the place a disagreement with a number the technologist typed is KEPT rather than
 * resolved by overwriting either:
 *
 *   · `pending`        — the study is not acquired yet; Send will use these numbers if none is typed.
 *   · `recorded`       — Send used them; the register row says `dose_origin = 'dose_sr'`.
 *   · `confirmed`      — a typed number was already on the register and the SR agrees with it.
 *   · `conflict`       — it does not; both values are in `conflict`, the register is untouched.
 *   · `unmatched`      — no study carries this UID or accession yet (re-tried on reconciliation).
 *   · `not_applicable` — the study is not ionising, or was an outside study.
 */
export const DOSE_SR_OUTCOMES = ["pending", "recorded", "confirmed", "conflict", "unmatched", "not_applicable"] as const;
export type DoseSrOutcome = (typeof DOSE_SR_OUTCOMES)[number];
export const DOSE_SR_TEMPLATES = ["ct_10011", "projection_10001", "unknown"] as const;

export const imagingDoseSrReceipts = pgTable(
  "imaging_dose_sr_receipts",
  {
    id: text("id").primaryKey(), // ULID via newId()
    sopInstanceUid: text("sop_instance_uid").notNull().unique(),
    studyInstanceUid: text("study_instance_uid").notNull(),
    accessionNumber: text("accession_number"),
    studyId: text("study_id").references(() => imagingStudies.id),
    template: text("template").notNull(),
    doseCtdivol: numeric("dose_ctdivol", { precision: 10, scale: 3 }),
    doseDlp: numeric("dose_dlp", { precision: 10, scale: 3 }),
    doseDap: numeric("dose_dap", { precision: 10, scale: 3 }),
    fluoroSeconds: integer("fluoro_seconds"),
    doseAgd: numeric("dose_agd", { precision: 10, scale: 3 }),
    /** 18-S RS12b — 113725 Dose (RP) Total, mGy (Ka,r). Never counted by the dose CHECK below. */
    doseKar: numeric("dose_ka_r", { precision: 10, scale: 3 }),
    outcome: text("outcome").notNull(),
    /** For `conflict`: `{quantity: {typed, sr}}` per disagreeing quantity. */
    conflict: jsonb("conflict"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("imaging_dose_sr_receipts_uid_idx").on(t.studyInstanceUid),
    index("imaging_dose_sr_receipts_study_idx").on(t.studyId),
    index("imaging_dose_sr_receipts_outcome_idx").on(t.outcome, t.receivedAt),
    check("imaging_dose_sr_receipts_outcome_ck", inList(t.outcome, DOSE_SR_OUTCOMES)),
    check("imaging_dose_sr_receipts_template_ck", inList(t.template, DOSE_SR_TEMPLATES)),
    check(
      "imaging_dose_sr_receipts_dose_ck",
      sql`${t.doseCtdivol} is not null or ${t.doseDlp} is not null or ${t.doseDap} is not null
          or ${t.fluoroSeconds} is not null or ${t.doseAgd} is not null`,
    ),
    check("imaging_dose_sr_receipts_conflict_ck", sql`(${t.outcome} = 'conflict') = (${t.conflict} is not null)`),
  ],
);

/**
 * ═══ PLAN 18a-iii T1 — `imaging_contrast_administrations`: WHAT WENT INTO THE ARM ═══
 *
 * 18a put three columns on the study — `contrast_given`, `contrast_agent`, `contrast_volume_ml` —
 * and its own CHECK comment left this phase the note: *"A contrast agent nobody gave, or a volume
 * with no agent, is a row 18a-iii cannot interpret."* Those three are a SUMMARY. This table is the
 * fact they summarise: one row per injection, with the person who gave it, the instant, the route
 * and the vial.
 *
 * ═══ THE SUMMARY IS DERIVED FROM HERE AND NEVER TYPED BESIDE IT (§2.54) ═══
 *
 * `contrast.ts`'s `summariseContrast` recomputes all three study columns from every row of this
 * table inside the same transaction as the insert, under a `FOR UPDATE` on the study. There is no
 * path that writes an administration and leaves the summary stale, and no path that edits the
 * summary to disagree with the rows — which is what makes the study's columns safe for `read.ts`,
 * `reports.ts` and `drafter.ts` to keep reading unchanged.
 *
 * ═══ THE VOLUME ON THE STUDY IS THE INTRAVASCULAR VOLUME, AND THAT IS A DECISION ═══
 *
 * `drafter.ts:76` already prints the study's volume as *"with 90 ml Omnipaque **intravenously**"*.
 * Summing a litre of dilute oral barium into that number would make the report sentence say
 * something false about a real patient, and the number itself would be true of nothing: the figure
 * a nephrotoxicity or iodine-load question means is the INTRAVASCULAR one. So oral, rectal,
 * intra-articular and the rest are recorded here in full, contribute their AGENT to the summary,
 * and contribute no volume. A study given only oral contrast carries `contrast_given = true`, an
 * agent and a NULL volume — which `imaging_studies_contrast_ck` permits and the drafter already has
 * a sentence for.
 *
 * ═══ AN EXPIRED VIAL IS REFUSED AT THE DATABASE, NOT ONLY IN THE SERVICE ═══
 *
 * `vial_batch_no` and `vial_expiry` are the paper contrast register's two columns and they are
 * OPTIONAL — contrast is not in this hospital's item master, and a clinical record that cannot be
 * written because inventory is not set up is the worse error by a wide margin (Plan 14's
 * `perBaseOrNull` argument). But an expiry that IS recorded is a fact with a consequence:
 * `imaging_contrast_administrations_vial_expiry_ck` refuses a vial that had expired on the day it
 * was given. Nobody writes *"do not inject expired contrast"* into a plan, which is exactly why it
 * is here rather than in a service branch a later refactor can drop.
 *
 * No stock movement is posted. `materials` exposes `postMovement`/`issueStock` and radiology could
 * call them (spike §3.2), but there is no radiology store, contrast is in no item master, and a
 * one-sided `consume` row from a module that never received the stock would be a ledger entry
 * nobody can reconcile. `vial_batch_no` is indexed so a manufacturer recall is one query against
 * the patients who received the lot, which is the traceability the register is FOR.
 */
export const CONTRAST_ROUTES = [
  "intravenous", "intraarterial", "oral", "rectal", "intraarticular", "intrathecal",
  "intravesical", "intracavitary",
] as const;
export type ContrastRoute = (typeof CONTRAST_ROUTES)[number];

/** The routes whose volume is a DOSE. The study summary's volume is the sum of these and no other. */
export const INTRAVASCULAR_CONTRAST_ROUTES: readonly ContrastRoute[] = ["intravenous", "intraarterial"];

export const imagingContrastAdministrations = pgTable(
  "imaging_contrast_administrations",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    /** Free text, as `imaging_studies.contrast_agent` is: "Omnipaque 350", "Gadoterate meglumine". */
    agent: text("agent").notNull(),
    volumeMl: numeric("volume_ml", { precision: 8, scale: 2 }).notNull(),
    route: text("route").notNull(),
    /** Where the cannula was. An extravasation is followed up by SITE, and a null one cannot be. */
    site: text("site"),
    vialBatchNo: text("vial_batch_no"),
    vialExpiry: date("vial_expiry"),
    /** The person who INJECTED — not necessarily the actor who typed the row. */
    givenBy: text("given_by").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("imaging_contrast_administrations_study_idx").on(t.studyId, t.givenAt),
    /** The recall query: every patient who received a lot. Partial — most rows carry no batch. */
    index("imaging_contrast_administrations_batch_idx")
      .on(t.vialBatchNo).where(sql`${t.vialBatchNo} is not null`),
    check("imaging_contrast_administrations_route_ck", inList(t.route, CONTRAST_ROUTES)),
    /**
     * A zero-millilitre administration is not an administration. A one-millilitre TEST DOSE is,
     * and is why this is `> 0` and not a floor of any other number.
     */
    check("imaging_contrast_administrations_volume_ck", sql`${t.volumeMl} > 0`),
    /** The expired vial. Recorded expiry only; an unrecorded one is silent, never assumed good. */
    check(
      "imaging_contrast_administrations_vial_expiry_ck",
      sql`${t.vialExpiry} is null or ${t.vialExpiry} >= (${t.givenAt} at time zone 'Asia/Kolkata')::date`,
    ),
  ],
);

/**
 * ═══ PLAN 18a-iii T2 — `imaging_contrast_reactions`: THE ROW THAT MUST REACH THE NEXT SCAN ═══
 *
 * 18a's `prior_contrast_reaction` gate READS the patients module's allergy list, and 18a's own
 * out-of-scope note left this phase the other half: *"the reaction that WRITES that allergy is the
 * follow-on's."* This is that write, and D2 makes it the one thing about this table that is not
 * record-only.
 *
 * ═══ `allergy_id` IS `NOT NULL`, AND THAT IS THE WHOLE DESIGN IN ONE COLUMN ═══
 *
 * The defect this chain exists to prevent is *a reaction recorded in radiology and invisible to the
 * next CT's gate*. An event a consumer might one day handle does not prevent it; a service branch
 * that writes the allergy "as well" does not prevent it, because a later refactor can drop the
 * branch and every test about the reaction still passes. **A `NOT NULL` foreign key to
 * `patient_allergies` makes a reaction row that wrote no allergy a state the database cannot hold.**
 * The two writes are one transaction because they are one fact.
 *
 * The reaction hangs off the ADMINISTRATION, not off the study: `imaging_contrast_administrations`
 * already knows the agent, the volume and the route, so the substance written onto the allergy list
 * is the agent that actually went in rather than a second free-text field a hurried hand retypes.
 * `study_id` and `patient_id` are derived from that row and never taken from the caller.
 *
 * ═══ SEVERITY DECIDES WHAT THE RECORD REQUIRES, NEVER WHO MAY WRITE IT (D3) ═══
 *
 * A severe reaction demands the managing clinician and the treatment given —
 * `imaging_contrast_reactions_severe_ck` — because a cardiac arrest with no named clinician and no
 * treatment is not a record of anything. It does NOT demand a senior recorder: a radiographer at
 * 02:00 records what happened, and a system that made them wait for a doctor to type it would be a
 * system that loses the record.
 *
 * ═══ RECORD-ONLY, AND `ot`'s INCIDENT TABLE IS NOT REACHED INTO (D1) ═══
 *
 * `incident.reported` exists and is OWNED by `ot` — its own docstring calls it *"the OT-local
 * incident record, until the quality module (28a) subscribes to it"*. There is no hospital-wide
 * incident or ADR register and 28a is unbuilt. Radiology records the reaction on its own table and
 * emits `imaging.contrast_reaction` for a consumer that does not exist yet. Writing into `ot`'s
 * table would make the hospital's incident register a thing `ot` owns by accident of shipping first.
 */
export const CONTRAST_REACTION_SEVERITIES = ["mild", "moderate", "severe"] as const;
export type ContrastReactionSeverity = (typeof CONTRAST_REACTION_SEVERITIES)[number];

/** Acute versus delayed, the ACR split. A delayed rash at 24 hours is a reaction and is recordable. */
export const CONTRAST_REACTION_ONSETS = ["immediate", "delayed"] as const;
export type ContrastReactionOnset = (typeof CONTRAST_REACTION_ONSETS)[number];

/** Where the patient ended up. NULL while they are still in front of you, which is the usual case. */
export const CONTRAST_REACTION_OUTCOMES = [
  "recovered", "recovering", "admitted", "referred", "died",
] as const;
export type ContrastReactionOutcome = (typeof CONTRAST_REACTION_OUTCOMES)[number];

export const imagingContrastReactions = pgTable(
  "imaging_contrast_reactions",
  {
    id: text("id").primaryKey(), // ULID via newId()
    administrationId: text("administration_id").notNull()
      .references(() => imagingContrastAdministrations.id),
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** D2 — the allergy this reaction wrote. NOT NULL: see the header. */
    allergyId: text("allergy_id").notNull().references(() => patientAllergies.id),
    severity: text("severity").notNull(),
    onset: text("onset").notNull(),
    /** What happened, in the recorder's words. Clinical narrative: it stays here and never in an event. */
    manifestation: text("manifestation").notNull(),
    treatmentGiven: text("treatment_given"),
    managingClinicianId: text("managing_clinician_id"),
    outcome: text("outcome"),
    observedBy: text("observed_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The question the next scan asks: has this patient reacted before, and to what. */
    index("imaging_contrast_reactions_patient_idx").on(t.patientId, t.observedAt),
    index("imaging_contrast_reactions_study_idx").on(t.studyId),
    index("imaging_contrast_reactions_administration_idx").on(t.administrationId),
    check("imaging_contrast_reactions_severity_ck", inList(t.severity, CONTRAST_REACTION_SEVERITIES)),
    check("imaging_contrast_reactions_onset_ck", inList(t.onset, CONTRAST_REACTION_ONSETS)),
    check(
      "imaging_contrast_reactions_outcome_ck",
      sql`${t.outcome} is null or ${inList(t.outcome, CONTRAST_REACTION_OUTCOMES)}`,
    ),
    /** D3 — a severe reaction with no named clinician and no treatment records nothing. */
    check(
      "imaging_contrast_reactions_severe_ck",
      sql`${t.severity} <> 'severe' or (${t.treatmentGiven} is not null and ${t.managingClinicianId} is not null)`,
    ),
  ],
);

/**
 * ═══ PLAN 18a-iii T4 / D5 — `imaging_outside_studies`: A RECORD OF A DOCUMENT, NOT AN IMAGE STORE ═══
 *
 * 18b shipped `IMAGE_SOURCES` with `outside` in it and **nothing behind the value** — its D8 defers
 * the register here by name. This is that register, and D5 fixes its shape: a study performed
 * somewhere else enters as PROVENANCE — the centre, their date, the modality, their accession if the
 * paperwork carries one, and how the images physically arrived — so that a radiologist reporting on
 * it and a clinician reading that report can both see, without asking anybody, that it was not ours.
 *
 * **No file upload in this phase.** The DPDP question and the storage tiering belong with 18b-ii, and
 * a half-built upload is worse than a citation: a link that resolves for six months and then does
 * not is a report referring to evidence nobody can produce.
 *
 * ═══ WHY THE ROW HANGS OFF A STUDY RATHER THAN STANDING ALONE ═══
 *
 * Because the point of the register is that our radiologist REPORTS on it, and a report in this
 * module is written about an `imaging_studies` row. A free-standing provenance table would need a
 * second reporting path, a second worklist and a second way to be billed — D4's argument against a
 * `portable_studies` table, applied to the other end of the module.
 *
 * `study_id` is UNIQUE: one study is one outside examination. Two films from two centres are two
 * referrals, two studies and two rows, because a radiologist signs one report per study and a reader
 * must never have to work out which of two provenances a paragraph refers to.
 *
 * ═══ AND THE ROW IS THE PROOF THAT NO DOSE WAS LOGGED ═══
 *
 * `registerOutsideStudy` is the ONLY path that reaches `acquired` without an acquisition, and it
 * writes this row in the same transaction. So "an `acquired` study with no dose register entry" is
 * not an anomaly to investigate — it is an outside study, and this table says which centre irradiated
 * the patient instead of us.
 */
export const IMAGE_ARRIVALS = ["film", "cd", "link", "none"] as const;
export type ImageArrival = (typeof IMAGE_ARRIVALS)[number];

export const imagingOutsideStudies = pgTable(
  "imaging_outside_studies",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    /** Free text: the other hospital's name as it appears on the film or the envelope. */
    centreName: text("centre_name").notNull(),
    /** THEIR date, not ours. A date on a label, never an instant — it is often all the film carries. */
    studyDate: date("study_date").notNull(),
    modality: text("modality").notNull(),
    /** Their accession or film number, when the paperwork has one. Usually it does not. */
    externalAccessionNo: text("external_accession_no"),
    /** How the images physically arrived. `none` is a REPORT with no images, which is a real case. */
    arrival: text("arrival").notNull(),
    notes: text("notes"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("imaging_outside_studies_study_ux").on(t.studyId),
    index("imaging_outside_studies_centre_idx").on(t.centreName, t.studyDate),
    check("imaging_outside_studies_arrival_ck", inList(t.arrival, IMAGE_ARRIVALS)),
    /**
     * **No CHECK on `modality`, and that is deliberate.** `IMAGING_MODALITIES` lives in
     * `modules/radiology/kinds.ts` — a MODULE file — and this is the kernel schema surface. Inlining
     * the five words here would be a second copy of a vocabulary with one owner, and §2.54's rule is
     * that if a fact must be written twice, something must fail when the copies diverge. Nothing
     * would. `registerOutsideStudy` validates against the owning constant instead, which is also
     * where `imaging_studies` gets its modality answered from (the study TYPE, never a column).
     */
  ],
);

/**
 * 18-S RS9 T1 — what the report changed. The board's five choices (doctor's door, "Mark acted on").
 */
export const IMAGING_ACTED_OUTCOMES = [
  "changed_treatment", "referred", "followup_booked", "discussed_with_patient", "no_change",
] as const;

/** 18-S RS9 T4 — who took the report away from the imaging window. */
export const IMAGING_COLLECTOR_KINDS = ["patient", "relative", "ward_staff", "courier"] as const;
/** The ID a relative shows. Only the LAST FOUR characters are kept (a masked Aadhaar is lawful). */
export const IMAGING_COLLECTOR_ID_TYPES = ["aadhaar", "voter_id", "driving_licence", "pan", "passport", "other"] as const;
/** Ruling 1 — the physical media printed on request. The digital report and link are free. */
export const IMAGING_MEDIA_KINDS = ["film", "cd"] as const;

/**
 * ═══ PLAN 18a-iii T5 / D7 — `imaging_report_delivery`: WHAT HAPPENED TO A REPORT AFTER IT WAS SIGNED ═══
 *
 * **This table exists because the database refused the first design, and the database was right.**
 *
 * The Unread Watchman needs two mutable facts about a signed report — was it read by anybody but its
 * author, and has the chaser already escalated it. The obvious place was three columns on
 * `imaging_reports`, and `imaging_reports_forbid_mutation` (migration 0047) rejected the write:
 * *"only status and published_at may change after insert"*.
 *
 * That trigger is 18a's A10 — a signed report is a courtroom document and its row is append-only.
 * A design that put a chaser's bookkeeping on it would have made the document mutable to buy a
 * worker sweep a column, and every later reader would have had to know which of its fields were
 * evidence and which were housekeeping. **The report is immutable; its DELIVERY is not, and they
 * are different objects.** That is a better model than the one the trigger refused, and it was not
 * the one being written until the refusal.
 *
 * ═══ WHAT EACH COLUMN IS FOR ═══
 *
 * `first_read_*` — `reportView` writes this the first time a reader who is NOT the signer opens a
 * published report. Nothing else in the tree could answer "did this land": `phi_access_log` is an
 * AUDIT surface keyed by patient and surface, carrying the accession only inside a free-text
 * `reason`, and making a clinical escalation depend on that sentence would stop the chasing the day
 * somebody rewords it. `imaging_image_views` answers who opened the IMAGES, which is a different
 * question.
 *
 * FIRST read rather than latest, because the question is whether it landed — a report read once and
 * forgotten has landed. The SIGNER is excluded because a radiologist re-reading their own report is
 * not the referring clinician acting on it, and counting it would make every report look read the
 * moment it was written: the Watchman would go permanently silent, and **a safety net's silence is
 * indistinguishable from everything being fine.**
 *
 * `unread_chased_at` — a record that an escalation HAPPENED, never a state of the report. Same
 * argument as `imaging_critical_findings.chased_at`, and D7's rule that these chasers get a voice
 * rather than teeth.
 */
export const imagingReportDelivery = pgTable(
  "imaging_report_delivery",
  {
    id: text("id").primaryKey(), // ULID via newId()
    reportId: text("report_id").notNull().references(() => imagingReports.id),
    firstReadAt: timestamp("first_read_at", { withTimezone: true }),
    firstReadBy: text("first_read_by"),
    unreadChasedAt: timestamp("unread_chased_at", { withTimezone: true }),
    /**
     * 18-S RS9 T1 (Gap 6) — **THE NORTH-STAR CLOCK STOPS HERE.** The treating doctor records what
     * the report changed (`outcome` from a closed list, plus one line). Per report VERSION, like the
     * read: an amendment is a new version with its own delivery row, so acting on v1 does not count
     * for v2 and the loop re-opens (DECIDED — the doctor acted on a document that has since changed).
     */
    actedAt: timestamp("acted_at", { withTimezone: true }),
    actedBy: text("acted_by"),
    actedOutcome: text("acted_outcome"),
    actedNote: text("acted_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One delivery record per report. The read is an upsert against this. */
    uniqueIndex("imaging_report_delivery_report_ux").on(t.reportId),
    /** The Watchman's own query: unread and unchased, oldest first. */
    index("imaging_report_delivery_unread_idx").on(t.firstReadAt, t.unreadChasedAt),
    /** A read is a person and an instant. Half of one is not a read. */
    check(
      "imaging_report_delivery_first_read_ck",
      sql`(${t.firstReadBy} is null) = (${t.firstReadAt} is null)`,
    ),
    /** An act is a person, an instant, an outcome and a line — all four or none. */
    check(
      "imaging_report_delivery_acted_ck",
      sql`(${t.actedAt} is null) = (${t.actedBy} is null) and (${t.actedAt} is null) = (${t.actedOutcome} is null) and (${t.actedAt} is null) = (${t.actedNote} is null)`,
    ),
    check(
      "imaging_report_delivery_acted_outcome_ck",
      sql`${t.actedOutcome} is null or ${inList(t.actedOutcome, IMAGING_ACTED_OUTCOMES)}`,
    ),
    check(
      "imaging_report_delivery_acted_note_ck",
      sql`${t.actedNote} is null or char_length(btrim(${t.actedNote})) >= 4`,
    ),
  ],
);

/**
 * ═══ 18-S RS9 T4 — THE RELEASE REGISTER'S HAND-OVERS ═══
 *
 * The lab's `lab_report_deliveries` SHAPE (a physical hand-over names its collector), with the
 * collector TYPED rather than one free-text line, because the rule differs by type: a relative
 * needs a name, a relation and the ID they showed; ward staff and a courier need a name. There is
 * no patient OTP service on main (spike c) — DECIDED: the relative's ID type + last four is the
 * record until one exists, and the OTP is deferred and said so.
 *
 * Keyed to the REPORT version handed over (the paper carries that version) and the study.
 */
export const imagingReportHandovers = pgTable(
  "imaging_report_handovers",
  {
    id: text("id").primaryKey(), // ULID via newId()
    reportId: text("report_id").notNull().references(() => imagingReports.id),
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    collectorKind: text("collector_kind").notNull(),
    collectorName: text("collector_name"),
    collectorRelation: text("collector_relation"),
    collectorIdType: text("collector_id_type"),
    collectorIdLast4: text("collector_id_last4"),
    /** Film sheets and a CD handed over WITH the report, when printed (see `imaging_media_requests`). */
    filmSheets: integer("film_sheets").notNull().default(0),
    cd: boolean("cd").notNull().default(false),
    note: text("note"),
    handedBy: text("handed_by").notNull(),
    handedAt: timestamp("handed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("imaging_report_handovers_study_idx").on(t.studyId, t.handedAt),
    index("imaging_report_handovers_report_idx").on(t.reportId),
    check("imaging_report_handovers_kind_ck", inList(t.collectorKind, IMAGING_COLLECTOR_KINDS)),
    check(
      "imaging_report_handovers_id_type_ck",
      sql`${t.collectorIdType} is null or ${inList(t.collectorIdType, IMAGING_COLLECTOR_ID_TYPES)}`,
    ),
    /** Anyone but the patient is NAMED. */
    check(
      "imaging_report_handovers_named_ck",
      sql`${t.collectorKind} = 'patient' or char_length(btrim(coalesce(${t.collectorName}, ''))) >= 2`,
    ),
    /** A relative carries a relation and the ID they showed (type + last four). */
    check(
      "imaging_report_handovers_relative_ck",
      sql`${t.collectorKind} <> 'relative' or (char_length(btrim(coalesce(${t.collectorRelation}, ''))) >= 2 and ${t.collectorIdType} is not null and ${t.collectorIdLast4} ~ '^[A-Za-z0-9]{4}$')`,
    ),
    check("imaging_report_handovers_film_ck", sql`${t.filmSheets} >= 0 and ${t.filmSheets} <= 20`),
  ],
);

/**
 * ═══ 18-S RS9 T4 — FILM AND CD, PRINTED ON REQUEST (RULING 1) ═══
 *
 * A request is recorded at the window, printed, then handed over. `included` is the X-ray's one film
 * (ruling 1: an X-ray includes one film) — no charge. Anything else names the tariff service
 * (`RAD-FILM` / `RAD-CD`, RS4) the counter bills; this row composes no money (DD12) and links no
 * invoice — the charge is taken through billing's own path (DECIDED, RS9 as built).
 */
export const imagingMediaRequests = pgTable(
  "imaging_media_requests",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    kind: text("kind").notNull(),
    /** Film sheets (1+) for a film; 1 for a CD. */
    quantity: integer("quantity").notNull().default(1),
    included: boolean("included").notNull().default(false),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    printedBy: text("printed_by"),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    handoverId: text("handover_id").references(() => imagingReportHandovers.id),
  },
  (t) => [
    index("imaging_media_requests_study_idx").on(t.studyId),
    check("imaging_media_requests_kind_ck", inList(t.kind, IMAGING_MEDIA_KINDS)),
    check("imaging_media_requests_qty_ck", sql`${t.quantity} between 1 and 20 and (${t.kind} = 'film' or ${t.quantity} = 1)`),
    check("imaging_media_requests_printed_ck", sql`(${t.printedBy} is null) = (${t.printedAt} is null)`),
    /** Handed over only once printed. */
    check("imaging_media_requests_handed_ck", sql`${t.handoverId} is null or ${t.printedAt} is not null`),
  ],
);

/**
 * ═══ 18-S RS12b — THE INTERVENTIONAL RADIOLOGY SUITE ═══
 *
 * An IR procedure (PCN, PTBD, CT-guided biopsy, angiography) is an `imaging_studies` row whose study
 * type says `interventional: true` — DECIDED, no parallel procedure table, for the reason 18a-iii
 * gave the portable study: one accession, one set of gates, one dose-register row, one report. What
 * an IR case adds is carried in three tables keyed by the study:
 *
 *   · `imaging_ir_checklists` — the WHO surgical safety checklist, adapted (sign in → time out →
 *     sign out). The OT's `ot_checklist_runs` shape (`items [{key, answer, note?}]`, `participants`,
 *     who/when), one row per phase, written once: a phase is a moment the team stopped, not a form
 *     that is edited afterwards.
 *   · `imaging_ir_sedation_vitals` — the sedation chart (BP, HR, SpO₂, RASS, the drug given), a row
 *     per reading; the five-minute clock is derived from the last row.
 *   · `imaging_ir_cases` — one row per IR study for the facts that are not a checklist: the
 *     radiologist's coagulation override (who, when, why — the audit), the skin-dose follow-up
 *     (3 Gy), the procedure note and the recovery hand-off.
 */
export const IR_CHECKLIST_PHASES = ["sign_in", "time_out", "sign_out"] as const;
export type IrChecklistPhase = (typeof IR_CHECKLIST_PHASES)[number];

export const imagingIrChecklists = pgTable(
  "imaging_ir_checklists",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    phase: text("phase").notNull(),
    /** `[{key, answer, note?}]` — the OT's shape; the answers `ir.ts` validated. */
    items: jsonb("items").notNull(),
    /** User ids and/or names of the people who stopped for it (time out: ≥ 2 distinct). */
    participants: jsonb("participants").notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("imaging_ir_checklists_phase_ux").on(t.studyId, t.phase),
    check("imaging_ir_checklists_phase_ck", inList(t.phase, IR_CHECKLIST_PHASES)),
  ],
);

export const imagingIrSedationVitals = pgTable(
  "imaging_ir_sedation_vitals",
  {
    id: text("id").primaryKey(), // ULID via newId()
    studyId: text("study_id").notNull().references(() => imagingStudies.id),
    bpSystolic: integer("bp_systolic").notNull(),
    bpDiastolic: integer("bp_diastolic").notNull(),
    heartRate: integer("heart_rate").notNull(),
    spo2: integer("spo2").notNull(),
    /** Richmond Agitation–Sedation Scale, −5 (unrousable) … +4 (combative). */
    rass: integer("rass").notNull(),
    /** The sedative / analgesic given at this reading, as charted ("Midazolam 1 mg IV"). */
    drug: text("drug"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("imaging_ir_sedation_vitals_study_idx").on(t.studyId, t.recordedAt),
    check(
      "imaging_ir_sedation_vitals_range_ck",
      sql`${t.bpSystolic} between 40 and 300 and ${t.bpDiastolic} between 20 and 200
          and ${t.bpDiastolic} < ${t.bpSystolic} and ${t.heartRate} between 20 and 250
          and ${t.spo2} between 50 and 100 and ${t.rass} between -5 and 4`,
    ),
  ],
);

export const imagingIrCases = pgTable(
  "imaging_ir_cases",
  {
    studyId: text("study_id").primaryKey().references(() => imagingStudies.id),
    /** The radiologist's override of an out-of-range or missing INR / platelet count, with the verdict it overrode. */
    coagOverrideVerdict: text("coag_override_verdict"),
    coagOverrideReason: text("coag_override_reason"),
    coagOverrideBy: text("coag_override_by"),
    coagOverrideAt: timestamp("coag_override_at", { withTimezone: true }),
    /** Ka,r ≥ 3 Gy: the patient was told and a skin check booked 2–4 weeks out. */
    skinFollowUpOn: date("skin_follow_up_on"),
    skinFollowUpNote: text("skin_follow_up_note"),
    skinFollowUpBy: text("skin_follow_up_by"),
    skinFollowUpAt: timestamp("skin_follow_up_at", { withTimezone: true }),
    /** The procedure note. */
    noteProcedure: text("note_procedure"),
    noteApproach: text("note_approach"),
    noteDevices: text("note_devices"),
    noteSpecimens: text("note_specimens"),
    noteComplications: text("note_complications"),
    noteBloodLossMl: integer("note_blood_loss_ml"),
    noteBy: text("note_by"),
    noteAt: timestamp("note_at", { withTimezone: true }),
    /** The recovery hand-off: `{vitals, bedRestHours, drainCare, instructionsEn, instructionsHi, receivedBy}`. */
    handoff: jsonb("handoff"),
    handoffBy: text("handoff_by"),
    handoffAt: timestamp("handoff_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** An override is a verdict, a reason, a person and an instant — all four or none. */
    check(
      "imaging_ir_cases_coag_override_ck",
      sql`(${t.coagOverrideVerdict} is null and ${t.coagOverrideReason} is null and ${t.coagOverrideBy} is null and ${t.coagOverrideAt} is null)
          or (${t.coagOverrideVerdict} is not null and char_length(btrim(${t.coagOverrideReason})) >= 5
              and ${t.coagOverrideBy} is not null and ${t.coagOverrideAt} is not null)`,
    ),
    check(
      "imaging_ir_cases_skin_ck",
      sql`(${t.skinFollowUpOn} is null) = (${t.skinFollowUpBy} is null) and (${t.skinFollowUpBy} is null) = (${t.skinFollowUpAt} is null)`,
    ),
    check(
      "imaging_ir_cases_note_ck",
      sql`(${t.noteProcedure} is null and ${t.noteBy} is null and ${t.noteAt} is null)
          or (char_length(btrim(${t.noteProcedure})) >= 3 and ${t.noteBy} is not null and ${t.noteAt} is not null)`,
    ),
    check("imaging_ir_cases_blood_loss_ck", sql`${t.noteBloodLossMl} is null or ${t.noteBloodLossMl} between 0 and 10000`),
    /** Handed over only with a note written. */
    check(
      "imaging_ir_cases_handoff_ck",
      sql`(${t.handoff} is null and ${t.handoffBy} is null and ${t.handoffAt} is null)
          or (${t.handoff} is not null and ${t.handoffBy} is not null and ${t.handoffAt} is not null and ${t.noteAt} is not null)`,
    ),
  ],
);
