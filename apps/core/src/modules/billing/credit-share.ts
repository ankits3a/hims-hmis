import { assertPaise, divHalfUp } from "../tariff";
import { BillingError } from "./errors";

/** The credit-relevant projection of a STORED invoice line — a credit note never re-prices (D4). */
export type CreditableLine = {
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number; qty: number;
};

/** The five money fields a single credit step takes off the line. */
export type CreditShare = {
  grossPaise: number; discountPaise: number; taxableBasePaise: number;
  cgstPaise: number; sgstPaise: number;
};

const MONEY_FIELDS = ["grossPaise", "discountPaise", "taxableBasePaise", "cgstPaise", "sgstPaise"] as const;

/**
 * Plan 08 D4. PURE. Pro-ration is CUMULATIVE: for a line of qty n on which qty p has already been
 * credited, a further credit of qty k takes, for each money field F,
 *   share = divHalfUp(F x (p + k), n) - divHalfUp(F x p, n)
 * so the remainder always lands on the last step and cumulative credits exhaust the line EXACTLY.
 * The naive per-refund share divHalfUp(F x k, n) leaks paise — 100 over three refunds pays 33 + 33 + 33
 * = 99 where this rule pays 33 + 34 + 33 = 100 (B-05). A flat_paise discount is a whole-line amount at
 * pricing and pro-rates here by qty like every other field.
 */
export function creditShare(orig: CreditableLine, prevQty: number, addQty: number): CreditShare {
  for (const field of MONEY_FIELDS) assertPaise(orig[field], `line ${field}`);
  // assertPaise doubles as the non-negative-safe-integer guard for the three quantities.
  assertPaise(orig.qty, "line qty");
  assertPaise(prevQty, "already-credited qty");
  assertPaise(addQty, "credited qty");
  if (prevQty + addQty > orig.qty) {
    throw new BillingError("credit_exceeds_line", `credit of ${String(addQty)} after ${String(prevQty)} exceeds line qty ${String(orig.qty)}`,
      { qty: orig.qty, prevQty, addQty });
  }
  const share = (field: number): number => divHalfUp(field * (prevQty + addQty), orig.qty) - divHalfUp(field * prevQty, orig.qty);
  return {
    grossPaise: share(orig.grossPaise), discountPaise: share(orig.discountPaise),
    taxableBasePaise: share(orig.taxableBasePaise), cgstPaise: share(orig.cgstPaise), sgstPaise: share(orig.sgstPaise),
  };
}
