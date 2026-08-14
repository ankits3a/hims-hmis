import { TariffError } from "./errors";
import { simulateRevision } from "./simulation";
import type { GstCategoryConfig, PricingContext, ServiceInfo } from "./types";

// Pure fixtures, built inline — simulation.ts touches no database, no clock, no randomness.
const SERVICES: Record<string, ServiceInfo> = {
  "svc-cons": { id: "svc-cons", code: "CONS-GEN", name: "General consultation", category: "consultation", regulated: false, active: true },
};

const CATEGORIES: Record<string, GstCategoryConfig> = {
  consultation: { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null },
};

function makeCtx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    asOf: new Date("2026-09-01T00:00:00.000Z"),
    tariff: { versionId: "v1", versionNo: 1, items: { "svc-cons": 50000 } },
    services: SERVICES,
    regulatedPrices: {},
    gst: { categories: CATEGORIES, settings: { compositeHealthcareExempt: true, caSigned: false } },
    rules: [],
    manualCaps: {},
    sources: [],
    tags: [],
    ...overrides,
  };
}

// The draft context: same shape, revised price, a distinct version header (the D5 lock).
function makeDraftCtx(overrides: Partial<PricingContext> = {}): PricingContext {
  return makeCtx({ tariff: { versionId: "v2", versionNo: 2, items: { "svc-cons": 60000 } }, ...overrides });
}

test("a price change on an exempt service reports the net delta with zero tax delta", () => {
  const report = simulateRevision(makeCtx(), makeDraftCtx(), [{ lineId: "L1", serviceId: "svc-cons", qty: 1 }]);
  expect(report.lines).toEqual([
    { lineId: "L1", serviceId: "svc-cons", currentNetPaise: 50000, draftNetPaise: 60000, deltaPaise: 10000 },
  ]);
  expect(report.totals).toEqual({
    currentNetPaise: 50000, draftNetPaise: 60000, deltaPaise: 10000,
    currentTaxPaise: 0, draftTaxPaise: 0, taxDeltaPaise: 0,
  });
});

test("byService aggregates two lines of the same service into one sorted row", () => {
  const report = simulateRevision(makeCtx(), makeDraftCtx(), [
    { lineId: "L1", serviceId: "svc-cons", qty: 1 },
    { lineId: "L2", serviceId: "svc-cons", qty: 2 },
  ]);
  expect(report.byService).toEqual([
    { serviceId: "svc-cons", currentNetPaise: 150000, draftNetPaise: 180000, deltaPaise: 30000 },
  ]);
});

test("empty lines yield a zeroed report, and a draft missing a priced item throws tariff_item_missing", () => {
  expect.assertions(3);

  const empty = simulateRevision(makeCtx(), makeDraftCtx(), []);
  expect(empty).toEqual({
    lines: [],
    totals: { currentNetPaise: 0, draftNetPaise: 0, deltaPaise: 0, currentTaxPaise: 0, draftTaxPaise: 0, taxDeltaPaise: 0 },
    byService: [],
  });

  try {
    simulateRevision(makeCtx(), makeDraftCtx({ tariff: { versionId: "v2", versionNo: 2, items: {} } }), [
      { lineId: "L1", serviceId: "svc-cons", qty: 1 },
    ]);
  } catch (e) {
    expect(e).toBeInstanceOf(TariffError);
    expect((e as TariffError).code).toBe("tariff_item_missing");
  }
});
