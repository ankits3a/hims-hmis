/**
 * THE cross-module interface of the membership module (spec §4). Later modules import from here
 * or consume events — never internals; the module-isolation lint rule enforces it.
 *
 * Plan 09 fills this in task order: T2 exports the two `AdjustmentSource` factories and the pure
 * benefit resolver contract, T3 `resolveInstruments`, T4 the entitlement and redemption writers,
 * T5 the import lane. `billing` composes the sources at its own layer (DD2) and `partners` reads
 * nothing here at all — the graph is `billing → membership`, `partners → billing`, and it is
 * acyclic by construction (DD1).
 */
export { membershipManifest } from "./manifest";
export { MembershipModule } from "./membership.module";
export { MembershipError } from "./errors";
export type { MembershipErrorCode } from "./errors";
export * from "./events";

/**
 * T2 — the pure benefit surface. `billing` composes the two factories onto the pricing context it
 * already builds (DD2); nothing outside this module reads a membership table to price anything.
 *
 * `ResolvedInstruments` is the seam: T3's `resolveInstruments` produces it, these two factories
 * close over it, and T4 hands it across. `couponUnusableReason` is exported because the RECOGNITION
 * surface has to tell a member WHY a coupon did not apply, and the sources deliberately do not —
 * see its own comment.
 */
export { COUPON_SOURCE_KEY, couponSource, MEMBERSHIP_SOURCE_KEY, membershipSource } from "./sources";
export { benefitCandidate, benefitCoversLine } from "./instruments";
export type {
  BenefitScope, BenefitTerm, ResolvedCoupon, ResolvedInstruments, ResolvedMembership,
} from "./instruments";
export {
  couponUnusableReason, IST_OFFSET_MS, istDayIndex, istMinuteOfDay, istWeekdayMondayZero,
  membershipUsableAt,
} from "./coupon-rules";
export type { CouponUnusableReason } from "./coupon-rules";
