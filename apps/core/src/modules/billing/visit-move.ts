import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { invoiceLines, invoices } from "../../kernel/db/schema";
import { feeServiceFor, FEE_LINE_ID } from "./charge-rules";
import { chargeRulesAt, loadBillingConfig } from "./config";
import { CREDIT_NOTE_ISSUE_PERMISSION, invoiceLineCredits, issueCreditNote } from "./credit-notes";
import { BillingError } from "./errors";
import { issueInvoice, previewInvoice } from "./invoices";
import { allocatedByInvoice, creditedByInvoice, enteredInErrorDocIds, releaseInvoiceSurplusOnTx } from "./receipts";
import type { Actor } from "@hmis/contracts";
import type { TenderInput } from "./cash-law";
import type { EncounterRow } from "../opd";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * OWNER 2026-10-05 — A MOVED VISIT TAKES ITS MONEY WITH IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The desk can move a visit to the right department (`opd/department-move.ts`). Until this file a
 * bill on the visit refused the move outright. The owner approved four rules ("yes go ahead" to the
 * proposal, 2026-10-05):
 *
 *   1. a ₹0 bill — the move corrects it itself and the new visit is billed as the fee rules say;
 *   2. a paid bill, and the new visit costs THE SAME — the payment moves to the new visit: the old
 *      invoice is corrected, the money goes back onto the receipts it came from and settles the new
 *      invoice in the same transaction. No refund, no new collection, the drawer is untouched;
 *   3. a paid bill and a DIFFERENT fee — billing settles the difference as part of the move:
 *        · LOWER: the excess stays as the patient's advance (the owner's 2026-10-02 ruling — a credit
 *          note's surplus is the patient's credit) and is refunded from Refunds if they want cash;
 *        · HIGHER: the difference is collected in the same act, from the acting cashier's drawer.
 *      Both need `billing.credit_note.issue` (DECIDED: the standard Indian corporate hospital
 *      practice — a fee difference is the billing counter's to settle, never the registration
 *      desk's), and the higher one needs that person's open cash session (`issueInvoice` enforces);
 *   4. the consult has begun — no desk move at all (OPD refuses before this file is reached).
 *
 * What this file NEVER does: edit an invoice (they are immutable; a `correction` credit note is the
 * only way one shrinks), hand money back across a counter (a refund keeps its own voucher ladder),
 * or re-bill anything but the consultation fee. A bill carrying other services, a bill on credit,
 * or a part-paid bill goes to the billing office — `billing_office` below — because what to do with
 * those lines is a billing decision, not a seating one.
 *
 * Every billing call below takes the OUTER transaction as its handle, so each nests as a savepoint:
 * the credit note, the release, the new invoice and the visit move commit together or not at all.
 */

export type MoveMoneyKind = "none" | "zero_bill" | "transfer" | "difference" | "billing_office";
export type BillingOfficeReason = "other_services" | "on_credit" | "part_paid" | "several_bills";

export type MoveMoneyPlan = {
  kind: MoveMoneyKind;
  /** The bill on the visit being moved, when there is one. */
  invoiceId: string | null;
  invoiceNo: string | null;
  /** Money received against that bill, which the move carries over. */
  paidPaise: number;
  /** What the consultation costs in the new department (0 when it is free there). */
  newFeePaise: number;
  /** newFee − paid: positive is collected, negative stays as the patient's advance. Zero otherwise. */
  differencePaise: number;
  /** Why the billing office has to handle it, on `billing_office`. */
  billingOfficeReason: BillingOfficeReason | null;
};

export type MoveMoneyResult = MoveMoneyPlan & {
  creditNoteNo: string | null;
  newInvoiceId: string | null;
  newInvoiceNo: string | null;
  /** What stayed with the patient as advance (rule 3, lower). */
  advancePaise: number;
  /** What was collected now (rule 3, higher). */
  collectedPaise: number;
};

type LiveBill = { id: string; invoiceNo: string; netPayablePaise: number; creditExtended: boolean; serviceIds: string[] };

/** The bills on a visit that still count: not entered-in-error and not already corrected away. */
async function liveBillsOf(exec: Db | Tx, encounterId: string): Promise<LiveBill[]> {
  const rows = await exec
    .select({ id: invoices.id, invoiceNo: invoices.invoiceNo, netPayablePaise: invoices.netPayablePaise, creditExtended: invoices.creditExtended })
    .from(invoices)
    .where(eq(invoices.encounterId, encounterId))
    .orderBy(asc(invoices.issuedAt));
  if (rows.length === 0) return [];
  const dead = await enteredInErrorDocIds(exec, "invoice", rows.map((r) => r.id));
  const out: LiveBill[] = [];
  for (const row of rows) {
    if (dead.has(row.id)) continue;
    const lines = await exec.select({ id: invoiceLines.id, serviceId: invoiceLines.serviceId }).from(invoiceLines).where(eq(invoiceLines.invoiceId, row.id));
    const credits = await invoiceLineCredits(exec, lines.map((l) => l.id));
    // A ₹0 bill has nothing to subtract, so "still counts" is asked of its LINES: any line not yet credited in full.
    const open = lines.filter((l) => { const c = credits.get(l.id); return c === undefined || c.creditedQty < c.qty; });
    if (open.length === 0) continue;
    out.push({ ...row, serviceIds: lines.map((l) => l.serviceId) });
  }
  return out;
}

/** The consultation services — the only lines a move re-bills by itself. */
async function consultServiceIds(exec: Db | Tx): Promise<Set<string>> {
  const cfg = await loadBillingConfig(exec as unknown as Db);
  const c = cfg.chargeRules.opdConsult;
  return new Set([c.new, c.renewal, ...(c.revisit === undefined ? [] : [c.revisit])]);
}

/**
 * What the consultation costs a visit of this type in the new department, priced exactly as the
 * counter would price it (`previewInvoice`, the quote's own core). The OLD encounter is the pricing
 * context: same patient, same payer, same partner slip — only the visit type differs.
 */
export async function newConsultFeePaise(
  exec: Db | Tx, from: EncounterRow, toVisitType: string, now: Date,
): Promise<number> {
  const db = exec as unknown as Db;
  const cfg = await loadBillingConfig(db);
  const rules = await chargeRulesAt(db, cfg.chargeRules, now);
  const serviceId = feeServiceFor({ ...from, visitType: toVisitType, openedAt: now }, rules);
  if (serviceId === null) return 0;
  const priced = await previewInvoice(db, {
    encounterId: from.id,
    lines: [{ lineId: FEE_LINE_ID, serviceId, qty: 1 }],
    ...(from.attributionCode === null ? {} : { attributionCode: from.attributionCode }),
  }, now);
  return priced.totals.netPayablePaise;
}

/** Which of the four rules a move falls under — read-only, for the preview and the act alike. */
export async function moveMoneyPlan(exec: Db | Tx, fromEncounterId: string, newFeePaise: number): Promise<MoveMoneyPlan> {
  const bills = await liveBillsOf(exec, fromEncounterId);
  const base = { invoiceId: null, invoiceNo: null, paidPaise: 0, newFeePaise, differencePaise: 0, billingOfficeReason: null };
  if (bills.length === 0) return { kind: "none", ...base };
  const first = bills[0]!;
  const office = (reason: BillingOfficeReason): MoveMoneyPlan => ({
    ...base, kind: "billing_office", invoiceId: first.id, invoiceNo: first.invoiceNo, billingOfficeReason: reason,
  });
  if (bills.length > 1) return office("several_bills");
  const consult = await consultServiceIds(exec);
  if (first.serviceIds.some((s) => !consult.has(s))) return office("other_services");
  if (first.creditExtended) return office("on_credit");

  const credited = (await creditedByInvoice(exec, [first.id])).get(first.id) ?? 0;
  const owed = first.netPayablePaise - credited;
  const paid = (await allocatedByInvoice(exec, [first.id])).get(first.id) ?? 0;
  const named = { invoiceId: first.id, invoiceNo: first.invoiceNo };
  if (owed <= 0 && paid <= 0) return { ...base, ...named, kind: "zero_bill" };
  if (paid < owed) return office("part_paid");
  if (paid === newFeePaise) return { ...base, ...named, kind: "transfer", paidPaise: paid };
  return { ...base, ...named, kind: "difference", paidPaise: paid, differencePaise: newFeePaise - paid };
}

/** May this person settle a fee difference as part of a move (rule 3)? */
export async function maySettleMoveDifference(exec: Db | Tx, actor: Actor): Promise<boolean> {
  return actor.type === "user" && hasPermission(exec as unknown as Db, actor.id, CREDIT_NOTE_ISSUE_PERMISSION, "hospital");
}

/**
 * The money half of a move, inside the move's own transaction, AFTER the new visit is open. The plan
 * is recomputed here from the new visit's real fee quote, so a preview that went stale while the
 * clerk typed the reason can never move money the way the screen did not say.
 */
export async function carryMoneyToMovedVisit(
  tx: Tx,
  actor: Actor,
  input: {
    from: EncounterRow;
    to: EncounterRow;
    reason: string;
    /** Rule 3, higher fee: what the patient hands over now for the difference. */
    tenders?: TenderInput[];
  },
  now: Date = new Date(),
): Promise<MoveMoneyResult> {
  const db = tx as unknown as Db;
  const newFee = await newConsultFeePaise(tx, input.from, input.to.visitType, now);
  const plan = await moveMoneyPlan(tx, input.from.id, newFee);
  const result: MoveMoneyResult = {
    ...plan, creditNoteNo: null, newInvoiceId: null, newInvoiceNo: null, advancePaise: 0, collectedPaise: 0,
  };
  if (plan.kind === "none") return result;
  if (plan.kind === "billing_office") {
    throw new BillingError("move_needs_billing_office", billingOfficeMessage(plan), {
      invoiceId: plan.invoiceId, invoiceNo: plan.invoiceNo, reason: plan.billingOfficeReason,
    });
  }
  if (plan.kind === "difference" && !(await maySettleMoveDifference(tx, actor))) {
    throw new BillingError(
      "move_fee_differs",
      `the consultation costs ${rupees(plan.newFeePaise)} in the new department and ${rupees(plan.paidPaise)} was paid — the billing counter settles the difference as part of the move`,
      { invoiceNo: plan.invoiceNo, paidPaise: plan.paidPaise, newFeePaise: plan.newFeePaise, differencePaise: plan.differencePaise },
    );
  }
  const collect = plan.kind === "difference" && plan.differencePaise > 0 ? plan.differencePaise : 0;
  const tendered = (input.tenders ?? []).reduce((a, t) => a + t.amountPaise, 0);
  if (collect > 0 && tendered !== collect) {
    throw new BillingError(
      "move_difference_unpaid",
      `${rupees(collect)} more is due in the new department — take it as part of the move`,
      { differencePaise: collect, tenderedPaise: tendered },
    );
  }
  if (collect === 0 && tendered > 0) {
    throw new BillingError("move_difference_unpaid", "nothing more is due for this move — take no money", { tenderedPaise: tendered });
  }

  const why = `moved to another department — ${input.reason}`;
  // 1. the old bill is corrected away (the only way an invoice shrinks).
  const note = await issueCreditNote(db, actor, { kind: "correction", invoiceId: plan.invoiceId!, reason: why }, now);
  result.creditNoteNo = note.creditNoteNo;

  // 2. the money on it goes back onto the receipts it came from — the patient's advance, for a moment.
  let moves: { receiptId: string; amountPaise: number }[] = [];
  if (plan.paidPaise > 0) {
    moves = (await releaseInvoiceSurplusOnTx(tx, actor, { invoiceId: plan.invoiceId!, amountPaise: plan.paidPaise, reason: why }, now)).moves;
  }

  // 3. the new visit is billed as the fee rules say, settled first from that money.
  if (plan.kind === "zero_bill" && newFee > 0) {
    // Nothing was paid, so nothing is carried: the new visit's fee is collected at the counter like any visit's.
    return result;
  }
  let need = newFee - collect;
  const settle: { receiptId: string; amountPaise: number }[] = [];
  for (const m of moves) {
    if (need === 0) break;
    const take = Math.min(m.amountPaise, need);
    settle.push({ receiptId: m.receiptId, amountPaise: take });
    need -= take;
  }
  const issued = await issueFeeInvoice(db, actor, input.to, settle, collect > 0 ? input.tenders : undefined, now);
  if (issued !== null) { result.newInvoiceId = issued.invoiceId; result.newInvoiceNo = issued.invoiceNo; }
  result.collectedPaise = collect;
  result.advancePaise = Math.max(0, plan.paidPaise - (newFee - collect));
  return result;
}

/** The new visit's consultation bill, priced by the fee rules exactly as the counter prices it. */
async function issueFeeInvoice(
  db: Db, actor: Actor, to: EncounterRow,
  settle: { receiptId: string; amountPaise: number }[], tenders: TenderInput[] | undefined, now: Date,
): Promise<{ invoiceId: string; invoiceNo: string } | null> {
  const cfg = await loadBillingConfig(db);
  const rules = await chargeRulesAt(db, cfg.chargeRules, now);
  // No fee service (a free revisit, or the consultation fee switched off): the visit carries no bill
  // at all, exactly as at the counter. A fee service priced at ₹0 (a member's free consult) does.
  const serviceId = feeServiceFor(to, rules);
  if (serviceId === null) return null;
  const issued = await issueInvoice(db, actor, {
    draftId: newId(),
    patientId: to.patientId,
    encounterId: to.id,
    lines: [{ lineId: FEE_LINE_ID, serviceId, qty: 1 }],
    ...(to.attributionCode === null ? {} : { attributionCode: to.attributionCode }),
    ...(settle.length === 0 ? {} : { settleFromReceipts: settle }),
    ...(tenders === undefined ? {} : { receipt: { tenders } }),
  }, now);
  return { invoiceId: issued.invoiceId, invoiceNo: issued.invoiceNo };
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function billingOfficeMessage(plan: MoveMoneyPlan): string {
  const no = plan.invoiceNo ?? "";
  switch (plan.billingOfficeReason) {
    case "other_services": return `bill ${no} carries more than the consultation — the billing office corrects it, then the patient is moved`;
    case "on_credit": return `bill ${no} is on credit — the billing office settles it, then the patient is moved`;
    case "part_paid": return `bill ${no} is only part paid — the billing office settles it, then the patient is moved`;
    default: return `this visit carries more than one bill — the billing office corrects them, then the patient is moved`;
  }
}
