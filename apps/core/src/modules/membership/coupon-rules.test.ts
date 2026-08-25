import {
  couponUnusableReason, IST_OFFSET_MS, istDayIndex, istMinuteOfDay, istWeekdayMondayZero,
  membershipUsableAt,
} from "./coupon-rules";
import type { ResolvedCoupon, ResolvedMembership } from "./instruments";

/**
 * Plan 09 T2 — the IST clock and the two validity predicates. Every instrument below is INVENTED
 * (O-9): the codes, the people and the windows were written here and correspond to nothing.
 *
 * The instants are chosen so that every assertion has a UTC reading that DISAGREES with it —
 * an IST predicate tested only at 06:00 UTC would agree with a UTC one for ever.
 */

// 2026-09-28 is a Monday in IST, so the whole week below is anchored and checkable by hand.
const WED_1159_59_IST = new Date("2026-09-30T06:29:59.000Z"); // 11:59:59 IST Wed 30 Sep
const WED_1200_00_IST = new Date("2026-09-30T06:30:00.000Z"); // 12:00:00 IST Wed 30 Sep
const WED_1830_IST = new Date("2026-09-30T13:00:00.000Z");    // 18:30:00 IST Wed 30 Sep
const THU_0001_IST = new Date("2026-09-30T18:31:00.000Z");    // 00:01 IST Thu 1 Oct — same UTC DAY as above

function membership(over: Partial<ResolvedMembership> = {}): ResolvedMembership {
  return {
    instanceId: "mi-1", planId: "mp-1", planTitle: "Invented family card", cardCode: "INV-CARD-0001",
    status: "active",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: new Date("2026-09-30T00:00:00.000Z"), // IST day 30 Sep — 05:30 IST that morning
    benefits: [],
    ...over,
  };
}

function coupon(over: Partial<ResolvedCoupon> = {}): ResolvedCoupon {
  return {
    couponId: "cd-1", code: "INV-CPN-01", title: "Invented off-peak coupon", instanceId: null,
    benefit: { benefitKey: "INV-CPN-01", title: "Invented off-peak coupon", kind: "flat_paise", value: 6000, capPaise: null, scope: { serviceCategories: null, serviceIds: null } },
    minBillPaise: 0,
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validTo: new Date("2026-10-31T00:00:00.000Z"),
    weekdayMask: 127,
    windowStartMinute: null,
    windowEndMinute: null,
    status: "active",
    ...over,
  };
}

test("the IST offset is the fixed +05:30 hospital clock, no DST", () => {
  expect(IST_OFFSET_MS).toBe(19_800_000);
});

test("two instants on one IST day share a day index even when they straddle UTC midnight", () => {
  // 18:30 IST Wed and 23:59 IST Wed are 13:00Z Wed and 18:29Z Wed; 00:01 IST Thu is 18:31Z WED.
  expect(istDayIndex(WED_1830_IST)).toBe(istDayIndex(new Date("2026-09-30T18:29:00.000Z")));
  expect(istDayIndex(THU_0001_IST)).toBe(istDayIndex(WED_1830_IST) + 1);
  // …and the two that differ share a UTC calendar day, which is the whole point.
  expect(THU_0001_IST.toISOString().slice(0, 10)).toBe(WED_1830_IST.toISOString().slice(0, 10));
});

test("minute-of-day is IST, and the whole of a minute belongs to it", () => {
  expect(istMinuteOfDay(WED_1159_59_IST)).toBe(719); // 11 * 60 + 59
  expect(istMinuteOfDay(new Date("2026-09-30T06:29:00.000Z"))).toBe(719);
  expect(istMinuteOfDay(WED_1200_00_IST)).toBe(720);
  expect(istMinuteOfDay(THU_0001_IST)).toBe(1); // 00:01 IST, not 18:31
});

test("weekday is 0 = Monday … 6 = Sunday on the IST day, which is not JavaScript's UTC numbering", () => {
  expect(istWeekdayMondayZero(new Date("2026-09-28T06:00:00.000Z"))).toBe(0); // Mon
  expect(istWeekdayMondayZero(WED_1830_IST)).toBe(2); // Wed
  expect(istWeekdayMondayZero(new Date("2026-10-04T06:00:00.000Z"))).toBe(6); // Sun
  // 18:31Z Wednesday is already Thursday in IST — a UTC weekday would still say Wednesday.
  expect(istWeekdayMondayZero(THU_0001_IST)).toBe(3);
  expect(THU_0001_IST.getUTCDay()).toBe(3); // JS: 3 = Wednesday. Same number, different day.
});

test("B6 — a membership is live to the end of the IST day its valid_to falls on", () => {
  // valid_to is 2026-09-30T00:00:00Z = 05:30 IST that morning. A raw instant comparison
  // (at <= validTo) would refuse this member at 18:30 IST on the very date printed on the card.
  const m = membership();
  expect(membershipUsableAt(m, WED_1830_IST)).toBe(true);
  expect(WED_1830_IST.getTime() > m.validTo.getTime()).toBe(true);
});

test("B6 — and it is dead at IST midnight, one minute later, on the same UTC day", () => {
  expect(membershipUsableAt(membership(), THU_0001_IST)).toBe(false);
});

test("a membership before its valid_from IST day prices nothing", () => {
  expect(membershipUsableAt(membership({ validFrom: new Date("2026-10-01T00:00:00.000Z") }), WED_1830_IST)).toBe(false);
});

test("only an ACTIVE membership prices anything — suspended, cancelled and expired all refuse", () => {
  for (const status of ["suspended", "cancelled", "expired"] as const) {
    expect(membershipUsableAt(membership({ status }), WED_1830_IST)).toBe(false);
  }
  expect(membershipUsableAt(membership({ status: "active" }), WED_1830_IST)).toBe(true);
});

test("B5 — an inclusive off-peak window is live through 11:59:59 IST and dead at 12:00:00 IST", () => {
  const c = coupon({ windowStartMinute: 540, windowEndMinute: 719 }); // 09:00 – 11:59 IST
  expect(couponUnusableReason(c, { at: WED_1159_59_IST, billGrossPaise: 50000 })).toBeNull();
  expect(couponUnusableReason(c, { at: WED_1200_00_IST, billGrossPaise: 50000 })).toBe("outside_window");
});

test("B5 — the same two instants read 06:29:59 and 06:30:00 in UTC, both far outside a 09:00 start", () => {
  // The negative control for the assertion above: a UTC-minute implementation calls BOTH of these
  // "outside_window", so the pair discriminates the timezone and not merely the second.
  expect(WED_1159_59_IST.getUTCHours() * 60 + WED_1159_59_IST.getUTCMinutes()).toBe(389);
  expect(WED_1200_00_IST.getUTCHours() * 60 + WED_1200_00_IST.getUTCMinutes()).toBe(390);
});

test("a window's start minute is inclusive too", () => {
  const c = coupon({ windowStartMinute: 719, windowEndMinute: 780 });
  expect(couponUnusableReason(c, { at: WED_1159_59_IST, billGrossPaise: 0 })).toBeNull();
  expect(couponUnusableReason(c, { at: new Date("2026-09-30T06:28:59.000Z"), billGrossPaise: 0 })).toBe("outside_window");
});

test("a null window is all day", () => {
  expect(couponUnusableReason(coupon(), { at: new Date("2026-09-30T18:29:00.000Z"), billGrossPaise: 0 })).toBeNull();
});

test("the weekday mask is read on the IST day: a Wednesday-only coupon is gone by 00:01 IST Thursday", () => {
  const wedOnly = coupon({ weekdayMask: 1 << 2 });
  expect(couponUnusableReason(wedOnly, { at: WED_1830_IST, billGrossPaise: 0 })).toBeNull();
  expect(couponUnusableReason(wedOnly, { at: THU_0001_IST, billGrossPaise: 0 })).toBe("off_weekday");
  expect(couponUnusableReason(coupon({ weekdayMask: 0 }), { at: WED_1830_IST, billGrossPaise: 0 })).toBe("off_weekday");
});

test("K7 — a coupon's own date window is evaluated on IST days, both ends", () => {
  const c = coupon({ validFrom: new Date("2026-09-30T00:00:00.000Z"), validTo: new Date("2026-09-30T00:00:00.000Z") });
  expect(couponUnusableReason(c, { at: WED_1830_IST, billGrossPaise: 0 })).toBeNull();
  expect(couponUnusableReason(c, { at: THU_0001_IST, billGrossPaise: 0 })).toBe("expired");
  expect(couponUnusableReason(c, { at: new Date("2026-09-29T13:00:00.000Z"), billGrossPaise: 0 })).toBe("not_yet_valid");
});

test("K4 — the minimum bill is met at the threshold to the paise, and refused one paise below", () => {
  const c = coupon({ minBillPaise: 85000 });
  expect(couponUnusableReason(c, { at: WED_1830_IST, billGrossPaise: 85000 })).toBeNull();
  expect(couponUnusableReason(c, { at: WED_1830_IST, billGrossPaise: 84999 })).toBe("min_bill_not_met");
});

test("a retired coupon refuses before any window is even looked at", () => {
  expect(couponUnusableReason(coupon({ status: "retired" }), { at: WED_1830_IST, billGrossPaise: 999999 })).toBe("retired");
});

test("an active, in-window, in-date, over-threshold coupon returns null — the predicate is not stuck on 'no'", () => {
  const c = coupon({ minBillPaise: 10000, weekdayMask: 127, windowStartMinute: 0, windowEndMinute: 1439 });
  expect(couponUnusableReason(c, { at: WED_1830_IST, billGrossPaise: 10000 })).toBeNull();
});
