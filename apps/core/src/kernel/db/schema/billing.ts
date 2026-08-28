import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { patients } from "./patients";

/**
 * Plan 08 — billing: invoices, the receipts + allocations ledger, credit notes, refund
 * vouchers, cashier sessions (spec §7, C-2, D-17, E-24/25/26).
 *
 * Money is integer PAISE (bigint mode number — never floats), the Plan 04/06 precedent.
 *
 * The ledger is APPEND-ONLY by construction: `invoices`, `invoice_lines`, `credit_notes`,
 * `credit_note_lines`, `receipts` and `allocations` carry BEFORE UPDATE OR DELETE triggers
 * (migration 0012) that raise `billing_immutable`. Settlement state is NOT a column — it is
 * derived from allocations and credit notes (D1), which is exactly what lets those triggers
 * be total. The module's mutable columns, exhaustively: `receipt_tenders` lifecycle
 * (state/settled/reconciled/mismatch), `refund_vouchers` payment columns,
 * `cashier_sessions` lifecycle, `document_series.next_no`, `billing_config`, the
 * `daily_closes` claim row, and `idempotency_keys.state/response/completed_at` (the claim is
 * updated once with its result, and deleted when the work it guarded failed).
 *
 * FK group: `invoices`, `receipts` and `refund_vouchers` carry a REAL foreign key into
 * `patients` (owner ruling R5, 2026-08-19) — a money document must never be able to name a
 * patient id that never existed or was merged away, and that guarantee belongs in the
 * database rather than in every consuming call site. `encounter_id`, approval ids and service
 * ids stay plain text with no FK — the house precedent for cross-module references
 * (§4 module isolation; tariff_versions.approval_id carries the same note for the same
 * reason). Postgres refuses to TRUNCATE a table any FK still POINTS AT, whatever the row
 * counts and whatever the statement order (§3.12), so those three FKs put the whole billing
 * group into the patients truncate statement in test/helpers/db.ts — which is where its
 * fourteen names now live. Reads still go only through `modules/patients/index`, never
 * through the table.
 */

/**
 * The single audited config row (id = 'main'). Every threshold in this module is DATA the CA
 * revises against its statutory anchor, never a constant — C-2 cash law, the refund
 * bank-transfer floor, credit and outstanding caps, PSP fee basis points, recon tolerance,
 * document-series prefixes and the OPD fee branch (D-17). A missing row hard-fails every
 * billing write with `billing_not_configured`.
 */
export const billingConfig = pgTable("billing_config", {
  id: text("id").primaryKey(), // 'main'
  cashWarnPaise: bigint("cash_warn_paise", { mode: "number" }).notNull(),
  cashBlockPaise: bigint("cash_block_paise", { mode: "number" }).notNull(),
  panThresholdPaise: bigint("pan_threshold_paise", { mode: "number" }).notNull(),
  refundBankAbovePaise: bigint("refund_bank_above_paise", { mode: "number" }).notNull(),
  creditCapPaise: bigint("credit_cap_paise", { mode: "number" }).notNull(),
  outstandingCapPaise: bigint("outstanding_cap_paise", { mode: "number" }).notNull(),
  outstandingCapMode: text("outstanding_cap_mode").notNull().default("warn"), // 'off'|'warn'|'block'
  feeBps: jsonb("fee_bps").notNull(), // { upi: 0, card: 150 } — E-26 expected-net
  reconTolerancePaise: bigint("recon_tolerance_paise", { mode: "number" }).notNull(),
  seriesPrefixes: jsonb("series_prefixes").notNull(), // { invoice:"INV", receipt:"RCP", creditNote:"CN", voucher:"RFV" }
  chargeRules: jsonb("charge_rules").notNull(), // { opdConsult: { new: serviceId, renewal: serviceId } }
  degradedTender: boolean("degraded_tender").notNull().default(false), // E-24
  caSigned: boolean("ca_signed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * Per-fiscal-year document counters (D5). GST needs consecutive serials of at most 16 chars
 * that RESET each fiscal year, which a bigserial cannot do — so the counter is a row, moved
 * by a single-winner `UPDATE … RETURNING` (the OPD token precedent).
 */
export const documentSeries = pgTable(
  "document_series",
  {
    seriesKey: text("series_key").notNull(), // 'invoice'|'receipt'|'credit_note'|'voucher'
    fy: text("fy").notNull(), // '2026-27'
    nextNo: bigint("next_no", { mode: "number" }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.seriesKey, t.fy] })],
);

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  invoiceNo: text("invoice_no").notNull().unique(),
  patientId: text("patient_id").notNull().references(() => patients.id), // ruling R5
  encounterId: text("encounter_id"), // plain text — no FK into OPD (house precedent)
  tariffVersionId: text("tariff_version_id").notNull(), // the pin (§14.5)
  intendedPayer: text("intended_payer").notNull().default("self"),
  buyerGstin: text("buyer_gstin"),
  buyerLegalName: text("buyer_legal_name"), // ruling 4: the whole Phase-1 B2B provision
  grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
  discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
  taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
  cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(), // Σ line heads (§15) — never recomputed
  sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
  rawTotalPaise: bigint("raw_total_paise", { mode: "number" }).notNull(),
  roundingPaise: bigint("rounding_paise", { mode: "number" }).notNull(), // §170, owner ruling 2026-08-14
  netPayablePaise: bigint("net_payable_paise", { mode: "number" }).notNull(),
  creditExtended: boolean("credit_extended").notNull().default(false),
  creditReason: text("credit_reason"),
  creditApprovalId: text("credit_approval_id"),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  serviceDay: date("service_day", { mode: "string" }).notNull(), // IST day — day book / orphan grain
  // Arrival order for the dues worklist. ULID ids cannot carry it (§3.26) — the database does.
  seq: bigserial("seq", { mode: "number" }),
});

/** The engine's `PricedLine` persisted VERBATIM — head sums are read back, never re-derived. */
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id),
    lineNo: integer("line_no").notNull(),
    serviceId: text("service_id").notNull(),
    serviceName: text("service_name").notNull(),
    category: text("category").notNull(),
    qty: integer("qty").notNull(),
    unitPaise: bigint("unit_paise", { mode: "number" }).notNull(),
    grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
    regulatedClamp: jsonb("regulated_clamp"), // C-3 clamp record, when one applied
    candidates: jsonb("candidates").notNull(), // the D-8 contest record
    winner: jsonb("winner"),
    discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
    taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
    sacCode: text("sac_code").notNull(),
    rateBps: integer("rate_bps").notNull(),
    exempt: boolean("exempt").notNull(),
    exemptReason: text("exempt_reason"),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    netPaise: bigint("net_paise", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("invoice_lines_invoice_line_no").on(t.invoiceId, t.lineNo)],
);

/** The ONLY way an issued invoice's receivable shrinks (D4). Its own single rounding. */
export const creditNotes = pgTable("credit_notes", {
  id: text("id").primaryKey(),
  creditNoteNo: text("credit_note_no").notNull().unique(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  kind: text("kind").notNull(), // 'refund'|'clearance_discount'|'correction'
  discountCategory: text("discount_category"), // D-8 category — the clearance_discount lane only
  reason: text("reason").notNull(),
  approvalId: text("approval_id"),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
  discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
  taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
  cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
  sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
  roundingPaise: bigint("rounding_paise", { mode: "number" }).notNull(),
  netPaise: bigint("net_paise", { mode: "number" }).notNull(),
});

/** Cumulative pro-rated shares of a stored invoice line — derived, never re-priced (D4). */
export const creditNoteLines = pgTable("credit_note_lines", {
  id: text("id").primaryKey(),
  creditNoteId: text("credit_note_id").notNull().references(() => creditNotes.id),
  invoiceLineId: text("invoice_line_id").notNull().references(() => invoiceLines.id),
  qty: integer("qty").notNull(),
  grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
  discountPaise: bigint("discount_paise", { mode: "number" }).notNull(),
  taxableBasePaise: bigint("taxable_base_paise", { mode: "number" }).notNull(),
  cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
  sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
});

/** Money in. A bill payment and an advance are the SAME row — the difference is allocation. */
export const receipts = pgTable("receipts", {
  id: text("id").primaryKey(),
  receiptNo: text("receipt_no").notNull().unique(),
  patientId: text("patient_id").notNull().references(() => patients.id), // ruling R5
  cashierSessionId: text("cashier_session_id").notNull().references(() => cashierSessions.id),
  receivedBy: text("received_by").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  serviceDay: date("service_day", { mode: "string" }).notNull(), // IST day — C-2 episode grain
  totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
  panNumber: text("pan_number"), // C-2 §139A above the PAN threshold …
  form60: boolean("form60").notNull().default(false), // … or Form 60 in its place
  degraded: boolean("degraded").notNull().default(false), // E-24 stamp
  /**
   * PLAN 07b T5 — HOW MUCH OF THE SURPLUS WAS HANDED BACK AS CHANGE.
   *
   * `issueInvoice` has always computed the surplus (`unallocatedPaise`) and the counter has always
   * shown it — under a label reading "Change due / banked as advance". TWO OUTCOMES, ONE RECORD:
   * the cashier picked, and the ledger wrote the same row either way — an unallocated receipt
   * balance, which IS a patient advance. Nothing recorded cash handed back, so when the cashier
   * handed it over the advance was fictional: the patient's balance was overstated by exactly that
   * amount AND the drawer was short by it at close, with no row to explain the variance.
   *
   * This column is the cashier's DECLARATION, and `expectedCash` now subtracts it. What remains
   * unallocated after it is a real advance the patient can spend later.
   */
  changeGivenPaise: bigint("change_given_paise", { mode: "number" }).notNull().default(0),
  note: text("note"),
  seq: bigserial("seq", { mode: "number" }),
});

/** E-25 lifecycle: captured → reconciled | mismatched. `expected_net_paise` is stamped at CAPTURE. */
export const receiptTenders = pgTable("receipt_tenders", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull().references(() => receipts.id),
  mode: text("mode").notNull(), // 'cash'|'upi'|'card'
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  refText: text("ref_text"),
  state: text("state").notNull().default("captured"),
  expectedNetPaise: bigint("expected_net_paise", { mode: "number" }),
  settledPaise: bigint("settled_paise", { mode: "number" }),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  mismatchNote: text("mismatch_note"),
});

/** Append-only receipt → invoice. Effective allocation = Σ apply − Σ reverse (D1). */
export const allocations = pgTable("allocations", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull().references(() => receipts.id),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  kind: text("kind").notNull(), // 'apply'|'reverse'
  reversalOfId: text("reversal_of_id"), // plain text self-reference; nothing is ever updated
  reason: text("reason"),
  actorId: text("actor_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  seq: bigserial("seq", { mode: "number" }),
});

/** Approval-gated always (spec §7). The four legacy refund guards ride `guard_flags` (D6). */
export const refundVouchers = pgTable("refund_vouchers", {
  id: text("id").primaryKey(),
  voucherNo: text("voucher_no").notNull().unique(),
  patientId: text("patient_id").notNull().references(() => patients.id), // ruling R5
  kind: text("kind").notNull(), // 'invoice_refund'|'advance_refund'
  creditNoteId: text("credit_note_id"),
  invoiceId: text("invoice_id"),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  method: text("method").notNull(), // 'cash'|'bank_transfer'
  payeeName: text("payee_name"), // refund-to-payer identity, mandatory at PAY time
  payeeIdType: text("payee_id_type"),
  payeeIdRef: text("payee_id_ref"),
  reasonClass: text("reason_class").notNull(), // guard 4: 'mistake'|'genuine'
  reason: text("reason").notNull(),
  guardFlags: jsonb("guard_flags").notNull(), // guards 2+3: terminal_encounter / delivered_line
  approvalId: text("approval_id").notNull(),
  status: text("status").notNull().default("issued"), // 'issued'|'paid'
  requestedBy: text("requested_by").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  paidBy: text("paid_by"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  cashierSessionId: text("cashier_session_id"), // set when a cash voucher is paid from a drawer
});

export const cashierSessions = pgTable(
  "cashier_sessions",
  {
    id: text("id").primaryKey(),
    cashierUserId: text("cashier_user_id").notNull(),
    status: text("status").notNull().default("open"), // 'open'|'closing'|'closed'
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openingFloatPaise: bigint("opening_float_paise", { mode: "number" }).notNull(),
    denominations: jsonb("denominations"), // { "50000": 3, … } paise-denomination → count
    countedCashPaise: bigint("counted_cash_paise", { mode: "number" }),
    expectedCashPaise: bigint("expected_cash_paise", { mode: "number" }),
    variancePaise: bigint("variance_paise", { mode: "number" }),
    varianceApprovalId: text("variance_approval_id"),
    closeNote: text("close_note"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // One LIVE session per cashier — the arbiter behind `session_already_open`, at the
    // database layer (the tariff_versions_activated_effective_ux precedent). A closed
    // session frees the cashier; the predicate is live, not decorative.
    uniqueIndex("cashier_sessions_live_ux").on(t.cashierUserId).where(sql`${t.status} in ('open', 'closing')`),
  ],
);

/** `entered-in-error` marks against immutable documents — the only "void" this module has. */
export const enteredInErrorMarks = pgTable(
  "entered_in_error_marks",
  {
    id: text("id").primaryKey(),
    docType: text("doc_type").notNull(), // 'invoice'|'receipt'|'credit_note'
    docId: text("doc_id").notNull(),
    reason: text("reason").notNull(),
    markedBy: text("marked_by").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("entered_in_error_marks_doc_ux").on(t.docType, t.docId)],
);

/** E-26: one uploaded PSP statement. No PSP API this plan — statement upload only. */
export const reconBatches = pgTable("recon_batches", {
  id: text("id").primaryKey(),
  uploadedBy: text("uploaded_by").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(), // 'upi'|'card'
  rowsTotal: integer("rows_total").notNull(),
  rowsMatched: integer("rows_matched").notNull(),
  rowsMismatched: integer("rows_mismatched").notNull(),
  rowsUnmatched: integer("rows_unmatched").notNull(), // reported, never guessed
});

/** The daily-close claim row: `ON CONFLICT DO NOTHING` makes a second run a no-op (D9). */
export const dailyCloses = pgTable("daily_closes", {
  day: date("day", { mode: "string" }).primaryKey(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  totals: jsonb("totals").notNull(),
});

/**
 * THE IDEMPOTENCY CLAIM — one row per (actor, route, client key).
 *
 * A double-clicked, reloaded, retried or duplicated write must not create a SECOND money
 * document. `SubmitButton` (apps/web) closes the double click inside one tab; it cannot close a
 * page reload, a second tab, or a request the network duplicates after the client gave up
 * waiting. Only the server can, and only by remembering what it already did.
 *
 * THE CLAIM IS TAKEN BEFORE THE WORK, NOT AFTER. `INSERT … ON CONFLICT DO NOTHING` is the
 * arbiter (the `daily_closes` precedent, D9): the request that inserts owns the work, and a
 * concurrent duplicate loses the insert and never reaches the write path at all. Recording the
 * key AFTER the work would be too late — both requests would already have issued a document.
 *
 * `response` is written when the work succeeds, so a replay returns the ORIGINAL result rather
 * than a refusal: a cashier who reloads mid-payment must see the receipt she already took, not
 * an error. `request_hash` is what makes that safe — the same key against a DIFFERENT body is a
 * client bug and is refused, never silently answered with the old document.
 *
 * This table is deliberately NOT in the immutability trigger set: the claim is updated once with
 * its response, and deleted if the work failed so a corrected retry may reuse the key.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    route: text("route").notNull(), // 'POST /billing/receipts' — the scope the key is unique within
    key: text("key").notNull(), // the client's `Idempotency-Key` header, verbatim
    requestHash: text("request_hash").notNull(), // sha256 of the canonical body
    state: text("state").notNull().default("in_progress"), // 'in_progress' | 'done'
    response: jsonb("response"), // the original result, served verbatim on replay
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("idempotency_keys_actor_route_key_ux").on(t.actorId, t.route, t.key)],
);
