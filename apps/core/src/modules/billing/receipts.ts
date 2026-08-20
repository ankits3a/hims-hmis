import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  allocations, creditNotes, enteredInErrorMarks, invoices, receipts, refundVouchers,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { getPatientSummaries } from "../patients";
import { assertPaise } from "../tariff";
import { assertCashAccepted } from "./cash-law";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { insertReceiptWithTenders, patientOutstandingPaise } from "./invoices";
import { requireOpenSession } from "./sessions";
import { settlementState } from "./settlement";
import {
  advanceReceived, allocationReversed, cashThresholdBlocked, cashThresholdWarned,
  documentEnteredInError, paymentReceived, receiptRecorded,
} from "./events";
import type { CashThresholdDetail, TenderInput } from "./cash-law";
import type { Settlement } from "./settlement";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D1 — the patient money ledger: append-only receipts, append-only allocations, and the
 * readers that DERIVE settlement and advance balances from them. Nothing here ever updates or
 * deletes a ledger row (migration 0012's triggers would raise anyway); a mistake is undone by
 * appending a `reverse` allocation or by an `entered-in-error` mark, never by rewriting history.
 *
 * PLAN DEVIATION, DISCLOSED: the plan's Files list put `advanceOf` in `settlement.ts`, exactly as
 * it had put T5's `outstandingOf`/`invoiceSettlement` there. `settlement.ts` is one of the five
 * files `billing-purity.test.ts` (T2, outside this task's Files list) sweeps for
 * `from "../../kernel` and `await ` — a SQL reader cannot live in it without either breaking that
 * shipped test or silently relaxing it. T5 reported the same defect and put its readers beside the
 * writer whose rows they read; this task follows that precedent rather than editing a file it does
 * not own. The pure state function stays where T2 put it; `advanceOf` lives here.
 *
 * LOCK DISCIPLINE (D1, and the Plan 06.1 C1 lesson — see the identical warning in
 * `modules/tariff/versions.ts`): every writer in this file acquires INVOICE rows first and the
 * RECEIPT row second, and where more than one invoice is involved it takes them as ONE ordered
 * statement (`order by id for update`), never row-then-set. A single global acquisition order is
 * what makes two concurrent ledger writes queue instead of deadlocking (Postgres 40P01).
 */

export type ReceiptRow = typeof receipts.$inferSelect;
export type AllocationRow = typeof allocations.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Ledger aggregates. Each reads ONE table at a time: drizzle renders a column interpolated into a
// `sql` SELECT FIELD without its table qualifier, so a two-table query written that way can
// silently compare the wrong columns (the caveat T5 recorded on the same aggregates).
// ---------------------------------------------------------------------------------------------

async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

/** Effective allocation per invoice: Sigma apply - Sigma reverse (D1). */
async function allocatedByInvoice(exec: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await exec
    .select({
      invoiceId: allocations.invoiceId,
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(inArray(allocations.invoiceId, invoiceIds))
    .groupBy(allocations.invoiceId);
  return new Map(rows.map((r) => [r.invoiceId, Number(r.total)] as const)); // sum() over bigint arrives as numeric text
}

/** Effective allocation per receipt — how much of the money taken is already spoken for (D1). */
async function allocatedByReceipt(exec: Db | Tx, receiptIds: string[]): Promise<Map<string, number>> {
  if (receiptIds.length === 0) return new Map();
  const rows = await exec
    .select({
      receiptId: allocations.receiptId,
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(inArray(allocations.receiptId, receiptIds))
    .groupBy(allocations.receiptId);
  return new Map(rows.map((r) => [r.receiptId, Number(r.total)] as const));
}

/** Sigma non-EIE credit-note nets per invoice (D1). Nothing credits until T7 ships. */
async function creditedByInvoice(exec: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await exec
    .select({ id: creditNotes.id, invoiceId: creditNotes.invoiceId, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(inArray(creditNotes.invoiceId, invoiceIds));
  if (rows.length === 0) return new Map();
  const dead = await enteredInErrorDocIds(exec, "credit_note", rows.map((r) => r.id));
  const out = new Map<string, number>();
  for (const row of rows) {
    if (dead.has(row.id)) continue;
    out.set(row.invoiceId, (out.get(row.invoiceId) ?? 0) + row.netPaise);
  }
  return out;
}

/**
 * Sigma advance-refund vouchers the patient already holds, issued or paid (D1's third term). T8
 * writes them; the term is folded in here because `refunds.ts` cannot edit this file and a reader
 * that ignored the vouchers it has already paid would let the same advance be refunded twice.
 */
async function advanceRefundedPaise(exec: Db | Tx, patientId: string): Promise<number> {
  const rows = await exec
    .select({ total: sql<string>`coalesce(sum(${refundVouchers.amountPaise}), 0)` })
    .from(refundVouchers)
    .where(
      and(
        eq(refundVouchers.patientId, patientId),
        eq(refundVouchers.kind, "advance_refund"),
        inArray(refundVouchers.status, ["issued", "paid"]),
      ),
    );
  return Number(rows[0]!.total);
}

/**
 * D1's advance formula, with ONE receipt optionally dropped from the live set.
 *
 * `excludeReceiptId === null` is `advanceOf` itself. A non-null id answers "what would this
 * patient's advance be if that receipt were dead?" — which is exactly the post-mark state, because
 * marking a receipt entered-in-error takes its total AND its allocations out of the balance
 * together (`markEnteredInError` reverses the live allocations in the same transaction). The
 * refund term is untouched by the exclusion: `advanceRefundedPaise` is PER-PATIENT and no voucher
 * names a receipt, which is the whole reason the invariant below has to be stated as a balance.
 */
async function advanceOfExcluding(
  exec: Db | Tx,
  patientId: string,
  excludeReceiptId: string | null,
): Promise<number> {
  const rows = await exec
    .select({ id: receipts.id, totalPaise: receipts.totalPaise })
    .from(receipts)
    .where(eq(receipts.patientId, patientId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "receipt", rows.map((r) => r.id));
  const live = rows.filter((r) => !dead.has(r.id) && r.id !== excludeReceiptId);
  const allocated = await allocatedByReceipt(exec, live.map((r) => r.id));
  let total = 0;
  for (const row of live) total += row.totalPaise - (allocated.get(row.id) ?? 0);
  return total - (await advanceRefundedPaise(exec, patientId));
}

/**
 * The patient's advance balance (D1): Sigma receipt totals - Sigma effective allocations of those
 * receipts - Sigma advance-refund vouchers. Money on a receipt marked `entered-in-error` leaves
 * the balance entirely — the mark reverses that receipt's live allocations in the same
 * transaction, so neither term counts it afterwards.
 *
 * DELIBERATELY NOT FLOORED AT ZERO. A floor would hide the symptom and not the defect: with
 * `total(live) = 0` and `refunded = 10000` it clamps -10000 to 0, but the patient's NEXT 100000p
 * advance then computes 100000 - 10000 = 90000 — positive, so the floor never bites and the
 * absorption survives untouched. This reader stays honest and `markEnteredInError`'s guard is what
 * keeps the state from being created.
 */
export async function advanceOf(exec: Db | Tx, patientId: string): Promise<number> {
  return advanceOfExcluding(exec, patientId, null);
}

// ---------------------------------------------------------------------------------------------
// Row locks. Order is INVOICE(S) then RECEIPT, everywhere in this file.
// ---------------------------------------------------------------------------------------------

/**
 * D1's serializer for allocation writes. Locking an immutable row is legal — 0012's trigger
 * forbids UPDATE and DELETE, not locks — and it is what makes over-allocation a plain in-transaction
 * sum check: the second writer cannot read the invoice's allocated total until the first COMMITS.
 */
async function lockInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ id: string; patientId: string; netPayablePaise: number }> {
  const rows = await tx
    .select({ id: invoices.id, patientId: invoices.patientId, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  return row;
}

/** The receipt-side serializer: one receipt's unallocated remainder can only be spent once. */
async function lockReceipt(
  tx: Tx,
  receiptId: string,
): Promise<{ id: string; receiptNo: string; patientId: string; totalPaise: number }> {
  const rows = await tx
    .select({
      id: receipts.id, receiptNo: receipts.receiptNo,
      patientId: receipts.patientId, totalPaise: receipts.totalPaise,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for("update");
  const row = rows[0];
  if (!row) throw new BillingError("unknown_receipt", `unknown receipt ${receiptId}`);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Money in — the advance lane (D1: an advance receipt and a bill payment are the SAME row)
// ---------------------------------------------------------------------------------------------

export type RecordReceiptInput = {
  patientId: string;
  tenders: TenderInput[];
  panNumber?: string;
  form60?: boolean;
  note?: string;
};

export type RecordReceiptResult = { receiptId: string; receiptNo: string; totalPaise: number };

/**
 * Takes money with no invoice behind it. The row is identical to the one `issueInvoice` writes —
 * what makes this an "advance" is only that nothing is allocated against it yet, which is why the
 * C-2 cash law reaches it unchanged (D7: cash is cash under 269ST, and `episodeCashPaise` reads
 * receipts rather than invoices precisely so an advance counts into the episode).
 */
export async function recordReceipt(
  db: Db,
  actor: Actor,
  input: RecordReceiptInput,
  now: Date = new Date(),
): Promise<RecordReceiptResult> {
  const cfg = await loadBillingConfig(db);
  // The M3 belt at OUR boundary, before anything is read or written (the `issueInvoice` precedent).
  let totalPaise = 0;
  for (const tender of input.tenders) {
    assertPaise(tender.amountPaise, `${tender.mode} tender amount`);
    totalPaise += tender.amountPaise;
  }
  if (totalPaise <= 0) {
    throw new BillingError("invalid_paise", "a receipt must take a positive amount of money");
  }

  try {
    return await withTx(db, async (tx) => {
      const session = await requireOpenSession(tx, actor); // D9 — the ACTING cashier's drawer
      const verdict = await assertCashAccepted(tx, cfg, {
        patientId: input.patientId,
        tenders: input.tenders,
        panNumber: input.panNumber,
        form60: input.form60,
        at: now,
      });
      const written = await insertReceiptWithTenders(tx, actor, cfg, {
        patientId: input.patientId,
        cashierSessionId: session.id,
        tenders: input.tenders,
        panNumber: input.panNumber,
        form60: input.form60,
        note: input.note,
        at: now,
      });

      // No correlationId: a standalone advance has no invoice to correlate to (Global
      // Constraints — receipt events carry their invoice's id WHERE ONE EXISTS).
      const scope = { patientId: input.patientId };
      await appendEvent(
        tx,
        receiptRecorded.make({
          actor,
          payload: {
            receiptId: written.receiptId, receiptNo: written.receiptNo,
            patientId: input.patientId, totalPaise: written.totalPaise,
          },
          ...scope,
        }),
      );
      await appendEvent(
        tx,
        advanceReceived.make({
          actor,
          payload: { receiptId: written.receiptId, patientId: input.patientId, amountPaise: written.totalPaise },
          ...scope,
        }),
      );
      if (verdict.warned) {
        await appendEvent(
          tx,
          cashThresholdWarned.make({
            actor,
            payload: {
              patientId: input.patientId,
              episodeCashPaise: verdict.episodeCashPaise,
              thresholdPaise: cfg.cashWarnPaise,
            },
            ...scope,
          }),
        );
      }
      return written;
    });
  } catch (e) {
    if (e instanceof BillingError && e.code === "cash_threshold_blocked") {
      // The same audit rule `issueInvoice` states: the refusal rolls its own transaction back, so
      // the C-2 event is appended in a transaction of its own afterwards. An audit trail that only
      // survives when the money was accepted is not an audit trail.
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
          }),
        ),
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Allocations — append-only, serialized on the invoice row (D1)
// ---------------------------------------------------------------------------------------------

export type AllocateReceiptInput = { receiptId: string; invoiceId: string; amountPaise: number };
export type AllocateReceiptResult = { allocationId: string; amountPaise: number; settlement: Settlement };

/**
 * Clears (part of) an invoice from money already received. Partial settlement is the normal case,
 * not an exception: the ledger carries the amount, and settlement state is re-derived from it.
 *
 * The two guards are ordinary in-transaction sum checks made total by the two row locks above —
 * the invoice cannot be overpaid (`over_allocation`, invoice side) and a receipt cannot be spent
 * twice (`over_allocation`, receipt side). Nothing in this module marks an INVOICE
 * entered-in-error (D4 gives invoices the `correction` credit note instead), so no invoice-side EIE
 * check exists here; the receipt side has one because `markEnteredInError` below writes exactly
 * that mark.
 */
export async function allocateReceipt(
  db: Db,
  actor: Actor,
  input: AllocateReceiptInput,
  now: Date = new Date(),
): Promise<AllocateReceiptResult> {
  assertPaise(input.amountPaise, "allocation amount");
  if (input.amountPaise === 0) {
    throw new BillingError("invalid_paise", "an allocation must move a positive amount of money");
  }

  return withTx(db, async (tx) => {
    const invoice = await lockInvoice(tx, input.invoiceId);
    const receipt = await lockReceipt(tx, input.receiptId);

    // One patient's money never settles another patient's bill. The invoice is existence-hidden
    // rather than described across the patient boundary (the patients module's own idiom).
    if (receipt.patientId !== invoice.patientId) {
      throw new BillingError("unknown_invoice", `invoice ${input.invoiceId} does not belong to this receipt's patient`);
    }
    const dead = await enteredInErrorDocIds(tx, "receipt", [receipt.id]);
    if (dead.has(receipt.id)) {
      throw new BillingError("unknown_receipt", `receipt ${receipt.id} is entered-in-error`, {
        receiptId: receipt.id, enteredInError: true,
      });
    }

    const allocatedPaise = (await allocatedByInvoice(tx, [invoice.id])).get(invoice.id) ?? 0;
    const creditedPaise = (await creditedByInvoice(tx, [invoice.id])).get(invoice.id) ?? 0;
    const before = settlementState(invoice.netPayablePaise, creditedPaise, allocatedPaise);
    if (input.amountPaise > before.outstandingPaise) {
      throw new BillingError(
        "over_allocation",
        `${String(input.amountPaise)}p exceeds the ${String(before.outstandingPaise)}p outstanding on this invoice`,
        { askedPaise: input.amountPaise, outstandingPaise: before.outstandingPaise },
      );
    }

    const spentPaise = (await allocatedByReceipt(tx, [receipt.id])).get(receipt.id) ?? 0;
    const remainingPaise = receipt.totalPaise - spentPaise;
    if (input.amountPaise > remainingPaise) {
      throw new BillingError(
        "over_allocation",
        `${String(input.amountPaise)}p exceeds the ${String(remainingPaise)}p still unallocated on this receipt`,
        { askedPaise: input.amountPaise, remainingPaise },
      );
    }

    const allocationId = newId();
    await tx.insert(allocations).values({
      id: allocationId,
      receiptId: receipt.id,
      invoiceId: invoice.id,
      amountPaise: input.amountPaise,
      kind: "apply",
      reversalOfId: null,
      reason: null,
      actorId: actor.id,
      at: now,
    });
    await appendEvent(
      tx,
      paymentReceived.make({
        actor,
        payload: {
          receiptId: receipt.id, invoiceId: invoice.id,
          patientId: invoice.patientId, amountPaise: input.amountPaise,
        },
        patientId: invoice.patientId,
        correlationId: invoice.id,
      }),
    );

    return {
      allocationId,
      amountPaise: input.amountPaise,
      settlement: settlementState(invoice.netPayablePaise, creditedPaise, allocatedPaise + input.amountPaise),
    };
  });
}

export type ReverseAllocationResult = { reversalId: string; amountPaise: number; settlement: Settlement };

/**
 * Undoes an allocation by APPENDING its mirror row — the ledger is never rewritten. A `reverse`
 * row names the row it reverses, so "already reversed" is a query, not a status column.
 *
 * `allocation_reversed_already` covers both "no such allocation" and "reversed by an earlier
 * call": the predicate is the same one — there is no LIVE apply allocation with this id — and the
 * module's closed error union (T1, frozen here) carries no separate unknown-allocation code. The
 * detail distinguishes the two cases for the caller.
 */
export async function reverseAllocation(
  db: Db,
  actor: Actor,
  input: { allocationId: string; reason?: string },
  now: Date = new Date(),
): Promise<ReverseAllocationResult> {
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(allocations).where(eq(allocations.id, input.allocationId));
    const original = rows[0];
    if (!original || original.kind !== "apply") {
      throw new BillingError("allocation_reversed_already", `no live allocation ${input.allocationId} to reverse`, {
        allocationId: input.allocationId, found: original !== undefined,
      });
    }
    const invoice = await lockInvoice(tx, original.invoiceId);

    // Re-checked UNDER the invoice lock: two concurrent reversals of one allocation both pass the
    // read above, and only the one holding the lock may append.
    const reversals = await tx
      .select({ id: allocations.id })
      .from(allocations)
      .where(and(eq(allocations.kind, "reverse"), eq(allocations.reversalOfId, original.id)));
    if (reversals.length > 0) {
      throw new BillingError("allocation_reversed_already", `allocation ${original.id} is already reversed`, {
        allocationId: original.id, reversedByAllocationId: reversals[0]!.id,
      });
    }

    const reversalId = await appendReversal(tx, actor, original, invoice.patientId, input.reason ?? null, now);
    const allocatedPaise = (await allocatedByInvoice(tx, [invoice.id])).get(invoice.id) ?? 0;
    const creditedPaise = (await creditedByInvoice(tx, [invoice.id])).get(invoice.id) ?? 0;
    return {
      reversalId,
      amountPaise: original.amountPaise,
      settlement: settlementState(invoice.netPayablePaise, creditedPaise, allocatedPaise),
    };
  });
}

/** The one place a `reverse` row is written, so its event can never drift from its row. */
async function appendReversal(
  tx: Tx,
  actor: Actor,
  original: AllocationRow,
  patientId: string,
  reason: string | null,
  now: Date,
): Promise<string> {
  const reversalId = newId();
  await tx.insert(allocations).values({
    id: reversalId,
    receiptId: original.receiptId,
    invoiceId: original.invoiceId,
    amountPaise: original.amountPaise,
    kind: "reverse",
    reversalOfId: original.id,
    reason,
    actorId: actor.id,
    at: now,
  });
  await appendEvent(
    tx,
    allocationReversed.make({
      actor,
      payload: {
        allocationId: original.id, receiptId: original.receiptId, invoiceId: original.invoiceId,
        amountPaise: original.amountPaise, reason,
      },
      patientId,
      correlationId: original.invoiceId,
    }),
  );
  return reversalId;
}

// ---------------------------------------------------------------------------------------------
// entered-in-error — the module's only "void" (D1: nothing is deleted, ever)
// ---------------------------------------------------------------------------------------------

export type MarkEnteredInErrorResult = { markId: string; reversedAllocationIds: string[] };

/**
 * Marks a RECEIPT entered-in-error and reverses its live allocations IN THE SAME TRANSACTION —
 * money that was never really received cannot keep settling invoices, so the mark and the
 * reversals are one atomic act or neither happens. Invoices get the `correction` credit note
 * instead (D4) and credit notes are T7's, so `receipt` is the only doc type this function writes.
 *
 * Lock order is the file's global one — INVOICES first (as ONE ordered statement over every
 * invoice this receipt's money touches: the Plan 06.1 C1 lesson, never row-then-set), then the
 * patient's RECEIPTS as ONE ordered statement, then this receipt. Holding the receipt row is also
 * what makes the "already marked" check total: a second marker queues behind it and reads the
 * committed mark.
 *
 * THE ADVANCE INVARIANT (the money defect this guard exists for). An advance-refund voucher is
 * PER-PATIENT and names no receipt (`advanceRefundedPaise`), so there is no receipt -> voucher link
 * to ask about. Marking a receipt whose money a voucher has ALREADY returned takes the receipt out
 * of the live set while the voucher's subtraction stands: `advanceOf` goes NEGATIVE, the balance
 * endpoint serves that verbatim, and the patient's next unrelated advance is silently absorbed by
 * the shortfall. Stated as a balance invariant instead: the mark must not drive this patient's
 * advance below zero. Refusing leaves no dead end — the money was returned, so the receipt is
 * already economically neutralised and the audit trail is right as it stands; voiding it as well
 * would double-count. Nothing cascades onto the voucher: a paid voucher is cash that physically
 * left the drawer and cannot be un-paid.
 */
export async function markEnteredInError(
  db: Db,
  actor: Actor,
  input: { receiptId: string; reason: string },
  now: Date = new Date(),
): Promise<MarkEnteredInErrorResult> {
  return withTx(db, async (tx) => {
    // Read the owner UNLOCKED, only so the patient-wide lock below can name a patient. Safe by
    // construction: `receipts` is immutable under migration 0012's trigger (UPDATE and DELETE are
    // both forbidden), so `patient_id` cannot change under us between this read and the locks.
    // A missing row is left to `lockReceipt`, which raises `unknown_receipt` as it always has.
    const owner = await tx
      .select({ patientId: receipts.patientId })
      .from(receipts)
      .where(eq(receipts.id, input.receiptId));
    const ownerPatientId = owner[0]?.patientId;

    await tx.execute(
      sql`select id from invoices
          where id in (select invoice_id from allocations where receipt_id = ${input.receiptId})
          order by id for update`,
    );
    if (ownerPatientId !== undefined) {
      // THE SINGLE ORDERED LOCK, mode FOR UPDATE — the SAME statement T8's advance-refund lane
      // takes (`refunds.ts` issueRefundVoucher): every receipt row of this patient, in id order,
      // in ONE statement, never row-then-set (the Plan 06.1 C1 lesson). Taken BEFORE `lockReceipt`
      // so the file's INVOICES-then-RECEIPTS order still holds and receipts are still acquired in
      // id order. It is what serializes the balance check below — against a concurrent advance
      // refund, and against a concurrent mark of a DIFFERENT receipt of the same patient, where
      // each mark's own single-row `lockReceipt` would otherwise take a different row and neither
      // would wait.
      await tx.execute(sql`select id from receipts where patient_id = ${ownerPatientId} order by id for update`);
    }
    const receipt = await lockReceipt(tx, input.receiptId);

    const marked = await enteredInErrorDocIds(tx, "receipt", [receipt.id]);
    if (marked.has(receipt.id)) {
      throw new BillingError("eie_already_marked", `receipt ${receipt.id} is already entered-in-error`, {
        receiptId: receipt.id,
      });
    }

    // The post-mark advance, simulated by excluding this receipt from the live set — its total and
    // its allocations drop out together, which is exactly what the mark is about to do.
    const wouldBeAdvancePaise = await advanceOfExcluding(tx, receipt.patientId, receipt.id);
    if (wouldBeAdvancePaise < 0) {
      const refundedPaise = await advanceRefundedPaise(tx, receipt.patientId);
      throw new BillingError(
        "eie_advance_refunded",
        `marking receipt ${receipt.receiptNo} entered-in-error would leave this patient a ${String(wouldBeAdvancePaise)}p advance: ${String(refundedPaise)}p has already gone back on advance-refund vouchers`,
        { receiptId: receipt.id, wouldBeAdvancePaise, refundedPaise },
      );
    }

    const applied = await tx
      .select()
      .from(allocations)
      .where(and(eq(allocations.receiptId, receipt.id), eq(allocations.kind, "apply")))
      .orderBy(asc(allocations.seq));
    const reversedIds = await tx
      .select({ reversalOfId: allocations.reversalOfId })
      .from(allocations)
      .where(and(eq(allocations.receiptId, receipt.id), eq(allocations.kind, "reverse")));
    const dead = new Set(reversedIds.map((r) => r.reversalOfId));

    const reversedAllocationIds: string[] = [];
    for (const original of applied) {
      if (dead.has(original.id)) continue;
      // Same patient by construction: an allocation can only ever link a receipt and an invoice
      // that share one patient (`allocateReceipt`'s cross-patient refusal, and `issueInvoice`'s
      // single-patient transaction).
      await appendReversal(tx, actor, original, receipt.patientId, `receipt ${receipt.receiptNo} entered in error`, now);
      reversedAllocationIds.push(original.id);
    }

    const markId = newId();
    await tx.insert(enteredInErrorMarks).values({
      id: markId,
      docType: "receipt",
      docId: receipt.id,
      reason: input.reason,
      markedBy: actor.id,
      markedAt: now,
    });
    await appendEvent(
      tx,
      documentEnteredInError.make({
        actor,
        payload: { docType: "receipt", docId: receipt.id, reason: input.reason },
        patientId: receipt.patientId,
      }),
    );

    return { markId, reversedAllocationIds };
  });
}

// ---------------------------------------------------------------------------------------------
// Reads — the dues worklist and the one-patient balance the counter screen shows
// ---------------------------------------------------------------------------------------------

export type DueRow = {
  invoiceId: string;
  invoiceNo: string;
  patientId: string;
  uhid: string;
  name: string | null; // null whenever the row is restricted
  alias: string | null; // the public-surface stand-in when it is
  restricted: boolean;
  serviceDay: string;
  issuedAt: Date;
  netPayablePaise: number;
  outstandingPaise: number;
  creditExtended: boolean;
  seq: number;
};

/**
 * Every invoice still carrying an outstanding balance, OLDEST FIRST. The order key is `seq`, never
 * `id`: `newId()` is a ULID with 80 bits of fresh randomness per millisecond, so `id` is a total
 * order but NOT insertion order (ledger §3.26) — the schema carries `seq` for exactly this reason.
 *
 * Names come from the patients module's own confidential gate: a restricted row renders its alias
 * and never the name, and no billing surface orders or prioritizes on identity (§14).
 */
export async function listDues(
  db: Db,
  actor: Actor,
  filters: { patientId?: string } = {},
): Promise<DueRow[]> {
  const rows = await db
    .select({
      id: invoices.id, invoiceNo: invoices.invoiceNo, patientId: invoices.patientId,
      serviceDay: invoices.serviceDay, issuedAt: invoices.issuedAt,
      netPayablePaise: invoices.netPayablePaise, creditExtended: invoices.creditExtended, seq: invoices.seq,
    })
    .from(invoices)
    .where(filters.patientId === undefined ? undefined : eq(invoices.patientId, filters.patientId))
    .orderBy(asc(invoices.seq));
  if (rows.length === 0) return [];

  const invoiceIds = rows.map((r) => r.id);
  const dead = await enteredInErrorDocIds(db, "invoice", invoiceIds);
  const allocated = await allocatedByInvoice(db, invoiceIds);
  const credited = await creditedByInvoice(db, invoiceIds);

  const due = rows
    .filter((r) => !dead.has(r.id))
    .map((row) => ({
      row,
      settlement: settlementState(row.netPayablePaise, credited.get(row.id) ?? 0, allocated.get(row.id) ?? 0),
    }))
    .filter((d) => d.settlement.outstandingPaise > 0);
  if (due.length === 0) return [];

  const summaries = await getPatientSummaries(db, actor, due.map((d) => d.row.patientId));
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));

  return due.map(({ row, settlement }) => {
    // A summary is always present: `invoices.patient_id` carries a real FK into `patients`
    // (ruling R5), and `getPatientSummaries` resolves merged ids back through the chain.
    const summary = byPatient.get(row.patientId);
    return {
      invoiceId: row.id,
      invoiceNo: row.invoiceNo,
      patientId: row.patientId,
      uhid: summary?.uhid ?? "",
      name: summary?.name ?? null,
      alias: summary?.alias ?? null,
      restricted: summary?.restricted ?? false,
      serviceDay: row.serviceDay,
      issuedAt: row.issuedAt,
      netPayablePaise: row.netPayablePaise,
      outstandingPaise: settlement.outstandingPaise,
      creditExtended: row.creditExtended,
      seq: row.seq,
    };
  });
}

export type PatientBalance = {
  patientId: string;
  advancePaise: number;
  outstandingPaise: number;
  dues: DueRow[];
};

/**
 * One patient, both sides of the ledger — the number the dues & advances screen renders. Dues and
 * advances are ONE mechanism (the owner's 2026-08-18 ruling): the same receipt row pays a bill or
 * banks an advance, so both sides are read from it rather than from two instruments.
 */
export async function patientBalance(db: Db, actor: Actor, patientId: string): Promise<PatientBalance> {
  return {
    patientId,
    advancePaise: await advanceOf(db, patientId),
    // THE reader the per-invoice outstanding cap already uses (T5), so the screen and the cap can
    // never disagree about what a patient owes.
    outstandingPaise: await patientOutstandingPaise(db, patientId),
    dues: await listDues(db, actor, { patientId }),
  };
}
