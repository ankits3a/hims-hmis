import { sql } from "drizzle-orm";
import {
  boolean, customType, date, index, integer, jsonb, pgSequence, pgTable,
  text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/** drizzle has no built-in bytea — the standard customType pattern. Round-trip pinned by test. */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * UHID allocation counter. Gaplessness is NOT required (a rolled-back registration may skip a number).
 *
 * IT STARTS AT 1,234,501, NOT AT 1 (owner ruling 2026-08-25). Serials 1..1,234,500 are reserved
 * and carry NO meaning — see the long note in modules/patients/uhid.ts for why that band is
 * deliberately not a VIP or membership range. `allocateUhid` refuses any serial inside it, so a
 * sequence reset below the floor fails loudly at the counter instead of quietly minting a UHID
 * that the hospital has promised itself it would never issue.
 */
export const uhidSeq = pgSequence("uhid_seq", { startWith: 1234501, increment: 1 });

/**
 * Registration configuration — a single audited row (id = 'main'). The UHID prefix is
 * hospital identity: owner-gated (Class A) at go-live, seeded via scripts/seed-registration.ts.
 * Deliberately data, not an env var: no loadConfig change, no .env.example change.
 */
export const registrationConfig = pgTable("registration_config", {
  id: text("id").primaryKey(),
  uhidPrefix: text("uhid_prefix").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The patient master (spec §6): ONE patients table owned by the registration module; every
 * later module references patient_id and never copies demographics. ABHA is the D-30 field
 * set (address + verification status + link token), nullable from day one — linkable at any
 * visit, never blocking one. Confidential/VIP (§14) affects privacy surfaces only, never
 * priority (D-37). sensitive_context is the D-31 override: it seals the guardian message
 * channel (POCSO/abuse/adolescent-confidentiality — IPD-phase flows depend on it existing NOW).
 */
export const patients = pgTable(
  "patients",
  {
    id: text("id").primaryKey(), // ULID via newId() — entity ids share the event-id grammar
    uhid: text("uhid").notNull(), // <PREFIX><7-digit serial><Verhoeff check digit> — e.g. U12345013
    name: text("name").notNull(),
    phone: text("phone"), // normalized 10-digit Indian mobile; NULLABLE — phoneless patients are a designed path (D-34)
    altPhone: text("alt_phone"),
    dob: date("dob", { mode: "date" }), // nullable: unknown DOB; estimated flag below
    dobEstimated: boolean("dob_estimated").notNull().default(false), // true when derived from an entered age
    sex: text("sex").notNull(), // 'male' | 'female' | 'other' | 'unknown'
    /**
     * PLAN 22c-A DD4 — RULED: administrative gender is Class I (identity-bearing), clinical sex
     * is Class III. They are two columns because they answer two questions and correct by two
     * different paths. `administrative_gender` is the LEGAL identity marker: it prints on
     * documents, a patient has a NALSA right to change it, and it is therefore versioned
     * (`patient_identity_versions`) and amendment-gated. `sex` above stays the clinical
     * observation that will drive reference ranges and dosing when a lab or a formulary needs
     * them, and it corrects through the `entered_in_error` grammar allergies already use.
     *
     * Getting this backwards obstructs a legal right in one direction and lets a clinical value
     * be rewritten as an identity correction in the other. Measured at kickoff (spike S6): NO
     * clinical reader of `sex` exists yet — all 52 non-test references are display, document,
     * search or form. That is precisely why the split is affordable in this phase and will not
     * be affordable in the one that ships the lab.
     *
     * Backfilled from `sex` for every existing row in 0043, then set NOT NULL — 24 production
     * patients, of whom 4 carry 'unknown' or 'other' (S3), so the values carry across unchanged.
     */
    administrativeGender: text("administrative_gender").notNull(), // 'male' | 'female' | 'other' | 'unknown'
    /**
     * PLAN 22c-A DD2 — the assurance ladder, stored as TEXT and compared by an exported rank
     * function, never by string order: 'self_declared' (0) < 'staff_verified' (1) <
     * 'id_verified' (2) < 'abha_verified' (3). Not a Postgres enum, following this table's own
     * precedent (`sex`, `abha_verification_status`) — a fifth level will arrive and an enum
     * would make that a migration with a lock.
     *
     * The DEFAULT is 'self_declared' because that is what a patient asserting their own identity
     * in the app will be. Every row that exists TODAY backfills to 'staff_verified' instead:
     * every patient in the master was typed in by a clerk who saw the person. The default and
     * the backfill deliberately differ, and 0043 spells that out.
     */
    identityAssurance: text("identity_assurance").notNull().default("self_declared"),
    addressLine: text("address_line"),
    district: text("district"),
    stateName: text("state_name"),
    pincode: text("pincode"),
    language: text("language").notNull().default("hi"), // 'hi' | 'en' — outbound-message language (§6), NOT the UI language
    // D9 (DPDP): promotional consent, captured at registration from go-live day one and revocable
    // on the patient record. DEFAULT FALSE is the decision, not a convenience — opt-IN means the
    // patient acted. Nothing in Phase 1 reads it in the send path: the gateway REFUSES the
    // promotional class outright, and the CRM plan that builds promotional sending owns replacing
    // that refusal with a check against this column.
    promotionalOptIn: boolean("promotional_opt_in").notNull().default(false),
    bloodGroup: text("blood_group"), // 'A+'|'A-'|'B+'|'B-'|'AB+'|'AB-'|'O+'|'O-'
    isConfidential: boolean("is_confidential").notNull().default(false), // §14 staff-as-patient / VIP
    alias: text("alias"), // required when confidential; the name public surfaces use
    sensitiveContext: boolean("sensitive_context").notNull().default(false), // D-31 sealed-channel override
    abhaAddress: text("abha_address"), // D-30: the ABHA *address*, not just a number
    abhaNumber: text("abha_number"),
    abhaVerificationStatus: text("abha_verification_status").notNull().default("none"), // 'none'|'self_declared'|'verified'
    abhaLinkToken: text("abha_link_token"), // D-30 reserved M1/M2 field — populated by the real ABDM flow, later plan
    legacyUhid: text("legacy_uhid"), // D-43 old-UHID cross-reference (paper-era continuity)
    qrVersion: integer("qr_version").notNull().default(1), // D-23: reissue increments; old cards fail the scan
    // D10 (D-33): the deceased flag. NULL means alive-as-far-as-this-system-knows. The
    // notifications gateway reads it at SEND time as a hard stop that beats urgency and beats
    // everything else in the suppression gauntlet — a deceased patient's family is structurally
    // unreachable by this machinery from the first message it ever sends. Phase 1 has no
    // death-recording flow, so it is set on the patient-master edit surface and audited through
    // patient.updated's field diff; IPD's death cascade will write it later.
    deceasedAt: timestamp("deceased_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // 'active' | 'merged'
    mergedIntoPatientId: text("merged_into_patient_id"), // set when status='merged'; resolution follows the chain
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    index("patients_created_by_at_idx").on(t.createdBy, t.createdAt),
    uniqueIndex("patients_uhid_ux").on(t.uhid),
    // Phone-first search (<300 ms budget): prefix LIKE needs text_pattern_ops under the
    // cluster's en_US.utf8 collation — a plain btree would be ignored by LIKE 'x%'.
    index("patients_phone_idx").using("btree", t.phone.op("text_pattern_ops")),
    index("patients_alt_phone_idx").using("btree", t.altPhone.op("text_pattern_ops")),
    // Name prefix search on lower(name) — expression index, same opclass reasoning.
    index("patients_name_idx").using("btree", sql`lower(${t.name}) text_pattern_ops`),
  ],
);

/** One CURRENT photo per patient (PK = patient_id) — C-18's photo-prompt source. Cap enforced in code (512,000 bytes). */
/**
 * PLAN 22c-A DD3/DD6 — the identity spine. Append-only, one row per Class I state a patient has
 * ever been in, so a document can be re-rendered as the person who was seen rather than as the
 * person the record has since become.
 *
 * WHY THIS TABLE EXISTS, in one measured line: there is NO name snapshot anywhere in this
 * schema — every document renders `patients.name` by live join — so today amending a name
 * silently rewrites every prescription ever printed for that patient. The competitor teardown
 * (`01-MEDANTA-TEARDOWN.md` P1) shows the mature version of the same bug: one patient's age
 * printed three different ways across a single episode.
 *
 * CLASS I is `name`, `dob`, `administrative_gender`, `abha_number` — the fields that answer
 * *"who was this person"*. A Class II contact change (phone, address) mints NOTHING: a phone
 * number is not part of that answer, and minting on it would make the table unbounded and the
 * resolver ambiguous.
 *
 * FULL FIELD SET PER ROW, NEVER A DIFF (DD3). The resolver is then a single indexed lookup —
 * "newest row with valid_from <= t" — and never a replay. A diff table would be smaller and
 * would put a fold in the render path of every document the hospital prints.
 *
 * APPEND-ONLY IS ENFORCED IN THE DATABASE, not in code: 0043 puts the billing trigger pattern
 * (0012) on this table. A version that can be updated is not a version.
 */
export const patientIdentityVersions = pgTable(
  "patient_identity_versions",
  {
    id: text("id").primaryKey(), // ULID via newId()
    patientId: text("patient_id").notNull().references(() => patients.id),
    version: integer("version").notNull(), // 1-based, per patient, gapless within a patient
    // --- the Class I field set, in force from `validFrom` ---
    name: text("name").notNull(),
    dob: date("dob", { mode: "date" }),
    dobEstimated: boolean("dob_estimated").notNull().default(false),
    administrativeGender: text("administrative_gender").notNull(),
    abhaNumber: text("abha_number"),
    /**
     * Provenance, snapshotted with the field set rather than looked up live. A document asks
     * "who was this person" and the honest answer carries "and how sure were we at the time" —
     * a name at 'self_declared' and the same name at 'id_verified' are different claims.
     */
    identityAssurance: text("identity_assurance").notNull(),
    /**
     * `valid_from` is the instant this version came into force, and the resolver's comparison is
     * `<=` (A21): a version minted at exactly `t` IS in force at `t`. An amendment and an issue
     * in the same second must resolve to the same side deterministically, and the amendment
     * happened first or it would not be in the table.
     */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    /** T7's enumerated reason class — never free text (series R-018). NULL on the 0043 backfill row. */
    reasonClass: text("reason_class"),
    /** Optional pointer to the evidence a clerk saw (a document number, an upload id later). */
    evidenceRef: text("evidence_ref"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("patient_identity_versions_patient_version_ux").on(t.patientId, t.version),
    // The resolver's only query: newest row for a patient with valid_from <= t. DESC on
    // valid_from so the planner takes the first row of the index rather than a sort.
    index("patient_identity_versions_resolve_idx").on(t.patientId, t.validFrom.desc()),
  ],
);

export const patientPhotos = pgTable("patient_photos", {
  patientId: text("patient_id").primaryKey().references(() => patients.id),
  mimeType: text("mime_type").notNull(), // image/jpeg only in v1
  bytes: bytea("bytes").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Allergy list on the patient master (§6): captured at registration (vitals/consult sources
 * arrive Plan 07). Append-only with the E-8 entered-in-error grammar — never edited, never
 * deleted; corrections flip status and mint correction.entered_in_error.
 */
export const patientAllergies = pgTable(
  "patient_allergies",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    substance: text("substance").notNull(),
    reaction: text("reaction"),
    severity: text("severity"), // 'mild' | 'moderate' | 'severe' | null
    source: text("source").notNull(), // 'registration' | 'vitals' | 'consult'
    status: text("status").notNull().default("active"), // 'active' | 'entered_in_error'
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    correctedBy: text("corrected_by"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctionReason: text("correction_reason"),
  },
  (t) => [index("patient_allergies_patient_idx").on(t.patientId)],
);

/**
 * D-31 guardianship: relationship, verified identity, authority SCOPE (messages/consents/
 * DSR/bills), validity dates, DOB-driven majority transition. Enforcement is read-time
 * (guardians.ts effectiveGuardianAuthority); the sweep only flips status and events.
 */
export const patientGuardians = pgTable(
  "patient_guardians",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    name: text("name").notNull(),
    phone: text("phone"),
    relationship: text("relationship").notNull(), // 'father'|'mother'|'spouse'|'sibling'|'legal_guardian'|'other'
    idType: text("id_type"), // 'aadhaar'|'pan'|'voter_id'|'other'
    idNumberMasked: text("id_number_masked"), // last-4 only — never the full document number
    idVerified: boolean("id_verified").notNull().default(false),
    authorityMessages: boolean("authority_messages").notNull().default(true),
    authorityConsents: boolean("authority_consents").notNull().default(true),
    authorityDsr: boolean("authority_dsr").notNull().default(false),
    authorityBills: boolean("authority_bills").notNull().default(true),
    consentNote: text("consent_note"), // DPDP §9 guardian-consent record at minor registration
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }), // explicit validity end (court orders etc.)
    status: text("status").notNull().default("active"), // 'active' | 'ended' | 'majority_ended'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("patient_guardians_patient_idx").on(t.patientId)],
);

/**
 * Merge requests (§11.5): approval-gated via Plan 04 (approval_id is PLAIN TEXT, no FK —
 * see the task's Interfaces note), snapshot carries both rows at request time so unmerge
 * can restore exactly. Status is the single-winner discriminator for execute/unmerge.
 */
export const patientMergeRequests = pgTable(
  "patient_merge_requests",
  {
    id: text("id").primaryKey(),
    winnerId: text("winner_id").notNull().references(() => patients.id),
    loserId: text("loser_id").notNull().references(() => patients.id),
    approvalId: text("approval_id").notNull(), // Plan 04 approvals.id — plain text, deliberately no FK
    unmergeApprovalId: text("unmerge_approval_id"), // set when an unmerge is requested (one per merge in v1)
    requestNote: text("request_note").notNull(),
    snapshot: jsonb("snapshot").notNull(), // { winnerBefore, loserBefore } — full rows at request time
    movedRows: jsonb("moved_rows"), // set at execute: { allergyIds: string[], guardianIds: string[], photoMoved: boolean }
    status: text("status").notNull().default("requested"), // 'requested' | 'executed' | 'unmerged'
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    executedBy: text("executed_by"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    unmergedBy: text("unmerged_by"),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [
    // One live request per loser — the Plan 03 partial-unique precedent (one-active-per-key).
    uniqueIndex("patient_merge_requests_pending_loser_ux")
      .on(t.loserId)
      .where(sql`${t.status} = 'requested'`),
    index("patient_merge_requests_winner_idx").on(t.winnerId),
    index("patient_merge_requests_loser_idx").on(t.loserId),
  ],
);
