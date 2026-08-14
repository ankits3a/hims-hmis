import { manualDiscountSource, standingRuleSource } from "./contest";
import { TariffError } from "./errors";
import { priceInvoiceLines } from "./pricing";
import type {
  AdjustmentRuleConfig,
  AdjustmentSource,
  GstCategoryConfig,
  InvoiceLineInput,
  ManualCaps,
  PricingContext,
  ServiceInfo,
} from "./types";

// Pure fixtures, built inline — pricing.ts touches no database, no clock, no randomness.
const SERVICES: Record<string, ServiceInfo> = {
  "svc-cons": { id: "svc-cons", code: "CONS-GEN", name: "General consultation", category: "consultation", regulated: false, active: true },
  "svc-proc": { id: "svc-proc", code: "PROC-MIN", name: "Minor procedure", category: "procedure", regulated: false, active: true },
  "svc-drug-a": { id: "svc-drug-a", code: "DRUG-A", name: "Drug A", category: "pharmacy", regulated: true, active: true },
  "svc-drug-b": { id: "svc-drug-b", code: "DRUG-B", name: "Drug B", category: "pharmacy", regulated: true, active: true },
  "svc-drug-c": { id: "svc-drug-c", code: "DRUG-C", name: "Drug C", category: "pharmacy", regulated: true, active: true },
  "svc-drug-d": { id: "svc-drug-d", code: "DRUG-D", name: "Drug D", category: "pharmacy", regulated: true, active: true },
  "svc-retired": { id: "svc-retired", code: "CONS-OLD", name: "Retired consultation", category: "consultation", regulated: false, active: false },
  "svc-unpriced": { id: "svc-unpriced", code: "CONS-NEW", name: "Unpriced consultation", category: "consultation", regulated: false, active: true },
};

const CATEGORIES: Record<string, GstCategoryConfig> = {
  consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
  procedure: { category: "procedure", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
  pharmacy: { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null },
};

const CAPS: ManualCaps = {
  charity: { maxBps: 2500, approvalAboveBps: 1000 },
  employee: { maxBps: 1000, approvalAboveBps: null },
  scheme: { maxBps: 1500, approvalAboveBps: 1000 },
  negotiated_corporate: { maxBps: 2000, approvalAboveBps: 1500 },
};

const R_EMP10: AdjustmentRuleConfig = {
  ruleKey: "R-EMP10", title: "Employee discount", kind: "percent_bps", value: 1000,
  discountCategory: "employee", requiredTag: "employee", serviceCategory: null, serviceId: null,
};

function makeCtx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    asOf: new Date("2026-09-01T00:00:00.000Z"),
    tariff: {
      versionId: "v1", versionNo: 1,
      items: {
        // svc-unpriced is deliberately absent — the tariff_item_missing case.
        "svc-cons": 50000, "svc-proc": 33335, "svc-retired": 50000,
        "svc-drug-a": 12000, "svc-drug-b": 9000, "svc-drug-c": 7000, "svc-drug-d": 5000,
      },
    },
    services: SERVICES,
    regulatedPrices: {
      // svc-drug-d is deliberately absent — the regulated_price_missing case.
      "svc-drug-a": { mrpPaise: 10000, ceilingPaise: 15000 },
      "svc-drug-b": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-c": { mrpPaise: 10000, ceilingPaise: 8000 },
    },
    gst: { categories: CATEGORIES, settings: { compositeHealthcareExempt: true, caSigned: false } },
    rules: [],
    manualCaps: CAPS,
    sources: [standingRuleSource, manualDiscountSource],
    tags: [],
    ...overrides,
  };
}

function thrownCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return e instanceof TariffError ? e.code : `not-a-TariffError: ${String(e)}`;
  }
  return null;
}

test("a plain exempt consultation prices end to end", () => {
  expect(priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-cons", qty: 1 }])).toEqual([
    {
      lineId: "L1", serviceId: "svc-cons", serviceName: "General consultation", category: "consultation",
      qty: 1, unitPaise: 50000, grossPaise: 50000,
      regulatedClamp: null, candidates: [], winner: null,
      discountPaise: 0, taxableBasePaise: 50000,
      gst: { sacCode: "999312", rateBps: 1800, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 },
      netPaise: 50000,
    },
  ]);
});

test("C-3 regulated clamp is min(tariff, MRP, ceiling) — each bound wins once, tariff-wins records no clamp", () => {
  const lines: InvoiceLineInput[] = [
    { lineId: "L1", serviceId: "svc-drug-a", qty: 1 },
    { lineId: "L2", serviceId: "svc-drug-b", qty: 1 },
    { lineId: "L3", serviceId: "svc-drug-c", qty: 1 },
  ];
  expect(priceInvoiceLines(makeCtx(), lines)).toEqual([
    {
      // min(12000, 10000, 15000) = 10000 -> MRP; head = divHalfUp(10000 * 1200, 20000) = 600; net 11200
      lineId: "L1", serviceId: "svc-drug-a", serviceName: "Drug A", category: "pharmacy",
      qty: 1, unitPaise: 10000, grossPaise: 10000,
      regulatedClamp: { boundApplied: "mrp", tariffPaise: 12000, mrpPaise: 10000, ceilingPaise: 15000 },
      candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 10000,
      gst: { sacCode: "3004", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 600, sgstPaise: 600 },
      netPaise: 11200,
    },
    {
      // min(9000, 10000, 8000) = 8000 -> NPPA ceiling hard block; head = 480; net 8960
      lineId: "L2", serviceId: "svc-drug-b", serviceName: "Drug B", category: "pharmacy",
      qty: 1, unitPaise: 8000, grossPaise: 8000,
      regulatedClamp: { boundApplied: "ceiling", tariffPaise: 9000, mrpPaise: 10000, ceilingPaise: 8000 },
      candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 8000,
      gst: { sacCode: "3004", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 480, sgstPaise: 480 },
      netPaise: 8960,
    },
    {
      // min(7000, 10000, 8000) = 7000 -> the tariff wins, so NO clamp is recorded; head = 420; net 7840
      lineId: "L3", serviceId: "svc-drug-c", serviceName: "Drug C", category: "pharmacy",
      qty: 1, unitPaise: 7000, grossPaise: 7000,
      regulatedClamp: null,
      candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 7000,
      gst: { sacCode: "3004", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 420, sgstPaise: 420 },
      netPaise: 7840,
    },
  ]);
});

test("a regulated service with no effective MRP/ceiling row is refused, never priced at tariff", () => {
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-drug-d", qty: 1 }])))
    .toBe("regulated_price_missing");
});

test("unknown and inactive services are refused by code", () => {
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-nope", qty: 1 }])))
    .toBe("unknown_service");
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-retired", qty: 1 }])))
    .toBe("service_inactive");
});

test("a service with no item in the locked tariff version is refused", () => {
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-unpriced", qty: 1 }])))
    .toBe("tariff_item_missing");
});

test("qty must be a positive integer", () => {
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-cons", qty: 0 }])))
    .toBe("invalid_qty");
  expect(thrownCode(() => priceInvoiceLines(makeCtx(), [{ lineId: "L1", serviceId: "svc-cons", qty: 1.5 }])))
    .toBe("invalid_qty");
});

test("the contest winner flows into the taxable base (nonzero discount)", () => {
  const ctx = makeCtx({ rules: [R_EMP10], tags: ["employee"] });
  const [priced] = priceInvoiceLines(ctx, [{ lineId: "L1", serviceId: "svc-proc", qty: 1 }]);
  expect(priced?.grossPaise).toBe(33335);
  expect(priced?.candidates).toHaveLength(1);
  expect(priced?.winner?.ruleKey).toBe("R-EMP10");
  expect(priced?.winner?.amountPaise).toBe(3334); // pct(33335, 1000) = 3334 (exact 3333.5)
  expect(priced?.discountPaise).toBe(3334);
  expect(priced?.taxableBasePaise).toBe(30001); // 33335 - 3334
  expect(priced?.netPaise).toBe(30001); // procedure is category-exempt
});

test("priceInvoiceLines is synchronous, deterministic, and mutates NOTHING it is handed", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
      Object.freeze(value);
    }
    return value;
  }
  const ctx = deepFreeze(makeCtx({ rules: [R_EMP10], tags: ["employee"] }));
  const lines = deepFreeze<InvoiceLineInput[]>([
    { lineId: "L1", serviceId: "svc-proc", qty: 1 },
    { lineId: "L2", serviceId: "svc-drug-b", qty: 2 },
  ]);
  const snapshot = JSON.parse(JSON.stringify({ ctx, lines })) as unknown;
  const first = priceInvoiceLines(ctx, lines);
  expect(Array.isArray(first)).toBe(true); // an array, not a Promise
  expect(first).not.toBeInstanceOf(Promise);
  const second = priceInvoiceLines(ctx, lines);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  // Frozen objects throw on mutation under "use strict" (all ts-jest code is strict); the JSON
  // snapshot is the belt in case any layer silently ignores the freeze. (deepFreeze also freezes
  // the module-level SERVICES/CATEGORIES/CAPS fixtures — harmless: no test mutates them, and an
  // ENGINE that tried is exactly what this test exists to catch.)
  expect(JSON.parse(JSON.stringify({ ctx, lines }))).toEqual(snapshot);
});

test("a regulated row with BOTH bounds null is refused — the C-3 hard block must never silently no-op", () => {
  const ctx = makeCtx({
    regulatedPrices: {
      "svc-drug-a": { mrpPaise: 10000, ceilingPaise: 15000 },
      "svc-drug-b": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-c": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-d": { mrpPaise: null, ceilingPaise: null },
    },
  });
  // The write path refuses this shape (regulated_bounds_missing), but a bulk-loaded or hand-fixed
  // row must not price at bare tariff with regulatedClamp: null. Shipped code returns netPaise
  // 5600 here (tariff 5000 + 2×300) with no clamp and no error — killed by expecting the throw.
  expect(thrownCode(() => priceInvoiceLines(ctx, [{ lineId: "L1", serviceId: "svc-drug-d", qty: 1 }])))
    .toBe("regulated_price_missing");
});

test("an over-gross winner from a rogue source fails LOUDLY at the taxable base, never a negative net", () => {
  const rogue: AdjustmentSource = {
    key: "rogue",
    propose: () => [{
      sourceKey: "rogue", ruleKey: null, kind: "flat_paise", discountCategory: null,
      amountPaise: 60000, reason: "violates the D2 pre-cap contract on purpose",
      requiresApproval: false, rejected: null,
    }],
  };
  // ctx.sources is an OPEN plugin array (Plan 09 registers two more). Shipped code returns
  // netPaise -10000 here; the belt turns that into a thrown invalid_paise (M3 belt).
  expect(thrownCode(() => priceInvoiceLines(makeCtx({ sources: [rogue] }), [{ lineId: "L1", serviceId: "svc-cons", qty: 1 }])))
    .toBe("invalid_paise");
});
