import { and, eq, inArray } from "drizzle-orm";
import { allocations, enteredInErrorMarks, invoices, receipts, receiptTenders, refundVouchers } from "../../kernel/db/schema";
import { invoiceSettlement } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * UX-AUDIT 2026-09-28 — "OPEN ON THIS DRAWER": what a cashier still owes the day before she counts.
 *
 * The session screen's board (`BillingEdge.dc.html`, right panel) lists what is still open on a
 * drawer — non-cash tenders nobody has confirmed, refunds queued against the cash, bills paid in
 * part — beside "If you closed the drawer now". None of it was readable by the person who holds the
 * drawer: `/billing/refunds` and the recon worklist are office reads (`billing.reports.read`).
 *
 * ═══ THIS READ NEVER CARRIES A CASH FIGURE ═══
 *
 * The close is a BLIND COUNT: the expected cash stays hidden until the cashier has posted hers,
 * because a cashier shown the answer first will find it every time and a real short is never found.
 * So nothing here sums a CASH tender, a cash voucher paid from this drawer, or change handed back —
 * the three inputs of `liveExpectedCashPaise`. Refunds paid from this drawer are a COUNT, never an
 * amount. The queued-refund total is the hospital's issued-and-unpaid cash vouchers, which the
 * expected figure does not contain until one is paid. A test pins the payload's keys.
 *
 * Read-only, and each aggregate reads one table at a time (the `enteredInErrorDocIds` note in
 * `invoices.ts`: a correlated NOT EXISTS written through drizzle's `sql` compares the wrong columns).
 */
export type DrawerOpenItems = {
  /** Live (not entered-in-error) receipts taken on this drawer. */
  receipts: number;
  /** UPI and card tenders still `captured` — no settlement statement has confirmed them yet. */
  nonCashUnconfirmed: { count: number; paise: number };
  /** UPI and card tenders a statement disagreed with (`mismatched`). */
  nonCashMismatched: { count: number; paise: number };
  /** Cash refund vouchers issued and approved but not yet paid, hospital-wide — hold that cash. */
  refundsQueued: { count: number; paise: number };
  /** Cash refund vouchers paid out of THIS drawer — a count only; the amount is part of the expected. */
  refundsPaidHere: number;
  /** Bills this drawer took money against that still carry a balance. */
  partPaid: { count: number; paise: number; items: PartPaidItem[] };
};

export type PartPaidItem = { invoiceId: string; invoiceNo: string; patientId: string; outstandingPaise: number };

/** The list is a worklist, not a ledger: the first few, largest balance first; the count is whole. */
const PART_PAID_LIST_MAX = 20;

async function deadIds(db: Db, docType: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ docId: enteredInErrorMarks.docId }).from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, ids)));
  return new Set(rows.map((r) => r.docId));
}

export async function drawerOpenItems(db: Db, sessionId: string): Promise<DrawerOpenItems> {
  const receiptRows = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.cashierSessionId, sessionId));
  const deadReceipts = await deadIds(db, "receipt", receiptRows.map((r) => r.id));
  const liveReceiptIds = receiptRows.map((r) => r.id).filter((id) => !deadReceipts.has(id));

  const nonCashUnconfirmed = { count: 0, paise: 0 };
  const nonCashMismatched = { count: 0, paise: 0 };
  const touched = new Set<string>();
  if (liveReceiptIds.length > 0) {
    const tenders = await db.select({ mode: receiptTenders.mode, amountPaise: receiptTenders.amountPaise, state: receiptTenders.state })
      .from(receiptTenders).where(inArray(receiptTenders.receiptId, liveReceiptIds));
    for (const t of tenders) {
      if (t.mode === "cash") continue; // THE BLIND COUNT: no cash figure leaves this function.
      const bucket = t.state === "captured" ? nonCashUnconfirmed : t.state === "mismatched" ? nonCashMismatched : null;
      if (bucket === null) continue;
      bucket.count += 1;
      bucket.paise += t.amountPaise;
    }
    const allocs = await db.select({ invoiceId: allocations.invoiceId }).from(allocations)
      .where(and(inArray(allocations.receiptId, liveReceiptIds), eq(allocations.kind, "apply")));
    for (const a of allocs) touched.add(a.invoiceId);
  }

  const partPaidAll: PartPaidItem[] = [];
  if (touched.size > 0) {
    const ids = [...touched];
    const deadInvoices = await deadIds(db, "invoice", ids);
    const rows = await db.select({ id: invoices.id, invoiceNo: invoices.invoiceNo, patientId: invoices.patientId })
      .from(invoices).where(inArray(invoices.id, ids));
    for (const row of rows) {
      if (deadInvoices.has(row.id)) continue;
      // The ledger's own settlement rule — the same `settlementState` every other reader uses.
      const s = await invoiceSettlement(db, row.id);
      if (s.state !== "partial") continue;
      partPaidAll.push({ invoiceId: row.id, invoiceNo: row.invoiceNo, patientId: row.patientId, outstandingPaise: s.outstandingPaise });
    }
  }
  partPaidAll.sort((a, b) => b.outstandingPaise - a.outstandingPaise || a.invoiceNo.localeCompare(b.invoiceNo));

  const queued = await db.select({ amountPaise: refundVouchers.amountPaise }).from(refundVouchers)
    .where(and(eq(refundVouchers.status, "issued"), eq(refundVouchers.method, "cash")));
  const paidHere = await db.select({ id: refundVouchers.id }).from(refundVouchers)
    .where(and(eq(refundVouchers.cashierSessionId, sessionId), eq(refundVouchers.status, "paid"), eq(refundVouchers.method, "cash")));

  return {
    receipts: liveReceiptIds.length,
    nonCashUnconfirmed,
    nonCashMismatched,
    refundsQueued: { count: queued.length, paise: queued.reduce((n, r) => n + r.amountPaise, 0) },
    refundsPaidHere: paidHere.length,
    partPaid: {
      count: partPaidAll.length,
      paise: partPaidAll.reduce((n, r) => n + r.outstandingPaise, 0),
      items: partPaidAll.slice(0, PART_PAID_LIST_MAX),
    },
  };
}
