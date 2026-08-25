import { couponUnusableReason, membershipUsableAt } from "./coupon-rules";
import { benefitCandidate, benefitCoversLine } from "./instruments";
import type { ResolvedInstruments } from "./instruments";
import type { AdjustmentCandidate, AdjustmentSource } from "../tariff";

/**
 * Plan 09 T2 — THE TWO `AdjustmentSource` FACTORIES. This is the whole of DD2's integration.
 *
 * ═══ WHAT THE BILLING LAYER DOES WITH THEM, AND WHY `modules/tariff` IS BYTE-UNTOUCHED ═══
 *
 *     const base = await loadPricingContext(db, { at: now, tags });
 *     const ctx  = { ...base, sources: [...base.sources, membershipSource(r), couponSource(r)] };
 *
 * That is the entire change to the money path (T4 makes it, behind `MEMBER_BENEFITS_ENABLED`).
 * The spike measured it end to end before this file existed: both appended sources appeared in
 * `invoice_lines.candidates`, the largest won, and the taxable line's GST was computed on the
 * POST-discount base — so an appended source flows through the whole engine, not merely the
 * contest. No file under `apps/core/src/modules/tariff/` changes, which is what lets the freeze be
 * the whole directory (§3 Q3, DD2).
 *
 * ═══ THE ORDER `[rule, manual, membership, coupon]` IS A RULING, NOT AN ACCIDENT (DD2) ═══
 *
 * `runContest` sorts by amount first; the array position decides EXACT ties only. On a tie a
 * standing hospital rule (charity, scheme) beats a commercial instrument, and a membership — a
 * paid, durable relationship — beats a one-shot coupon. That is explainable to a member across a
 * counter, which is the test a tie-break rule has to pass. Book row B2 pins the direction.
 *
 * ═══ B7 — THE TRAP THE SPIKE FOUND, AND IT IS SILENT IN BOTH DIRECTIONS ═══
 *
 * `runContest` builds its precedence map as `ctx.sources.forEach((s, i) => order.set(s.key, i))`
 * and then looks each candidate up by **`candidate.sourceKey`**, falling back to
 * `Number.MAX_SAFE_INTEGER`. Two consequences, neither of which fails anywhere:
 *
 *   - two appended sources SHARING a `key` collapse into one precedence slot, so the DD2 order
 *     above stops existing and ties break by `ruleKey` instead;
 *   - a candidate whose `sourceKey` differs from its own source's `key` misses the map entirely
 *     and sorts LAST on every tie, silently losing contests the ruling says it wins.
 *
 * So the two keys below are distinct constants, each factory passes ITS OWN key into
 * `benefitCandidate` rather than spelling the string twice, and `sources.test.ts` asserts the
 * equality directly as well as through a tie it must win.
 *
 * ═══ PURE AND SYNCHRONOUS, AND ASSERTED RATHER THAN CLAIMED ═══
 *
 * `propose` reads only its three arguments and the plain value the factory closed over. No `await`,
 * no `async`, no `Date.now`, no `new Date`, no database import — `sources.test.ts` scans this
 * file's own text for every one of those tokens and runs both sources with `Date.now` stubbed to
 * throw. The instant always comes from `ctx.asOf`, the one time authority the engine already pins.
 */
export const MEMBERSHIP_SOURCE_KEY = "membership";
export const COUPON_SOURCE_KEY = "coupon";

/**
 * Every benefit term of every currently-usable membership that reaches this line, as candidates.
 *
 * ALL of them, not the best of them: picking a winner is `runContest`'s job and doing it here
 * would delete the losing candidates from `invoice_lines.candidates`, which is the D-8 audit
 * record a member can be shown at the counter. Never a SUM either — best-single-benefit is the
 * house rule (B1) and a source that added two terms together would stack benefits while the
 * contest happily reported one winner.
 */
export function membershipSource(resolved: ResolvedInstruments): AdjustmentSource {
  return {
    key: MEMBERSHIP_SOURCE_KEY,
    propose(ctx, line, grossPaise) {
      const out: AdjustmentCandidate[] = [];
      for (const instrument of resolved.memberships) {
        if (!membershipUsableAt(instrument, ctx.asOf)) continue;
        for (const term of instrument.benefits) {
          if (!benefitCoversLine(term.scope, ctx, line)) continue;
          out.push(benefitCandidate({ sourceKey: MEMBERSHIP_SOURCE_KEY, term, grossPaise }));
        }
      }
      return out;
    },
  };
}

/**
 * Every presented coupon that is usable at `ctx.asOf` and reaches this line, as candidates.
 *
 * A coupon that is retired, out of its date window, off its weekday, outside its time-of-day
 * window or under its minimum bill proposes NOTHING — see `couponUnusableReason` for why that is
 * not a rejected candidate. A coupon that IS usable but asks above its cap proposes a REJECTED
 * candidate carrying the ask, because that one refusal is the hospital declining money the
 * instrument asked for and it belongs in the audit record (B3).
 */
export function couponSource(resolved: ResolvedInstruments): AdjustmentSource {
  return {
    key: COUPON_SOURCE_KEY,
    propose(ctx, line, grossPaise) {
      const out: AdjustmentCandidate[] = [];
      for (const coupon of resolved.coupons) {
        const unusable = couponUnusableReason(coupon, {
          at: ctx.asOf,
          billGrossPaise: resolved.billGrossPaise,
        });
        if (unusable !== null) continue;
        if (!benefitCoversLine(coupon.benefit.scope, ctx, line)) continue;
        out.push(benefitCandidate({ sourceKey: COUPON_SOURCE_KEY, term: coupon.benefit, grossPaise }));
      }
      return out;
    },
  };
}
