import { and, eq } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { pharmacyDispenses } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition } from "../../kernel/workflow/instances";
import { getInvoice, issueCreditNote, requestRefund } from "../billing";
import { releaseReservation } from "../materials";
import { dispenseCancelled } from "./events";
import { PharmacyError } from "./errors";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { DispenseView } from "./queue";

/**
 * ═══ PHARMACY P5 — A PAID DISPENSE THAT CANNOT BE COLLECTED HAS A WAY OUT ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p5-billed-cancel-refund.md`.
 *
 * Hand-over refuses a batch that expired between the bill and the collection
 * (`batch_expired_before_collection`), and `cancelDispense` refuses a billed dispense. So a patient
 * who had paid could not collect, the counter had no exit, and the picked stock stayed reserved for
 * ever. The workflow definition already allowed `billed → cancelled` to a pharmacist.
 *
 * ONE ACT, ONE TRANSACTION:
 *   - the dispense is cancelled (a row lock and a conditional update, as `cancelDispense` does);
 *   - its order items are cancelled and its reservations released, so the stock is back on offer;
 *   - the bill is credited IN FULL with a `refund` credit note: the drug was never supplied;
 *   - the refund is REQUESTED. Billing's approval-gated voucher pays it (spec §7: money out is
 *     always approved), so the counter never hands cash back on its own authority.
 *
 * WHO. The workflow names the pharmacist, and this is the Act's pharmacist (`requireRegisteredPharmacist`).
 * The two billing strings are asserted HERE as well as at the route: the FD-31 rule that an
 * authority this consequential does not rest on a decorator nobody re-reads.
 */
export type CancelBilledInput = { reason: string; reasonClass: "mistake" | "genuine" };
export type CancelBilledResult = { dispense: DispenseView; creditNoteId: string; creditNoteNo: string; refundApprovalId: string };

const BILLING_STRINGS = ["billing.credit_note.issue", "billing.refund.request"] as const;

export async function cancelBilledDispense(
  db: Db, actor: Actor, decls: readonly OrderKindDecl[], dispenseId: string, input: CancelBilledInput, now: Date,
): Promise<CancelBilledResult> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "billed") {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}: only a billed dispense is cancelled with a refund`, { status: d.status });
  }
  await requireRegisteredPharmacist(db, actor, now);
  for (const permission of BILLING_STRINGS) {
    if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
      throw new PharmacyError("permission_denied", `cancelling a paid dispense raises a credit note and a refund request, which needs ${permission}`);
    }
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new PharmacyError("reason_required", "a paid dispense is cancelled with a reason the refund approver will read");
  if (d.invoiceId === null) throw new PharmacyError("not_found", `dispense ${d.id} is billed and carries no invoice`);
  const invoiceId = d.invoiceId;
  const invoice = await getInvoice(db, invoiceId);
  if (invoice === null) throw new PharmacyError("not_found", `invoice ${invoiceId} not found`);
  const lines = await linesOf(db, dispenseId);

  const result = await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyDispenses)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: reason })
      .where(and(eq(pharmacyDispenses.id, d.id), eq(pharmacyDispenses.status, "billed")))
      .returning({ id: pharmacyDispenses.id });
    if (won.length === 0) throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} moved while cancelling`);
    let released = 0;
    for (const line of lines) {
      if (line.status !== "open") continue;
      if (line.orderItemId !== null) await advanceOrderItem(tx, actor, decls, line.orderItemId, "cancelled", { reason, at: now });
      if (line.reservationId !== null) { await releaseReservation(tx, actor, line.reservationId); released += 1; }
    }
    if (d.workflowInstanceId !== null) await transition(tx, d.workflowInstanceId, "cancelled", actor);

    // Billing opens its own transaction; on a `Tx` that is a savepoint inside this one (the
    // `bill.ts` cast), so the credit note, the refund request and the cancel commit together.
    const credit = await issueCreditNote(tx as unknown as Db, actor, {
      kind: "refund", invoiceId, reason: `pharmacy: ${reason}`,
      lines: invoice.lines.map((l) => ({ invoiceLineId: l.id, qty: l.qty })),
    }, now);
    const refund = await requestRefund(tx as unknown as Db, actor, {
      kind: "invoice_refund", creditNoteId: credit.creditNoteId, amountPaise: credit.netPaise,
      reasonClass: input.reasonClass, reason: `pharmacy: ${reason}`,
    });

    await appendEvent(tx, dispenseCancelled.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, patientId: d.patientId, fromStatus: d.status, reason, reservationsReleased: released,
        creditNoteId: credit.creditNoteId, refundApprovalId: refund.approvalId,
      },
    }));
    return { creditNoteId: credit.creditNoteId, creditNoteNo: credit.creditNoteNo, refundApprovalId: refund.approvalId };
  });
  return { dispense: await getDispense(db, actor, d.id, now), ...result };
}
