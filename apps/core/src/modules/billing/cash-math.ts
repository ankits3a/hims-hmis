import { assertPaise } from "../tariff";
import { BillingError } from "./errors";

/**
 * Plan 08 D9. PURE — no kernel import, no await, no clock read, no randomness
 * (billing-purity.test.ts sweeps this file). Indian currency denominations, in paise: the only
 * keys `beginClose`'s counted-cash JSONB may carry (`{ "50000": 3, ... }`, paise-denomination
 * -> count). Ten notes/coins, Rs 2000 down to Re 1.
 */
export const CASH_DENOMINATIONS_PAISE = [200_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100] as const;
const KNOWN_DENOMINATIONS = new Set<number>(CASH_DENOMINATIONS_PAISE);

/**
 * Sigma denomination x count over the counted-cash JSONB (D9's `countedCashPaise`). Every key
 * must name a known Indian denomination in paise; every count must be a non-negative safe
 * integer -- `assertPaise` doubles as that guard here too, the credit-share.ts convention. An
 * empty object is a legal zero count, not an error. The running total is itself re-checked with
 * `assertPaise` before it is returned, so an overflow that no single entry would have caught
 * still cannot escape this function silently.
 */
export function sumDenominations(denominations: Record<string, number>): number {
  let total = 0;
  for (const [key, count] of Object.entries(denominations)) {
    const denomPaise = Number(key);
    if (!Number.isInteger(denomPaise) || !KNOWN_DENOMINATIONS.has(denomPaise)) {
      throw new BillingError("invalid_paise", `"${key}" is not a known cash denomination (paise)`);
    }
    assertPaise(count, `count for denomination ${key}`);
    total += denomPaise * count;
  }
  assertPaise(total, "denomination total");
  return total;
}

/**
 * D9's other fold: `expectedCashPaise = openingFloat + Sigma cash tenders - Sigma cash vouchers
 * paid`, in-session. The two sums are session-scoped SQL reads (sessions.ts, which reads receipts
 * and cash-paid vouchers for the session); this function is their pure combinator, so the
 * arithmetic itself stays kernel-free and grep-clean under the purity sweep.
 */
export function expectedCash(
  openingFloatPaise: number,
  cashTendersPaise: number,
  cashVouchersPaidPaise: number,
  changeGivenPaise = 0,
): number {
  assertPaise(openingFloatPaise, "opening float");
  assertPaise(cashTendersPaise, "cash tenders");
  assertPaise(cashVouchersPaidPaise, "cash vouchers paid");
  assertPaise(changeGivenPaise, "change given");
  /**
   * PLAN 07b T5 — CHANGE HANDED BACK LEAVES THE DRAWER, so it is subtracted exactly as a paid cash
   * voucher is. Its absence was a real money defect rather than a missing feature: the surplus was
   * recorded as a patient advance whether or not the cash was handed over, so a cashier who gave
   * change was short by that amount at close and carried a variance they did not cause.
   *
   * It DEFAULTS to zero so every existing caller and every row written before `0039` keeps its
   * current arithmetic — the column defaults to 0 for the same reason.
   */
  return openingFloatPaise + cashTendersPaise - cashVouchersPaidPaise - changeGivenPaise;
}
