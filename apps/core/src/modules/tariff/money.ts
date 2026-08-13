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
