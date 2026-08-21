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

/** UHID allocation counter. Gaplessness is NOT required (a rolled-back registration may skip a number). */
export const uhidSeq = pgSequence("uhid_seq", { startWith: 1, increment: 1 });

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
    uhid: text("uhid").notNull(), // <PREFIX>-<8 digits>-<Verhoeff check digit>
    name: text("name").notNull(),
    phone: text("phone"), // normalized 10-digit Indian mobile; NULLABLE — phoneless patients are a designed path (D-34)
    altPhone: text("alt_phone"),
    dob: date("dob", { mode: "date" }), // nullable: unknown DOB; estimated flag below
    dobEstimated: boolean("dob_estimated").notNull().default(false), // true when derived from an entered age
    sex: text("sex").notNull(), // 'male' | 'female' | 'other' | 'unknown'
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
