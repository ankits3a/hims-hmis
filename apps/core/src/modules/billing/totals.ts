import { roundTotalToRupee } from "../tariff";
import type { PricedLine } from "../tariff";

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
  netPayablePaise: number; roundingPaise: number; // §170: roundTotalToRupee(rawTotal), applied ONCE
};

/**
 * Plan 08 D3. PURE and synchronous: every field is a fold over values the pricing engine already
 * computed. The invoice never re-derives a head from a summed base — three lines of taxable base
 * 18875 at 1200 bps carry heads of 1133 each (3399), where taxHead(56625, 1200) would post 3398
 * (§15.1). The only arithmetic this function performs on an invoice-level base is the single §170
 * rupee rounding of the raw total (§15.2, B-03).
 */
export function totalInvoice(lines: PricedLine[]): InvoiceTotals {
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

  const { roundedPaise, roundingPaise } = roundTotalToRupee(rawTotalPaise);
  return {
    grossPaise, discountPaise, taxableBasePaise, cgstPaise, sgstPaise,
    taxableTurnoverPaise, exemptTurnoverPaise,
    taxSummary: [...groups.values()],
    rawTotalPaise, netPayablePaise: roundedPaise, roundingPaise,
  };
}
