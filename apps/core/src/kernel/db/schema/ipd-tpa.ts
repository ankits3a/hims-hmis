import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions, ipdPayerClaims } from "./ipd";

/**
 * #604 (decision 0075) — THE INSURANCE-LITE TPA DESK (SPEC-tpa-desk-2026-10-15). The pre-auth record itself is
 * `ipd_payer_auths` and the claim is `ipd_payer_claims` (one per settled bill); these tables add what a TPA desk works
 * from every day. Rows are appended; a query is answered and a document or package is retired by stamping, never deleted.
 */

/** An insurer's (or scheme's) query on a pre-auth, an enhancement, the final approval or a claim, and our answer. */
export const ipdTpaQueries = pgTable(
  "ipd_tpa_queries",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    claimId: text("claim_id").references(() => ipdPayerClaims.id),
    stage: text("stage").notNull(),
    /** When the insurer raised it (typed from the portal or mail): the hospital's clock starts here. */
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    queryText: text("query_text").notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
    responseText: text("response_text"),
  },
  (t) => [
    index("ipd_tpa_queries_admission_idx").on(t.admissionId, t.raisedAt),
    index("ipd_tpa_queries_open_idx").on(t.raisedAt).where(sql`${t.answeredAt} is null`),
    check("ipd_tpa_queries_stage_ck", sql`${t.stage} in ('preauth', 'enhancement', 'final', 'claim')`),
    check("ipd_tpa_queries_claim_ck", sql`(${t.stage} = 'claim') = (${t.claimId} is not null)`),
    check("ipd_tpa_queries_answer_ck", sql`(${t.answeredAt} is null) = (${t.answeredBy} is null) and (${t.answeredAt} is null) = (${t.responseText} is null)`),
  ],
);

/** A patient document (patients' `patient_documents`) attached to a TPA stage by kind. Detached, never deleted. */
export const ipdTpaDocuments = pgTable(
  "ipd_tpa_documents",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    claimId: text("claim_id").references(() => ipdPayerClaims.id),
    stage: text("stage").notNull(),
    kind: text("kind").notNull(),
    patientDocumentId: text("patient_document_id").notNull(),
    attachedBy: text("attached_by").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull(),
    detachedBy: text("detached_by"),
    detachedAt: timestamp("detached_at", { withTimezone: true }),
  },
  (t) => [
    index("ipd_tpa_documents_admission_idx").on(t.admissionId),
    uniqueIndex("ipd_tpa_documents_live_ux").on(t.admissionId, t.stage, t.kind, t.patientDocumentId).where(sql`${t.detachedAt} is null`),
    check("ipd_tpa_documents_stage_ck", sql`${t.stage} in ('preauth', 'enhancement', 'final', 'claim')`),
    check("ipd_tpa_documents_detached_ck", sql`(${t.detachedAt} is null) = (${t.detachedBy} is null)`),
  ],
);

/**
 * The PM-JAY / state-scheme package master (NHA HBP list, or the state's): one LIVE row per (scheme, code). A re-import
 * whose rate or name differs retires the live row and inserts the new one; nothing is updated in place.
 */
export const ipdSchemePackages = pgTable(
  "ipd_scheme_packages",
  {
    id: text("id").primaryKey(),
    scheme: text("scheme").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    specialty: text("specialty").notNull(),
    kind: text("kind").notNull(),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    preauthRequired: boolean("preauth_required").notNull(),
    importBatch: text("import_batch").notNull(),
    importedBy: text("imported_by").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
    retiredBy: text("retired_by"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_scheme_packages_live_ux").on(t.scheme, t.code).where(sql`${t.retiredAt} is null`),
    check("ipd_scheme_packages_scheme_ck", sql`${t.scheme} in ('pmjay', 'state_scheme')`),
    check("ipd_scheme_packages_kind_ck", sql`${t.kind} in ('surgical', 'medical', 'day_care')`),
    check("ipd_scheme_packages_rate_ck", sql`${t.ratePaise} > 0`),
    check("ipd_scheme_packages_retired_ck", sql`(${t.retiredAt} is null) = (${t.retiredBy} is null)`),
  ],
);

/** A package chosen for a scheme stay. The rate is a SNAPSHOT at selection (DECIDED $): a later import never re-prices it. */
export const ipdAdmissionPackages = pgTable(
  "ipd_admission_packages",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    packageId: text("package_id").notNull().references(() => ipdSchemePackages.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    selectedBy: text("selected_by").notNull(),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull(),
    removedBy: text("removed_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedReason: text("removed_reason"),
  },
  (t) => [
    uniqueIndex("ipd_admission_packages_live_ux").on(t.admissionId, t.code).where(sql`${t.removedAt} is null`),
    check("ipd_admission_packages_rate_ck", sql`${t.ratePaise} > 0`),
    check(
      "ipd_admission_packages_removed_ck",
      sql`(${t.removedAt} is null) = (${t.removedBy} is null) and (${t.removedAt} is null or coalesce(btrim(${t.removedReason}), '') <> '')`,
    ),
  ],
);

/**
 * A claim's life after the bill: submitted (with the amount claimed), settled or short-paid (net paid, TDS, UTR) or
 * rejected. A rejected claim may be submitted again. The latest event is the claim's state.
 */
export const ipdClaimEvents = pgTable(
  "ipd_claim_events",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id").notNull().references(() => ipdPayerClaims.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    /** When it happened (typed from the portal or the advice). */
    at: timestamp("at", { withTimezone: true }).notNull(),
    claimRef: text("claim_ref"),
    claimedPaise: bigint("claimed_paise", { mode: "number" }),
    netPaidPaise: bigint("net_paid_paise", { mode: "number" }),
    tdsPaise: bigint("tds_paise", { mode: "number" }),
    utrRef: text("utr_ref"),
    settledOn: date("settled_on"),
    reason: text("reason"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_claim_events_claim_idx").on(t.claimId, t.at),
    check("ipd_claim_events_kind_ck", sql`${t.kind} in ('submitted', 'settled', 'short_paid', 'rejected')`),
    check("ipd_claim_events_submitted_ck", sql`(${t.kind} = 'submitted') = (${t.claimedPaise} is not null)`),
    check(
      "ipd_claim_events_paid_ck",
      sql`(${t.kind} in ('settled', 'short_paid')) = (${t.netPaidPaise} is not null and ${t.tdsPaise} is not null and ${t.utrRef} is not null)`,
    ),
    check("ipd_claim_events_rejected_ck", sql`${t.kind} <> 'rejected' or coalesce(btrim(${t.reason}), '') <> ''`),
    check(
      "ipd_claim_events_money_ck",
      sql`coalesce(${t.claimedPaise}, 1) > 0 and coalesce(${t.netPaidPaise}, 0) >= 0 and coalesce(${t.tdsPaise}, 0) >= 0`,
    ),
  ],
);

/** A deduction the payer made on a short-paid claim, with its reason (DECIDED $: never re-billed by the system). */
export const ipdClaimDeductions = pgTable(
  "ipd_claim_deductions",
  {
    id: text("id").primaryKey(),
    claimEventId: text("claim_event_id").notNull().references(() => ipdClaimEvents.id),
    claimId: text("claim_id").notNull().references(() => ipdPayerClaims.id),
    reason: text("reason").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    note: text("note"),
    line: integer("line").notNull(),
  },
  (t) => [
    index("ipd_claim_deductions_claim_idx").on(t.claimId),
    check("ipd_claim_deductions_money_ck", sql`${t.amountPaise} > 0`),
    check(
      "ipd_claim_deductions_reason_ck",
      sql`${t.reason} in ('non_payable_items', 'room_rent_cap', 'proportionate', 'co_pay', 'tariff_difference', 'over_package', 'documents_missing', 'policy_exclusion', 'other')`,
    ),
    check("ipd_claim_deductions_other_ck", sql`${t.reason} <> 'other' or coalesce(btrim(${t.note}), '') <> ''`),
  ],
);
