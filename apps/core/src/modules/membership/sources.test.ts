import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUPON_SOURCE_KEY, couponSource, MEMBERSHIP_SOURCE_KEY, membershipSource } from "./sources";
import type { BenefitTerm, ResolvedCoupon, ResolvedInstruments, ResolvedMembership } from "./instruments";
import { manualDiscountSource, priceInvoiceLines, runContest, standingRuleSource } from "../tariff";
import type {
  AdjustmentRuleConfig, AdjustmentSource, GstCategoryConfig, InvoiceLineInput, PricingContext, ServiceInfo,
} from "../tariff";

/**
 * Plan 09 T2 — the two factories, and the properties DD2 bought by making them factories.
 *
 * Everything below is INVENTED (O-9). The card codes, coupon codes, titles and percentages were
 * written in this file and correspond to nothing in the out-of-git partner book.
 */
const SERVICES: Record<string, ServiceInfo> = {
  "svc-cons": { id: "svc-cons", code: "CONS-GEN", name: "General consultation", category: "consultation", regulated: false, active: true },
  "svc-lab": { id: "svc-lab", code: "LAB-CBC", name: "Complete blood count", category: "lab", regulated: false, active: true },
};
const CATEGORIES: Record<string, GstCategoryConfig> = {
  consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
  lab: { category: "lab", sacCode: "999316", exempt: false, rateBps: 1800, specialRule: null, thresholdPaise: null },
};
const AT = new Date("2026-09-30T06:00:00.000Z"); // 11:30 IST Wed 30 Sep 2026
const CONS_LINE: InvoiceLineInput = { lineId: "L1", serviceId: "svc-cons", qty: 1 };
const LAB_LINE: InvoiceLineInput = { lineId: "L2", serviceId: "svc-lab", qty: 1 };

function ctxWith(sources: AdjustmentSource[], over: Partial<PricingContext> = {}): PricingContext {
  return {
    asOf: AT,
    tariff: { versionId: "tv1", versionNo: 1, items: { "svc-cons": 50000, "svc-lab": 20000 } },
    services: SERVICES,
    regulatedPrices: {},
    gst: { categories: CATEGORIES, settings: { compositeHealthcareExempt: true, caSigned: false } },
    rules: [],
    manualCaps: { charity: { maxBps: 2500, approvalAboveBps: 1000 } },
    sources,
    tags: [],
    ...over,
  };
}

function term(over: Partial<BenefitTerm> = {}): BenefitTerm {
  return {
    benefitKey: "INV-BEN-OPD", title: "Invented OPD benefit", kind: "flat_paise", value: 5000,
    capPaise: null, scope: { serviceCategories: null, serviceIds: null }, ...over,
  };
}

function membership(over: Partial<ResolvedMembership> = {}): ResolvedMembership {
  return {
    instanceId: "mi-1", planId: "mp-1", planTitle: "Invented family card", cardCode: "INV-CARD-0001",
    status: "active",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: new Date("2026-12-31T00:00:00.000Z"),
    benefits: [term()],
    ...over,
  };
}

function coupon(over: Partial<ResolvedCoupon> = {}): ResolvedCoupon {
  return {
    couponId: "cd-1", code: "INV-CPN-01", title: "Invented monsoon coupon", instanceId: null,
    benefit: term({ benefitKey: "INV-CPN-01", title: "Invented monsoon coupon" }),
    minBillPaise: 0,
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validTo: new Date("2026-10-31T00:00:00.000Z"),
    weekdayMask: 127, windowStartMinute: null, windowEndMinute: null, status: "active",
    ...over,
  };
}

function resolved(over: Partial<ResolvedInstruments> = {}): ResolvedInstruments {
  return { patientId: "pt-1", memberships: [], coupons: [], billGrossPaise: 50000, ...over };
}

/** The four sources in the DD2 order the billing layer composes. */
function composed(r: ResolvedInstruments): AdjustmentSource[] {
  return [standingRuleSource, manualDiscountSource, membershipSource(r), couponSource(r)];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURITY — asserted, not claimed. `AdjustmentSource.propose` is documented PURE and SYNC in the
// frozen `modules/tariff/types.ts`, and DD2's whole shape depends on it staying that way.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Comments are stripped first: these three files DISCUSS the forbidden tokens at length. */
function codeOf(file: string): string {
  const src = readFileSync(join(__dirname, file), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no impurity reaches the money path: the three source files contain no await, clock or database import", () => {
  const forbidden = [
    ["async", /\basync\b/],
    ["await", /\bawait\b/],
    ["a clock read", /Date\s*\.\s*now/],
    ["a Date construction", /new\s+Date\s*\(/],
    ["a drizzle import", /drizzle-orm/],
    ["a database import", /kernel\/db/],
  ] as const;
  for (const file of ["sources.ts", "instruments.ts", "coupon-rules.ts"]) {
    const code = codeOf(file);
    for (const [what, pattern] of forbidden) expect([file, what, pattern.test(code)]).toEqual([file, what, false]);
  }
  // The scanner is not vacuous: it sees the tokens when they are really there.
  expect(/new\s+Date\s*\(/.test(codeOf("sources.test.ts"))).toBe(true);
});

test("propose is a plain synchronous function in both sources, not an async one", () => {
  for (const source of [membershipSource(resolved()), couponSource(resolved())]) {
    expect(source.propose.constructor.name).toBe("Function");
    expect(Array.isArray(source.propose(ctxWith([]), CONS_LINE, 50000))).toBe(true);
  }
});

test("neither source reads the clock — both price correctly with Date.now stubbed to throw", () => {
  const spy = jest.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("a source read the clock");
  });
  try {
    const r = resolved({ memberships: [membership()], coupons: [coupon()] });
    expect(membershipSource(r).propose(ctxWith([]), CONS_LINE, 50000)).toHaveLength(1);
    expect(couponSource(r).propose(ctxWith([]), CONS_LINE, 50000)).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

test("propose is deterministic: the same context, line and gross give a deep-equal answer every time", () => {
  const source = membershipSource(resolved({ memberships: [membership()] }));
  expect(source.propose(ctxWith([]), CONS_LINE, 50000)).toEqual(source.propose(ctxWith([]), CONS_LINE, 50000));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B7 — sourceKey === key, and the two keys differ.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("B7 — the two source keys are distinct, so they cannot collapse into one precedence slot", () => {
  expect(MEMBERSHIP_SOURCE_KEY).not.toBe(COUPON_SOURCE_KEY);
  expect(membershipSource(resolved()).key).toBe(MEMBERSHIP_SOURCE_KEY);
  expect(couponSource(resolved()).key).toBe(COUPON_SOURCE_KEY);
});

test("B7 — every candidate a source emits carries THAT source's own key, which is what runContest indexes by", () => {
  const r = resolved({
    memberships: [membership({ benefits: [term({ benefitKey: "INV-BEN-A" }), term({ benefitKey: "INV-BEN-B", value: 3000 })] })],
    coupons: [coupon(), coupon({ couponId: "cd-2", code: "INV-CPN-02", benefit: term({ benefitKey: "INV-CPN-02", value: 2000 }) })],
  });
  for (const source of [membershipSource(r), couponSource(r)]) {
    const proposed = source.propose(ctxWith([]), CONS_LINE, 50000);
    expect(proposed).toHaveLength(2);
    for (const c of proposed) expect(c.sourceKey).toBe(source.key);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The contest properties DD2 says are "new fixtures, not new code".
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("B1 — a member holding both a membership and a coupon gets the BEST ONE, never the sum", () => {
  const r = resolved({
    memberships: [membership({ benefits: [term({ benefitKey: "INV-BEN-OPD", kind: "percent_bps", value: 1000 })] })], // 5000
    coupons: [coupon({ benefit: term({ benefitKey: "INV-CPN-01", kind: "flat_paise", value: 8000 }) })],              // 8000
  });
  const { candidates, winner } = runContest(ctxWith(composed(r)), CONS_LINE, 50000);
  expect(candidates.map((c) => [c.sourceKey, c.amountPaise])).toEqual([["membership", 5000], ["coupon", 8000]]);
  expect(winner?.amountPaise).toBe(8000);
  expect(winner?.sourceKey).toBe("coupon");
  // The sum, 13000, appears nowhere — neither as a candidate nor as the discount.
  expect(candidates.some((c) => c.amountPaise === 13000)).toBe(false);
});

test("B2/B7 — an exact tie breaks toward MEMBERSHIP, which sits earlier in [rule, manual, membership, coupon]", () => {
  const r = resolved({
    memberships: [membership({ benefits: [term({ benefitKey: "INV-BEN-OPD", kind: "flat_paise", value: 5000 })] })],
    coupons: [coupon({ benefit: term({ benefitKey: "INV-CPN-01", kind: "flat_paise", value: 5000 }) })],
  });
  const { candidates, winner } = runContest(ctxWith(composed(r)), CONS_LINE, 50000);
  expect(candidates.map((c) => c.amountPaise)).toEqual([5000, 5000]);
  expect(winner?.sourceKey).toBe("membership");
  expect(winner?.ruleKey).toBe("INV-BEN-OPD");
});

test("B2 — a standing hospital rule still beats a commercial instrument on an exact tie", () => {
  const rule: AdjustmentRuleConfig = {
    ruleKey: "R-INV-CHARITY", title: "Invented charity rule", kind: "flat_paise", value: 5000,
    discountCategory: "charity", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  const r = resolved({ memberships: [membership()], coupons: [coupon()] });
  const { winner } = runContest(ctxWith(composed(r), { rules: [rule] }), CONS_LINE, 50000);
  expect(winner?.sourceKey).toBe("rule");
});

test("B3 — an over-cap coupon on an otherwise-eligible line is RECORDED as rejected, never dropped", () => {
  const r = resolved({
    memberships: [membership({ benefits: [term({ benefitKey: "INV-BEN-OPD", kind: "flat_paise", value: 4000 })] })],
    coupons: [coupon({ benefit: term({ benefitKey: "INV-CPN-01", kind: "percent_bps", value: 5000, capPaise: 20000 }) })],
  });
  const { candidates, winner } = runContest(ctxWith(composed(r)), CONS_LINE, 50000);
  expect(candidates).toHaveLength(2);
  const cpn = candidates.find((c) => c.sourceKey === "coupon");
  expect(cpn?.rejected).toEqual({ code: "over_cap", detail: '25000p exceeds the 20000p cap on "INV-CPN-01"' });
  expect(cpn?.amountPaise).toBe(25000); // the ASK, for the audit record
  expect(winner?.sourceKey).toBe("membership"); // the rejected candidate never wins
  expect(winner?.amountPaise).toBe(4000);
});

test("an instrument that is not usable at ctx.asOf proposes NOTHING — no zero candidate, no rejected row", () => {
  const r = resolved({
    memberships: [membership({ status: "suspended" })],
    coupons: [coupon({ weekdayMask: 1 << 6 })], // Sunday only; AT is a Wednesday in IST
  });
  expect(membershipSource(r).propose(ctxWith([]), CONS_LINE, 50000)).toEqual([]);
  expect(couponSource(r).propose(ctxWith([]), CONS_LINE, 50000)).toEqual([]);
});

test("K4 — the minimum bill is read off the DRAFT's gross total, not off the line the coupon lands on", () => {
  const r = resolved({ billGrossPaise: 90000, coupons: [coupon({ minBillPaise: 85000 })] });
  // The line is 50 000p — well under the threshold — but the bill it belongs to is 90 000p.
  expect(couponSource(r).propose(ctxWith([]), CONS_LINE, 50000)).toHaveLength(1);
  expect(couponSource(resolved({ billGrossPaise: 84999, coupons: [coupon({ minBillPaise: 85000 })] }))
    .propose(ctxWith([]), CONS_LINE, 50000)).toEqual([]);
});

test("a scoped benefit reaches only the lines it names, and the other line prices untouched", () => {
  const r = resolved({
    memberships: [membership({ benefits: [term({ scope: { serviceCategories: ["lab"], serviceIds: null } })] })],
  });
  const ctx = ctxWith(composed(r));
  const [cons, lab] = priceInvoiceLines(ctx, [CONS_LINE, LAB_LINE]);
  expect(cons?.candidates).toEqual([]);
  expect(cons?.netPaise).toBe(50000);
  expect(lab?.winner?.sourceKey).toBe("membership");
  // GST is charged on the POST-discount base, which is what proves an appended source flows
  // through the WHOLE engine and not only the contest: base 20000 - 5000 = 15000,
  // taxHead(15000, 1800) = divHalfUp(27000000, 20000) = floor((54000000 + 20000)/40000) = 1350.
  expect(lab?.taxableBasePaise).toBe(15000);
  expect(lab?.gst.cgstPaise).toBe(1350);
  expect(lab?.netPaise).toBe(15000 + 1350 + 1350);
});

test("composing the two sources changes nothing when the patient holds no instrument", () => {
  const bare = priceInvoiceLines(ctxWith([standingRuleSource, manualDiscountSource]), [CONS_LINE, LAB_LINE]);
  const withEmpty = priceInvoiceLines(ctxWith(composed(resolved())), [CONS_LINE, LAB_LINE]);
  expect(withEmpty).toEqual(bare);
});
