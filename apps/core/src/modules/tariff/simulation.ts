import { TariffError } from "./errors";
import { priceInvoiceLines } from "./pricing";
import type { InvoiceLineInput, PricedLine, PricingContext } from "./types";

export type ImpactLineDelta = { lineId: string; serviceId: string; currentNetPaise: number; draftNetPaise: number; deltaPaise: number };
export type ImpactTotals = {
  currentNetPaise: number; draftNetPaise: number; deltaPaise: number;
  currentTaxPaise: number; draftTaxPaise: number; taxDeltaPaise: number;
};
export type ImpactByService = { serviceId: string; currentNetPaise: number; draftNetPaise: number; deltaPaise: number };
export type ImpactReport = { lines: ImpactLineDelta[]; totals: ImpactTotals; byService: ImpactByService[] };

function taxPaise(line: PricedLine): number {
  return line.gst.cgstPaise + line.gst.sgstPaise;
}

// Aggregated by serviceId, sorted ascending — deterministic output (D6).
function aggregateByService(current: PricedLine[], draft: PricedLine[]): ImpactByService[] {
  const totals = new Map<string, { currentNetPaise: number; draftNetPaise: number }>();
  for (const line of current) {
    const entry = totals.get(line.serviceId) ?? { currentNetPaise: 0, draftNetPaise: 0 };
    entry.currentNetPaise += line.netPaise;
    totals.set(line.serviceId, entry);
  }
  for (const line of draft) {
    const entry = totals.get(line.serviceId) ?? { currentNetPaise: 0, draftNetPaise: 0 };
    entry.draftNetPaise += line.netPaise;
    totals.set(line.serviceId, entry);
  }
  return [...totals.entries()]
    .map(([serviceId, t]) => ({ serviceId, currentNetPaise: t.currentNetPaise, draftNetPaise: t.draftNetPaise, deltaPaise: t.draftNetPaise - t.currentNetPaise }))
    .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
}

/**
 * PURE + SYNCHRONOUS (§7, §18, D6): prices the same `lines` under both contexts and diffs the results.
 * Engine errors propagate as-is — a draft that cannot price the lines is a broken draft and the caller
 * must see which line (§11.11).
 */
export function simulateRevision(currentCtx: PricingContext, draftCtx: PricingContext, lines: InvoiceLineInput[]): ImpactReport {
  const current = priceInvoiceLines(currentCtx, lines);
  const draft = priceInvoiceLines(draftCtx, lines);

  const impactLines: ImpactLineDelta[] = current.map((c, i) => {
    const d = draft[i];
    // current and draft price the SAME `lines` array, so they are always the same length and order.
    if (!d) throw new TariffError("tariff_item_missing", `simulateRevision: draft produced ${draft.length} priced lines, expected ${current.length}`);
    return { lineId: c.lineId, serviceId: c.serviceId, currentNetPaise: c.netPaise, draftNetPaise: d.netPaise, deltaPaise: d.netPaise - c.netPaise };
  });

  const currentNetPaise = current.reduce((sum, l) => sum + l.netPaise, 0);
  const draftNetPaise = draft.reduce((sum, l) => sum + l.netPaise, 0);
  const currentTaxPaise = current.reduce((sum, l) => sum + taxPaise(l), 0);
  const draftTaxPaise = draft.reduce((sum, l) => sum + taxPaise(l), 0);

  const totals: ImpactTotals = {
    currentNetPaise, draftNetPaise, deltaPaise: draftNetPaise - currentNetPaise,
    currentTaxPaise, draftTaxPaise, taxDeltaPaise: draftTaxPaise - currentTaxPaise,
  };

  return { lines: impactLines, totals, byService: aggregateByService(current, draft) };
}
