import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  allocations, creditNotes, enteredInErrorMarks, invoiceLines, invoices, receipts, receiptTenders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { getApproval } from "../../kernel/approvals/worklist";
import { getEncounter } from "../opd";
import { assertPaise, loadPricingContext, percentAmount, priceInvoiceLines } from "../tariff";
import { assertCashAccepted } from "./cash-law";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { nextDocNo } from "./series";
import { requireOpenSession } from "./sessions";
import { settlementState } from "./settlement";
import { istDay } from "./time";
import { totalInvoice } from "./totals";
import {
  advanceReceived, cashThresholdBlocked, cashThresholdWarned, invoiceCreditExtended, invoiceIssued,
  paymentReceived, receiptRecorded,
} from "./events";
import type { CashLawVerdict, CashThresholdDetail, TenderInput, TenderMode } from "./cash-law";
import type { BillingConfig, FeeBps } from "./config";
import type { Settlement } from "./settlement";
import type { InvoiceTotals } from "./totals";
import type { InvoiceLineInput, PricedLine } from "../tariff";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D2 — `issueInvoice`, the module's core transaction, plus the invoice-side settlement
 * readers and the invoice read surface.
 *
 * PLAN DEVIATION, DISCLOSED (T5 report): the plan's Files list put `outstandingOf` and
 * `invoiceSettlement` in `settlement.ts`, but `settlement.ts` is one of the five files
 * `billing-purity.test.ts` (T2, and outside this task's Files list) sweeps for `from "../../kernel`
 * and `await ` — a SQL reader cannot live there without either breaking that shipped test or
 * silently relaxing it. The pure state function stays where T2 put it; the readers that feed it
 * live here, beside the writer whose rows they read. Reported as a plan defect rather than
 * resolved by editing a file this task does not own.
 */

/** The permission the credit lane needs (owner ruling 2). T11's manifest declares it. */
export const CREDIT_EXTEND_PERMISSION = "billing.credit.extend";

/** The two approval types this transaction checks on execute, and the subjects they bind to. */
export const CREDIT_APPROVAL_TYPE = "billing_credit_extension";
export const CREDIT_APPROVAL_SUBJECT = "billing_credit";
export const DISCOUNT_APPROVAL_TYPE = "billing_discount";
export const DISCOUNT_APPROVAL_SUBJECT = "billing_discount";

/**
 * A discount approval is filed BEFORE the invoice exists, so it cannot name the invoice id. It
 * binds to the client-supplied draft id plus the line it pays for — the pair the counter screen
 * already holds while the bill is being built.
 */
export function discountSubjectId(draftId: string, lineId: string): string {
  return `${draftId}:${lineId}`;
}

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;

export type IssueInvoiceInput = {
  draftId: string; // client-supplied; the subject id every pre-invoice approval binds to
  patientId: string;
  encounterId?: string;
  buyerGstin?: string; // ruling 4 — the whole Phase-1 B2B provision
  buyerLegalName?: string;
  lines: InvoiceLineInput[];
  tags?: string[]; // request-level pricing eligibility tags
  receipt?: { tenders: TenderInput[]; panNumber?: string; form60?: boolean; note?: string };
  credit?: { reason: string; approvalId?: string };
  discountApprovals?: Record<string, string>; // lineId -> approvalId, for `requiresApproval` winners
};

export type IssueInvoiceResult = {
  invoiceId: string;
  invoiceNo: string;
  totals: InvoiceTotals;
  receiptId: string | null;
  receiptNo: string | null;
  allocatedPaise: number;
  unallocatedPaise: number; // the change-due / banked-advance lane (D2 step 5) — never an error
  creditExtended: boolean;
  settlement: Settlement;
  warnings: string[];
};

export type PreviewInvoiceInput = { encounterId?: string; lines: InvoiceLineInput[]; tags?: string[] };
export type PricedDraft = {
  tariffVersionId: string;
  intendedPayer: string;
  lines: PricedLine[];
  totals: InvoiceTotals;
};

// ---------------------------------------------------------------------------------------------
// Settlement readers (D1). Settlement is DERIVED — no status column exists on `invoices`, which
// is what keeps the immutability triggers total.
// ---------------------------------------------------------------------------------------------

/**
 * Which of these documents carry an `entered-in-error` mark. Read as a set rather than as a
 * correlated NOT EXISTS: drizzle renders a column interpolated into a `sql` SELECT FIELD without
 * its table qualifier, so a correlated subquery written that way silently compares the wrong two
 * columns and returns zero — measured, not assumed. Every aggregate below therefore reads ONE
 * table at a time, where the unqualified name is unambiguous.
 */
async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

/** Effective allocation against one invoice: Sigma apply - Sigma reverse. Append-only (D1). */
async function allocatedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(eq(allocations.invoiceId, invoiceId));
  return Number(rows[0]!.total); // sum() over bigint arrives as numeric text
}

/** Sigma non-EIE credit-note nets against one invoice (D1). Nothing credits until T7 ships. */
async function creditedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({ id: creditNotes.id, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoiceId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "credit_note", rows.map((r) => r.id));
  let total = 0;
  for (const row of rows) {
    if (!dead.has(row.id)) total += row.netPaise;
  }
  return total;
}

/** The invoice's derived settlement — `settlementState` fed from the ledger (D1). */
export async function invoiceSettlement(exec: Db | Tx, invoiceId: string): Promise<Settlement> {
  const rows = await exec
    .select({ netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  const creditedPaise = await creditedPaiseOf(exec, invoiceId);
  const allocatedPaise = await allocatedPaiseOf(exec, invoiceId);
  return settlementState(row.netPayablePaise, creditedPaise, allocatedPaise);
}

/** The invoice's outstanding paise, floored at zero (D1). */
export async function outstandingOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const settlement = await invoiceSettlement(exec, invoiceId);
  return settlement.outstandingPaise;
}

/**
 * The patient's total receivable across every non-EIE invoice — the number the per-patient
 * outstanding cap (owner ruling 2) is compared against. Each invoice's own outstanding is floored
 * at zero first, so one over-collected bill can never mask another bill's dues.
 */
export async function patientOutstandingPaise(exec: Db | Tx, patientId: string): Promise<number> {
  const rows = await exec
    .select({ id: invoices.id, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.patientId, patientId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "invoice", rows.map((r) => r.id));
  let total = 0;
  for (const row of rows) {
    if (dead.has(row.id)) continue;
    const creditedPaise = await creditedPaiseOf(exec, row.id);
    const allocatedPaise = await allocatedPaiseOf(exec, row.id);
    total += settlementState(row.netPayablePaise, creditedPaise, allocatedPaise).outstandingPaise;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function getInvoice(
  exec: Db | Tx,
  invoiceId: string,
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const rows = await exec.select().from(invoices).where(eq(invoices.id, invoiceId));
  const invoice = rows[0];
  if (!invoice) return null;
  const lines = await exec
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNo));
  return { invoice, lines };
}

/** Arrival order is `seq`, never the id — ULIDs are not insertion-ordered (§3.26). */
export async function listInvoices(
  exec: Db | Tx,
  filters: { patientId?: string; encounterId?: string } = {},
): Promise<InvoiceRow[]> {
  const conditions = [];
  if (filters.patientId !== undefined) conditions.push(eq(invoices.patientId, filters.patientId));
  if (filters.encounterId !== undefined) conditions.push(eq(invoices.encounterId, filters.encounterId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return exec.select().from(invoices).where(where).orderBy(asc(invoices.seq));
}

// ---------------------------------------------------------------------------------------------
// D2 step 1 — everything before the transaction: resolve, load, belt, price. PURE after the load.
// ---------------------------------------------------------------------------------------------

async function resolveIntendedPayer(db: Db, encounterId: string | undefined): Promise<string> {
  if (encounterId === undefined) return "self";
  // Cross-module read through the OPD module's index, never its tables (spec §4).
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new BillingError("unknown_encounter", `unknown encounter ${encounterId}`);
  return encounter.intendedPayer;
}

/**
 * M3 at OUR boundary. The tariff stress test warned that `priceInvoiceLines` is reachable by a
 * non-controller caller with unparsed money, and this plan is exactly that caller: every
 * externally supplied amount is integer-checked HERE, before the engine ever runs, so a
 * fractional discount ask is refused as `invalid_paise` rather than pricing something first and
 * failing somewhere deeper.
 */
function assertBoundaryPaise(draft: { lines: InvoiceLineInput[]; receipt?: { tenders: TenderInput[] } }): void {
  for (const line of draft.lines) {
    const manual = line.manualDiscount;
    if (manual !== undefined && manual !== null) {
      assertPaise(manual.value, `line ${line.lineId} manual discount value`);
    }
  }
  for (const tender of draft.receipt?.tenders ?? []) {
    assertPaise(tender.amountPaise, `${tender.mode} tender amount`);
  }
}

async function priceDraft(
  db: Db,
  draft: { encounterId?: string; lines: InvoiceLineInput[]; tags?: string[]; receipt?: { tenders: TenderInput[] } },
  now: Date,
): Promise<PricedDraft> {
  const intendedPayer = await resolveIntendedPayer(db, draft.encounterId);
  // `loadPricingContext` takes Db, NOT Tx (§14.5) and runs OUTSIDE any transaction; the engine
  // itself is pure and synchronous, so pricing holds no connection and no lock.
  const ctx = await loadPricingContext(db, { at: now, tags: draft.tags ?? [] });
  assertBoundaryPaise(draft);
  const lines = priceInvoiceLines(ctx, draft.lines);
  return { tariffVersionId: ctx.tariff.versionId, intendedPayer, lines, totals: totalInvoice(lines) };
}

/**
 * The fee-quote core (D8): prices a draft exactly as `issueInvoice` would and persists NOTHING.
 * T10's `feeQuote` composes this with the charge-rule branch.
 */
export async function previewInvoice(db: Db, input: PreviewInvoiceInput, now: Date = new Date()): Promise<PricedDraft> {
  return priceDraft(db, input, now);
}

// ---------------------------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------------------------

/**
 * E-26's `expectedNetPaise`, stamped HERE — at CAPTURE, never at reconciliation (self-review 12).
 * Stamping it when the statement arrives would let a later fee-config revision rewrite what
 * "expected" meant for money the hospital already took; T9 compares the settled amount against
 * this stored number. Cash settles at face value and carries no expectation.
 */
export function tenderExpectedNetPaise(mode: TenderMode, amountPaise: number, feeBps: FeeBps): number | null {
  if (mode === "cash") return null;
  return amountPaise - percentAmount(amountPaise, feeBps[mode]);
}

/**
 * One receipt with its tenders (D1: money in; an advance and a bill payment are the same row).
 * Exported because T6's `recordReceipt` writes the identical rows and cannot edit this file.
 */
export async function insertReceiptWithTenders(
  tx: Tx,
  actor: Actor,
  cfg: BillingConfig,
  input: {
    patientId: string; cashierSessionId: string; tenders: TenderInput[];
    panNumber?: string; form60?: boolean; note?: string; at: Date;
  },
): Promise<{ receiptId: string; receiptNo: string; totalPaise: number }> {
  let totalPaise = 0;
  for (const tender of input.tenders) {
    if (tender.mode !== "cash" && (tender.refText ?? "").trim() === "") {
      throw new BillingError("tender_ref_required", `a ${tender.mode} tender needs a settlement reference`);
    }
    totalPaise += tender.amountPaise;
  }

  const receiptId = newId();
  const receiptNo = await nextDocNo(tx, cfg, "receipt", input.at);
  await tx.insert(receipts).values({
    id: receiptId,
    receiptNo,
    patientId: input.patientId,
    cashierSessionId: input.cashierSessionId,
    receivedBy: actor.id,
    receivedAt: input.at,
    serviceDay: istDay(input.at), // the C-2 episode grain
    totalPaise,
    panNumber: input.panNumber ?? null,
    form60: input.form60 ?? false,
    degraded: cfg.degradedTender, // E-24 stamp
    note: input.note ?? null,
  });
  for (const tender of input.tenders) {
    await tx.insert(receiptTenders).values({
      id: newId(),
      receiptId,
      mode: tender.mode,
      amountPaise: tender.amountPaise,
      refText: tender.refText ?? null,
      state: "captured", // E-25 lifecycle start
      expectedNetPaise: tenderExpectedNetPaise(tender.mode, tender.amountPaise, cfg.feeBps),
    });
  }
  return { receiptId, receiptNo, totalPaise };
}

// ---------------------------------------------------------------------------------------------
// Approvals — check-on-execute BY DESIGN (Global Constraint 1, roadmap trap 1). Plan 08.5 puts
// the dispatcher on a clock; this section still verifies against the approvals row at execution
// time, never via an event consumer — the loop existing does not change it.
// ---------------------------------------------------------------------------------------------

async function assertGrantedApproval(
  db: Db,
  approvalId: string,
  expected: { typeKey: string; subjectType: string; subjectId: string; patientId: string; amountPaise?: number },
): Promise<void> {
  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === expected.typeKey &&
    approval.subjectType === expected.subjectType &&
    approval.subjectId === expected.subjectId &&
    approval.patientId === expected.patientId &&
    (expected.amountPaise === undefined || approval.amountPaise === expected.amountPaise);
  if (!bound) {
    throw new BillingError(
      "approval_subject_mismatch",
      `approval ${approvalId} does not bind to this ${expected.typeKey} request`,
      { expected, got: { typeKey: approval.typeKey, subjectType: approval.subjectType, subjectId: approval.subjectId, patientId: approval.patientId, amountPaise: approval.amountPaise } },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// D2 — the one transaction
// ---------------------------------------------------------------------------------------------

/**
 * D2, frozen order: load and price OUTSIDE (above), then ONE transaction that allocates the
 * document number, verifies the discount approvals, settles the credit question, persists the
 * invoice and its lines VERBATIM from the engine's `PricedLine[]`, records the receipt with its
 * tenders under the C-2 cash law, allocates against the invoice, and appends the events.
 *
 * The credit decision is evaluated BEFORE the insert because `credit_extended`, `credit_reason`
 * and `credit_approval_id` are columns on the invoice row and the row is immutable the moment it
 * lands (migration 0012's triggers): there is no later UPDATE in which to record them.
 *
 * NO INVOICE-ROW LOCK IS TAKEN HERE, deliberately. This function only INSERTS fresh rows, so it
 * has nothing to serialize against. The `SELECT id FROM invoices ... FOR UPDATE` belongs to the
 * ALLOCATION writers (T6), where concurrent allocations against one existing invoice must not
 * overpay it. Adding a lock here would serialize unrelated issues for no invariant.
 *
 * `hasPermission` and `getApproval` are kernel readers that take `Db`, so both run on the OUTER
 * handle from inside this transaction. Both read already-committed governance rows that nothing
 * in this transaction can change, and neither writes.
 */
export async function issueInvoice(
  db: Db,
  actor: Actor,
  input: IssueInvoiceInput,
  now: Date = new Date(),
): Promise<IssueInvoiceResult> {
  const cfg = await loadBillingConfig(db);
  const draft = await priceDraft(db, input, now);
  const { totals } = draft;

  // Pure arithmetic over what the caller handed in and what the engine returned.
  let receiptTotalPaise = 0;
  for (const tender of input.receipt?.tenders ?? []) receiptTotalPaise += tender.amountPaise;
  const allocatedPaise = Math.min(receiptTotalPaise, totals.netPayablePaise);
  const remainderPaise = totals.netPayablePaise - allocatedPaise;
  // D2 step 5: overpayment is NOT an error. The surplus stays unallocated on the receipt — it IS
  // the change-due / banked-advance lane, and refusing it would refuse ordinary cash transactions.
  const unallocatedPaise = receiptTotalPaise - allocatedPaise;

  try {
    return await withTx(db, async (tx) => {
      const invoiceId = newId();
      const invoiceNo = await nextDocNo(tx, cfg, "invoice", now);

      // Every `requiresApproval` winner the engine produced must be covered by a GRANTED approval
      // bound to this draft, this line, this patient and this exact benefit (D2 step 2).
      for (const line of draft.lines) {
        const winner = line.winner;
        if (winner === null || !winner.requiresApproval) continue;
        const approvalId = input.discountApprovals?.[line.lineId];
        if (approvalId === undefined) {
          throw new BillingError(
            "discount_approval_missing",
            `line ${line.lineId} carries a discount that needs approval and none was supplied`,
            { lineId: line.lineId, amountPaise: winner.amountPaise },
          );
        }
        await assertGrantedApproval(db, approvalId, {
          typeKey: DISCOUNT_APPROVAL_TYPE,
          subjectType: DISCOUNT_APPROVAL_SUBJECT,
          subjectId: discountSubjectId(input.draftId, line.lineId),
          patientId: input.patientId,
          amountPaise: winner.amountPaise,
        });
      }

      // D2 step 3 — remainder > 0 is the credit lane or a refusal. Nothing else may persist an
      // unsettled invoice: that is the invariant that stops a counter minting dues silently.
      const warnings: string[] = [];
      let creditBlock: { reason: string; approvalId?: string } | null = null;
      if (remainderPaise > 0) {
        const credit = input.credit;
        // A credit block without a reason is not a credit block (the reason is mandatory, owner
        // ruling 2) — so it lands on the same refusal as no credit block at all.
        if (credit === undefined || credit.reason.trim() === "") {
          throw new BillingError(
            "unsettled_issue_refused",
            `${String(remainderPaise)}p would be left unsettled and no credit extension was requested`,
            { remainderPaise },
          );
        }
        if (!(await hasPermission(db, actor.id, CREDIT_EXTEND_PERMISSION, "hospital"))) {
          throw new BillingError("credit_permission_required", `extending credit needs ${CREDIT_EXTEND_PERMISSION}`);
        }
        if (remainderPaise > cfg.creditCapPaise) {
          if (credit.approvalId === undefined) {
            throw new BillingError(
              "credit_approval_required",
              `${String(remainderPaise)}p exceeds the per-invoice credit cap ${String(cfg.creditCapPaise)}p`,
              { remainderPaise, creditCapPaise: cfg.creditCapPaise },
            );
          }
          await assertGrantedApproval(db, credit.approvalId, {
            typeKey: CREDIT_APPROVAL_TYPE,
            subjectType: CREDIT_APPROVAL_SUBJECT,
            subjectId: input.draftId,
            patientId: input.patientId,
          });
        }
        if (cfg.outstandingCapMode !== "off") {
          const prospectivePaise = (await patientOutstandingPaise(tx, input.patientId)) + remainderPaise;
          if (prospectivePaise > cfg.outstandingCapPaise) {
            if (cfg.outstandingCapMode === "block") {
              throw new BillingError(
                "outstanding_cap_exceeded",
                `patient dues would reach ${String(prospectivePaise)}p against a cap of ${String(cfg.outstandingCapPaise)}p`,
                { prospectivePaise, outstandingCapPaise: cfg.outstandingCapPaise },
              );
            }
            warnings.push("outstanding_cap");
          }
        }
        creditBlock = { reason: credit.reason, approvalId: credit.approvalId };
      }

      // The two §15 numbers are persisted EXACTLY as `totalInvoice` returned them — sums of the
      // LINE heads. No code path here applies a tax head to an invoice-level base (K18/M-I2).
      await tx.insert(invoices).values({
        id: invoiceId,
        invoiceNo,
        patientId: input.patientId,
        encounterId: input.encounterId ?? null,
        tariffVersionId: draft.tariffVersionId, // the pin (§14.5)
        intendedPayer: draft.intendedPayer,
        buyerGstin: input.buyerGstin ?? null,
        buyerLegalName: input.buyerLegalName ?? null,
        grossPaise: totals.grossPaise,
        discountPaise: totals.discountPaise,
        taxableBasePaise: totals.taxableBasePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        rawTotalPaise: totals.rawTotalPaise,
        roundingPaise: totals.roundingPaise,
        netPayablePaise: totals.netPayablePaise,
        creditExtended: creditBlock !== null,
        creditReason: creditBlock?.reason ?? null,
        creditApprovalId: creditBlock?.approvalId ?? null,
        issuedBy: actor.id,
        issuedAt: now,
        serviceDay: istDay(now),
      });

      // `PricedLine` persisted verbatim, `candidates` jsonb = the D-8 contest record.
      await tx.insert(invoiceLines).values(
        draft.lines.map((line, index) => ({
          id: newId(),
          invoiceId,
          lineNo: index + 1,
          serviceId: line.serviceId,
          serviceName: line.serviceName,
          category: line.category,
          qty: line.qty,
          unitPaise: line.unitPaise,
          grossPaise: line.grossPaise,
          regulatedClamp: line.regulatedClamp,
          candidates: line.candidates,
          winner: line.winner,
          discountPaise: line.discountPaise,
          taxableBasePaise: line.taxableBasePaise,
          sacCode: line.gst.sacCode,
          rateBps: line.gst.rateBps,
          exempt: line.gst.exempt,
          exemptReason: line.gst.exemptReason,
          cgstPaise: line.gst.cgstPaise,
          sgstPaise: line.gst.sgstPaise,
          netPaise: line.netPaise,
        })),
      );

      let receiptId: string | null = null;
      let receiptNo: string | null = null;
      let cashVerdict: CashLawVerdict | null = null;
      const receipt = input.receipt;
      if (receipt !== undefined) {
        const session = await requireOpenSession(tx, actor); // D9 — the ACTING cashier's drawer
        cashVerdict = await assertCashAccepted(tx, cfg, {
          patientId: input.patientId,
          tenders: receipt.tenders,
          panNumber: receipt.panNumber,
          form60: receipt.form60,
          at: now,
        });
        const written = await insertReceiptWithTenders(tx, actor, cfg, {
          patientId: input.patientId,
          cashierSessionId: session.id,
          tenders: receipt.tenders,
          panNumber: receipt.panNumber,
          form60: receipt.form60,
          note: receipt.note,
          at: now,
        });
        receiptId = written.receiptId;
        receiptNo = written.receiptNo;
        if (allocatedPaise > 0) {
          await tx.insert(allocations).values({
            id: newId(),
            receiptId,
            invoiceId,
            amountPaise: allocatedPaise,
            kind: "apply",
            reversalOfId: null,
            reason: null,
            actorId: actor.id,
            at: now,
          });
        }
      }

      // D2 step 4. correlationId is the invoice id on every invoice-scoped emission.
      const scope = { patientId: input.patientId, encounterId: input.encounterId, correlationId: invoiceId };
      await appendEvent(
        tx,
        invoiceIssued.make({
          actor,
          payload: { invoiceId, invoiceNo, patientId: input.patientId, netPayablePaise: totals.netPayablePaise },
          ...scope,
        }),
      );
      if (creditBlock !== null) {
        await appendEvent(
          tx,
          invoiceCreditExtended.make({
            actor,
            payload: { invoiceId, invoiceNo, patientId: input.patientId, remainderPaise, reason: creditBlock.reason },
            ...scope,
          }),
        );
      }
      if (receiptId !== null && receiptNo !== null) {
        await appendEvent(
          tx,
          receiptRecorded.make({
            actor,
            payload: { receiptId, receiptNo, patientId: input.patientId, totalPaise: receiptTotalPaise },
            ...scope,
          }),
        );
        if (allocatedPaise > 0) {
          await appendEvent(
            tx,
            paymentReceived.make({
              actor,
              payload: { receiptId, invoiceId, patientId: input.patientId, amountPaise: allocatedPaise },
              ...scope,
            }),
          );
        }
        if (unallocatedPaise > 0) {
          await appendEvent(
            tx,
            advanceReceived.make({
              actor,
              payload: { receiptId, patientId: input.patientId, amountPaise: unallocatedPaise },
              ...scope,
            }),
          );
        }
        if (cashVerdict !== null && cashVerdict.warned) {
          await appendEvent(
            tx,
            cashThresholdWarned.make({
              actor,
              payload: {
                patientId: input.patientId,
                episodeCashPaise: cashVerdict.episodeCashPaise,
                thresholdPaise: cfg.cashWarnPaise,
              },
              ...scope,
            }),
          );
        }
      }

      return {
        invoiceId,
        invoiceNo,
        totals,
        receiptId,
        receiptNo,
        allocatedPaise,
        unallocatedPaise,
        creditExtended: creditBlock !== null,
        settlement: settlementState(totals.netPayablePaise, 0, allocatedPaise),
        warnings,
      };
    });
  } catch (e) {
    if (e instanceof BillingError && e.code === "cash_threshold_blocked") {
      // The refusal rolls its own transaction back by construction, so the C-2 audit event is
      // appended in a transaction of its own AFTER it. An event that only survives when the money
      // was accepted would be the opposite of an audit trail.
      const detail = e.detail as CashThresholdDetail;
      await withTx(db, (tx) =>
        appendEvent(
          tx,
          cashThresholdBlocked.make({
            actor,
            payload: {
              patientId: input.patientId,
              episodeCashPaise: detail.episodeCashPaise,
              thresholdPaise: detail.thresholdPaise,
            },
            patientId: input.patientId,
            encounterId: input.encounterId,
          }),
        ),
      );
    }
    throw e;
  }
}
