import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { pharmacyCreditMoves, receipts } from "../../kernel/db/schema";
import { advanceOf, receiptUnallocatedPaise, releaseInvoiceSurplusOnTx } from "../billing";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ OWNER RULING 2026-10-02 — PHARMACY CREDIT ═══
 *
 * The owner asked whether a patient can use a credit note to buy other medicine and pay only the
 * difference, and ruled "use your recommendations":
 *
 *   1. the pharmacy counter MAY hold patient credit — an exception to "no ₹ balance at counter";
 *   2. keeping credit needs NO approval: no money leaves the hospital;
 *   3. what a smaller purchase leaves over STAYS as credit; taking it out as money is the ordinary
 *      approval-gated advance refund, at the billing office;
 *   4. it is spent at the pharmacy desk only (DECIDED: the narrowest reading; widening is a new ruling);
 *   5. it does not expire.
 *
 * THE MONEY IS BILLING'S. Keeping credit frees a credit note's surplus back onto the receipt it came
 * from (`releaseInvoiceSurplusOnTx`), where it is the patient's advance; using it is `issueInvoice`'s
 * `settleFromReceipts`. This file only keeps the pharmacy's BOOK of which unallocated money is credit
 * (`pharmacy_credit_moves`), so nothing else a receipt holds is ever spent here.
 *
 * THE BALANCE is, per receipt, `min(Σ kept − Σ used, what the receipt still has unallocated)`, summed,
 * and never more than the patient's advance — so an advance refund paid at the office lowers it too.
 */
export type CreditSource = { receiptId: string; receiptNo: string; availablePaise: number };
export type PharmacyCredit = { availablePaise: number; sources: CreditSource[] };

export async function pharmacyCreditOf(exec: Db | Tx, patientId: string): Promise<PharmacyCredit> {
  const moves = await exec.select().from(pharmacyCreditMoves).where(eq(pharmacyCreditMoves.patientId, patientId));
  if (moves.length === 0) return { availablePaise: 0, sources: [] };
  const book = new Map<string, number>();
  for (const m of moves) book.set(m.receiptId, (book.get(m.receiptId) ?? 0) + (m.kind === "kept" ? m.amountPaise : -m.amountPaise));
  const ids = [...book.entries()].filter(([, v]) => v > 0).map(([id]) => id).sort();
  if (ids.length === 0) return { availablePaise: 0, sources: [] };
  const numbers = new Map((await exec.select({ id: receipts.id, receiptNo: receipts.receiptNo }).from(receipts).where(inArray(receipts.id, ids))).map((r) => [r.id, r.receiptNo] as const));
  let cap = Math.max(0, await advanceOf(exec, patientId));
  const sources: CreditSource[] = [];
  for (const receiptId of ids) {
    const held = await receiptUnallocatedPaise(exec, receiptId);
    const availablePaise = Math.min(book.get(receiptId) ?? 0, held?.unallocatedPaise ?? 0, cap);
    if (availablePaise <= 0) continue;
    sources.push({ receiptId, receiptNo: numbers.get(receiptId) ?? "", availablePaise });
    cap -= availablePaise;
  }
  return { availablePaise: sources.reduce((s, x) => s + x.availablePaise, 0), sources };
}

/**
 * A return kept as credit: free the credit note's surplus and write it in the book. What was never
 * paid cannot be kept — a bill on the owner's credit frees nothing — so the answer is what WAS kept.
 */
export async function keepReturnAsCredit(
  tx: Tx, actor: Actor,
  args: { patientId: string; invoiceId: string; creditNoteId: string; amountPaise: number; dispenseId: string | null; reason: string; now: Date },
): Promise<number> {
  if (args.amountPaise <= 0) return 0;
  let released;
  try {
    released = await releaseInvoiceSurplusOnTx(tx, actor, { invoiceId: args.invoiceId, amountPaise: args.amountPaise, reason: args.reason }, args.now);
  } catch (e) {
    throw new PharmacyError("credit_not_available", "this bill has no paid money free to keep as credit — it was not paid in full, or a refund has already claimed it", { cause: e instanceof Error ? e.message : String(e) });
  }
  for (const m of released.moves) {
    await tx.insert(pharmacyCreditMoves).values({
      id: newId(), patientId: args.patientId, kind: "kept", amountPaise: m.amountPaise, receiptId: m.receiptId,
      invoiceId: args.invoiceId, creditNoteId: args.creditNoteId, dispenseId: args.dispenseId, actorId: actor.id, at: args.now,
    });
  }
  return released.releasedPaise;
}

/** The receipts a bill of `askPaise` draws its credit from, oldest first; refused when the book holds less. */
export async function planCreditUse(exec: Db | Tx, patientId: string, askPaise: number): Promise<{ receiptId: string; amountPaise: number }[]> {
  if (!Number.isSafeInteger(askPaise) || askPaise <= 0) return [];
  const credit = await pharmacyCreditOf(exec, patientId);
  if (askPaise > credit.availablePaise) {
    throw new PharmacyError("credit_not_available", `the patient holds ${String(credit.availablePaise)}p of pharmacy credit, not ${String(askPaise)}p`, { availablePaise: credit.availablePaise, askedPaise: askPaise });
  }
  const out: { receiptId: string; amountPaise: number }[] = [];
  let left = askPaise;
  for (const s of credit.sources) {
    if (left === 0) break;
    const take = Math.min(s.availablePaise, left);
    out.push({ receiptId: s.receiptId, amountPaise: take });
    left -= take;
  }
  return out;
}

export async function recordCreditUse(
  tx: Tx, actor: Actor, args: { patientId: string; invoiceId: string; dispenseId: string; plan: readonly { receiptId: string; amountPaise: number }[]; now: Date },
): Promise<void> {
  for (const p of args.plan) {
    await tx.insert(pharmacyCreditMoves).values({
      id: newId(), patientId: args.patientId, kind: "used", amountPaise: p.amountPaise, receiptId: p.receiptId,
      invoiceId: args.invoiceId, creditNoteId: null, dispenseId: args.dispenseId, actorId: actor.id, at: args.now,
    });
  }
}

/** What a bill settled from credit, for its paper and its closing line. */
export async function creditUsedOn(exec: Db | Tx, invoiceId: string): Promise<{ usedPaise: number; receiptIds: string[] }> {
  const rows = (await exec.select().from(pharmacyCreditMoves).where(eq(pharmacyCreditMoves.invoiceId, invoiceId))).filter((r) => r.kind === "used");
  return { usedPaise: rows.reduce((s, r) => s + r.amountPaise, 0), receiptIds: [...new Set(rows.map((r) => r.receiptId))] };
}
