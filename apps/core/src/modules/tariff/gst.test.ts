import { TariffError } from "./errors";
import { computeGst } from "./gst";
import type { GstCategoryConfig, GstSettings, InvoiceLineInput } from "./types";

const CONSULTATION: GstCategoryConfig = { category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null };
const PHARMACY: GstCategoryConfig = { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null };
const DEVICE: GstCategoryConfig = { category: "device", sacCode: "9021", exempt: false, rateBps: 500, specialRule: null, thresholdPaise: null };
const ROOM: GstCategoryConfig = { category: "room_rent", sacCode: "999311", exempt: false, rateBps: 500, specialRule: "room_rent_daily_threshold", thresholdPaise: 500000 };

const SETTINGS: GstSettings = { compositeHealthcareExempt: true, caSigned: false };

function line(over: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return { lineId: "L1", serviceId: "svc-x", qty: 1, ...over };
}

function thrownCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return e instanceof TariffError ? e.code : `not-a-TariffError: ${String(e)}`;
  }
  return null;
}

test("a category-exempt line is exempt AND still echoes its nonzero would-be rate", () => {
  const gst = computeGst({ cfg: CONSULTATION, settings: SETTINGS, line: line(), taxableBasePaise: 50000, qty: 1 });
  // rateBps 1800 would give heads of 4500 each if the exempt flag were ignored — the nonzero rate is what gives
  // this assertion teeth: "exempt honored" is distinguishable from "the rate happened to be zero".
  expect(gst.rateBps).toBe(1800);
  expect(gst.cgstPaise).toBe(0);
  expect(gst.sgstPaise).toBe(0);
  expect(gst).toEqual({ sacCode: "999312", rateBps: 1800, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 });
});

test("a composite healthcare supply exempts an otherwise TAXABLE category", () => {
  const gst = computeGst({
    cfg: PHARMACY, settings: SETTINGS,
    line: line({ supplyContext: "composite_healthcare" }), taxableBasePaise: 18875, qty: 1,
  });
  expect(gst).toEqual({ sacCode: "3004", rateBps: 1200, exempt: true, exemptReason: "composite_healthcare", cgstPaise: 0, sgstPaise: 0 });
});

test("the compositeHealthcareExempt setting is consulted — false leaves the same line taxable", () => {
  const gst = computeGst({
    cfg: PHARMACY, settings: { compositeHealthcareExempt: false, caSigned: false },
    line: line({ supplyContext: "composite_healthcare" }), taxableBasePaise: 18875, qty: 1,
  });
  expect(gst).toEqual({ sacCode: "3004", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 1133, sgstPaise: 1133 });
});

test("the room-rent threshold is thresholdPaise x qty and 'exceeding' is strictly greater", () => {
  // qty 2, base 960000: threshold x qty = 1,000,000 -> exempt. A `base > thresholdPaise` implementation
  // (960000 > 500000) would call this taxable — killed.
  expect(computeGst({ cfg: ROOM, settings: SETTINGS, line: line({ qty: 2 }), taxableBasePaise: 960000, qty: 2 }))
    .toEqual({ sacCode: "999311", rateBps: 500, exempt: true, exemptReason: "room_rent_at_or_below_threshold", cgstPaise: 0, sgstPaise: 0 });

  // exactly at the line, qty 1: 500000 > 500000 is false -> exempt. A `>=` implementation taxes this — killed.
  expect(computeGst({ cfg: ROOM, settings: SETTINGS, line: line(), taxableBasePaise: 500000, qty: 1 }))
    .toEqual({ sacCode: "999311", rateBps: 500, exempt: true, exemptReason: "room_rent_at_or_below_threshold", cgstPaise: 0, sgstPaise: 0 });

  // one paise above threshold x qty -> taxable; head = divHalfUp(1000001 * 500, 20000) = 25000 (exact 25000.025)
  expect(computeGst({ cfg: ROOM, settings: SETTINGS, line: line({ qty: 2 }), taxableBasePaise: 1000001, qty: 2 }))
    .toEqual({ sacCode: "999311", rateBps: 500, exempt: false, exemptReason: null, cgstPaise: 25000, sgstPaise: 25000 });
});

test("the room-rent rule without a thresholdPaise is a loud config error", () => {
  const call = () => computeGst({
    cfg: { ...ROOM, thresholdPaise: null }, settings: SETTINGS, line: line(), taxableBasePaise: 600000, qty: 1,
  });
  expect(call).toThrow(TariffError);
  expect(thrownCode(call)).toBe("gst_config_invalid");
});

test("each head is computed independently at half the rate, half-up (833, not 834)", () => {
  // divHalfUp(33333 * 500, 20000) = divHalfUp(16,666,500, 20000) = 833 (exact 833.325)
  expect(computeGst({ cfg: DEVICE, settings: SETTINGS, line: line(), taxableBasePaise: 33333, qty: 1 }))
    .toEqual({ sacCode: "9021", rateBps: 500, exempt: false, exemptReason: null, cgstPaise: 833, sgstPaise: 833 });
});

test("a half-paise head rounds UP — banker's and truncation both say 1132", () => {
  // divHalfUp(18875 * 1200, 20000) = divHalfUp(22,650,000, 20000) = 1133 (exact 1132.5)
  expect(computeGst({ cfg: PHARMACY, settings: SETTINGS, line: line(), taxableBasePaise: 18875, qty: 1 }))
    .toEqual({ sacCode: "3004", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 1133, sgstPaise: 1133 });
});
