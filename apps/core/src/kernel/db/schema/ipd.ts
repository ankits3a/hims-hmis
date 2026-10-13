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
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ipd_payer_auths_admission_idx").on(t.admissionId, t.recordedAt),
    check("ipd_payer_auths_entry_ck", sql`${t.entry} in ('initial', 'enhancement', 'final', 'denial', 'payer_change')`),
    check("ipd_payer_auths_status_ck", sql`${t.status} in ('requested', 'approved', 'partially_approved', 'denied', 'final_approved')`),
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
    reversalOf: text("reversal_of"),
    reason: text("reason"),
    postedBy: text("posted_by").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ipd_charge_lines_nightly_ux").on(t.admissionId, t.serviceDate, t.component).where(sql`${t.source} = 'ipd.nightly'`),
    uniqueIndex("ipd_charge_lines_visit_ux").on(t.admissionId, t.serviceDate, t.consultantUserId).where(sql`${t.source} = 'ipd.visit'`),
    uniqueIndex("ipd_charge_lines_reversal_ux").on(t.reversalOf).where(sql`${t.reversalOf} is not null`),
    index("ipd_charge_lines_admission_idx").on(t.admissionId, t.serviceDate),
    check("ipd_charge_lines_component_ck", sql`${t.component} in (${CHARGE_COMPONENTS_SQL})`),
    check("ipd_charge_lines_source_ck", sql`${t.source} in ('ipd.nightly', 'ipd.visit', 'ipd.reversal')`),
    check("ipd_charge_lines_qty_ck", sql`${t.qty} > 0`),
    check(
      "ipd_charge_lines_sign_ck",
      sql`(${t.source} = 'ipd.reversal') = (${t.reversalOf} is not null) and (${t.reversalOf} is null) = (${t.netPaise} >= 0 and ${t.grossPaise} >= 0 and ${t.unitPaise} >= 0)`,
    ),
    check("ipd_charge_lines_reason_ck", sql`${t.reversalOf} is null or coalesce(btrim(${t.reason}), '') <> ''`),
  ],
);

/**
 * A charge that could not be posted (spec §4.3: a missing rate is a visible exception, never a guessed number). One
 * row per admission, day, component and (for visits) consultant (`key`); seen again on every retry, resolved when a
 * later run posts the line. The bill desk (E2.3) works the open rows; the interim bill lists them.
 */
export const ipdChargeExceptions = pgTable(
  "ipd_charge_exceptions",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    component: text("component").notNull(),
    billedClass: text("billed_class"),
    serviceCode: text("service_code"),
    /** `rate_missing` (no price on the locked version, or the service is switched off) or `tariff_missing`. */
    reason: text("reason").notNull(),
    tariffVersionId: text("tariff_version_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedLineId: text("resolved_line_id"),
  },
  (t) => [
    uniqueIndex("ipd_charge_exceptions_key_ux").on(t.key),
    index("ipd_charge_exceptions_open_idx").on(t.admissionId).where(sql`${t.resolvedAt} is null`),
    check("ipd_charge_exceptions_component_ck", sql`${t.component} in (${CHARGE_COMPONENTS_SQL})`),
    check("ipd_charge_exceptions_reason_ck", sql`${t.reason} in ('rate_missing', 'tariff_missing')`),
  ],
);
