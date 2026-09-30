import { roundTotalToRupee } from "../tariff";
import type { PricedLine } from "../tariff";

/**
 * ═══ OWNER RULING 2026-09-30 (money) — HOW A TOTAL IS ROUNDED IS THE INVOICE'S OWN, AND PERSISTED ═══
 *
 * `half_up` is §170 as it has stood since 2026-08-14: the whole rupee, halves up. Every OPD, lab,
 * radiology and front-desk invoice stays on it — it is the default, and nothing but an in-process
 * caller can ask for another (no HTTP body declares the field).
 *
 * The pharmacy's two, owner 2026-09-30: *"If patient is paying using cash then keep whole-rupee
 * rounding, round down. If paying via UPI or Card then we can collect to the paisa."* A medicine is
 * never sold above its printed MRP, and ₹33.60 collected as ₹34.00 was.
 *   · `down`  — the whole rupee, always DOWN (₹33.60 → ₹33.00; the rounding line reads −₹0.60).
 *   · `exact` — no rounding at all (₹33.60 → ₹33.60).
 *
 * The rule is stored on the invoice (`invoices.rounding_rule`) because a credit note against it must
 * round the same way: a `down` bill paid ₹33.00, and a credit note rounded half-up would free ₹34.00
 * for a refund the voucher guard then refuses as more than was received.
 */
export const ROUNDING_RULES = ["half_up", "down", "exact"] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];

/** A stored `rounding_rule`, read back. A value this code does not know is refused, never guessed. */
export function roundingRuleOf(stored: string): RoundingRule {
  const rule = ROUNDING_RULES.find((r) => r === stored);
  if (rule === undefined) throw new Error(`unknown rounding rule "${stored}"`);
  return rule;
}

export function roundTotalBy(rule: RoundingRule, totalPaise: number): { roundedPaise: number; roundingPaise: number } {
  if (rule === "half_up") return roundTotalToRupee(totalPaise);
  // `roundTotalToRupee` owns the paise guard; reuse it so the three rules refuse the same inputs.
  roundTotalToRupee(totalPaise);
  const roundedPaise = rule === "down" ? Math.floor(totalPaise / 100) * 100 : totalPaise;
  return { roundedPaise, roundingPaise: roundedPaise - totalPaise };
}

/** One GSTR-1 row: the invoice's lines folded by (sacCode, rateBps, exempt). */
export type TaxSummaryRow = {
  sacCode: string; rateBps: number; exempt: boolean;
  taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
};

export type InvoiceTotals = {
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number; // Σ of the line HEADS — never recomputed (§15.1/§15.2)
  taxableTurnoverPaise: number; exemptTurnoverPaise: number; // Rule 42/43 split, net of line discounts
  taxSummary: TaxSummaryRow[]; // grouped at the GSTR-1 grain, in first-appearance order
  rawTotalPaise: number; // Σ line netPaise
  netPayablePaise: number; roundingPaise: number; // §170: roundTotalBy(rule, rawTotal), applied ONCE
};

/**
 * Plan 08 D3. PURE and synchronous: every field is a fold over values the pricing engine already
 * computed. The invoice never re-derives a head from a summed base — three lines of taxable base
 * 18875 at 1200 bps carry heads of 1133 each (3399), where taxHead(56625, 1200) would post 3398
 * (§15.1). The only arithmetic this function performs on an invoice-level base is the single §170
 * rupee rounding of the raw total (§15.2, B-03).
 */
export function totalInvoice(lines: PricedLine[], roundingRule: RoundingRule = "half_up"): InvoiceTotals {
  let grossPaise = 0;
  let discountPaise = 0;
  let taxableBasePaise = 0;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let taxableTurnoverPaise = 0;
  let exemptTurnoverPaise = 0;
  let rawTotalPaise = 0;
  const groups = new Map<string, TaxSummaryRow>();

  for (const line of lines) {
    const { sacCode, rateBps, exempt } = line.gst;
    grossPaise += line.grossPaise;
    discountPaise += line.discountPaise;
    taxableBasePaise += line.taxableBasePaise;
    cgstPaise += line.gst.cgstPaise;
    sgstPaise += line.gst.sgstPaise;
    rawTotalPaise += line.netPaise;
    if (exempt) exemptTurnoverPaise += line.taxableBasePaise;
    else taxableTurnoverPaise += line.taxableBasePaise;

    // The exempt flag is part of the key: the same SAC and rate appear both taxed and exempt on one
    // invoice (category exemption, composite supply), and GSTR-1 reports them as separate rows.
    const key = `${sacCode}|${String(rateBps)}|${String(exempt)}`;
    const row = groups.get(key);
    if (row) {
      row.taxableBasePaise += line.taxableBasePaise;
      row.cgstPaise += line.gst.cgstPaise;
      row.sgstPaise += line.gst.sgstPaise;
    } else {
      groups.set(key, {
        sacCode, rateBps, exempt,
        taxableBasePaise: line.taxableBasePaise, cgstPaise: line.gst.cgstPaise, sgstPaise: line.gst.sgstPaise,
      });
    }
  }

  const { roundedPaise, roundingPaise } = roundTotalBy(roundingRule, rawTotalPaise);
  return {
    grossPaise, discountPaise, taxableBasePaise, cgstPaise, sgstPaise,
    taxableTurnoverPaise, exemptTurnoverPaise,
    taxSummary: [...groups.values()],
    rawTotalPaise, netPayablePaise: roundedPaise, roundingPaise,
  };
}
