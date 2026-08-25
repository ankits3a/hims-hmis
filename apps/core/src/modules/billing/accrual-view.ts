import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  allocations, creditNoteLines, creditNotes, enteredInErrorMarks, invoiceLines, invoices,
  refundVouchers,
} from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 09 DD19 / sweep S15 — THE ONE NEW BILLING EXPORT, and the only way the accrual consumer
 * will ever read billing money.
 *
 * ═══ WHY IT EXISTS AT ALL ═══
 *
 * DD12's rewritten accrual base needs an invoice's LIVE money and its PER-LINE credited base:
 *
 *     liveBase(L)  = L.taxableBasePaise − creditedBasePaise(L)     per line, floored at 0
 *     settleable   = netPayablePaise − creditedPaise               floored at 0
 *     collected    = allocatedPaise − refundedPaise                floored at 0
 *
 * Billing keeps `creditedPaiseOf`, `allocatedPaiseOf` and `enteredInErrorDocIds` PRIVATE, and
 * `invoiceSettlement` returns only `{state, outstandingPaise}` — from which `credited` and
 * `allocated` cannot be separated again. The module-isolation lint means `partners` may read this
 * module's `index` and nothing deeper, so there were exactly two options: break the isolation
 * rule, or add a reader. This is the reader. It lives in billing because that is where the tables
 * are, and it is the only new cross-module surface this phase opens.
 *
 * ═══ IT REPORTS, IT DOES NOT DECIDE (the §2.49 discipline this seam is under) ═══
 *
 * Every number below is a SUM OF ROWS, and not one of them is combined with another here. The
 * subtraction, the flooring and the ratio are DD12's, and DD12 belongs to the accrual consumer
 * (T6). A view that pre-computed `settleable` would put half of the accrual base in a module that
 * cannot be tested against a partner agreement, and the spike already measured what happens when
 * the base is defined in the wrong place: 63 543 where 45 000 was correct.
 *
 * ═══ WHY THE SPIKE'S COUNTER-EXAMPLE IS THE FIXTURE SHAPE ═══
 *
 * `invoices` and `invoice_lines` are IMMUTABLE under migration 0012's triggers, so a credit note
 * moves neither: on a settled invoice carrying one, the measured run found all three line rows
 * BYTE-IDENTICAL after the credit note while the money had moved. An implementation of this view
 * that returned the stored line's `taxable_base_paise` and called it live would therefore look
 * perfectly correct and be wrong by the whole value of the credit note. `accrual-view.test.ts`
 * runs against invoices carrying a credit note ON AN ELIGIBLE LINE, an allocation reversal and an
 * entered-in-error mark, with numbers that differ from one another, so that implementation fails.
 *
 * ═══ S12 ═══
 *
 * `billing-purity.test.ts` greps every file under `modules/billing` — this one included — for the
 * five float tokens, which it assembles from fragments so that the sweep covers its own file too;
 * naming them literally here would make this file the violation. Nothing here divides at all: the
 * only arithmetic is integer addition over paise, and the one division DD12 needs is the tariff
 * engine's `divHalfUp`, in T6.
 */

/** One invoice line as the accrual base reads it. `creditedBasePaise` is the part already credited. */
export type InvoiceAccrualLine = {
  lineId: string;
  category: string;
  taxableBasePaise: number;
  creditedBasePaise: number;
};

export type InvoiceAccrualView = {
  invoiceId: string;
  issuedAt: Date;
  /** DD12: an invoice marked entered-in-error has `target = 0`, so everything reverses. */
  enteredInError: boolean;
  netPayablePaise: number;
  /** Σ non-EIE credit-note nets — the amount by which the receivable has shrunk (D4). */
  creditedPaise: number;
  /** Σ apply − Σ reverse. An `allocation.reversed` carries collected money back off the invoice. */
  allocatedPaise: number;
  /** Σ PAID refund vouchers drawn against this invoice. An issued-but-unpaid voucher is not money
   *  that has left, so it is not subtracted from what was collected. */
  refundedPaise: number;
  lines: InvoiceAccrualLine[];
};

/**
 * Which of these documents carry an `entered-in-error` mark. Read as a SET rather than as a
 * correlated NOT EXISTS: drizzle renders a column interpolated into a `sql` SELECT FIELD without
 * its table qualifier, so a correlated subquery written that way silently compares the wrong two
 * columns and returns zero — measured by Plan 08, not assumed here. Every aggregate below
 * therefore reads ONE table at a time, where the unqualified name is unambiguous.
 */
async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

/**
 * DD19's reader. `null` for an invoice this database does not hold — the accrual consumer replays
 * from an event cursor that can outlive the rows it names, and a null is a fact it can skip rather
 * than an exception it must catch on every cycle.
 *
 * A `clearance_discount` note carries NO lines, so its net shrinks `creditedPaise` and no line's
 * `creditedBasePaise`. That asymmetry is correct and is DD12's: the receivable moved, the eligible
 * SERVICE base did not, and the ratio between them is exactly what the accrual base is measuring.
 */
export async function invoiceAccrualView(exec: Db | Tx, invoiceId: string): Promise<InvoiceAccrualView | null> {
  const invoiceRows = await exec
    .select({
      id: invoices.id,
      issuedAt: invoices.issuedAt,
      netPayablePaise: invoices.netPayablePaise,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const invoice = invoiceRows[0];
  if (!invoice) return null;

  const invoiceMarked = await enteredInErrorDocIds(exec, "invoice", [invoice.id]);

  const noteRows = await exec
    .select({ id: creditNotes.id, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoice.id));
  const deadNotes = await enteredInErrorDocIds(exec, "credit_note", noteRows.map((n) => n.id));
  const liveNoteIds = noteRows.filter((n) => !deadNotes.has(n.id)).map((n) => n.id);
  let creditedPaise = 0;
  for (const note of noteRows) {
    if (!deadNotes.has(note.id)) creditedPaise += note.netPaise;
  }

  const allocationRows = await exec
    .select({
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(eq(allocations.invoiceId, invoice.id));
  const allocatedPaise = Number(allocationRows[0]!.total); // sum() over bigint arrives as numeric text

  const refundRows = await exec
    .select({ total: sql<string>`coalesce(sum(${refundVouchers.amountPaise}), 0)` })
    .from(refundVouchers)
    .where(and(eq(refundVouchers.invoiceId, invoice.id), eq(refundVouchers.status, "paid")));
  const refundedPaise = Number(refundRows[0]!.total);

  const lineRows = await exec
    .select({
      id: invoiceLines.id,
      category: invoiceLines.category,
      taxableBasePaise: invoiceLines.taxableBasePaise,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoice.id))
    .orderBy(asc(invoiceLines.lineNo));

  // Per-line credited BASE, over the LIVE notes only. A note marked entered-in-error credited
  // nothing, exactly as it counts for nothing in `creditedPaise` above.
  const creditedBase = new Map<string, number>();
  if (liveNoteIds.length > 0) {
    const shareRows = await exec
      .select({
        invoiceLineId: creditNoteLines.invoiceLineId,
        taxableBasePaise: creditNoteLines.taxableBasePaise,
      })
      .from(creditNoteLines)
      .where(inArray(creditNoteLines.creditNoteId, liveNoteIds));
    for (const share of shareRows) {
      creditedBase.set(share.invoiceLineId, (creditedBase.get(share.invoiceLineId) ?? 0) + share.taxableBasePaise);
    }
  }

  return {
    invoiceId: invoice.id,
    issuedAt: invoice.issuedAt,
    enteredInError: invoiceMarked.has(invoice.id),
    netPayablePaise: invoice.netPayablePaise,
    creditedPaise,
    allocatedPaise,
    refundedPaise,
    lines: lineRows.map((line) => ({
      lineId: line.id,
      category: line.category,
      taxableBasePaise: line.taxableBasePaise,
      creditedBasePaise: creditedBase.get(line.id) ?? 0,
    })),
  };
}
