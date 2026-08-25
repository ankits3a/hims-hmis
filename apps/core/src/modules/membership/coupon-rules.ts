import type { ResolvedCoupon, ResolvedMembership } from "./instruments";

/**
 * Plan 09 T2 — THE VALIDITY PREDICATES, and the module's own IST clock.
 *
 * Everything here is a PURE function of an instant and a configured window. There is no clock read
 * (`Date.now`), no `new Date`, no `Intl` and no process timezone: the instant always arrives as an
 * argument, which is what lets `AdjustmentSource.propose` stay synchronous and deterministic and
 * what lets the golden fixtures beside this file pin a boundary to the SECOND.
 *
 * ═══ THE IST ARITHMETIC IS DUPLICATED HERE ON PURPOSE ═══
 *
 * `modules/opd/time.ts` and `modules/billing/time.ts` each carry their own copy of exactly this
 * offset arithmetic, and `billing/time.ts` says why in its own header: cross-module internals are
 * not importable (spec §4 — only a module's `index.ts` is), and neither an OPD session nor a
 * fiscal year is a coupon concept. This is the third copy and it is deliberate, recorded rather
 * than left for a reader to find. IST is UTC+05:30, fixed, no DST — the hospital clock.
 *
 * ═══ WHY A COUPON'S DAY BOUNDARY IS NOT `at <= validTo` ═══
 *
 * A card, a coupon and a membership all expire on a DATE that a human reads off a printed card,
 * and the hospital's date is the IST one. `valid_to` is stored as an instant, so the predicate
 * compares IST CALENDAR DAYS: an instrument is live through the end of the IST day its `valid_to`
 * falls on. Comparing the raw instants instead would expire a card stamped "30 Sep" at 05:30 IST
 * that morning if the row happened to be written as midnight UTC — an off-by-one-day refusal at a
 * counter, in the member's face, for a card that is plainly still valid. That is Book row B6.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Whole IST days since the epoch. Two instants on the same IST calendar day share this number. */
export function istDayIndex(at: Date): number {
  return Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/**
 * Minutes elapsed since IST midnight, 0…1439. `Math.floor` means the whole of minute 719 —
 * 11:59:00.000 through 11:59:59.999 IST — is minute 719, which is what makes an inclusive window
 * end "close at its stated second" (B5).
 */
export function istMinuteOfDay(at: Date): number {
  const ms = at.getTime() + IST_OFFSET_MS;
  return Math.floor((((ms % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS);
}

/**
 * 0 = Monday … 6 = Sunday for the IST calendar day of an instant — the spelling
 * `coupon_definitions.weekday_mask` is documented in (bit 0 = Monday). Epoch day 0 is a Thursday,
 * hence the +3; the outer `+ 7` keeps pre-epoch instants non-negative rather than assuming none
 * exist.
 */
export function istWeekdayMondayZero(at: Date): number {
  return (((istDayIndex(at) + 3) % 7) + 7) % 7;
}

/** Is `dayIndex` inside `[from, to]`, both ends being IST calendar days? */
function withinIstDays(from: Date, to: Date, at: Date): boolean {
  const day = istDayIndex(at);
  return istDayIndex(from) <= day && day <= istDayIndex(to);
}

/**
 * O-2 — a membership prices something only while it is ACTIVE and inside its own IST day window.
 *
 * `suspended` and `cancelled` price nothing; `expired` is the same answer arrived at twice, and
 * both legs are kept because the status column and the dates are maintained by different writers
 * (the import lane sets one, the counter sets the other) and neither is allowed to be the only
 * guard.
 */
export function membershipUsableAt(instrument: ResolvedMembership, at: Date): boolean {
  if (instrument.status !== "active") return false;
  return withinIstDays(instrument.validFrom, instrument.validTo, at);
}

/**
 * Why a coupon does not apply, or `null` when it does.
 *
 * A REASON RATHER THAN A BOOLEAN because each of these is a different sentence at the counter and
 * `MembershipErrorCode` already carries four of them (`coupon_expired`, `coupon_not_yet_valid`,
 * `coupon_out_of_window`, `coupon_min_bill_not_met`). T3 maps this to the refusal it shows; the
 * SOURCE maps every one of them to "propose nothing", because a coupon that does not apply is not
 * a rejected candidate — `AdjustmentCandidate.rejected` is a CLOSED union in the frozen
 * `modules/tariff/types.ts` (`over_cap` | `unknown_category`) and neither member means "out of
 * hours". Recorded here so the next reader does not go looking for the missing audit row.
 */
export type CouponUnusableReason =
  | "retired"
  | "not_yet_valid"
  | "expired"
  | "off_weekday"
  | "outside_window"
  | "min_bill_not_met";

/**
 * The K4/K7/K8 predicate, in a fixed order: catalog state, then the date window, then the weekday,
 * then the time-of-day window, then the minimum bill. The ORDER is the reported reason's order and
 * nothing else — every leg is evaluated against the same instant, so no leg can mask a later one's
 * answer, only its message.
 *
 * `billGrossPaise` is the draft's GROSS total (see `ResolvedInstruments.billGrossPaise`): K4's
 * threshold is measured before any adjustment, so a coupon on a bill that qualifies does not
 * disqualify itself the moment another instrument discounts it.
 */
export function couponUnusableReason(
  coupon: ResolvedCoupon,
  args: { at: Date; billGrossPaise: number },
): CouponUnusableReason | null {
  const { at, billGrossPaise } = args;
  if (coupon.status !== "active") return "retired";
  if (istDayIndex(at) < istDayIndex(coupon.validFrom)) return "not_yet_valid";
  if (istDayIndex(at) > istDayIndex(coupon.validTo)) return "expired";
  if (((coupon.weekdayMask >> istWeekdayMondayZero(at)) & 1) === 0) return "off_weekday";
  // Inclusive both ends, exactly as `coupon_definitions.window_{start,end}_minute` documents:
  // a window written 09:00–11:59 is live through 11:59:59 IST and dead at 12:00:00 IST (B5).
  if (coupon.windowStartMinute !== null && istMinuteOfDay(at) < coupon.windowStartMinute) return "outside_window";
  if (coupon.windowEndMinute !== null && istMinuteOfDay(at) > coupon.windowEndMinute) return "outside_window";
  if (billGrossPaise < coupon.minBillPaise) return "min_bill_not_met";
  return null;
}
