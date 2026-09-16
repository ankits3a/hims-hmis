import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { issueCreditNote, requestRefund } from "../billing";
import { getBatch, itemsByIds, postMovement, returnedQtyByRef, uomsByItems } from "../materials";
import {
  RETURN_MIN_SHELF_DAYS, RETURN_REF_TYPE, RETURN_REFUSED_STORAGE, RETURN_WINDOW_DAYS, istDateOf,
} from "./config";
import { dispenseLineReturned } from "./events";
import { PharmacyError } from "./errors";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { DispenseView } from "./queue";

/**
 * ═══ PHARMACY P6 — A SALES RETURN AT THE COUNTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p6-sales-returns.md`. Doc 16 O-7 is
 * the standard Indian retail-pharmacy policy, and each clause is a refusal here:
 *   - within RETURN_WINDOW_DAYS of the hand-over (`return_window_closed`);
 *   - sealed and intact, attested by the registered pharmacist who inspects it (`return_not_sealed`);
 *   - whole issue packs, never a cut strip (`return_cut_strip`);
 *   - never a cold-chain, frozen or narcotic item (`return_not_accepted`);
 *   - a batch that can still go back on the shelf (`return_short_expiry`);
 *   - never more than was dispensed on the line, net of earlier returns (`return_exceeds_dispensed`).
 *
 * ONE TRANSACTION:
 *   - each pack goes back into the counter's store as a `return` ledger row naming the dispense
 *     line (`ref_type = pharmacy_return`), which is also how "already returned" is counted;
 *   - the invoice lines are credited for exactly the returned quantity (a `refund` credit note;
 *     billing pro-rates tax and discount);
 *   - the refund is REQUESTED, and billing's approval and the cashier's voucher pay it.
 *
 * The dispense stays `handed_over`: a return is partial by nature, and the event is its record.
 */
export type ReturnInput = {
  lines: { lineIdx: number; qtyBase: number }[];
  /** The pharmacist's attestation, typed as a literal true at the route: sealed and intact. */
  sealedIntact: boolean;
  reason: string;
  reasonClass: "mistake" | "genuine";
};
export type ReturnResult = { dispense: DispenseView; creditNoteId: string; creditNoteNo: string; refundApprovalId: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (isoDate: string): number => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);

export async function acceptReturn(
  db: Db, actor: Actor, _decls: readonly OrderKindDecl[], dispenseId: string, input: ReturnInput, now: Date,
): Promise<ReturnResult> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "handed_over" || d.handedOverAt === null || d.invoiceId === null) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}: only a handed-over dispense takes a return`, { status: d.status });
  }
  await requireRegisteredPharmacist(db, actor, now);
  for (const permission of ["billing.credit_note.issue", "billing.refund.request"] as const) {
    if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
      throw new PharmacyError("permission_denied", `a return raises a credit note and a refund request, which needs ${permission}`);
    }
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new PharmacyError("reason_required", "a return records why, for the refund approver");
  if (input.sealedIntact !== true) {
    throw new PharmacyError("return_not_sealed", "only a sealed, intact pack comes back on the shelf — inspect it and confirm");
  }
  const today = istDateOf(now);
  if (dayNumber(today) - dayNumber(istDateOf(d.handedOverAt)) > RETURN_WINDOW_DAYS) {
    throw new PharmacyError("return_window_closed", `returns are accepted within ${String(RETURN_WINDOW_DAYS)} days of the hand-over`, { handedOverAt: d.handedOverAt });
  }
  if (input.lines.length === 0) throw new PharmacyError("nothing_to_dispense", "name at least one line to return");

  const lines = await linesOf(db, dispenseId);
  const already = await returnedQtyByRef(db, RETURN_REF_TYPE, lines.map((l) => l.id));
  const itemIds = lines.map((l) => l.itemId).filter((x): x is string => x !== null);
  const [items, uoms] = await Promise.all([itemsByIds(db, itemIds), uomsByItems(db, itemIds)]);
  if (d.storeResourceId === null) throw new PharmacyError("store_missing", "the dispense names no store to return to");
  const storeId = d.storeResourceId;

  const plan: { lineId: string; lineIdx: number; qtyBase: number; batchId: string; invoiceLineId: string }[] = [];
  for (const want of input.lines) {
    const l = lines.find((x) => x.lineIdx === want.lineIdx);
    if (l === undefined || l.status !== "open" || l.qtyBase === null || l.batchId === null || l.itemId === null || l.invoiceLineId === null) {
      throw new PharmacyError("unknown_line", `line ${String(want.lineIdx + 1)} was not handed over`, { lineIdx: want.lineIdx });
    }
    if (!Number.isSafeInteger(want.qtyBase) || want.qtyBase <= 0) throw new PharmacyError("qty_required", `line ${String(want.lineIdx + 1)} needs a quantity`);
    const left = l.qtyBase - (already.get(l.id) ?? 0);
    if (want.qtyBase > left) {
      throw new PharmacyError("return_exceeds_dispensed", `line ${String(want.lineIdx + 1)}: ${String(left)} can still come back, not ${String(want.qtyBase)}`, { lineIdx: want.lineIdx, left });
    }
    const item = items.get(l.itemId);
    if (item !== undefined && (RETURN_REFUSED_STORAGE as readonly string[]).includes(item.storageClass)) {
      throw new PharmacyError("return_not_accepted", `${item.name} is ${item.storageClass}: its storage after it left the counter cannot be vouched for`, { lineIdx: want.lineIdx, storageClass: item.storageClass });
    }
    const pack = (uoms.get(l.itemId) ?? []).filter((u) => u.isIssueUom && u.toBaseMultiplier > 1).sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier)[0];
    if (pack !== undefined && want.qtyBase % pack.toBaseMultiplier !== 0) {
      throw new PharmacyError("return_cut_strip", `line ${String(want.lineIdx + 1)}: returns come back in whole ${pack.uom}s of ${String(pack.toBaseMultiplier)}`, { lineIdx: want.lineIdx, pack: pack.toBaseMultiplier });
    }
    const batch = await getBatch(db, l.batchId);
    if (batch === undefined) throw new PharmacyError("batch_not_saleable", `batch ${l.batchId} not found`);
    if (batch.recallStatus !== "none" || (batch.expiryDate !== null && dayNumber(batch.expiryDate) - dayNumber(today) < RETURN_MIN_SHELF_DAYS)) {
      throw new PharmacyError("return_short_expiry", `batch ${batch.batchNo} cannot go back on the shelf (expiry ${batch.expiryDate ?? "none"}, recall ${batch.recallStatus}) — quarantine it instead`, { lineIdx: want.lineIdx });
    }
    plan.push({ lineId: l.id, lineIdx: l.lineIdx, qtyBase: want.qtyBase, batchId: l.batchId, invoiceLineId: l.invoiceLineId });
  }
  const invoiceId = d.invoiceId;

  const result = await withTx(db, async (tx) => {
    const returned: { lineIdx: number; qtyBase: number; batchId: string; ledgerEntryId: string }[] = [];
    for (const p of plan) {
      const moved = await postMovement(tx, actor, {
        resourceId: storeId, batchId: p.batchId, qtyDelta: p.qtyBase, reason: "return",
        refType: RETURN_REF_TYPE, refId: p.lineId, patientId: d.patientId, encounterId: d.encounterId, occurredAt: now,
      });
      returned.push({ lineIdx: p.lineIdx, qtyBase: p.qtyBase, batchId: p.batchId, ledgerEntryId: moved.ledgerEntryId });
    }
    // Billing's own transactions are savepoints inside this one (the `bill.ts` cast).
    const credit = await issueCreditNote(tx as unknown as Db, actor, {
      kind: "refund", invoiceId, reason: `pharmacy return: ${reason}`,
      lines: plan.map((p) => ({ invoiceLineId: p.invoiceLineId, qty: p.qtyBase })),
    }, now);
    const refund = await requestRefund(tx as unknown as Db, actor, {
      kind: "invoice_refund", creditNoteId: credit.creditNoteId, amountPaise: credit.netPaise,
      reasonClass: input.reasonClass, reason: `pharmacy return: ${reason}`,
    });
    await appendEvent(tx, dispenseLineReturned.make({
      actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, patientId: d.patientId, lines: returned, sealedIntact: true, reason,
        reasonClass: input.reasonClass, creditNoteId: credit.creditNoteId, refundApprovalId: refund.approvalId,
      },
    }));
    return { creditNoteId: credit.creditNoteId, creditNoteNo: credit.creditNoteNo, refundApprovalId: refund.approvalId };
  });
  return { dispense: await getDispense(db, actor, d.id, now), ...result };
}
