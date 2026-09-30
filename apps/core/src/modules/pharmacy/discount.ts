import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import { SALE_DISCOUNT_SOURCE_KEY } from "../billing";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RoundingRule, SaleDiscountInput } from "../billing";

/**
 * ═══ OWNER RULINGS 2026-09-30 (money) — ROUNDING BY TENDER, AND THE SALE-SIDE DISCOUNT ═══
 *
 * Owner, 2026-09-30 (memory `owner-rulings-2026-09-30-pharmacy-money`):
 *
 * 1. *"If patient is paying using cash then keep whole-rupee rounding, round down. If paying via UPI or
 *    Card then we can collect to the paisa."* Never above MRP. A mixed tender that includes cash is cash.
 * 2. *"The pharmacist may give up to 10% off MRP on a bill, with a reason. Above 10% needs the pharmacy
 *    in-charge's approval. Above 25% goes to the owner. A discount worth more than ₹25,000 on one bill
 *    also goes to the owner."*
 *
 * Both apply to the desk's dispense bill AND the walk-in sale, and to nothing else: billing admits a
 * non-default rounding or a sale discount only on a bill whose every line is priced at its MRP.
 */

/** Ruling 1. Any cash → DOWN. Only UPI and card → to the paisa. No tender at all (the owner's credit) → DOWN (DECIDED: never above MRP, and the dues may be paid in cash). */
export function pharmacyRoundingRule(tenders: readonly { mode: string }[]): RoundingRule {
  if (tenders.length === 0 || tenders.some((t) => t.mode === "cash")) return "down";
  return "exact";
}

/** What the desk asks for: a % off MRP (basis points, 800 = 8%) or rupees off the bill (paise), with a reason. */
export type DiscountAsk = SaleDiscountInput;

export const PHARMACIST_DISCOUNT_MAX_BPS = 1000; // up to 10% inclusive: the pharmacist gives it
export const INCHARGE_DISCOUNT_MAX_BPS = 2500; // above 10%, up to 25% inclusive: the pharmacy in-charge
export const OWNER_DISCOUNT_ABOVE_PAISE = 2_500_000; // worth MORE than ₹25,000 on one bill: the owner, whatever the %

export type DiscountTier = "pharmacist" | "pharmacy_incharge" | "owner";

export const DISCOUNT_INCHARGE_APPROVAL_TYPE = "pharmacy_discount_incharge";
export const DISCOUNT_OWNER_APPROVAL_TYPE = "pharmacy_discount_owner";
export const DISCOUNT_APPROVAL_SUBJECT = "pharmacy_sale_discount";

export function approvalTypeFor(tier: Exclude<DiscountTier, "pharmacist">): string {
  return tier === "owner" ? DISCOUNT_OWNER_APPROVAL_TYPE : DISCOUNT_INCHARGE_APPROVAL_TYPE;
}

/**
 * Who gives it. The comparisons are EXACT (cross-multiplied, never a rounded percentage): 10.00% is the
 * pharmacist's, 10.01% is not; 25.00% is the in-charge's, 25.01% the owner's; ₹25,000.00 of discount is
 * not "more than ₹25,000", ₹25,000.01 is. A rupee discount is judged by its share of the bill's MRP total.
 */
export function discountTier(ask: Pick<DiscountAsk, "kind" | "value">, grossPaise: number, amountPaise: number): DiscountTier {
  if (amountPaise > OWNER_DISCOUNT_ABOVE_PAISE) return "owner";
  const atMost = (bps: number): boolean => ask.kind === "percent_bps" ? ask.value <= bps : ask.value * 10000 <= bps * grossPaise;
  if (atMost(PHARMACIST_DISCOUNT_MAX_BPS)) return "pharmacist";
  if (atMost(INCHARGE_DISCOUNT_MAX_BPS)) return "pharmacy_incharge";
  return "owner";
}

/** The part of a priced bill's discount that is the sale discount (a member's benefit that beat it on a line is not). */
export function saleDiscountPaise(lines: readonly { discountPaise: number; winner: { sourceKey: string } | null }[]): number {
  return lines.reduce((n, l) => n + (l.winner?.sourceKey === SALE_DISCOUNT_SOURCE_KEY ? l.discountPaise : 0), 0);
}

/**
 * The approval binds THE BILL and THE DISCOUNT: the subject is the draft (the dispense, or the walk-in
 * cart's own id) with the kind and value asked, and the amount is the rupees it takes off. A re-picked
 * basket, another percentage or another bill is another question.
 */
export function discountSubjectId(draftId: string, ask: Pick<DiscountAsk, "kind" | "value">): string {
  return `${draftId}:${ask.kind}:${String(ask.value)}`;
}

export type DiscountQuote = {
  kind: DiscountAsk["kind"]; value: number; amountPaise: number; tier: DiscountTier;
  /** Who must approve it: null when the pharmacist gives it. */
  approverRole: "pharmacy_incharge" | "owner" | null;
};

export function quoteDiscount(ask: DiscountAsk, grossPaise: number, amountPaise: number): DiscountQuote {
  const tier = discountTier(ask, grossPaise, amountPaise);
  return { kind: ask.kind, value: ask.value, amountPaise, tier, approverRole: tier === "pharmacist" ? null : tier };
}

/** Files the ask for THIS bill's discount with the tier's approver. The pharmacist's own tier needs none. */
export async function requestDiscountApproval(
  db: Db, actor: Actor,
  args: { draftId: string; patientId: string | null; ask: DiscountAsk; quote: DiscountQuote },
): Promise<{ approvalId: string; tier: DiscountTier; amountPaise: number }> {
  const { quote } = args;
  if (quote.tier === "pharmacist") {
    throw new PharmacyError("discount_not_bound", "a discount of up to 10% is the pharmacist's own — no approval is needed");
  }
  if (args.patientId === null) {
    throw new PharmacyError("discount_needs_customer", "name the customer first — an approval of money is filed against a patient");
  }
  if (quote.amountPaise <= 0) throw new PharmacyError("discount_not_bound", "this discount takes nothing off the bill");
  const pct = args.ask.kind === "percent_bps" ? `${(args.ask.value / 100).toFixed(2)}%` : `₹${(args.ask.value / 100).toFixed(2)}`;
  const filed = await withTx(db, (tx) => requestApproval(tx, actor, {
    typeKey: approvalTypeFor(quote.tier as Exclude<DiscountTier, "pharmacist">),
    subject: { type: DISCOUNT_APPROVAL_SUBJECT, id: discountSubjectId(args.draftId, args.ask) },
    patientId: args.patientId!,
    amountPaise: quote.amountPaise,
    requestNote: `${pct} off MRP — ${args.ask.reason.trim()}`,
  }));
  return { approvalId: filed.approvalId, tier: quote.tier, amountPaise: quote.amountPaise };
}

/**
 * Check-on-execute, the owner-credit shape (`assertGrantedApproval` in billing): the pharmacist's tier
 * passes; above it there must be a GRANTED approval of the tier's own type, bound to this draft, this
 * kind and value, this patient and this exact amount. The requester can never have granted it: the
 * kernel refuses a decision by the person who asked (`REQUESTER_APPROVER_PAIR`).
 */
export async function assertDiscountCovered(
  db: Db,
  args: { draftId: string; patientId: string | null; ask: DiscountAsk; quote: DiscountQuote; approvalId: string | undefined },
): Promise<void> {
  const { quote } = args;
  if (quote.tier === "pharmacist") return;
  const who = quote.tier === "owner" ? "the owner" : "the pharmacy in-charge";
  if (args.approvalId === undefined) {
    throw new PharmacyError("discount_approval_required", `this discount needs ${who}'s approval — ask, and bill when it is granted`, {
      tier: quote.tier, amountPaise: quote.amountPaise,
    });
  }
  const a = await getApproval(db, args.approvalId);
  if (a === null || a.status !== "granted") {
    throw new PharmacyError("discount_approval_required", `the approval for this discount is not granted (${a?.status ?? "not found"})`, {
      tier: quote.tier, status: a?.status ?? null,
    });
  }
  const bound = a.typeKey === approvalTypeFor(quote.tier)
    && a.subjectType === DISCOUNT_APPROVAL_SUBJECT
    && a.subjectId === discountSubjectId(args.draftId, args.ask)
    && a.patientId === args.patientId
    && a.amountPaise === quote.amountPaise;
  if (!bound) {
    throw new PharmacyError("discount_not_bound", "the approval does not cover this bill's discount — the basket or the discount changed; ask again", {
      expected: { typeKey: approvalTypeFor(quote.tier), subjectId: discountSubjectId(args.draftId, args.ask), amountPaise: quote.amountPaise },
      got: { typeKey: a.typeKey, subjectId: a.subjectId, amountPaise: a.amountPaise },
    });
  }
}

/** Where an ask stands — the desk polls this and bills the moment it reads `granted`. */
export async function discountRequestStatus(
  db: Db, approvalId: string,
): Promise<{ approvalId: string; status: string; amountPaise: number | null; tier: DiscountTier; decisionNote: string | null }> {
  const a = await getApproval(db, approvalId);
  if (a === null || (a.typeKey !== DISCOUNT_INCHARGE_APPROVAL_TYPE && a.typeKey !== DISCOUNT_OWNER_APPROVAL_TYPE)) {
    throw new PharmacyError("not_found", `no discount request ${approvalId}`);
  }
  return {
    approvalId, status: a.status, amountPaise: a.amountPaise,
    tier: a.typeKey === DISCOUNT_OWNER_APPROVAL_TYPE ? "owner" : "pharmacy_incharge", decisionNote: a.decisionNote ?? null,
  };
}

/** The reason the pharmacist gave for a sale discount, read back off the invoice's stored contest winner. */
export function saleDiscountReason(lines: readonly { winner: unknown }[]): string | null {
  for (const l of lines) {
    const w = l.winner as { sourceKey?: string; reason?: string } | null;
    if (w?.sourceKey === SALE_DISCOUNT_SOURCE_KEY && typeof w.reason === "string" && w.reason !== "") return w.reason;
  }
  return null;
}
