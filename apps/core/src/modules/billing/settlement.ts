export type SettlementState = "unpaid" | "partial" | "settled";
export type Settlement = { state: SettlementState; outstandingPaise: number };

/**
 * Plan 08 D1. PURE. Settlement is DERIVED, never stored — no status column exists on `invoices`, which
 * is what keeps the immutability triggers total. `credited` is Σ non-EIE credit-note nets against the
 * invoice and `allocated` is the effective allocation (Σ apply - Σ reverse); outstanding is floored at
 * zero, so an over-collection reads `settled` with nothing outstanding rather than a negative balance
 * (the surplus lives on the receipt as the change-due / advance lane, D2).
 * T6 adds the SQL readers that feed this function.
 */
export function settlementState(netPayablePaise: number, creditedPaise: number, allocatedPaise: number): Settlement {
  const coveredPaise = creditedPaise + allocatedPaise;
  const remainderPaise = netPayablePaise - coveredPaise;
  if (remainderPaise <= 0) return { state: "settled", outstandingPaise: 0 };
  return { state: coveredPaise > 0 ? "partial" : "unpaid", outstandingPaise: remainderPaise };
}
