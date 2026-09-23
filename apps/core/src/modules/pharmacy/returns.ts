import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { getInvoice, invoiceLineCredits, issueCreditNote, requestRefund } from "../billing";
import { getBatch, itemsByIds, postMovement, returnedQtyByRef, uomsByItems } from "../materials";
import {
  RETURN_MIN_SHELF_DAYS, RETURN_REF_TYPE, RETURN_REFUSED_STORAGE, RETURN_WINDOW_DAYS, istDateOf,
} from "./config";
import { dispenseLineReturned } from "./events";
import { PharmacyError } from "./errors";
import { gstCategoryMap, priceBatchLine } from "./bill";
import { residueLinesOf } from "./bill-rows";
import { requireRegisteredPharmacist } from "./pharmacists";
import { getDispense, getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
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

/** A line that left the counter and was billed: the only kind a return may name. */
export type ReturnableLine = { id: string; lineIdx: number; qtyBase: number; itemId: string; batchId: string; invoiceLineId: string };
export type ReturnPlanLine = {
  lineId: string; lineIdx: number; qtyBase: number; batchId: string; invoiceLineId: string;
  /** The loose-MRP ruling's pack-residue line to credit alongside, or null (see `residueCredits`). */
  residue: { invoiceLineId: string; qty: number } | null;
};
/** The sale a return is against: its invoice, and when it was priced (the regulation in force then). */
export type ReturnSale = { invoiceId: string; pricedAt: Date };
export type ReturnedLine = { lineIdx: number; qtyBase: number; batchId: string; ledgerEntryId: string };

/**
 * Who takes a pack back (P6-4): a registered pharmacist, holding the two billing strings the act
 * uses. P19b shares it.
 */
export async function requireReturnTaker(db: Db, actor: Actor, now: Date): Promise<void> {
  await requireRegisteredPharmacist(db, actor, now);
  for (const permission of ["billing.credit_note.issue", "billing.refund.request"] as const) {
    if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
      throw new PharmacyError("permission_denied", `a return raises a credit note and a refund request, which needs ${permission}`);
    }
  }
}

/** O-7's clauses about the act: the reason, the attestation, the window from when the pack left. */
export function judgeReturnAct(input: ReturnInput, leftAt: Date, now: Date): string {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new PharmacyError("reason_required", "a return records why, for the refund approver");
  if (input.sealedIntact !== true) {
    throw new PharmacyError("return_not_sealed", "only a sealed, intact pack comes back on the shelf — inspect it and confirm");
  }
  if (dayNumber(istDateOf(now)) - dayNumber(istDateOf(leftAt)) > RETURN_WINDOW_DAYS) {
    throw new PharmacyError("return_window_closed", `returns are accepted within ${String(RETURN_WINDOW_DAYS)} days of the hand-over`, { handedOverAt: leftAt });
  }
  if (input.lines.length === 0) throw new PharmacyError("nothing_to_dispense", "name at least one line to return");
  return reason;
}

/**
 * O-7's clauses about each line: named, not more than is left after earlier returns (counted from the
 * ledger rows of `refType`), not a refused storage class, whole packs, and a batch that can go back
 * on the shelf.
 */
export async function judgeReturnLines(
  db: Db, lines: readonly ReturnableLine[], wanted: ReturnInput["lines"], refType: string, now: Date, sale: ReturnSale,
): Promise<ReturnPlanLine[]> {
  const today = istDateOf(now);
  const already = await returnedQtyByRef(db, refType, lines.map((l) => l.id));
  const itemIds = lines.map((l) => l.itemId);
  const [items, uoms] = await Promise.all([itemsByIds(db, itemIds), uomsByItems(db, itemIds)]);
  const plan: ReturnPlanLine[] = [];
  for (const want of wanted) {
    const l = lines.find((x) => x.lineIdx === want.lineIdx);
    if (l === undefined) {
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
    plan.push({ lineId: l.id, lineIdx: l.lineIdx, qtyBase: want.qtyBase, batchId: l.batchId, invoiceLineId: l.invoiceLineId, residue: null });
  }
  return residueCredits(db, lines, plan, already, sale);
}

/**
 * ═══ THE LOOSE-MRP RULING, ON THE WAY BACK (owner, money, 2026-09-22) ═══
 *
 * A sale line whose full pack does not divide (₹35.50 / 15) was billed as a MAIN line at the loose
 * rate plus a PACK-RESIDUE line right after it (`priceBatchLine`: 20 tablets = 20 × 236 + 1 × 10).
 * Crediting only the main line on a return would keep the residue of a strip the patient gave back,
 * and what they kept would then have cost MORE than its share of the MRP. So the residue line is
 * credited down to what the RETAINED quantity owes: re-priced at the sale's own date, the kept
 * units' residue is what stays billed, and the difference is credited with the return.
 *
 * The residue line is the invoice line immediately after the main one that is no sale line's own
 * (`invoiceInputsOf` put it there; the invoice is immutable).
 */
async function residueCredits(
  db: Db, lines: readonly ReturnableLine[], plan: ReturnPlanLine[], already: Map<string, number>, sale: ReturnSale,
): Promise<ReturnPlanLine[]> {
  if (plan.length === 0) return plan;
  const invoice = await getInvoice(db, sale.invoiceId);
  if (invoice === null) return plan;
  const residueOf = residueLinesOf(invoice.lines, new Set(lines.map((l) => l.invoiceLineId)));
  if (residueOf.size === 0) return plan;
  const credited = await invoiceLineCredits(db, [...residueOf.values()].map((r) => r.id));
  const gst = await gstCategoryMap(db);
  const out: ReturnPlanLine[] = [];
  const returningNow = new Map<string, number>();
  for (const p of plan) returningNow.set(p.lineId, (returningNow.get(p.lineId) ?? 0) + p.qtyBase);
  const done = new Set<string>(); // a line named twice in one return has its residue credited once
  for (const p of plan) {
    const residue = residueOf.get(p.invoiceLineId);
    const l = lines.find((x) => x.id === p.lineId);
    if (residue === undefined || l === undefined || done.has(l.id)) { out.push(p); continue; }
    done.add(l.id);
    const remaining = residue.qty - (credited.get(residue.id)?.creditedQty ?? 0);
    const retained = l.qtyBase - (already.get(l.id) ?? 0) - (returningNow.get(l.id) ?? 0);
    let owed = remaining; // if the kept units cannot be re-priced, keep the residue billed rather than guess
    if (retained <= 0) {
      owed = 0;
    } else {
      try {
        const kept = await priceBatchLine(db, gst, { itemId: l.itemId, batchId: l.batchId, qtyBase: retained }, sale.pricedAt);
        const keptResidue = kept.residual;
        if (keptResidue === null) owed = 0;
        else if (keptResidue.batchUnitPaise === residue.unitPaise) owed = keptResidue.qty;
      } catch (e) {
        if (!(e instanceof PharmacyError)) throw e;
      }
    }
    const qty = remaining - owed;
    out.push(qty > 0 ? { ...p, residue: { invoiceLineId: residue.id, qty } } : p);
  }
  return out;
}

/**
 * P6-2 and P6-3, inside the caller's transaction: each pack back into `storeId` as a `return` row of
 * `refType` naming its line, one `refund` credit note for exactly those quantities, and the refund
 * requested.
 */
export async function restockAndRefund(
  tx: Tx, actor: Actor,
  args: {
    storeId: string; refType: string; patientId: string; encounterId: string | null; invoiceId: string;
    plan: readonly ReturnPlanLine[]; reason: string; reasonClass: ReturnInput["reasonClass"]; now: Date;
  },
): Promise<{ returned: ReturnedLine[]; creditNoteId: string; creditNoteNo: string; refundApprovalId: string }> {
  const { plan, now } = args;
  const returned: ReturnedLine[] = [];
  for (const p of plan) {
    const moved = await postMovement(tx, actor, {
      resourceId: args.storeId, batchId: p.batchId, qtyDelta: p.qtyBase, reason: "return",
      refType: args.refType, refId: p.lineId, patientId: args.patientId, encounterId: args.encounterId, occurredAt: now,
    });
    returned.push({ lineIdx: p.lineIdx, qtyBase: p.qtyBase, batchId: p.batchId, ledgerEntryId: moved.ledgerEntryId });
  }
  // Billing's own transactions are savepoints inside this one (the `bill.ts` cast).
  const credit = await issueCreditNote(tx as unknown as Db, actor, {
    kind: "refund", invoiceId: args.invoiceId, reason: `pharmacy return: ${args.reason}`,
    lines: plan.flatMap((p) => [
      { invoiceLineId: p.invoiceLineId, qty: p.qtyBase },
      ...(p.residue === null ? [] : [{ invoiceLineId: p.residue.invoiceLineId, qty: p.residue.qty }]),
    ]),
  }, now);
  const refund = await requestRefund(tx as unknown as Db, actor, {
    kind: "invoice_refund", creditNoteId: credit.creditNoteId, amountPaise: credit.netPaise,
    reasonClass: args.reasonClass, reason: `pharmacy return: ${args.reason}`,
  });
  return { returned, creditNoteId: credit.creditNoteId, creditNoteNo: credit.creditNoteNo, refundApprovalId: refund.approvalId };
}

export async function acceptReturn(
  db: Db, actor: Actor, _decls: readonly OrderKindDecl[], dispenseId: string, input: ReturnInput, now: Date,
): Promise<ReturnResult> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "handed_over" || d.handedOverAt === null || d.invoiceId === null) {
    throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}: only a handed-over dispense takes a return`, { status: d.status });
  }
  await requireReturnTaker(db, actor, now);
  const reason = judgeReturnAct(input, d.handedOverAt, now);
  if (d.storeResourceId === null) throw new PharmacyError("store_missing", "the dispense names no store to return to");
  const storeId = d.storeResourceId;
  const returnable: ReturnableLine[] = [];
  for (const l of await linesOf(db, dispenseId)) {
    if (l.status !== "open" || l.qtyBase === null || l.batchId === null || l.itemId === null || l.invoiceLineId === null) continue;
    returnable.push({ id: l.id, lineIdx: l.lineIdx, qtyBase: l.qtyBase, itemId: l.itemId, batchId: l.batchId, invoiceLineId: l.invoiceLineId });
  }
  const invoiceId = d.invoiceId;
  const plan = await judgeReturnLines(db, returnable, input.lines, RETURN_REF_TYPE, now, { invoiceId, pricedAt: d.billedAt ?? d.handedOverAt });

  const result = await withTx(db, async (tx) => {
    const done = await restockAndRefund(tx, actor, {
      storeId, refType: RETURN_REF_TYPE, patientId: d.patientId, encounterId: d.encounterId, invoiceId, plan,
      reason, reasonClass: input.reasonClass, now,
    });
    await appendEvent(tx, dispenseLineReturned.make({
      occurredAt: now, actor, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
      payload: {
        dispenseId: d.id, patientId: d.patientId, lines: done.returned, sealedIntact: true, reason,
        reasonClass: input.reasonClass, creditNoteId: done.creditNoteId, refundApprovalId: done.refundApprovalId,
      },
    }));
    return { creditNoteId: done.creditNoteId, creditNoteNo: done.creditNoteNo, refundApprovalId: done.refundApprovalId };
  });
  return { dispense: await getDispense(db, actor, d.id, now), ...result };
}
