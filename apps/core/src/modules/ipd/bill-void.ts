import { and, eq, inArray, sql } from "drizzle-orm";
import { IpdAskBillVoidSchema, IpdVoidBillSchema, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  allocations, approvals, ipdAdmissionDeposits, ipdFinalBills, ipdGatePasses, ipdPayerClaims, receiptTenders, receipts, refundVouchers,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { rejectRequest } from "../../kernel/approvals/decisions";
import { BillingError, issueCreditNote, registerRefundVoucherGuard, releaseInvoiceSurplusOnTx, withIdempotency } from "../billing";
import { lockAdmission, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { grantedApproval, requestIpdApproval } from "./approval-types";
import { liveBills } from "./bill-cover";
import { billVoided } from "./discharge-events";
import { IpdError } from "./errors";
import { IPD_DISCHARGE_BILL } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RefundVoucherGuard } from "../billing";

/**
 * #763 — VOIDING A SETTLED IPD BILL (final or supplementary). DECIDED $ (standard Indian corporate hospital practice):
 *
 * - Billing ASKS (`ipd.discharge.bill`) with a reason; the billing manager (or the owner) GRANTS on the kernel approvals
 *   engine (`ipd_bill_void`, subject = the bill). The engine refuses a self-approval (requester ≠ approver); the void
 *   re-checks it, so a row written around the engine cannot pass.
 * - The void is ONE transaction under the admission lock. Every money move is a DOCUMENT, never an edit: a `correction`
 *   credit note against the invoice (billing's own, exhausting every line), then the invoice's allocations reversed
 *   (`releaseInvoiceSurplusOnTx`) so the deposit and any money paid on the bill are free again. Money paid at the counter
 *   on the voided bill is ADOPTED as the stay's deposit (an `ipd_admission_deposits` row naming that receipt), so the
 *   re-settled bill applies it instead of asking the patient again.
 * - The payer's claim row is withdrawn (`withdrawn`). The excess-deposit refund the bill raised is cancelled when its
 *   voucher is not issued (a pending request is rejected when the voider may decide it; in every case billing's voucher
 *   guard refuses it from now on); when the voucher IS issued the money is out and the void is refused `refund_issued`.
 * - Newest first: a supplementary bill must be voided before the bill it followed (`void_newer_bill_first`).
 * - A live gate pass (issued on the voided bill's facts) is voided with it.
 * - Voiding reopens the running bill: the days the bill closed are posted again by the nightly job, `cancel_fit` proceeds,
 *   and the next settle composes ONE new bill from every line no live bill has taken.
 */

type Opts = { now?: Date };

export async function askBillVoid(db: Db, actor: Actor, raw: unknown): Promise<{ approvalId: string }> {
  const input = IpdAskBillVoidSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const a = await readAdmission(db, input.admissionId);
  const bill = (await liveBills(db, a.id)).find((b) => b.id === input.billId);
  if (bill === undefined) throw new IpdError("bill_not_found", "no live bill with that id on this admission", { billId: input.billId });
  const label = bill.kind === "final" ? "final bill" : `supplementary bill ${String(bill.seq)}`;
  return withTx(db, (tx) => requestIpdApproval(tx, actor, {
    kind: "bill_void", subjectId: bill.id, patientId: a.patientId, note: `Void ${label} ${bill.invoiceNo ?? ""}: ${input.reason}`.trim(),
    amountPaise: bill.totalPaise,
  }));
}

export type VoidBillResult = {
  admissionId: string;
  billId: string;
  creditNoteNo: string | null;
  claimWithdrawn: boolean;
  refundCancelled: boolean;
  gatePassVoided: boolean;
};

export async function voidBill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<VoidBillResult> {
  const input = IpdVoidBillSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const scope = { actorId: actor.id, route: "ipd:void_bill", key: input.idempotencyKey.toLowerCase() };
  return withIdempotency(db, scope, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    const bill = (await tx.select().from(ipdFinalBills).where(eq(ipdFinalBills.id, input.billId)).for("update"))[0];
    if (bill?.admissionId !== a.id) throw new IpdError("bill_not_found", "no bill with that id on this admission", { billId: input.billId });
    if (bill.voidedAt !== null) throw new IpdError("bill_already_voided", "this bill is already voided", { voidedAt: bill.voidedAt.toISOString() });
    const newer = (await liveBills(tx, a.id)).filter((b) => b.seq > bill.seq);
    if (newer.length > 0) throw new IpdError("void_newer_bill_first", "void the newer supplementary bill first", { billIds: newer.map((b) => b.id) });

    // The approval: granted, for THIS bill, and not decided by its own requester (the engine refuses that; re-checked).
    const ok = await grantedApproval(tx, input.approvalId, "bill_void", [bill.id]);
    const req = (await tx.select({ requesterId: approvals.requesterId }).from(approvals).where(eq(approvals.id, input.approvalId)))[0];
    if (ok === null || req === undefined || ok.decidedBy === null || ok.decidedBy === req.requesterId) {
      throw new IpdError("void_needs_approval", "a void needs a granted approval for this bill, decided by someone other than its requester", {
        approvalId: input.approvalId,
      });
    }

    // The refund this bill raised: refused when the money is out; else cancelled (the voucher guard below refuses it).
    let refundCancelled = false;
    if (bill.refundApprovalId !== null && bill.refundPaise > 0) {
      // The same row lock billing's voucher issue takes first: a void and a voucher can never both win.
      await tx.execute(sql`select id from approvals where id = ${bill.refundApprovalId} for update`);
      const v = (await tx.select({ voucherNo: refundVouchers.voucherNo }).from(refundVouchers).where(eq(refundVouchers.approvalId, bill.refundApprovalId)))[0];
      if (v !== undefined) {
        throw new IpdError("refund_issued", "the bill's refund voucher is already issued: the money is out, the bill cannot be voided", {
          voucherNo: v.voucherNo,
        });
      }
      const pending = (await tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, bill.refundApprovalId)))[0]?.status === "pending";
      if (pending) {
        try {
          await rejectRequest(tx as unknown as Db, actor, { approvalId: bill.refundApprovalId, note: `IPD bill voided: ${input.reason}` });
        } catch {
          // Not this person's to decide (role, or they asked for it): it stays pending, and the guard refuses its voucher.
        }
      }
      refundCancelled = true;
    }

    // The money documents: a correction credit note against the invoice, then its allocations reversed.
    let creditNote: { id: string; no: string } | null = null;
    if (bill.invoiceId !== null) {
      const reason = `IPD bill void (${a.admissionNo ?? a.id}): ${input.reason}`;
      const cn = await issueCreditNote(tx as unknown as Db, actor, { kind: "correction", invoiceId: bill.invoiceId, reason }, at);
      creditNote = { id: cn.creditNoteId, no: cn.creditNoteNo };
      const [alloc] = await tx.select({
        total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
      }).from(allocations).where(eq(allocations.invoiceId, bill.invoiceId));
      const allocated = Number(alloc?.total ?? 0);
      if (allocated > 0) {
        const released = await releaseInvoiceSurplusOnTx(tx, actor, { invoiceId: bill.invoiceId, amountPaise: allocated, reason }, at);
        await adoptPaidReceipts(tx, actor, a.id, bill.id, released.moves, at);
      }
    }

    const claims = await tx.update(ipdPayerClaims).set({ status: "withdrawn", withdrawnBy: actor.id, withdrawnAt: at })
      .where(and(eq(ipdPayerClaims.finalBillId, bill.id), inArray(ipdPayerClaims.status, ["pending", "filed", "rejected"])))
      .returning({ id: ipdPayerClaims.id });
    await tx.update(ipdFinalBills).set({
      voidedAt: at, voidedBy: actor.id, voidReason: input.reason, voidApprovalId: ok.id, creditNoteId: creditNote?.id ?? null,
      creditNoteNo: creditNote?.no ?? null, refundCancelledAt: refundCancelled ? at : null,
    }).where(eq(ipdFinalBills.id, bill.id));
    const passes = await tx.update(ipdGatePasses).set({ status: "void", voidedBy: actor.id, voidedAt: at, voidReason: "bill_voided" })
      .where(and(eq(ipdGatePasses.admissionId, a.id), eq(ipdGatePasses.status, "issued"))).returning({ id: ipdGatePasses.id });
    await appendEvent(tx, billVoided.make({
      payload: { admissionId: a.id, billId: bill.id, creditNoteId: creditNote?.id ?? null, approvalId: ok.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return {
      admissionId: a.id, billId: bill.id, creditNoteNo: creditNote?.no ?? null, claimWithdrawn: claims.length > 0, refundCancelled,
      gatePassVoided: passes.length > 0,
    };
  }), at);
}

/**
 * Money paid on the voided bill (a counter receipt, not a deposit) becomes the stay's deposit, so the re-settled bill
 * applies it. One row per receipt (the deposit table's unique receipt id); a deposit receipt is already the stay's.
 */
async function adoptPaidReceipts(
  tx: Tx, actor: Actor, admissionId: string, billId: string, moves: readonly { receiptId: string; amountPaise: number }[], at: Date,
): Promise<void> {
  const ids = [...new Set(moves.map((m) => m.receiptId))];
  if (ids.length === 0) return;
  const known = new Set((await tx.select({ receiptId: ipdAdmissionDeposits.receiptId }).from(ipdAdmissionDeposits)
    .where(inArray(ipdAdmissionDeposits.receiptId, ids))).map((r) => r.receiptId));
  for (const receiptId of ids) {
    if (known.has(receiptId)) continue;
    const r = (await tx.select({ receiptNo: receipts.receiptNo }).from(receipts).where(eq(receipts.id, receiptId)))[0];
    const tender = (await tx.select({ mode: receiptTenders.mode }).from(receiptTenders).where(eq(receiptTenders.receiptId, receiptId)))[0];
    const amountPaise = moves.filter((m) => m.receiptId === receiptId).reduce((t, m) => t + m.amountPaise, 0);
    if (r === undefined || amountPaise <= 0) continue;
    await tx.insert(ipdAdmissionDeposits).values({
      id: newId(), admissionId, receiptId, receiptNo: r.receiptNo, amountPaise, tender: tender?.mode ?? "cash",
      payerName: "Paid on a voided bill", payerRelation: "self", idempotencyKey: `bill_void:${billId}:${receiptId}`, takenBy: actor.id, takenAt: at,
    });
  }
}

/**
 * Billing's voucher guard (registered by `IpdModule`): a refund approval a void cancelled never issues a voucher. Runs
 * inside billing's voucher transaction, after it locked the approval row.
 */
export const ipdRefundVoucherGuard: RefundVoucherGuard = async (tx, ctx) => {
  const row = (await tx.select({ id: ipdFinalBills.id }).from(ipdFinalBills)
    .where(and(eq(ipdFinalBills.refundApprovalId, ctx.approvalId), sql`${ipdFinalBills.refundCancelledAt} is not null`)))[0];
  if (row !== undefined) {
    throw new BillingError("approval_not_granted", `refund approval ${ctx.approvalId} was cancelled: its IPD bill was voided`);
  }
};

/** Registers `ipdRefundVoucherGuard` with billing (`IpdModule` at boot); returns the unregister function. */
export function registerIpdRefundVoucherGuard(): () => void {
  return registerRefundVoucherGuard("ipd.bill-void", ipdRefundVoucherGuard);
}
