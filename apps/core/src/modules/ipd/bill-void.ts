import { and, eq, inArray } from "drizzle-orm";
import { IpdAskBillVoidSchema, IpdVoidBillSchema, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  approvals, ipdAdmissionDeposits, ipdFinalBills, ipdGatePasses, ipdPayerClaims, receiptTenders, receipts,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { rejectRequest } from "../../kernel/approvals/decisions";
import { SodViolationError } from "../../kernel/auth/sod";
import { WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, cancelRefundRequestOnTx, invoiceAllocatedPaise, issueCreditNote, releaseInvoiceSurplusOnTx, withIdempotency } from "../billing";
import { lockAdmission, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { grantedApproval, requestIpdApproval } from "./approval-types";
import { liveBills } from "./bill-cover";
import { depositTaken } from "./admission-events";
import { billVoided } from "./discharge-events";
import { IpdError } from "./errors";
import { IPD_DISCHARGE_BILL } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

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
 *   voucher is not issued — billing's own marker (`cancelRefundRequestOnTx`, read by `issueRefundVoucher` in every process)
 *   refuses its voucher from now on, and a pending request is also rejected when the voider may decide it; when the
 *   voucher IS issued the money is out and the void is refused `refund_issued`.
 * - Newest first: a supplementary bill must be voided before the bill it followed (`void_newer_bill_first`).
 * - ⚖ Refused while a gate pass is issued and not yet scanned (`gate_pass_live` — never stop a patient at the gate); allowed
 *   after the scan. Refused when the payer has settled the bill's claim (`payer_claim_settled`) or holds it (`payer_claim_filed`). Both before any write.
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
  adoptedReceiptIds: string[];
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

    // The approval: granted, for THIS bill, and not decided by its own requester (the engine refuses that; re-checked here,
    // so a grant written around the engine stops at this check — `detail.reason`).
    const ok = await grantedApproval(tx, input.approvalId, "bill_void", [bill.id]);
    if (ok === null) {
      throw new IpdError("void_needs_approval", "a void needs a granted approval for this bill", { approvalId: input.approvalId, reason: "not_granted" });
    }
    const req = (await tx.select({ requesterId: approvals.requesterId }).from(approvals).where(eq(approvals.id, input.approvalId)))[0];
    if (req === undefined || ok.decidedBy === null || ok.decidedBy === req.requesterId) {
      throw new IpdError("void_needs_approval", "the approval was decided by its own requester", { approvalId: input.approvalId, reason: "self_approved" });
    }

    // ⚖ Review RED 3: an issued pass not yet scanned is the patient's way out — never pulled from under them.
    const pass = (await tx.select({ code: ipdGatePasses.code }).from(ipdGatePasses)
      .where(and(eq(ipdGatePasses.admissionId, a.id), eq(ipdGatePasses.status, "issued"))))[0];
    if (pass !== undefined) throw new IpdError("gate_pass_live", "a gate pass is issued and not yet scanned: void after the exit", { gatePassCode: pass.code });
    // Review RED 4: a claim the payer has settled is money received against this bill — refused before any write.
    const settledClaim = (await tx.select({ id: ipdPayerClaims.id }).from(ipdPayerClaims)
      .where(and(eq(ipdPayerClaims.finalBillId, bill.id), eq(ipdPayerClaims.status, "settled"))))[0];
    if (settledClaim !== undefined) throw new IpdError("payer_claim_settled", "the payer has settled this bill's claim", { claimId: settledClaim.id });
    // #604 review: a claim filed with the payer (with_payer) — withdrawing it here would leave the payer's settlement
    // unrecordable and free the stay to claim again on a new bill. The desk records the payer's rejection first.
    const filedClaim = (await tx.select({ id: ipdPayerClaims.id }).from(ipdPayerClaims)
      .where(and(eq(ipdPayerClaims.finalBillId, bill.id), eq(ipdPayerClaims.status, "filed"))))[0];
    if (filedClaim !== undefined) throw new IpdError("payer_claim_filed", "this bill's claim is with the payer", { claimId: filedClaim.id });

    // The refund this bill raised: refused when the money is out; else cancelled by billing's own marker (fails closed).
    let refundCancelled = false;
    if (bill.refundApprovalId !== null && bill.refundPaise > 0) {
      try {
        await cancelRefundRequestOnTx(tx, actor, { approvalId: bill.refundApprovalId, reason: `IPD bill voided: ${input.reason}` }, at);
      } catch (e) {
        if (e instanceof BillingError && e.code === "voucher_state_conflict") {
          throw new IpdError("refund_issued", "the bill's refund voucher is already issued: the money is out, the bill cannot be voided", {
            refundApprovalId: bill.refundApprovalId,
          });
        }
        throw e;
      }
      refundCancelled = true;
      const pending = (await tx.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, bill.refundApprovalId)))[0]?.status === "pending";
      if (pending) {
        try {
          await rejectRequest(tx as unknown as Db, actor, { approvalId: bill.refundApprovalId, note: `IPD bill voided: ${input.reason}` });
        } catch (e) {
          // Review BLUE 15: only "not this person's to decide" (the requester, or a role the refund ladder does not name) is
          // tolerated — the request stays pending and billing's cancellation marker refuses its voucher. Anything else fails.
          if (!(e instanceof SodViolationError) && !(e instanceof WorkflowError && e.code === "role_denied")) throw e;
        }
      }
    }

    // The money documents: a correction credit note against the invoice, then its allocations reversed.
    let creditNote: { id: string; no: string } | null = null;
    let adopted: string[] = [];
    if (bill.invoiceId !== null) {
      const reason = `IPD bill void (${a.admissionNo ?? a.id}): ${input.reason}`;
      const cn = await issueCreditNote(tx as unknown as Db, actor, { kind: "correction", invoiceId: bill.invoiceId, reason }, at);
      creditNote = { id: cn.creditNoteId, no: cn.creditNoteNo };
      const allocated = await invoiceAllocatedPaise(tx, bill.invoiceId);
      if (allocated > 0) {
        const released = await releaseInvoiceSurplusOnTx(tx, actor, { invoiceId: bill.invoiceId, amountPaise: allocated, reason }, at);
        adopted = await adoptPaidReceipts(tx, actor, a, bill.id, released.moves, at);
      }
    }

    const claims = await tx.update(ipdPayerClaims).set({ status: "withdrawn", withdrawnBy: actor.id, withdrawnAt: at })
      .where(and(eq(ipdPayerClaims.finalBillId, bill.id), inArray(ipdPayerClaims.status, ["pending", "filed", "rejected"])))
      .returning({ id: ipdPayerClaims.id });
    await tx.update(ipdFinalBills).set({
      voidedAt: at, voidedBy: actor.id, voidReason: input.reason, voidApprovalId: ok.id, creditNoteId: creditNote?.id ?? null,
      creditNoteNo: creditNote?.no ?? null, refundCancelledAt: refundCancelled ? at : null,
    }).where(eq(ipdFinalBills.id, bill.id));
    await appendEvent(tx, billVoided.make({
      payload: {
        admissionId: a.id, billId: bill.id, creditNoteId: creditNote?.id ?? null, approvalId: ok.id, adoptedReceiptIds: adopted,
        provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return {
      admissionId: a.id, billId: bill.id, creditNoteNo: creditNote?.no ?? null, claimWithdrawn: claims.length > 0, refundCancelled,
      adoptedReceiptIds: adopted,
    };
  }), at);
}

/**
 * Money paid on the voided bill (a counter receipt, not a deposit) becomes the stay's deposit, so the re-settled bill
 * applies it. One row per receipt (the deposit table's unique receipt id); a deposit receipt is already the stay's.
 */
async function adoptPaidReceipts(
  tx: Tx, actor: Actor, a: { id: string; patientId: string }, billId: string, moves: readonly { receiptId: string; amountPaise: number }[], at: Date,
): Promise<string[]> {
  const admissionId = a.id;
  const out: string[] = [];
  const ids = [...new Set(moves.map((m) => m.receiptId))];
  if (ids.length === 0) return out;
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
    // The deposit row's event, as `takeDeposit` writes it (review 10).
    await appendEvent(tx, depositTaken.make({
      payload: { admissionId, receiptId, provenance: provenanceOf(actor) },
      actor, correlationId: admissionId, patientId: a.patientId, occurredAt: at,
    }));
    out.push(receiptId);
  }
  return out;
}
