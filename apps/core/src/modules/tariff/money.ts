import { TariffError } from "./errors";

export function assertPaise(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TariffError("invalid_paise", `${what} must be a non-negative integer of paise, got ${String(n)}`);
  }
}

/** round(n/d) with halves rounded UP (away from zero). Integer-only; d > 0. 2n stays < 2^53 for all invoice-scale inputs. */
export function divHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(d) || d <= 0) {
    throw new TariffError("invalid_paise", `divHalfUp(${String(n)}, ${String(d)})`);
  }
  return Math.floor((2 * n + d) / (2 * d));
}

export function percentAmount(grossPaise: number, bps: number): number {
  return divHalfUp(grossPaise * bps, 10000);
}

export function taxHead(basePaise: number, rateBps: number): number {
  return divHalfUp(basePaise * rateBps, 20000);
}

export function roundTotalToRupee(totalPaise: number): { roundedPaise: number; roundingPaise: number } {
  assertPaise(totalPaise, "invoice total");
  const roundedPaise = divHalfUp(totalPaise, 100) * 100;
  return { roundedPaise, roundingPaise: roundedPaise - totalPaise };
}

/**
 * PHARMACY P1 (L1): one head of the GST CONTAINED in a tax-inclusive amount, rounded half-up.
 * `inclusive x rate / (2 x (10000 + rate))`. The taxable value is `inclusive - 2 x head`, so the two
 * halves are equal and the three parts sum to the inclusive amount exactly. For some amounts no
 * equal split lands exactly on `taxHead(taxable)`; the gap is then at most one paisa a head.
 */
export function inclusiveTaxHead(inclusivePaise: number, rateBps: number): number {
  return divHalfUp(inclusivePaise * rateBps, 2 * (10000 + rateBps));
}

/**
 * PHARMACY P1 (L2): a price notified BEFORE GST, on the inclusive basis. Floored: rounding may only
 * ever lower the lawful maximum a patient is charged.
 */
export function inclusiveOf(exclusivePaise: number, rateBps: number): number {
  assertPaise(exclusivePaise, "exclusive price");
  return Math.floor((exclusivePaise * (10000 + rateBps)) / 10000);
}

/**
 * "1250", "1250.5", "1,250.00", "1,00,000", "₹1250" → integer paise; null when the text is not a sum of rupees.
 * String arithmetic only — never `parseFloat(x) * 100`, which turns 0.29 into 28.999….
 */
export function rupeesTextToPaise(text: string): number | null {
  const trimmed = text.replace(/[₹\s]/g, "");
  // Grouping is checked BEFORE the commas go: "1,2,3" is not 123 (review #744). Plain digits, Western
  // (1,000,000) or Indian (10,00,000) grouping, then up to two decimals.
  const plain = /^\d+(\.\d{1,2})?$/;
  const western = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
  const indian = /^\d{1,2}(,\d{2})*,\d{3}(\.\d{1,2})?$/;
  if (!plain.test(trimmed) && !western.test(trimmed) && !indian.test(trimmed)) return null;
  const clean = trimmed.replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = "0", frac = ""] = clean.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
