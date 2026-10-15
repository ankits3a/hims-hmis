import { assertPaise, percentAmount } from "../tariff";
import { BillingError } from "./errors";
import type { AdjustmentCandidate, AdjustmentSource, InvoiceLineInput } from "../tariff";

/**
 * ═══ OWNER RULING 2026-09-30 (money) — A SALE-SIDE DISCOUNT ON A PHARMACY BILL ═══
 *
 * *"The pharmacist may give up to 10% off MRP on a bill, with a reason. Above 10% needs the pharmacy
 * in-charge's approval. Above 25% goes to the owner. A discount worth more than ₹25,000 on one bill
 * also goes to the owner."* WHO may give it is the pharmacy's to decide (`pharmacy/discount.ts`); this
 * file is only HOW it prices, and it prices through the contest every other benefit already uses.
 *
 * ═══ THE MEMBERSHIP MECHANISM, REUSED — NOT A SECOND DISCOUNT PATH ═══
 *
 * A member's percentage reaches a bill as ONE MORE `AdjustmentSource` appended to `ctx.sources`
 * (`composeBenefits`), and the engine does the rest: `runContest` takes the best single benefit per
 * line, and `pricing.ts` carves the GST out of the DISCOUNTED amount on a tax-inclusive line
 * (`inclusiveTaxHead(chargedPaise)`), so the taxable value and CGST/SGST fall with the price. This
 * source is the same shape: `discountCategory: null` (it is not charity, scheme, corporate or
 * employee, so `ctx.manualCaps` must not reach it), `requiresApproval: false` (the pharmacy checks its
 * approval before it calls billing, the way `billDispense` already carries the owner's credit grant).
 * It sorts LAST, so on an exact tie a benefit the patient bought wins the attribution.
 *
 * INTERNAL ONLY. No HTTP body declares `saleDiscount`; the zod bodies strip it. And it is admitted
 * only on a bill whose every line is `taxInclusive` — which `pricing.ts` itself admits only on a
 * `pharmacy*` category — so no OPD, lab or radiology bill can be discounted through it.
 */
export type SaleDiscountInput = { kind: "percent_bps" | "flat_paise"; value: number; reason: string };

export const SALE_DISCOUNT_SOURCE_KEY = "sale";

/** A bill's rounding or sale discount other than the default, refused on anything but a pharmacy bill. */
export function assertPharmacyOnly(lines: readonly InvoiceLineInput[], what: string): void {
  if (lines.length === 0 || lines.some((l) => l.taxInclusive !== true)) {
    throw new BillingError("pharmacy_bill_only", `${what} applies only to a pharmacy bill (every line priced at its MRP)`);
  }
}

/**
 * Each line's share of the discount. A percentage is taken off each line's own gross (half-up, the
 * `percentAmount` every other percentage benefit uses). A rupee amount is spread over the lines in
 * proportion to their gross, floored, with the leftover paise going one at a time to the largest
 * remainders (ties to the earlier line) — so the shares sum to the amount asked, exactly.
 */
export function saleDiscountShares(input: SaleDiscountInput, grossByLine: readonly { lineId: string; grossPaise: number }[]): Map<string, number> {
  assertPaise(input.value, "sale discount");
  if (input.reason.trim() === "") throw new BillingError("sale_discount_refused", "a discount needs a reason");
  const out = new Map<string, number>();
  if (input.kind === "percent_bps") {
    if (input.value > 10000) throw new BillingError("sale_discount_refused", "a discount cannot exceed 100%");
    for (const l of grossByLine) out.set(l.lineId, Math.min(percentAmount(l.grossPaise, input.value), l.grossPaise));
    return out;
  }
  const total = grossByLine.reduce((n, l) => n + l.grossPaise, 0);
  if (input.value > total) throw new BillingError("sale_discount_refused", `a discount of ${String(input.value)}p exceeds the ${String(total)}p bill`);
  if (total === 0) { for (const l of grossByLine) out.set(l.lineId, 0); return out; }
  let given = 0;
  const rema: { lineId: string; rem: number; idx: number }[] = [];
  grossByLine.forEach((l, idx) => {
    const exact = input.value * l.grossPaise;
    const share = Math.floor(exact / total);
    out.set(l.lineId, share);
    given += share;
    rema.push({ lineId: l.lineId, rem: exact % total, idx });
  });
  rema.sort((a, b) => (b.rem - a.rem) || (a.idx - b.idx));
  for (let i = 0; given < input.value; i += 1, given += 1) {
    const r = rema[i % rema.length]!;
    out.set(r.lineId, (out.get(r.lineId) ?? 0) + 1);
  }
  return out;
}

/** OWNER 2026-10-02 — the source key of an item's STANDING discount (`pharmacy_sale_items.discount_bps`). */
export const ITEM_DISCOUNT_SOURCE_KEY = "item";

/** Refuses a standing discount that is not a whole number of basis points between 0 and 100%. True when any line carries one. */
export function assertStandingDiscounts(lines: readonly InvoiceLineInput[]): boolean {
  let any = false;
  for (const l of lines) {
    const bps = l.standingDiscountBps;
    if (bps === undefined || bps === 0) continue;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) {
      throw new BillingError("sale_discount_refused", `a standing discount of ${String(bps)} bps is not between 0% and 100%`);
    }
    any = true;
  }
  return any;
}

/**
 * The standing discount as a contest candidate: the line's own share of its gross. It asks for no approval
 * here — whoever SET it on the sale item needed the authority — and it carries the fixed reason the bill and
 * the registers print. It competes with the counter's sale discount and a member's benefit; the largest wins.
 */
export function itemDiscountSource(): AdjustmentSource {
  return {
    key: ITEM_DISCOUNT_SOURCE_KEY,
    propose(_ctx, line, grossPaise): AdjustmentCandidate[] {
      const bps = line.standingDiscountBps ?? 0;
      if (bps <= 0) return [];
      const amount = Math.min(percentAmount(grossPaise, bps), grossPaise);
      if (amount <= 0) return [];
      return [{
        sourceKey: ITEM_DISCOUNT_SOURCE_KEY, ruleKey: null, kind: "percent_bps", discountCategory: null,
        amountPaise: amount, reason: "Standing discount on this medicine", requiresApproval: false, rejected: null,
      }];
    },
  };
}

export function saleDiscountSource(input: SaleDiscountInput, shares: ReadonlyMap<string, number>): AdjustmentSource {
  return {
    key: SALE_DISCOUNT_SOURCE_KEY,
    propose(_ctx, line, grossPaise): AdjustmentCandidate[] {
      const amount = Math.min(shares.get(line.lineId) ?? 0, grossPaise);
      if (amount <= 0) return [];
      return [{
        sourceKey: SALE_DISCOUNT_SOURCE_KEY, ruleKey: null, kind: input.kind, discountCategory: null,
        amountPaise: amount, reason: input.reason.trim(), requiresApproval: false, rejected: null,
      }];
    },
  };
}
