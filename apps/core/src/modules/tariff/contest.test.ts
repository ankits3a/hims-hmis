import { manualDiscountSource, runContest, standingRuleSource } from "./contest";
import { TariffError } from "./errors";
import type {
  AdjustmentRuleConfig,
  AdjustmentSource,
  GstCategoryConfig,
  InvoiceLineInput,
  ManualCaps,
  PricingContext,
  ServiceInfo,
} from "./types";

// Pure fixtures, built inline — contest.ts touches no database, no clock, no randomness.
const SERVICES: Record<string, ServiceInfo> = {
  "svc-cons": { id: "svc-cons", code: "CONS-GEN", name: "General consultation", category: "consultation", regulated: false, active: true },
  "svc-proc": { id: "svc-proc", code: "PROC-MIN", name: "Minor procedure", category: "procedure", regulated: false, active: true },
};

const CATEGORIES: Record<string, GstCategoryConfig> = {
  consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
  procedure: { category: "procedure", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
};

const CAPS: ManualCaps = {
  charity: { maxBps: 2500, approvalAboveBps: 1000 },
  employee: { maxBps: 1000, approvalAboveBps: null },
  scheme: { maxBps: 1500, approvalAboveBps: 1000 },
  negotiated_corporate: { maxBps: 2000, approvalAboveBps: 1500 },
};

const R_CAMP5: AdjustmentRuleConfig = {
  ruleKey: "R-CAMP5", title: "Camp 2026 procedure scheme", kind: "percent_bps", value: 500,
  discountCategory: "scheme", requiredTag: "camp2026", serviceCategory: "procedure", serviceId: null,
};
const R_EMP10: AdjustmentRuleConfig = {
  ruleKey: "R-EMP10", title: "Employee discount", kind: "percent_bps", value: 1000,
  discountCategory: "employee", requiredTag: "employee", serviceCategory: null, serviceId: null,
};

function makeCtx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    asOf: new Date("2026-09-01T00:00:00.000Z"),
    tariff: { versionId: "v1", versionNo: 1, items: { "svc-cons": 50000, "svc-proc": 33335 } },
    services: SERVICES,
    regulatedPrices: {},
    gst: { categories: CATEGORIES, settings: { compositeHealthcareExempt: true, caSigned: false } },
    rules: [],
    manualCaps: CAPS,
    sources: [standingRuleSource, manualDiscountSource],
    tags: [],
    ...overrides,
  };
}

const CONS_LINE: InvoiceLineInput = { lineId: "L1", serviceId: "svc-cons", qty: 1 };
const PROC_LINE: InvoiceLineInput = { lineId: "L1", serviceId: "svc-proc", qty: 1 };

test("a tagged rule proposes nothing without the tag and the exact rounded amount with it", () => {
  expect(standingRuleSource.propose(makeCtx({ rules: [R_EMP10] }), PROC_LINE, 33335)).toEqual([]);

  const withTag = standingRuleSource.propose(makeCtx({ rules: [R_EMP10], tags: ["employee"] }), PROC_LINE, 33335);
  expect(withTag).toHaveLength(1);
  // pct(33335, 1000) = divHalfUp(33,335,000, 10000) = 3334 (exact 3333.5 -> half-up)
  expect(withTag[0]).toEqual({
    sourceKey: "rule", ruleKey: "R-EMP10", kind: "percent_bps", discountCategory: "employee",
    amountPaise: 3334, reason: "Employee discount", requiresApproval: false, rejected: null,
  });
});

test("a scoped rule fires inside its scope and nowhere else (both directions, category and serviceId)", () => {
  const byCategory = makeCtx({ rules: [R_CAMP5], tags: ["camp2026"] });
  expect(standingRuleSource.propose(byCategory, PROC_LINE, 33335)).toHaveLength(1);
  expect(standingRuleSource.propose(byCategory, CONS_LINE, 50000)).toEqual([]);

  const pinned: AdjustmentRuleConfig = { ...R_EMP10, serviceId: "svc-proc" };
  const byServiceId = makeCtx({ rules: [pinned], tags: ["employee"] });
  expect(standingRuleSource.propose(byServiceId, PROC_LINE, 33335)).toHaveLength(1);
  expect(standingRuleSource.propose(byServiceId, CONS_LINE, 50000)).toEqual([]);
});

test("a flat rule is capped at the line gross", () => {
  const flat: AdjustmentRuleConfig = {
    ruleKey: "R-FLAT60", title: "Flat waiver", kind: "flat_paise", value: 60000,
    discountCategory: "charity", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  const out = standingRuleSource.propose(makeCtx({ rules: [flat] }), CONS_LINE, 50000);
  expect(out).toHaveLength(1);
  expect(out[0]?.amountPaise).toBe(50000); // 60000 asked, gross 50000 — capped at gross
});

test("a manual discount in a category with no configured cap is RECORDED as rejected", () => {
  const ctx = makeCtx({ manualCaps: { charity: { maxBps: 2500, approvalAboveBps: 1000 } } });
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "scheme", kind: "percent_bps", value: 500, reason: "camp" },
  };
  const out = manualDiscountSource.propose(ctx, line, 50000);
  expect(out).toHaveLength(1); // recorded, not dropped
  expect(out[0]?.amountPaise).toBe(2500);
  expect(out[0]?.rejected).toEqual({ code: "unknown_category", detail: 'no cap configured for "scheme"' });
});

test("an over-cap manual discount records the amount that was ASKED and is rejected, never clamped", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "percent_bps", value: 2500, reason: "asked too much" },
  };
  const out = manualDiscountSource.propose(makeCtx(), line, 50000);
  expect(out).toHaveLength(1);
  // asked 25% of 50000 = 12500; cap is 2000bps = 10000. A clamping implementation reports 10000 and no rejection.
  expect(out[0]?.amountPaise).toBe(12500);
  expect(out[0]?.rejected).toEqual({ code: "over_cap", detail: "12500p exceeds 2000bps of 50000p" });
});

test("requiresApproval is an EXACT rational compare — exactly at the line is NOT above it", () => {
  const above: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 10000, reason: "camp waiver" },
  };
  // 10000 * 10000 = 100,000,000 > 1000 * 50000 = 50,000,000
  expect(manualDiscountSource.propose(makeCtx(), above, 50000)[0]?.requiresApproval).toBe(true);

  const atTheLine: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 5000, reason: "camp waiver" },
  };
  // 5000 * 10000 = 50,000,000 === 1000 * 50000 = 50,000,000 — equal is not "above"
  expect(manualDiscountSource.propose(makeCtx(), atTheLine, 50000)[0]?.requiresApproval).toBe(false);
});

test("the contest picks the single largest valid benefit — no stacking", () => {
  const ctx = makeCtx({ rules: [R_CAMP5, R_EMP10], tags: ["employee", "camp2026"] });
  const line: InvoiceLineInput = {
    ...PROC_LINE,
    manualDiscount: { discountCategory: "charity", kind: "percent_bps", value: 800, reason: "hardship" },
  };
  const { candidates, winner } = runContest(ctx, line, 33335);
  // R-CAMP5 pct 500 = 1667 (1666.75), R-EMP10 pct 1000 = 3334 (3333.5), manual pct 800 = 2667 (2666.8)
  expect(candidates.map((c) => c.amountPaise)).toEqual([1667, 3334, 2667]);
  expect(winner?.sourceKey).toBe("rule");
  expect(winner?.ruleKey).toBe("R-EMP10");
  expect(winner?.amountPaise).toBe(3334);
});

test("an exact tie breaks by ctx.sources order — asserted from BOTH orderings", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "charity", kind: "percent_bps", value: 1000, reason: "tie-test" },
  };

  const ruleFirst = runContest(
    makeCtx({ rules: [R_EMP10], tags: ["employee"], sources: [standingRuleSource, manualDiscountSource] }),
    line, 50000,
  );
  expect(ruleFirst.candidates.map((c) => c.amountPaise)).toEqual([5000, 5000]); // a genuine tie
  expect(ruleFirst.winner?.sourceKey).toBe("rule");
  expect(ruleFirst.winner?.ruleKey).toBe("R-EMP10");

  const manualFirst = runContest(
    makeCtx({ rules: [R_EMP10], tags: ["employee"], sources: [manualDiscountSource, standingRuleSource] }),
    line, 50000,
  );
  expect(manualFirst.candidates.map((c) => c.amountPaise)).toEqual([5000, 5000]);
  expect(manualFirst.winner?.sourceKey).toBe("manual");
  expect(manualFirst.winner?.ruleKey).toBeNull();
});

test("a tie inside one source breaks by ruleKey ascending", () => {
  const zz: AdjustmentRuleConfig = {
    ruleKey: "R-ZZZ", title: "Late alphabet", kind: "percent_bps", value: 1000,
    discountCategory: "scheme", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  const aa: AdjustmentRuleConfig = {
    ruleKey: "R-AAA", title: "Early alphabet", kind: "percent_bps", value: 1000,
    discountCategory: "scheme", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  const { candidates, winner } = runContest(makeCtx({ rules: [zz, aa] }), CONS_LINE, 50000);
  expect(candidates.map((c) => c.ruleKey)).toEqual(["R-AAA", "R-ZZZ"]);
  expect(candidates.map((c) => c.amountPaise)).toEqual([5000, 5000]);
  expect(winner?.ruleKey).toBe("R-AAA");
});

test("when every candidate is rejected the winner is null and the rejects are still recorded", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "percent_bps", value: 2500, reason: "asked too much" },
  };
  const { candidates, winner } = runContest(makeCtx(), line, 50000);
  expect(winner).toBeNull();
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.rejected?.code).toBe("over_cap");
  expect(candidates[0]?.amountPaise).toBe(12500);
});

test("an over-GROSS flat ask is recorded at the ASKED amount — 60000, never the 50000 clamp", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "flat_paise", value: 60000, reason: "asked too much" },
  };
  const out = manualDiscountSource.propose(makeCtx(), line, 50000);
  expect(out).toHaveLength(1);
  // A clamp-then-record implementation reports Math.min(60000, 50000) = 50000 on BOTH fields —
  // killed twice over. 60000×10000 = 600,000,000 > 2000×50000 = 100,000,000 → over_cap.
  expect(out[0]?.amountPaise).toBe(60000);
  expect(out[0]?.rejected).toEqual({ code: "over_cap", detail: "60000p exceeds 2000bps of 50000p" });
});

test("a fractional manual discount value is refused as invalid_paise before any arithmetic", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 1250.5, reason: "typo" },
  };
  // The HTTP DTO already refuses non-integers; this guards the direct programmatic caller —
  // Plan 08 — where 1250.5 previously flowed to a fractional netPaise on a bigint column (M3).
  expect(() => manualDiscountSource.propose(makeCtx(), line, 50000)).toThrow(TariffError);
  try {
    manualDiscountSource.propose(makeCtx(), line, 50000);
  } catch (e) {
    expect((e as TariffError).code).toBe("invalid_paise");
  }
});

test("the intra-source ruleKey tie-break is real: an UNSORTED source's equal candidates break to the earlier key", () => {
  const stub: AdjustmentSource = {
    key: "stub",
    propose: () => [
      { sourceKey: "stub", ruleKey: "R-ZZZ", kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "zz", requiresApproval: false, rejected: null },
      { sourceKey: "stub", ruleKey: null, kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "anon", requiresApproval: false, rejected: null },
      { sourceKey: "stub", ruleKey: "R-AAA", kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "aa", requiresApproval: false, rejected: null },
    ],
  };
  // standingRuleSource pre-sorts its own output, so only a deliberately unsorted source reaches
  // runContest's nulls-last + ruleKey comparison at all (M6). Deleting that block leaves a stable
  // sort in input order → R-ZZZ wins → killed.
  const { winner } = runContest(makeCtx({ sources: [stub] }), CONS_LINE, 50000);
  expect(winner?.ruleKey).toBe("R-AAA");
});

test("a zero-computed benefit is recorded but can never win", () => {
  const tiny: AdjustmentRuleConfig = {
    ruleKey: "R-1BPS", title: "One bps", kind: "percent_bps", value: 1,
    discountCategory: "scheme", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  // pct(4, 1) = divHalfUp(4, 10000) = floor((8 + 10000) / 20000) = 0. Dropping the
  // `amountPaise > 0` filter puts a zero-benefit discount line on an invoice (winner non-null) — killed.
  const ctx = makeCtx({ rules: [tiny], tariff: { versionId: "v1", versionNo: 1, items: { "svc-cons": 4 } } });
  const { candidates, winner } = runContest(ctx, CONS_LINE, 4);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.amountPaise).toBe(0);
  expect(winner).toBeNull();
});
