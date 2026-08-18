import { totalInvoice } from "./totals";
import type { PricedLine } from "../tariff";

/**
 * Plan 08 D3 / Task 2. Every number here is hand-derived in the plan document (Task 2's step list and
 * self-review 18-20) — none was read back from a run. The shipped primitives the derivations use:
 * `taxHead(base, rate) = divHalfUp(base x rate, 20000)` and `roundTotalToRupee(t) = divHalfUp(t, 100) x 100`.
 */
function priced(args: {
  lineId: string; grossPaise: number; discountPaise: number;
  sacCode: string; rateBps: number; exempt: boolean; headPaise: number;
}): PricedLine {
  const taxableBasePaise = args.grossPaise - args.discountPaise;
  return {
    lineId: args.lineId, serviceId: `svc-${args.lineId}`, serviceName: `Service ${args.lineId}`,
    category: "pharmacy", qty: 1, unitPaise: args.grossPaise, grossPaise: args.grossPaise,
    regulatedClamp: null, candidates: [], winner: null,
    discountPaise: args.discountPaise, taxableBasePaise,
    gst: {
      sacCode: args.sacCode, rateBps: args.rateBps, exempt: args.exempt,
      exemptReason: args.exempt ? "category_exempt" : null,
      cgstPaise: args.headPaise, sgstPaise: args.headPaise,
    },
    netPaise: taxableBasePaise + args.headPaise + args.headPaise, // the engine's own identity (pricing.ts)
  };
}

const PHARMACY = { sacCode: "3004", rateBps: 1200, exempt: false };
const DEVICE = { sacCode: "9021", rateBps: 500, exempt: false };
const EXEMPT_CARE = { sacCode: "999312", rateBps: 1800, exempt: true };

describe("totalInvoice (pure, D3)", () => {
  it("B-01: sums the line HEADS — 3399, not the 3398 an invoice-level recompute yields (§15.1)", () => {
    // taxHead(18875, 1200) = divHalfUp(22,650,000, 20,000) = floor((45,300,000 + 20,000) / 40,000) = floor(1133.0) = 1133.
    // Three such lines: 3 x 1133 = 3399 per head. taxHead(56625, 1200) = floor((135,900,000 + 20,000) / 40,000) = 3398.
    const lines = ["L1", "L2", "L3"].map((lineId) => priced({ ...PHARMACY, lineId, grossPaise: 18875, discountPaise: 0, headPaise: 1133 }));
    const totals = totalInvoice(lines);
    expect(totals.cgstPaise).toBe(3399);
    expect(totals.sgstPaise).toBe(3399);
    expect(totals.taxableBasePaise).toBe(56625);
  });

  it("B-02: the two heads are line heads, never a GST total split in half (§15.2)", () => {
    // taxHead(33333, 500) = divHalfUp(16,666,500, 20,000) = floor((33,333,000 + 20,000) / 40,000) = floor(833.825) = 833.
    // percentAmount(33333, 500) = divHalfUp(16,666,500, 10,000) = floor((33,333,000 + 10,000) / 20,000) = floor(1667.15) = 1667,
    // which split 834/833 would post a GST total of 1667 where the Book value is 1666.
    const totals = totalInvoice([priced({ ...DEVICE, lineId: "L1", grossPaise: 33333, discountPaise: 0, headPaise: 833 })]);
    expect(totals.cgstPaise).toBe(833);
    expect(totals.sgstPaise).toBe(833);
    expect(totals.cgstPaise + totals.sgstPaise).toBe(1666);
  });

  it("B-03: §170 rounding is applied ONCE to the raw total — the 5651/5582 pair discriminates, 5617/5616 does not", () => {
    // roundTotalToRupee(11233) = divHalfUp(11233, 100) x 100 = floor((22,466 + 100) / 200) x 100 = floor(112.83) x 100 = 11200.
    // Rounding each line first: 5651 -> 5700 and 5582 -> 5600, summing to 11300. (The plan's first candidate
    // pair 5617/5616 rounds to 5600 + 5600 = 11200 either way and proves nothing — self-review item 3.)
    const lines = [5651, 5582].map((grossPaise, i) => priced({ ...EXEMPT_CARE, lineId: `L${i + 1}`, grossPaise, discountPaise: 0, headPaise: 0 }));
    const totals = totalInvoice(lines);
    expect(totals.rawTotalPaise).toBe(11233);
    expect(totals.netPayablePaise).toBe(11200);
    expect(totals.roundingPaise).toBe(-33);
  });

  it("groups the tax summary by (sacCode, rateBps, exempt) — two like lines merge into one GSTR-1 row", () => {
    // Merged base 2 x 18875 = 37750 and merged heads 2 x 1133 = 2266. A report layer that recomputed
    // from the merged base would post taxHead(37750, 1200) = floor((90,600,000 + 20,000) / 40,000) = 2265.
    const lines = ["L1", "L2"].map((lineId) => priced({ ...PHARMACY, lineId, grossPaise: 18875, discountPaise: 0, headPaise: 1133 }));
    expect(totalInvoice(lines).taxSummary).toEqual([
      { sacCode: "3004", rateBps: 1200, exempt: false, taxableBasePaise: 37750, cgstPaise: 2266, sgstPaise: 2266 },
    ]);
  });

  it("does NOT merge two lines that differ only in `exempt` — the same SAC and rate can be taxed and exempt in one invoice", () => {
    const lines = [
      priced({ ...PHARMACY, lineId: "L1", grossPaise: 18875, discountPaise: 0, headPaise: 1133 }),
      priced({ sacCode: "3004", rateBps: 1200, exempt: true, lineId: "L2", grossPaise: 10000, discountPaise: 0, headPaise: 0 }),
    ];
    expect(totalInvoice(lines).taxSummary).toEqual([
      { sacCode: "3004", rateBps: 1200, exempt: false, taxableBasePaise: 18875, cgstPaise: 1133, sgstPaise: 1133 },
      { sacCode: "3004", rateBps: 1200, exempt: true, taxableBasePaise: 10000, cgstPaise: 0, sgstPaise: 0 },
    ]);
  });

  it("splits turnover taxable vs exempt NET of line discounts (the Rule 42/43 split)", () => {
    // Exempt line: gross 10000 - discount 1000 = taxableBase 9000, so exemptTurnover is 9000, not 10000.
    const lines = [
      priced({ ...EXEMPT_CARE, lineId: "L1", grossPaise: 10000, discountPaise: 1000, headPaise: 0 }),
      priced({ ...PHARMACY, lineId: "L2", grossPaise: 18875, discountPaise: 0, headPaise: 1133 }),
    ];
    const totals = totalInvoice(lines);
    expect(totals.exemptTurnoverPaise).toBe(9000);
    expect(totals.taxableTurnoverPaise).toBe(18875);
  });

  it("gross, discount and taxable base are folds over the lines — nothing is re-derived", () => {
    const lines = [
      priced({ ...EXEMPT_CARE, lineId: "L1", grossPaise: 10000, discountPaise: 1000, headPaise: 0 }),
      priced({ ...PHARMACY, lineId: "L2", grossPaise: 18875, discountPaise: 0, headPaise: 1133 }),
    ];
    const totals = totalInvoice(lines);
    expect(totals.grossPaise).toBe(28875);
    expect(totals.discountPaise).toBe(1000);
    expect(totals.taxableBasePaise).toBe(27875);
  });

  it("rawTotalPaise is Σ line netPaise — the zero-discount identity 102208 + 1966 + 1966 = 106140", () => {
    const lines = [
      priced({ ...PHARMACY, lineId: "L1", grossPaise: 18875, discountPaise: 0, headPaise: 1133 }), // net 21141
      priced({ ...DEVICE, lineId: "L2", grossPaise: 33333, discountPaise: 0, headPaise: 833 }), // net 34999
      priced({ ...EXEMPT_CARE, lineId: "L3", grossPaise: 50000, discountPaise: 0, headPaise: 0 }), // net 50000
    ];
    const totals = totalInvoice(lines);
    expect(totals.rawTotalPaise).toBe(106140);
    expect(totals.cgstPaise).toBe(1966);
    expect(totals.sgstPaise).toBe(1966);
  });

  it("a rupee-exact raw total rounds to itself: rounding 0", () => {
    // taxHead(5000, 1200) = divHalfUp(6,000,000, 20,000) = floor((12,000,000 + 20,000) / 40,000) = floor(300.5) = 300;
    // net 5000 + 300 + 300 = 5600, already a whole rupee.
    const totals = totalInvoice([priced({ ...PHARMACY, lineId: "L1", grossPaise: 5000, discountPaise: 0, headPaise: 300 })]);
    expect(totals.rawTotalPaise).toBe(5600);
    expect(totals.netPayablePaise).toBe(5600);
    expect(totals.roundingPaise).toBe(0);
  });

  it("netPayable = rawTotal + rounding, downwards and upwards", () => {
    const down = totalInvoice([5651, 5582].map((grossPaise, i) => priced({ ...EXEMPT_CARE, lineId: `L${i + 1}`, grossPaise, discountPaise: 0, headPaise: 0 })));
    expect(down.netPayablePaise).toBe(down.rawTotalPaise + down.roundingPaise);
    expect(down.roundingPaise).toBe(-33);
    // roundTotalToRupee(34999) = floor((69,998 + 100) / 200) x 100 = floor(350.49) x 100 = 35000, rounding +1.
    const up = totalInvoice([priced({ ...DEVICE, lineId: "L1", grossPaise: 33333, discountPaise: 0, headPaise: 833 })]);
    expect(up.netPayablePaise).toBe(up.rawTotalPaise + up.roundingPaise);
    expect(up.roundingPaise).toBe(1);
  });
});
