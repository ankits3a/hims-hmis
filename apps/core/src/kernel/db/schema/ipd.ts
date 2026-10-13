import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * `IPD_BED_CLASSES` (packages/contracts/src/ipd-bed-classes.ts), retyped because drizzle-kit loads this file without
 * the workspace packages. `modules/ipd/bed-classes-parity.test.ts` holds the two equal.
 */
export const IPD_BED_CLASS_VALUES = [
  "general", "semi_private", "private", "deluxe", "suite", "hdu", "icu", "nicu", "picu", "ldr", "daycare", "emergency", "overflow",
] as const;
const CLASS_LIST = sql.raw(IPD_BED_CLASS_VALUES.map((c) => `'${c}'`).join(", "));

/**
 * E1.1 (#718) — IPD's bed facts that are not the bed itself (spec SPEC-ipd-core §4.1).
 *
 * WHY TABLES AND NOT `resources.attributes`: the kernel's bed vocabulary has no `reserved` or "block on release"
 * status, and adding one is a kernel edit. A reservation and a block are each a thing with its own life — who,
 * until when, ended how — that the 2-hour lapse job, the board and the goal queries read, and that two desks race
 * for. A partial unique index per table makes "one live reservation per bed" and "one live block per bed" a
 * database fact, not a read-then-write hope. The bed's kernel status stays `available` while reserved; the board
 * overlays `reserved` from here.
 *
 * `bed_id` references the kernel `resources` row and `patient_id` the patient. `admission_id` has NO foreign key
 * yet: `ipd_admissions` arrives with the ipd-admit lane, which adds it. `placed_as` is the gender the patient was
 * placed as (recorded, or stated for other/unknown); null = not recorded, which locks a twin room as "unknown".
 */
export const ipdBedReservations = pgTable(
  "ipd_bed_reservations",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    admissionId: text("admission_id").notNull(), // no FK yet — ipd_admissions comes with ipd-admit
    patientId: text("patient_id").notNull().references(() => patients.id),
    placedAs: text("placed_as"),
    /** active → released (a person) | lapsed (the 2-hour job) | consumed (the patient was put on the bed). */
    status: text("status").notNull(),
    reservedBy: text("reserved_by").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("ipd_bed_reservations_live_bed_ux").on(t.bedId).where(sql`${t.status} = 'active'`),
    index("ipd_bed_reservations_due_idx").on(t.expiresAt).where(sql`${t.status} = 'active'`),
    index("ipd_bed_reservations_admission_idx").on(t.admissionId),
    check("ipd_bed_reservations_status_ck", sql`${t.status} in ('active', 'released', 'lapsed', 'consumed')`),
    check("ipd_bed_reservations_placed_as_ck", sql`${t.placedAs} is null or ${t.placedAs} in ('male', 'female')`),
  ],
);

export const ipdBedBlocks = pgTable(
  "ipd_bed_blocks",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    /** pending_release (asked on an occupied bed) → active (bed blocked) → ended | cancelled. */
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    note: text("note").notNull(),
    expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endNote: text("end_note"),
  },
  (t) => [
    uniqueIndex("ipd_bed_blocks_live_bed_ux").on(t.bedId).where(sql`${t.status} in ('pending_release', 'active')`),
    check("ipd_bed_blocks_status_ck", sql`${t.status} in ('pending_release', 'active', 'ended', 'cancelled')`),
    check(
      "ipd_bed_blocks_reason_ck",
      sql`${t.reason} in ('maintenance', 'infection_control', 'deep_clean', 'staff_shortage', 'other')`,
    ),
  ],
);

/**
 * One row per patient per bed: who lies on the bed, for which admission, billed at which class. The kernel bed row
 * holds the occupancy triad (`occupant_type` `ipd_admission`, `occupant_ref` the admission id); this row holds what
 * the kernel does not know — the patient (room gender, board initials) and the billed class with its 48-hour
 * protection (§4.2), which ipd-charges reads night by night. Ended when the bed is released or the patient moves.
 */
export const ipdBedStays = pgTable(
  "ipd_bed_stays",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    admissionId: text("admission_id").notNull(), // no FK yet — ipd_admissions comes with ipd-admit
    patientId: text("patient_id").notNull().references(() => patients.id),
    placedAs: text("placed_as"),
    bedClass: text("bed_class").notNull(),
    billedClass: text("billed_class").notNull(),
    protectedUntil: timestamp("protected_until", { withTimezone: true }),
    classChange: text("class_change"),
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_bed_stays_open_bed_ux").on(t.bedId).where(sql`${t.endedAt} is null`),
    uniqueIndex("ipd_bed_stays_open_admission_ux").on(t.admissionId).where(sql`${t.endedAt} is null`),
    index("ipd_bed_stays_patient_idx").on(t.patientId),
    check("ipd_bed_stays_bed_class_ck", sql`${t.bedClass} in (${CLASS_LIST})`),
    check("ipd_bed_stays_billed_class_ck", sql`${t.billedClass} in (${CLASS_LIST})`),
    check("ipd_bed_stays_placed_as_ck", sql`${t.placedAs} is null or ${t.placedAs} in ('male', 'female')`),
    check("ipd_bed_stays_class_change_ck", sql`${t.classChange} is null or ${t.classChange} in ('upgrade', 'downgrade')`),
  ],
);

// ═══════════════════════════════════════ E1.2 (#719) — admission ═══════════════════════════════════════

/** The states in which an admission is OPEN: one per patient (§4.2), enforced by a partial unique index. */
export const IPD_OPEN_ADMISSION_STATES = ["requested", "reserved", "admitted", "transferring", "fit_declared", "discharging"] as const;
const OPEN_STATES_SQL = sql.raw(IPD_OPEN_ADMISSION_STATES.map((s) => `'${s}'`).join(", "));

/**
 * One row per admission (spec SPEC-ipd-core §4.2): the request, the payer and plan the deposit was computed from, the
 * consent, the IP number and the downtime serial. `state` MIRRORS the admission workflow instance (one instance per
 * admission, spec v4.6 §10.2): every state change moves both in one transaction. The admission is the IP encounter:
 * its id is the encounter id. Money is integer paise.
 */
export const ipdAdmissions = pgTable(
  "ipd_admissions",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull(),
    workflowInstanceId: text("workflow_instance_id").notNull(),
    state: text("state").notNull(),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    consultantId: text("consultant_id").notNull(),
    coveringFor: text("covering_for"),
    department: text("department"),
    requestedClass: text("requested_class").notNull(),
    isolation: text("isolation").notNull(),
    icu: boolean("icu").notNull(),
    placeAs: text("place_as"),
    provisionalDiagnosis: text("provisional_diagnosis"),
    mlc: boolean("mlc").notNull().default(false),
    plannedFor: timestamp("planned_for", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** Advice validity: planned date (or request) + 24 h. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestedBy: text("requested_by").notNull(),
    payerKind: text("payer_kind"),
    coverageId: text("coverage_id"),
    planKind: text("plan_kind"),
    procedureEstimatePaise: bigint("procedure_estimate_paise", { mode: "number" }),
    estimatePaise: bigint("estimate_paise", { mode: "number" }),
    depositRequiredPaise: bigint("deposit_required_paise", { mode: "number" }),
    depositBasis: text("deposit_basis"),
    depositExemption: text("deposit_exemption"),
    depositExemptionApprovalId: text("deposit_exemption_approval_id"),
    consent: jsonb("consent").$type<Record<string, unknown>>(),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    icuApprovalId: text("icu_approval_id"),
    admissionYear: integer("admission_year"),
    admissionSerial: integer("admission_serial"),
    admissionNo: text("admission_no"),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    admittedBy: text("admitted_by"),
    stabilisedAt: timestamp("stabilised_at", { withTimezone: true }),
    downtimeSerial: text("downtime_serial"),
    /** Downtime: the paper deposit receipt's number, when the paper form carried one. */
    paperReceiptNo: text("paper_receipt_no"),
    /** Downtime back-fill: the deposit was taken (or not) on paper; the bill desk lists these until checked. */
    depositCheckPending: boolean("deposit_check_pending").notNull().default(false),
    /**
     * E2.1 (#725) — THE TARIFF LOCK: the tariff version in force at the admitted instant, recorded by every admit
     * path. Every IPD charge of this stay prices from this version (a later revision never reaches it); null =
     * admitted before E2.1 or with no tariff active, and the charge poster then resolves the version in force at
     * `admitted_at`.
     */
    tariffVersionId: text("tariff_version_id"),
    /**
     * E2.1 review — the last IST day the nightly poster has worked this admission through (capped at the discharge day).
     * The job re-selects an ENDED admission only while this is short of its discharge day or it has open exceptions.
     */
    chargesPostedThrough: date("charges_posted_through", { mode: "string" }),
    cancelReason: text("cancel_reason"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_admissions_open_patient_ux").on(t.patientId).where(sql`${t.state} in (${OPEN_STATES_SQL})`),
    uniqueIndex("ipd_admissions_no_ux").on(t.admissionNo).where(sql`${t.admissionNo} is not null`),
    uniqueIndex("ipd_admissions_serial_ux").on(t.admissionYear, t.admissionSerial).where(sql`${t.admissionSerial} is not null`),
    uniqueIndex("ipd_admissions_downtime_serial_ux").on(t.downtimeSerial).where(sql`${t.downtimeSerial} is not null`),
    uniqueIndex("ipd_admissions_instance_ux").on(t.workflowInstanceId),
    index("ipd_admissions_state_idx").on(t.state),
    index("ipd_admissions_patient_idx").on(t.patientId),
    check("ipd_admissions_source_ck", sql`${t.source} in ('opd_advice', 'ot_daycare_conversion', 'er', 'direct', 'transfer_in', 'downtime')`),
    check("ipd_admissions_payer_ck", sql`${t.payerKind} is null or ${t.payerKind} in ('cash', 'insurance_cashless', 'insurance_reimbursement', 'pmjay', 'state_scheme', 'corporate')`),
    check("ipd_admissions_money_ck", sql`coalesce(${t.estimatePaise}, 0) >= 0 and coalesce(${t.depositRequiredPaise}, 0) >= 0 and coalesce(${t.procedureEstimatePaise}, 0) >= 0`),
  ],
);

/**
 * The manual authorisation record (§2 answer 5): every entry is a row — the initial pre-auth, each enhancement, the
 * final approval or a denial, a payer change. Rows are never updated; `approved_total_paise` is the running total.
 */
export const ipdPayerAuths = pgTable(
  "ipd_payer_auths",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    payerKind: text("payer_kind").notNull(),
    payerRef: text("payer_ref"),
    entry: text("entry").notNull(),
    preAuthNumber: text("pre_auth_number"),
    status: text("status").notNull(),
    approvedAmountPaise: bigint("approved_amount_paise", { mode: "number" }),
    approvedTotalPaise: bigint("approved_total_paise", { mode: "number" }).notNull(),
    coversFrom: timestamp("covers_from", { withTimezone: true }),
    provisionalCashlessSigned: boolean("provisional_cashless_signed").notNull(),
    counsellingDocumentId: text("counselling_document_id"),
    /**
     * E2.2 (#726) — the letter's money terms, typed by the TPA desk. Null = not stated on THIS entry: the split reads
     * the latest stated value of each (`modules/ipd/payer-split.ts`). Never defaulted: no cap typed, no cap applied.
     * Room-rent cap per day as paise, or as basis points of the coverage's sum insured (100 = 1 %); co-pay in bp.
     */
    roomRentCapPaise: bigint("room_rent_cap_paise", { mode: "number" }),
    roomRentCapSiBp: integer("room_rent_cap_si_bp"),
    coPayBp: integer("co_pay_bp"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_payer_auths_admission_idx").on(t.admissionId, t.recordedAt),
    check("ipd_payer_auths_entry_ck", sql`${t.entry} in ('initial', 'enhancement', 'final', 'denial', 'payer_change')`),
    check("ipd_payer_auths_status_ck", sql`${t.status} in ('requested', 'approved', 'partially_approved', 'denied', 'final_approved')`),
    check("ipd_payer_auths_terms_ck", sql`(${t.roomRentCapPaise} is null or ${t.roomRentCapPaise} > 0)
      and (${t.roomRentCapSiBp} is null or ${t.roomRentCapSiBp} between 1 and 10000) and (${t.coPayBp} is null or ${t.coPayBp} between 0 and 10000)`),
    // Review RED 1: one entry states the cap ONE way — absolute or % of sum insured, never both.
    check("ipd_payer_auths_one_cap_ck", sql`${t.roomRentCapPaise} is null or ${t.roomRentCapSiBp} is null`),
  ],
);

/** A deposit receipt (billing's advance) taken for one admission, and who paid it: a refund goes back to them. */
export const ipdAdmissionDeposits = pgTable(
  "ipd_admission_deposits",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    receiptId: text("receipt_id").notNull(),
    receiptNo: text("receipt_no").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    tender: text("tender").notNull(),
    payerName: text("payer_name").notNull(),
    payerRelation: text("payer_relation").notNull(),
    payerPhone: text("payer_phone"),
    nonCoveredApprovalId: text("non_covered_approval_id"),
    /** The intent's idempotency key, committed WITH the receipt: a retry finds this row and never takes money twice. */
    idempotencyKey: text("idempotency_key").notNull(),
    takenBy: text("taken_by").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_admission_deposits_receipt_ux").on(t.receiptId),
    uniqueIndex("ipd_admission_deposits_key_ux").on(t.takenBy, t.idempotencyKey),
    index("ipd_admission_deposits_admission_idx").on(t.admissionId),
    check("ipd_admission_deposits_amount_ck", sql`${t.amountPaise} > 0`),
  ],
);

/** Every band printed: one live band per admission; a reprint voids the old one with its reason (§4.2). */
export const ipdBands = pgTable(
  "ipd_bands",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
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
    uniqueIndex("ipd_bands_serial_ux").on(t.serial),
    uniqueIndex("ipd_bands_live_admission_ux").on(t.admissionId).where(sql`${t.status} = 'printed'`),
    check("ipd_bands_status_ck", sql`${t.status} in ('printed', 'void')`),
  ],
);

// ═══════════════════════════════════════ E2.1 (#725) — the running bill ═══════════════════════════════════════

/** The daily and per-visit components the running bill posts (`IPD_RATE_COMPONENTS`, retyped for drizzle-kit). */
const CHARGE_COMPONENTS_SQL = sql.raw(["room", "nursing", "rmo", "visit", "cross_visit"].map((c) => `'${c}'`).join(", "));

/**
 * One posted line of an admission's running bill (spec SPEC-ipd-core §4.3). APPEND-ONLY: a wrong line is answered by
 * a REVERSAL — a new row whose `reversal_of` names it, with every amount negated and a reason — never an edit. The
 * final bill (E3.2) composes ONE billing invoice from these rows (the OT discharge-bill pattern): billing's invoices
 * are issued, numbered documents, so a running bill cannot live on one.
 *
 * Prices are FROZEN at posting from the admission's locked tariff version through the tariff engine (unit, GST,
 * net), integer paise. `service_date` is the IST calendar day the charge is for — not the day it was posted, so a
 * night caught up later still carries its own date. The partial unique indexes ARE the idempotency: one nightly
 * line per admission, day and component; one visit per admission, day and consultant; one reversal per line.
 */
export const ipdChargeLines = pgTable(
  "ipd_charge_lines",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull(),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    component: text("component").notNull(),
    /** The class the day (or the visit) bills at; null on nothing today, kept nullable for later sources. */
    billedClass: text("billed_class"),
    serviceId: text("service_id").notNull(),
    serviceCode: text("service_code").notNull(),
    serviceName: text("service_name").notNull(),
    tariffVersionId: text("tariff_version_id").notNull(),
    qty: integer("qty").notNull(),
    unitPaise: bigint("unit_paise", { mode: "number" }).notNull(),
    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
    taxablePaise: bigint("taxable_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    netPaise: bigint("net_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    gstExempt: boolean("gst_exempt").notNull(),
    /** `ipd.nightly` (rent, nursing, RMO), `ipd.visit` (the rounds tap), `ipd.reversal`. */
    source: text("source").notNull(),
    /** The visiting consultant (visit lines; copied onto their reversal). */
    consultantUserId: text("consultant_user_id"),
    /**
     * Visit lines: 0 for the first charge of the (admission, day, consultant), n for the charge after n reversed ones —
     * so a reversed visit can be charged again while a live one stays unique (review #756 item 7).
     */
    visitSeq: integer("visit_seq"),
    reversalOf: text("reversal_of"),
    reason: text("reason"),
    postedBy: text("posted_by").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_charge_lines_nightly_ux").on(t.admissionId, t.serviceDate, t.component).where(sql`${t.source} = 'ipd.nightly'`),
    uniqueIndex("ipd_charge_lines_visit_ux").on(t.admissionId, t.serviceDate, t.consultantUserId, t.visitSeq).where(sql`${t.source} = 'ipd.visit'`),
    uniqueIndex("ipd_charge_lines_reversal_ux").on(t.reversalOf).where(sql`${t.reversalOf} is not null`),
    index("ipd_charge_lines_admission_idx").on(t.admissionId, t.serviceDate),
    check("ipd_charge_lines_component_ck", sql`${t.component} in (${CHARGE_COMPONENTS_SQL})`),
    check("ipd_charge_lines_source_ck", sql`${t.source} in ('ipd.nightly', 'ipd.visit', 'ipd.reversal')`),
    check("ipd_charge_lines_qty_ck", sql`${t.qty} > 0`),
    check("ipd_charge_lines_reversal_ck", sql`(${t.source} = 'ipd.reversal') = (${t.reversalOf} is not null)`),
    // A posted line is never negative; a reversal is never positive. Zero is allowed both ways (a fully discounted line).
    check(
      "ipd_charge_lines_sign_ck",
      sql`case when ${t.reversalOf} is null then ${t.unitPaise} >= 0 and ${t.grossPaise} >= 0 and ${t.discountPaise} >= 0 and ${t.netPaise} >= 0
          else ${t.unitPaise} <= 0 and ${t.grossPaise} <= 0 and ${t.discountPaise} <= 0 and ${t.netPaise} <= 0 end`,
    ),
    check("ipd_charge_lines_visit_seq_ck", sql`(${t.source} = 'ipd.visit') = (${t.visitSeq} is not null) or ${t.source} = 'ipd.reversal'`),
    check("ipd_charge_lines_reason_ck", sql`${t.reversalOf} is null or coalesce(btrim(${t.reason}), '') <> ''`),
  ],
);

/**
 * A charge that could not be posted (spec §4.3: a missing rate is a visible exception, never a guessed number). One
 * row per admission, day, component and (for visits) consultant (`key`); seen again on every retry, resolved when a
 * later run posts the line. The bill desk (E2.3) works the open rows; the interim bill lists them.
 *
 * Review #756 item 2 — `posting_failed` (key `<admission>:posting_failed`, no day or component): the poster threw a
 * domain error for the admission; `fail_count` counts consecutive failures and at 3 the job skips the admission until
 * a person resolves the row (`retryAdmissionCharges`). `error_code` names the error.
 */
export const ipdChargeExceptions = pgTable(
  "ipd_charge_exceptions",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    serviceDate: date("service_date", { mode: "string" }),
    component: text("component"),
    billedClass: text("billed_class"),
    serviceCode: text("service_code"),
    /** `rate_missing` (no price on the locked version, or the service is switched off) or `tariff_missing`. */
    reason: text("reason").notNull(),
    tariffVersionId: text("tariff_version_id"),
    failCount: integer("fail_count").notNull().default(0),
    errorCode: text("error_code"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedLineId: text("resolved_line_id"),
  },
  (t) => [
    uniqueIndex("ipd_charge_exceptions_key_ux").on(t.key),
    index("ipd_charge_exceptions_open_idx").on(t.admissionId).where(sql`${t.resolvedAt} is null`),
    check("ipd_charge_exceptions_component_ck", sql`${t.component} is null or ${t.component} in (${CHARGE_COMPONENTS_SQL})`),
    check("ipd_charge_exceptions_reason_ck", sql`${t.reason} in ('rate_missing', 'tariff_missing', 'posting_failed')`),
    check("ipd_charge_exceptions_shape_ck", sql`(${t.reason} = 'posting_failed') = (${t.component} is null) and (${t.component} is null) = (${t.serviceDate} is null)`),
  ],
);

// ═══════════════════════════════════ E2.2 (#726) — payer authorisation and bill split ═══════════════════════════════════

/**
 * The non-payables list (spec §4.3 payer split): service codes or tariff categories an insurer never pays (IRDAI's
 * non-medical items). Configuration the TPA desk keeps; a row is retired, never deleted. Starts EMPTY (DECIDED, E2.2):
 * no IRDAI non-medical category exists as a tariff category today, so none is seeded.
 */
export const ipdPayerNonPayables = pgTable(
  "ipd_payer_non_payables",
  {
    id: text("id").primaryKey(),
    /** `service` (a tariff service code) or `category` (a tariff service category). */
    matchKind: text("match_kind").notNull(),
    matchValue: text("match_value").notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    retiredBy: text("retired_by"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_payer_non_payables_live_ux").on(t.matchKind, sql`lower(${t.matchValue})`).where(sql`${t.retiredAt} is null`),
    check("ipd_payer_non_payables_kind_ck", sql`${t.matchKind} in ('service', 'category')`),
  ],
);

/**
 * The payer split as it was PRINTED on an interim bill (spec E2.2 §2: the split is computed on read; a printed paper
 * is evidence, so what it said is kept). Append-only: one row per print, the whole split as jsonb.
 */
export const ipdPayerSplitSnapshots = pgTable(
  "ipd_payer_split_snapshots",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    payerPaise: bigint("payer_paise", { mode: "number" }).notNull(),
    patientPaise: bigint("patient_paise", { mode: "number" }).notNull(),
    split: jsonb("split").$type<Record<string, unknown>>().notNull(),
    printedBy: text("printed_by").notNull(),
    printedAt: timestamp("printed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_payer_split_snapshots_admission_idx").on(t.admissionId, t.printedAt),
    check("ipd_payer_split_snapshots_kind_ck", sql`${t.kind} in ('interim')`),
  ],
);

// ═══════════════════════════════════════ E3.1 (#729) — transfer and class change ═══════════════════════════════════════

/**
 * One row per transfer between beds (spec SPEC-ipd-core §4.4). Started by the sending side with an SBAR handover;
 * the target bed is HELD for the admission (an `ipd_bed_reservations` row, `reservation_id`) and the patient stays on
 * the origin bed — still occupied, the sending ward still responsible — until the receiving nurse accepts. Accept
 * closes the origin stay, opens the target stay and sends the origin bed to cleaning in one transaction; cancel
 * releases the hold. `open` → `accepted` | `cancelled`. One open transfer per admission (partial unique).
 */
export const ipdTransfers = pgTable(
  "ipd_transfers",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    fromBedId: text("from_bed_id").notNull().references(() => resources.id),
    toBedId: text("to_bed_id").notNull().references(() => resources.id),
    /** The target bed's hold (`ipd_bed_reservations`), consumed at acceptance or released at cancel. */
    reservationId: text("reservation_id").notNull(),
    reason: text("reason").notNull(),
    situation: text("situation").notNull(),
    background: text("background").notNull(),
    assessment: text("assessment").notNull(),
    recommendation: text("recommendation").notNull(),
    /** A copilot draft the nurse signed (AI drafting is later work); null when typed. */
    draftId: text("draft_id"),
    intensivistApprovalId: text("intensivist_approval_id"),
    status: text("status").notNull(),
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** The workflow's 100 % rung on `transferring`, copied for the handover list's clock. */
    escalatesAt: timestamp("escalates_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    cancelNote: text("cancel_note"),
  },
  (t) => [
    uniqueIndex("ipd_transfers_open_admission_ux").on(t.admissionId).where(sql`${t.status} = 'open'`),
    index("ipd_transfers_open_idx").on(t.toBedId).where(sql`${t.status} = 'open'`),
    check("ipd_transfers_status_ck", sql`${t.status} in ('open', 'accepted', 'cancelled')`),
    check(
      "ipd_transfers_reason_ck",
      sql`${t.reason} in ('clinical_step_up', 'clinical_step_down', 'post_op', 'isolation', 'gender_fix', 'patient_request', 'bed_management', 'maintenance')`,
    ),
    check("ipd_transfers_beds_ck", sql`${t.fromBedId} <> ${t.toBedId}`),
    check("ipd_transfers_ended_ck", sql`(${t.status} = 'open') = (${t.endedAt} is null)`),
    check(
      "ipd_transfers_cancel_ck",
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null) and (${t.cancelReason} is null or ${t.cancelReason} in ('patient_deteriorated', 'receiving_ward_declined', 'bed_unsuitable', 'plan_changed', 'other', 'hold_lapsed'))`,
    ),
  ],
);

/**
 * A billing-class change WITHOUT a bed move (§4.4 "class upgrade or downgrade on request: consent, effective next
 * noon"): the stay `stay_id` bills at `to_class` from `effective_from` (the next 12:00 IST after the consent). The
 * running bill folds it into the stay before the day rule (`class-change.ts` `applyClassChanges`), so the day rule's
 * "highest class held over an hour" decides the noon day. A newer change on the same stay that is not yet in effect
 * supersedes the older one. The consent is the admission consent's shape (who, relation, method, witness).
 */
export const ipdClassChanges = pgTable(
  "ipd_class_changes",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    stayId: text("stay_id").notNull().references(() => ipdBedStays.id),
    fromClass: text("from_class").notNull(),
    toClass: text("to_class").notNull(),
    direction: text("direction").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    consent: jsonb("consent").$type<Record<string, unknown>>().notNull(),
    roomRentCapAcknowledged: boolean("room_rent_cap_acknowledged").notNull(),
    /** active → superseded (a newer change on the stay before this one took effect). */
    status: text("status").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    index("ipd_class_changes_admission_idx").on(t.admissionId),
    check("ipd_class_changes_from_ck", sql`${t.fromClass} in (${CLASS_LIST})`),
    check("ipd_class_changes_to_ck", sql`${t.toClass} in (${CLASS_LIST})`),
    check("ipd_class_changes_direction_ck", sql`${t.direction} in ('upgrade', 'downgrade')`),
    check("ipd_class_changes_status_ck", sql`${t.status} in ('active', 'superseded')`),
    check("ipd_class_changes_differs_ck", sql`${t.fromClass} <> ${t.toClass}`),
  ],
);

// ═══════════════════════════════════════ E3.2 (#730) — discharge and the other ways a stay ends ═══════════════════════════════════════

/**
 * One row per fit declaration (spec SPEC-ipd-core §4.7): the discharge cascade's clock starts here. `active` →
 * `completed` (the gate scan) | `cancelled` (the patient worsened: cancel_fit). A new declaration after a cancel is a new
 * row; one active row per admission (partial unique).
 */
export const ipdDischarges = pgTable(
  "ipd_discharges",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    status: text("status").notNull(),
    /** `today` or `tomorrow` (an expected discharge for the evening huddle). */
    fitWhen: text("fit_when").notNull(),
    /** `home` or `transfer_out` (refer to another hospital). */
    disposition: text("disposition").notNull(),
    note: text("note"),
    declaredBy: text("declared_by").notNull(),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
    /** The 3-hour target for cash (the workflow's `fit_declared` SLA). */
    targetAt: timestamp("target_at", { withTimezone: true }).notNull(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    uniqueIndex("ipd_discharges_active_ux").on(t.admissionId).where(sql`${t.status} = 'active'`),
    index("ipd_discharges_admission_idx").on(t.admissionId, t.declaredAt),
    check("ipd_discharges_status_ck", sql`${t.status} in ('active', 'completed', 'cancelled')`),
    check("ipd_discharges_when_ck", sql`${t.fitWhen} in ('today', 'tomorrow')`),
    check("ipd_discharges_disposition_ck", sql`${t.disposition} in ('home', 'transfer_out')`),
    check("ipd_discharges_ended_ck", sql`(${t.status} = 'active') = (${t.endedAt} is null)`),
    check("ipd_discharges_cancel_ck", sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
  ],
);

/**
 * The departments that must confirm "no pending charge" for one fit declaration. DECIDED (E3.2): the departments are
 * those with lines or open orders for the admission (`ward` always — the nightly lines; `lab` / `radiology` when an
 * order placed since admission is still open), plus `billing`, which confirms last. One row per (discharge, department).
 */
export const ipdDischargeConfirmations = pgTable(
  "ipd_discharge_confirmations",
  {
    id: text("id").primaryKey(),
    dischargeId: text("discharge_id").notNull().references(() => ipdDischarges.id),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    department: text("department").notNull(),
    /** Why the department is on the list: `lines`, `open_orders` or `always`. */
    basis: text("basis").notNull(),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("ipd_discharge_confirmations_ux").on(t.dischargeId, t.department),
    check(
      "ipd_discharge_confirmations_dept_ck",
      sql`${t.department} in ('pharmacy', 'lab', 'radiology', 'ot', 'ward', 'dietary', 'cssd', 'blood_bank', 'billing')`,
    ),
    check("ipd_discharge_confirmations_basis_ck", sql`${t.basis} in ('lines', 'open_orders', 'always')`),
    check("ipd_discharge_confirmations_by_ck", sql`(${t.confirmedBy} is null) = (${t.confirmedAt} is null)`),
  ],
);

/**
 * The structured discharge summary (spec §4.7: signed before the patient leaves; a resident's sign needs the consultant's
 * co-sign). One per admission; every save bumps `version`, and signing names the version read (`draft_changed`).
 * `draft_model_id` / `draft_prompt_version` stay null until the copilot drafter (M5) writes a draft; the screen shows
 * "Draft" until a named consultant signs. A signed summary is immutable (the intent refuses a save after it).
 */
export const ipdDischargeSummaries = pgTable(
  "ipd_discharge_summaries",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    /** Provenance of the draft text: `person` (typed from the template) or `copilot_draft` (M5). */
    draftSource: text("draft_source").notNull(),
    draftModelId: text("draft_model_id"),
    draftPromptVersion: text("draft_prompt_version"),
    draftedBy: text("drafted_by").notNull(),
    draftedAt: timestamp("drafted_at", { withTimezone: true }).notNull(),
    residentSignedBy: text("resident_signed_by"),
    residentSignedAt: timestamp("resident_signed_at", { withTimezone: true }),
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** The signed copy's document id (minted at sign; the print names the doctor). */
    documentId: text("document_id"),
  },
  (t) => [
    uniqueIndex("ipd_discharge_summaries_admission_ux").on(t.admissionId),
    check("ipd_discharge_summaries_status_ck", sql`${t.status} in ('draft', 'awaiting_cosign', 'signed')`),
    check("ipd_discharge_summaries_source_ck", sql`${t.draftSource} in ('person', 'copilot_draft')`),
    check("ipd_discharge_summaries_signed_ck", sql`(${t.status} = 'signed') = (${t.signedAt} is not null)`),
    check("ipd_discharge_summaries_version_ck", sql`${t.version} > 0`),
  ],
);

/**
 * The final bill (spec §4.7): ONE billing invoice for the admission's PATIENT-payable portion, composed from the
 * non-reversed running-bill lines; deposits applied, excess refunded (a refund request), any unpaid balance recorded as
 * dues against the signed undertaking — never a detention; the dues approval follows the exit. One per admission.
 * Integer paise: `total_paise` = Σ the non-reversed lines' net; `patient_paise` = the invoice before rounding (as billing
 * prices it); `payer_paise` = total − patient (the claim). payer + patient = total, always.
 */
export const ipdFinalBills = pgTable(
  "ipd_final_bills",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    /** The running bill's version the cashier read (the count of its lines, append-only). */
    billVersion: integer("bill_version").notNull(),
    invoiceId: text("invoice_id"),
    invoiceNo: text("invoice_no"),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    payerPaise: bigint("payer_paise", { mode: "number" }).notNull(),
    /** The invoice's net payable (rounded once, by billing). */
    patientPaise: bigint("patient_paise", { mode: "number" }).notNull(),
    depositAppliedPaise: bigint("deposit_applied_paise", { mode: "number" }).notNull(),
    paidPaise: bigint("paid_paise", { mode: "number" }).notNull(),
    refundPaise: bigint("refund_paise", { mode: "number" }).notNull(),
    refundApprovalId: text("refund_approval_id"),
    duesPaise: bigint("dues_paise", { mode: "number" }).notNull(),
    settlement: text("settlement").notNull(),
    duesApprovalId: text("dues_approval_id"),
    duesApprovedBy: text("dues_approved_by"),
    /** E3.2 review ⚖: the dues approval is recorded AFTER the exit (a ledger step), never before it. */
    duesApprovedAt: timestamp("dues_approved_at", { withTimezone: true }),
    undertakingDocumentId: text("undertaking_document_id"),
    /** The payer split as it stood at settlement (the printed final bill's evidence). */
    split: jsonb("split").$type<Record<string, unknown>>().notNull(),
    settledBy: text("settled_by").notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_final_bills_admission_ux").on(t.admissionId),
    check("ipd_final_bills_settlement_ck", sql`${t.settlement} in ('paid', 'refund_due', 'dues_recorded', 'insurer_pending_undertaking')`),
    check(
      "ipd_final_bills_money_ck",
      sql`${t.totalPaise} >= 0 and ${t.payerPaise} >= 0 and ${t.patientPaise} >= 0 and ${t.depositAppliedPaise} >= 0 and ${t.paidPaise} >= 0 and ${t.refundPaise} >= 0 and ${t.duesPaise} >= 0`,
    ),
    check("ipd_final_bills_dues_ck", sql`${t.duesPaise} = 0 or ${t.undertakingDocumentId} is not null`),
  ],
);

/**
 * The payer's portion of the final bill (DECIDED $, E3.2): billing has no payer-credit model, so the invoice carries the
 * patient's portion and the insurer / corporate / scheme portion is this claim record. Filing is out of scope (later).
 */
export const ipdPayerClaims = pgTable(
  "ipd_payer_claims",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    finalBillId: text("final_bill_id").notNull().references(() => ipdFinalBills.id),
    payerKind: text("payer_kind").notNull(),
    coverageId: text("coverage_id"),
    preAuthNumber: text("pre_auth_number"),
    claimPaise: bigint("claim_paise", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_payer_claims_admission_ux").on(t.admissionId),
    check("ipd_payer_claims_status_ck", sql`${t.status} in ('pending', 'filed', 'settled', 'rejected')`),
    check("ipd_payer_claims_money_ck", sql`${t.claimPaise} > 0`),
  ],
);

/**
 * The gate pass (spec §4.7): issued only when charges are confirmed, the summary signed and the bill settled (or its
 * dues approved); security scans it at the exit, which ends the stay. One live pass per admission; a cancel_fit voids it.
 */
export const ipdGatePasses = pgTable(
  "ipd_gate_passes",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    code: text("code").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    duesRecorded: boolean("dues_recorded").notNull(),
    receivingHospital: jsonb("receiving_hospital").$type<{ name: string; confirmedBy: string }>(),
    followUpAppointmentId: text("follow_up_appointment_id"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    scannedBy: text("scanned_by"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    gateId: text("gate_id"),
    voidedBy: text("voided_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("ipd_gate_passes_code_ux").on(t.code),
    uniqueIndex("ipd_gate_passes_live_ux").on(t.admissionId).where(sql`${t.status} = 'issued'`),
    check("ipd_gate_passes_kind_ck", sql`${t.kind} in ('discharge', 'transfer_out')`),
    check("ipd_gate_passes_status_ck", sql`${t.status} in ('issued', 'used', 'void')`),
    check("ipd_gate_passes_used_ck", sql`(${t.status} = 'used') = (${t.scannedAt} is not null)`),
    check("ipd_gate_passes_void_ck", sql`(${t.status} = 'void') = (${t.voidedAt} is not null)`),
    check("ipd_gate_passes_refer_ck", sql`(${t.kind} = 'transfer_out') = (${t.receivingHospital} is not null)`),
  ],
);

/**
 * The other ways a stay ends (spec §4.7 edge cases): LAMA / DAMA, absconded, death. One per admission; `details` keeps the
 * form, witness, police intimation and the cause fields an MCCD will need later (no form generation here).
 */
export const ipdStayExits = pgTable(
  "ipd_stay_exits",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_stay_exits_admission_ux").on(t.admissionId),
    check("ipd_stay_exits_kind_ck", sql`${t.kind} in ('lama', 'dama', 'absconded', 'deceased')`),
  ],
);

/**
 * The minimal mortuary register (spec §4.7 death edge case). A death opens the row (`expected`); the mortuary receives the
 * body with a two-person identity check (`received`); release to the next of kin (`released`) needs police clearance
 * for an MLC. ⚖ Dues NEVER block a release: nothing here reads the bill.
 */
export const ipdMortuaryRegister = pgTable(
  "ipd_mortuary_register",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull(),
    status: text("status").notNull(),
    diedAt: timestamp("died_at", { withTimezone: true }).notNull(),
    mlc: boolean("mlc").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: text("received_by"),
    /** The second person of the two-person identity check at handover. */
    identityCheckedBy: text("identity_checked_by"),
    policeClearance: boolean("police_clearance").notNull().default(false),
    policeClearanceRef: text("police_clearance_ref"),
    releasedTo: jsonb("released_to").$type<{ name: string; relation: string; idProofRef: string }>(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: text("released_by"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_mortuary_register_admission_ux").on(t.admissionId),
    index("ipd_mortuary_register_status_idx").on(t.status),
    check("ipd_mortuary_register_status_ck", sql`${t.status} in ('expected', 'received', 'released')`),
    check("ipd_mortuary_register_received_ck", sql`(${t.status} = 'expected') = (${t.receivedAt} is null)`),
    check("ipd_mortuary_register_released_ck", sql`(${t.status} = 'released') = (${t.releasedAt} is not null)`),
    check("ipd_mortuary_register_mlc_ck", sql`${t.status} <> 'released' or not ${t.mlc} or ${t.policeClearance}`),
  ],
);

// ═══════════════════════════════════ E2.3 (#727) — the deposit ladder ═══════════════════════════════════

/**
 * One firing of a deposit-ladder threshold on an admission (spec SPEC-ipd-core §2 answer 3, §4.3; decision 0072): the
 * patient-payable running total reached `threshold_bp` of the deposit held (`top_up` 75 %, `escalate` 90 %). A level
 * fires ONCE while armed — the partial unique index admits one live row per (admission, level). A later evaluation that
 * finds usage back under the threshold (a top-up, a reversal) sets `rearmed_at`, and the next crossing fires a new row.
 * The figures are those at the firing; the row is the bill desk's and the desk card's source, never a block on care.
 */
export const ipdDepositAlerts = pgTable(
  "ipd_deposit_alerts",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    level: text("level").notNull(),
    thresholdBp: integer("threshold_bp").notNull(),
    usedBp: integer("used_bp").notNull(),
    patientPayablePaise: bigint("patient_payable_paise", { mode: "number" }).notNull(),
    depositHeldPaise: bigint("deposit_held_paise", { mode: "number" }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    rearmedAt: timestamp("rearmed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_deposit_alerts_live_ux").on(t.admissionId, t.level).where(sql`${t.rearmedAt} is null`),
    index("ipd_deposit_alerts_admission_idx").on(t.admissionId, t.firedAt),
    check("ipd_deposit_alerts_level_ck", sql`${t.level} in ('top_up', 'escalate')`),
    check("ipd_deposit_alerts_money_ck", sql`${t.patientPayablePaise} >= 0 and ${t.depositHeldPaise} >= 0 and ${t.usedBp} >= 0`),
  ],
);

/**
 * E2.3 (#727, review 9) — the daily totals to the attendant, ONE row per admission and IST day: what was done (queued, or
 * skipped and why) and the outbox row it queued. The unique key is the dedupe, taken under the admission's advisory lock,
 * so a rerun or two workers queue and record nothing twice.
 */
export const ipdDailyTotals = pgTable(
  "ipd_daily_totals",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    billDate: date("bill_date", { mode: "string" }).notNull(),
    outcome: text("outcome").notNull(),
    notificationId: text("notification_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_daily_totals_day_ux").on(t.admissionId, t.billDate),
    check("ipd_daily_totals_outcome_ck", sql`${t.outcome} in ('queued', 'no_attendant_phone', 'sealed')`),
  ],
);

// ═══════════════════════════════════ E3.3 (#731) — the family link ═══════════════════════════════════

/**
 * The condition word the treating team sets for the family page (spec §4.9 G: never written by a model), and the team's
 * switch that turns the family link off for this admission (psychiatric, HIV, MTP, POCSO, the patient's request). One
 * row per admission, overwritten; every change is an `ipd.condition.set` event.
 */
export const ipdAdmissionConditions = pgTable(
  "ipd_admission_conditions",
  {
    admissionId: text("admission_id").primaryKey().references(() => ipdAdmissions.id),
    word: text("word"),
    setBy: text("set_by"),
    setAt: timestamp("set_at", { withTimezone: true }),
    familyOffReason: text("family_off_reason"),
    familyOffBy: text("family_off_by"),
    familyOffAt: timestamp("family_off_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("ipd_admission_conditions_word_ck", sql`${t.word} is null or ${t.word} in ('stable', 'improving', 'serious', 'critical')`),
    check(
      "ipd_admission_conditions_off_ck",
      sql`${t.familyOffReason} is null or ${t.familyOffReason} in ('psychiatric', 'hiv', 'mtp', 'pocso', 'patient_request', 'other')`,
    ),
  ],
);

/**
 * One family link per issue (spec §4.9 G, §4.10 edge 15). The token is stored only as its SHA-256; the attendant is a
 * REFERENCE (guardian or deposit row) plus the phone's hash at issue, so an OTP goes only to the phone the desk saw — a
 * later change of that phone refuses the send. `consent` records who agreed and their relation (DPDP Act 2023 §6).
 * `active` → `revoked` (death, absconding, a new link, the team turned it off, the desk) | `expired` (24 h after the exit).
 */
export const ipdFamilyLinks = pgTable(
  "ipd_family_links",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    tokenHash: text("token_hash").notNull(),
    attendantKind: text("attendant_kind").notNull(),
    attendantRef: text("attendant_ref").notNull(),
    phoneHash: text("phone_hash").notNull(),
    phoneMasked: text("phone_masked").notNull(),
    purpose: text("purpose").notNull(),
    consent: jsonb("consent").$type<{ consentedBy: string; relation: string; method: string }>().notNull(),
    status: text("status").notNull(),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    uniqueIndex("ipd_family_links_token_ux").on(t.tokenHash),
    uniqueIndex("ipd_family_links_live_ux").on(t.admissionId).where(sql`${t.status} = 'active'`),
    check("ipd_family_links_status_ck", sql`${t.status} in ('active', 'revoked', 'expired')`),
    check("ipd_family_links_kind_ck", sql`${t.attendantKind} in ('guardian', 'deposit_payer')`),
    check("ipd_family_links_revoked_ck", sql`(${t.status} = 'active') = (${t.revokedAt} is null)`),
  ],
);

/**
 * One OTP challenge per send (3 an hour per link). The code is stored only as a hash bound to the challenge id and to the
 * browser that asked (`device_hash`); 10 minutes; a wrong code counts in `attempts` (5 wrong codes an hour per link).
 */
export const ipdFamilyOtps = pgTable(
  "ipd_family_otps",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id").notNull().references(() => ipdFamilyLinks.id),
    codeHash: text("code_hash").notNull(),
    deviceHash: text("device_hash").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [index("ipd_family_otps_link_idx").on(t.linkId, t.sentAt)],
);

/** A verified browser: the cookie's SHA-256, bound to the device that verified, 12 hours. */
export const ipdFamilySessions = pgTable(
  "ipd_family_sessions",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id").notNull().references(() => ipdFamilyLinks.id),
    tokenHash: text("token_hash").notNull(),
    deviceHash: text("device_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("ipd_family_sessions_token_ux").on(t.tokenHash), index("ipd_family_sessions_link_idx").on(t.linkId)],
);

/**
 * "Request a callback" from the family page (spec §4.10 edge 14): free text to the ward desk, NEVER answered by a model.
 * `open` → `done` with who called back and a note.
 */
export const ipdFamilyCallbacks = pgTable(
  "ipd_family_callbacks",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    linkId: text("link_id").notNull().references(() => ipdFamilyLinks.id),
    text: text("text").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    note: text("note"),
  },
  (t) => [
    index("ipd_family_callbacks_open_idx").on(t.status, t.createdAt),
    index("ipd_family_callbacks_admission_idx").on(t.admissionId),
    check("ipd_family_callbacks_status_ck", sql`${t.status} in ('open', 'done')`),
    check("ipd_family_callbacks_closed_ck", sql`(${t.status} = 'done') = (${t.closedAt} is not null)`),
  ],
);
