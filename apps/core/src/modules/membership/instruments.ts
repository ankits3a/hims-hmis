import { assertPaise, percentAmount } from "../tariff";
import type { AdjustmentCandidate, InvoiceLineInput, PricingContext } from "../tariff";

/**
 * Plan 09 T2 — THE VALUE THE MONEY PATH IS ALLOWED TO SEE, and the arithmetic that turns one
 * benefit term into one `AdjustmentCandidate`.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL (DD2) ═══
 *
 * `AdjustmentSource.propose` is PURE and SYNCHRONOUS — `modules/tariff/types.ts` says so in its
 * own comment and `priceInvoiceLines` is documented as taking no clock and no I/O. A membership
 * or a coupon cannot therefore be *looked up* inside a source. DD2's ruling is that the lookup
 * happens once, BEFORE the transaction, in exactly the place `loadPricingContext` already runs,
 * and its result is a PLAIN VALUE that two source factories close over. `ResolvedInstruments` is
 * that value: it is the seam between T3 (which produces it from the database) and T4 (which
 * composes the two sources onto the pricing context billing already builds).
 *
 * Everything here is arithmetic over integer paise through the frozen tariff index
 * (`assertPaise`, `percentAmount`). **This module rounds nothing of its own** — a second rounding
 * authority inside the money path is the defect DD2 exists to make impossible.
 *
 * ═══ THERE IS EXACTLY ONE TIME AUTHORITY, AND IT IS `ctx.asOf` ═══
 *
 * `ResolvedInstruments` deliberately carries NO timestamp. O-2 evaluates a percentage benefit at
 * the money moment, and the money moment is already pinned once, by the impure loader, onto
 * `PricingContext.asOf` ("the resolution timestamp the impure loader used; the engine never reads
 * a clock"). A second `at` on this value would be a second authority on the same instant inside
 * the money path, which is precisely the shape O-2's reasoning refuses. T3's `resolveInstruments`
 * still takes an `at` — that is a query parameter, not a term of the arithmetic.
 *
 * ═══ NO CODE, NO RATE AND NO NAME IS FIXED HERE (DD3 / owner ruling O-9) ═══
 *
 * Every field below is a SHAPE. The plan codes, coupon codes, percentages, caps and card numbers
 * are configuration rows seeded at commissioning and are never constants in `apps/`. The golden
 * fixtures beside this file invent their own codes and their own people for the same reason.
 */

/**
 * Which lines a benefit term reaches. `null` means "every one" — an unscoped benefit — and is not
 * the same as `[]`, which reaches nothing. Both spellings are legal config and the difference is
 * load-bearing, so it is a nullable array rather than an optional one.
 */
export type BenefitScope = {
  serviceCategories: string[] | null;
  serviceIds: string[] | null;
};

/**
 * ONE benefit term, as `membership_plans.benefits` / `coupon_definitions.benefit` carry it.
 *
 * `capPaise` is the K3/B4 cap and it applies to the ASK — see `benefitCandidate` for the whole
 * argument, because that is the one rule in this file that a reader will otherwise get backwards.
 */
export type BenefitTerm = {
  /** The plan's own key for this benefit (a coupon's is its code). Becomes the candidate's `ruleKey`. */
  benefitKey: string;
  /** Human text carried onto the candidate's `reason` and shown at the counter. */
  title: string;
  kind: "percent_bps" | "flat_paise";
  /** bps for `percent_bps`, paise for `flat_paise`. Integer either way. */
  value: number;
  capPaise: number | null;
  scope: BenefitScope;
};

/**
 * ONE recognised membership instance, flattened to what pricing needs.
 *
 * `verified` is NOT here, and its absence is a ruling rather than an omission: O-1 says a
 * grace-honored instance is HONOURED at the counter and accrues nothing to the partner. Honouring
 * is this file's business; accrual is T6's. Putting `verified` in the money path would make a
 * verification lag look to a member exactly like a refusal, which is the outcome O-1 exists to
 * prevent.
 */
export type ResolvedMembership = {
  instanceId: string;
  planId: string;
  planTitle: string;
  cardCode: string;
  /** `membership_instances.status` — only `active` prices anything. */
  status: "active" | "expired" | "suspended" | "cancelled";
  validFrom: Date;
  validTo: Date;
  benefits: BenefitTerm[];
};

/** ONE presented coupon, flattened. The validity predicate over these columns is `coupon-rules.ts`. */
export type ResolvedCoupon = {
  couponId: string;
  code: string;
  title: string;
  /** Set when the coupon was bundled with an instance; null for a standalone coupon. */
  instanceId: string | null;
  benefit: BenefitTerm;
  minBillPaise: number;
  validFrom: Date;
  validTo: Date;
  /** bit 0 = Monday … bit 6 = Sunday; 127 = every day. */
  weekdayMask: number;
  /** Minutes from IST midnight, inclusive both ends. Null = all day. */
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  status: "active" | "retired";
};

/**
 * THE SEAM. T3 produces it; T4 hands it to the two factories in `sources.ts`; nothing else in the
 * money path may read the membership tables at all.
 */
export type ResolvedInstruments = {
  /** The patient the instruments were resolved for; null at a counter that has not identified one. */
  patientId: string | null;
  memberships: ResolvedMembership[];
  coupons: ResolvedCoupon[];
  /**
   * THE GROSS TOTAL OF THE DRAFT ABOUT TO BE PRICED — the sum of every line's `grossPaise` before
   * any adjustment. K4's minimum-BILL threshold is compared against this and never against a
   * post-discount base or a single line's gross, and it has to be carried here because `propose`
   * sees one line at a time and `PricingContext` has no notion of an invoice total.
   *
   * The COMPOSER owns this number (T4). It is deliberately not optional: a default would let a
   * caller that forgot it silently suppress every minimum-bill coupon in the hospital.
   */
  billGrossPaise: number;
};

/** Does a benefit term reach this line? Unknown service → no (the engine refuses the line itself). */
export function benefitCoversLine(scope: BenefitScope, ctx: PricingContext, line: InvoiceLineInput): boolean {
  const svc = ctx.services[line.serviceId];
  if (!svc) return false;
  if (scope.serviceIds !== null && !scope.serviceIds.includes(line.serviceId)) return false;
  if (scope.serviceCategories !== null && !scope.serviceCategories.includes(svc.category)) return false;
  return true;
}

/**
 * ONE benefit term → ONE `AdjustmentCandidate` on ONE line. Pure, synchronous, integer-only.
 *
 * ═══ THE CAP APPLIES TO THE ASK, AND AN OVER-CAP ASK IS REJECTED, NOT CLAMPED (B4, K3) ═══
 *
 * This is `manualDiscountSource`'s rule, transplanted deliberately rather than reinvented, and
 * both halves matter:
 *
 * (1) REJECTED, NEVER CLAMPED. If an over-cap ask were silently reduced to the cap, the cap would
 *     stop being a control and become a price: every miscofigured 90%-off coupon would quietly pay
 *     out its cap for ever and nothing in the audit record would say a limit had been hit. D-8's
 *     contract is that a rejected candidate carries THE AMOUNT THAT WAS ASKED, so the record shows
 *     what the instrument wanted and what the hospital refused.
 *
 * (2) THE OPERAND IS `raw`, NEVER `Math.min(raw, grossPaise)`. This is the half that is invisible
 *     until you try to write the mutant. `Math.min` is commutative, so "cap the ask then clamp to
 *     gross" and "clamp to gross then cap" are the SAME NUMBER — a clamping cap could not be
 *     tested at all. Under rejection they differ precisely when the ask exceeds both the cap and
 *     the line gross: the correct code refuses, the mutant accepts the gross. That is Book row B4
 *     and it is why the comparison reads `raw > capPaise` on the unclamped ask.
 *
 * The exact hit is NOT over cap: `>` and not `>=`. A coupon written "up to ₹150" pays ₹150 (K3).
 *
 * `assertPaise` guards the configured value the way `manualDiscountSource` guards a caller's:
 * these terms arrive from `jsonb` config columns, which no zod schema parses on the way out of the
 * database, so a fractional paise in a seeded catalog would otherwise flow straight into the
 * contest (M3).
 */
export function benefitCandidate(args: {
  sourceKey: string;
  term: BenefitTerm;
  grossPaise: number;
}): AdjustmentCandidate {
  const { sourceKey, term, grossPaise } = args;
  assertPaise(term.value, `benefit "${term.benefitKey}" value`);
  if (term.capPaise !== null) assertPaise(term.capPaise, `benefit "${term.benefitKey}" cap`);
  const raw = term.kind === "percent_bps" ? percentAmount(grossPaise, term.value) : term.value;
  const base: AdjustmentCandidate = {
    // B7: the candidate's `sourceKey` is the SOURCE's own key, passed in rather than spelled again
    // here — `runContest` indexes its precedence map by this string and falls back to
    // MAX_SAFE_INTEGER, so a mismatch sorts the candidate last on every tie and NOTHING fails.
    sourceKey,
    ruleKey: term.benefitKey,
    kind: term.kind,
    // Never a `DiscountCategory`: an instrument benefit is not charity, scheme, employee or
    // negotiated-corporate, and `ctx.manualCaps` must not reach it. Its cap is its own.
    discountCategory: null,
    amountPaise: Math.min(raw, grossPaise), // D2's contract: candidates are pre-capped at gross
    reason: term.title,
    requiresApproval: false,
    rejected: null,
  };
  if (term.capPaise !== null && raw > term.capPaise) {
    return {
      ...base,
      amountPaise: raw, // the ASK — the D-8 audit record, never the clamped amount
      rejected: { code: "over_cap", detail: `${raw}p exceeds the ${term.capPaise}p cap on "${term.benefitKey}"` },
    };
  }
  return base;
}
