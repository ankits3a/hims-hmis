import { benefitCandidate, benefitCoversLine } from "./instruments";
import type { BenefitScope, BenefitTerm } from "./instruments";
import { TariffError } from "../tariff";
import type { GstCategoryConfig, InvoiceLineInput, PricingContext, ServiceInfo } from "../tariff";

/**
 * Plan 09 T2 — the benefit arithmetic, on its own. Every fixture below is invented here (O-9): no
 * plan code, coupon code, rate or person from the out-of-git partner book appears anywhere.
 */
const SERVICES: Record<string, ServiceInfo> = {
  "svc-cons": { id: "svc-cons", code: "CONS-GEN", name: "General consultation", category: "consultation", regulated: false, active: true },
  "svc-lab": { id: "svc-lab", code: "LAB-CBC", name: "Complete blood count", category: "lab", regulated: false, active: true },
};
const CATEGORIES: Record<string, GstCategoryConfig> = {
  consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
  lab: { category: "lab", sacCode: "999316", exempt: false, rateBps: 1800, specialRule: null, thresholdPaise: null },
};
const CTX: PricingContext = {
  asOf: new Date("2026-09-30T06:00:00.000Z"),
  tariff: { versionId: "tv1", versionNo: 1, items: { "svc-cons": 50000, "svc-lab": 20000 } },
  services: SERVICES,
  regulatedPrices: {},
  gst: { categories: CATEGORIES, settings: { compositeHealthcareExempt: true, caSigned: false } },
  rules: [],
  manualCaps: {},
  sources: [],
  tags: [],
};
const CONS_LINE: InvoiceLineInput = { lineId: "L1", serviceId: "svc-cons", qty: 1 };
const LAB_LINE: InvoiceLineInput = { lineId: "L2", serviceId: "svc-lab", qty: 1 };
const EVERYWHERE: BenefitScope = { serviceCategories: null, serviceIds: null };

function term(over: Partial<BenefitTerm> = {}): BenefitTerm {
  return {
    benefitKey: "BK-OPD", title: "Invented OPD benefit", kind: "percent_bps", value: 1000,
    capPaise: null, scope: EVERYWHERE, ...over,
  };
}

test("a percentage benefit rounds through the frozen engine's divHalfUp and never with maths of its own", () => {
  // percentAmount(33335, 1000) = divHalfUp(33335000, 10000) = floor((66670000 + 10000)/20000)
  //                            = floor(3334.0) = 3334 — the .5 case rounds AWAY from zero, so a
  // naive Math.round on a float (3333.5 -> 3334 by luck, 3333.4999 by float error -> 3333) is not
  // what produced this number.
  const c = benefitCandidate({ sourceKey: "membership", term: term({ value: 1000 }), grossPaise: 33335 });
  expect(c.amountPaise).toBe(3334);
  expect(c.kind).toBe("percent_bps");
});

test("a flat benefit is a whole-line amount and is pre-capped at the line gross (D2's candidate contract)", () => {
  const c = benefitCandidate({ sourceKey: "coupon", term: term({ kind: "flat_paise", value: 80000 }), grossPaise: 50000 });
  expect(c.amountPaise).toBe(50000);
  expect(c.rejected).toBeNull();
});

test("the candidate carries the source key it was GIVEN, never one of its own (B7's shipped half)", () => {
  expect(benefitCandidate({ sourceKey: "membership", term: term(), grossPaise: 50000 }).sourceKey).toBe("membership");
  expect(benefitCandidate({ sourceKey: "coupon", term: term(), grossPaise: 50000 }).sourceKey).toBe("coupon");
});

test("an instrument benefit carries NO DiscountCategory, so ctx.manualCaps can never govern it", () => {
  expect(benefitCandidate({ sourceKey: "membership", term: term(), grossPaise: 50000 }).discountCategory).toBeNull();
});

test("the benefit key becomes the candidate's ruleKey, so the audit record names the term that paid", () => {
  const c = benefitCandidate({ sourceKey: "coupon", term: term({ benefitKey: "CPN-INVENTED-7", title: "Invented monsoon coupon" }), grossPaise: 50000 });
  expect(c.ruleKey).toBe("CPN-INVENTED-7");
  expect(c.reason).toBe("Invented monsoon coupon");
  expect(c.requiresApproval).toBe(false);
});

test("K3 — an ask EXACTLY at the cap is paid, not refused: the comparison is > and not >=", () => {
  // percentAmount(100000, 1500) = divHalfUp(150000000, 10000) = floor((300000000+10000)/20000)
  //                             = floor(15000.5) = 15000, which is the cap to the paise.
  const c = benefitCandidate({ sourceKey: "coupon", term: term({ value: 1500, capPaise: 15000 }), grossPaise: 100000 });
  expect(c.rejected).toBeNull();
  expect(c.amountPaise).toBe(15000);
});

test("K3 — one paise over the cap is REJECTED, and the record carries the ASK, not the cap", () => {
  const c = benefitCandidate({ sourceKey: "coupon", term: term({ value: 1500, capPaise: 14999 }), grossPaise: 100000 });
  expect(c.rejected).toEqual({ code: "over_cap", detail: '15000p exceeds the 14999p cap on "BK-OPD"' });
  expect(c.amountPaise).toBe(15000);
});

test("B4 — the cap is compared against the ASK: an ask over BOTH the cap and the gross is refused, never clamped to gross and paid", () => {
  // gross 20000, flat ask 30000, cap 25000. The ask exceeds both.
  // Correct: 30000 > 25000 -> rejected, and the record keeps the 30000 that was asked.
  // "Cap the clamped value" instead: min(30000, 20000) = 20000 <= 25000 -> ACCEPTED for 20000, the
  // whole line free, with nothing anywhere saying a cap had been passed.
  const c = benefitCandidate({ sourceKey: "coupon", term: term({ kind: "flat_paise", value: 30000, capPaise: 25000 }), grossPaise: 20000 });
  expect(c.rejected).not.toBeNull();
  expect(c.rejected?.code).toBe("over_cap");
  expect(c.amountPaise).toBe(30000);
});

test("a fractional or negative configured value is refused by the frozen engine's own paise guard (M3)", () => {
  expect(() => benefitCandidate({ sourceKey: "coupon", term: term({ value: 12.5 }), grossPaise: 50000 })).toThrow(TariffError);
  expect(() => benefitCandidate({ sourceKey: "coupon", term: term({ value: -100 }), grossPaise: 50000 })).toThrow(/non-negative integer of paise/);
  expect(() => benefitCandidate({ sourceKey: "coupon", term: term({ capPaise: 0.5 }), grossPaise: 50000 })).toThrow(/cap must be a non-negative integer/);
});

test("a zero-gross line yields a zero candidate rather than a throw (K5)", () => {
  const pct = benefitCandidate({ sourceKey: "membership", term: term({ value: 1000 }), grossPaise: 0 });
  const flat = benefitCandidate({ sourceKey: "coupon", term: term({ kind: "flat_paise", value: 5000 }), grossPaise: 0 });
  expect(pct.amountPaise).toBe(0);
  expect(flat.amountPaise).toBe(0);
  expect(flat.rejected).toBeNull();
});

test("an unscoped term reaches every line; a category scope and an id scope each narrow it", () => {
  expect(benefitCoversLine(EVERYWHERE, CTX, CONS_LINE)).toBe(true);
  expect(benefitCoversLine(EVERYWHERE, CTX, LAB_LINE)).toBe(true);
  expect(benefitCoversLine({ serviceCategories: ["consultation"], serviceIds: null }, CTX, CONS_LINE)).toBe(true);
  expect(benefitCoversLine({ serviceCategories: ["consultation"], serviceIds: null }, CTX, LAB_LINE)).toBe(false);
  expect(benefitCoversLine({ serviceCategories: null, serviceIds: ["svc-lab"] }, CTX, LAB_LINE)).toBe(true);
  expect(benefitCoversLine({ serviceCategories: null, serviceIds: ["svc-lab"] }, CTX, CONS_LINE)).toBe(false);
});

test("an EMPTY scope array reaches nothing, and is not the same as null", () => {
  expect(benefitCoversLine({ serviceCategories: [], serviceIds: null }, CTX, CONS_LINE)).toBe(false);
  expect(benefitCoversLine({ serviceCategories: null, serviceIds: [] }, CTX, CONS_LINE)).toBe(false);
});

test("a line naming a service the context does not carry covers nothing (the engine refuses the line itself)", () => {
  expect(benefitCoversLine(EVERYWHERE, CTX, { lineId: "L9", serviceId: "svc-absent", qty: 1 })).toBe(false);
});
