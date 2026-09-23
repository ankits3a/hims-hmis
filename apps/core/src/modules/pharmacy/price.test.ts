import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PharmacyError } from "./errors";
import { gstCategoryFor, priceBatchSale, priceForBatch } from "./price";
import type { BatchPrice, BatchPriceInput } from "./price";

type Case = BatchPriceInput & { name: string; expect: BatchPrice | { error: string } };
type GstCase = { gstRateBps: number | null; category?: string; error?: string };
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, "../../../test/fixtures/pharmacy-price.json"), "utf8")) as {
  cases: Case[]; gst: GstCase[];
};

/**
 * PLAN 16c T2 — THE GOLDEN SUITE (doc 16 §14: "price-rule fixtures per slab and per winner").
 *
 * A2's mutant is `max` for `min` in the ceiling branch: on "CEILING wins" it returns a cap of
 * 1200 where the fixture pins 800 — paise differ, the row dies. The other rows are the
 * per-winner and per-slab table the owner's ruling R-1/R-2 is read against.
 */
describe("priceForBatch — the price rule at batch grain (16c T2, R-1)", () => {
  it("P1 — every case names the GST rate its ceiling is converted at, and some are not nil", () => {
    expect(FIXTURE.cases.every((c) => Number.isInteger(c.taxRateBps))).toBe(true);
    expect(new Set(FIXTURE.cases.map((c) => c.taxRateBps)).size).toBeGreaterThanOrEqual(3);
  });

  it("the fixture file carries every winner and the refusal", () => {
    const winners = new Set(FIXTURE.cases.map((c) => ("winner" in c.expect ? c.expect.winner : `error:${c.expect.error}`)));
    expect([...winners].sort()).toEqual(["batch_mrp", "ceiling", "error:price_unknown"]);
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const input: BatchPriceInput = { uoms: c.uoms, batch: c.batch, regulation: c.regulation, taxRateBps: c.taxRateBps };
      if ("error" in c.expect) {
        expect(() => priceForBatch(input)).toThrow(expect.objectContaining({ code: c.expect.error }));
        return;
      }
      expect(priceForBatch(input)).toEqual(c.expect);
    });
  }

  it("A2 — a cap never exceeds either term, and the winner is the lower one", () => {
    // The property behind the golden rows: for every priced case cap === min(mrp ?? ceiling, ceiling ?? mrp),
    // with the ceiling on the INCLUSIVE basis the MRP is printed on (pharmacy P1, L2).
    for (const c of FIXTURE.cases) {
      if ("error" in c.expect) continue;
      const p = priceForBatch({ uoms: c.uoms, batch: c.batch, regulation: c.regulation, taxRateBps: c.taxRateBps });
      const terms = [p.mrpPaisePerBase, p.ceilingInclusivePaisePerBase].filter((x): x is number => x !== null);
      expect(p.capUnitPaise).toBe(Math.min(...terms));
      expect(p.capUnitPaise).toBeLessThanOrEqual(p.batchUnitPaise);
    }
  });
});

/**
 * THE LOOSE-MRP RULING (owner, money, 2026-09-22): a FULL strip bills at exactly its printed MRP, a
 * LOOSE tablet at its share ROUNDED DOWN. ₹35.50 on a strip of 15.
 */
describe("priceBatchSale — the loose-MRP ruling", () => {
  const dolo = (regulation: BatchPriceInput["regulation"] = null, taxRateBps = 500): BatchPriceInput => ({
    uoms: [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 15 }],
    batch: { mrpPaise: 3550, mrpUom: "strip" }, regulation, taxRateBps,
  });

  it("15 tablets = 3550, 1 tablet = 236, 20 tablets = 4730 — main line at 236 plus the strip's 10-paise residue", () => {
    const strip = priceBatchSale(dolo(), 15);
    expect({ amount: strip.amountPaise, unit: strip.capUnitPaise, residue: strip.residue }).toEqual({ amount: 3550, unit: 236, residue: { qty: 1, unitPaise: 10 } });
    const one = priceBatchSale(dolo(), 1);
    expect({ amount: one.amountPaise, unit: one.capUnitPaise, residue: one.residue }).toEqual({ amount: 236, unit: 236, residue: null });
    const twenty = priceBatchSale(dolo(), 20);
    expect({ amount: twenty.amountPaise, unit: twenty.capUnitPaise, residue: twenty.residue }).toEqual({ amount: 4730, unit: 236, residue: { qty: 1, unitPaise: 10 } });
    // The segments reconcile to the amount, to the paisa: 20 × 236 + 1 × 10.
    expect(20 * twenty.capUnitPaise + twenty.residue!.qty * twenty.residue!.unitPaise).toBe(4730);
    const three = priceBatchSale(dolo(), 45);
    expect(three.amountPaise).toBe(3 * 3550);
    expect(three.residue).toEqual({ qty: 3, unitPaise: 10 });
  });

  it("a pack that divides has no residue and prices exactly as before", () => {
    const p = priceBatchSale({ uoms: [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 10 }], batch: { mrpPaise: 12000, mrpUom: "strip" }, regulation: null, taxRateBps: 500 }, 23);
    expect({ amount: p.amountPaise, unit: p.capUnitPaise, residue: p.residue, winner: p.saleWinner }).toEqual({ amount: 23 * 1200, unit: 1200, residue: null, winner: "batch_mrp" });
  });

  it("the inclusive ceiling gets the same pack/loose split, and the LOWER amount wins", () => {
    // Ceiling ₹33.10 a strip before GST → floor(3475.5) = ₹34.75 inclusive at 5%: below the ₹35.50
    // MRP, and it does not divide by 15 either (231.67 a tablet).
    const p = priceBatchSale(dolo({ ceilingPaise: 3310, mrpUom: "strip" }), 20);
    // 1 × 3475 + 5 × floor(3475 / 15) = 3475 + 5 × 231 = 4630 — main 20 × 231 + the strip's residue 1 × 10
    expect({ amount: p.amountPaise, winner: p.saleWinner, unit: p.capUnitPaise, residue: p.residue })
      .toEqual({ amount: 4630, winner: "ceiling", unit: 231, residue: { qty: 1, unitPaise: 10 } });
    // A ceiling that divides after gross-up (₹33.00 → ₹34.65 = 231 × 15) leaves no residue.
    expect(priceBatchSale(dolo({ ceilingPaise: 3300, mrpUom: "strip" }), 20)).toMatchObject({ amountPaise: 4620, residue: null, saleWinner: "ceiling" });
    // A ceiling above the MRP changes nothing.
    expect(priceBatchSale(dolo({ ceilingPaise: 4000, mrpUom: "strip" }), 20).amountPaise).toBe(4730);
  });
});

describe("gstCategoryFor — the slab is a category (16c T2, S2, R-2)", () => {
  for (const g of FIXTURE.gst) {
    it(`${String(g.gstRateBps)} bps → ${g.category ?? g.error ?? "?"}`, () => {
      if (g.error !== undefined) {
        expect(() => gstCategoryFor(g.gstRateBps)).toThrow(PharmacyError);
        expect(() => gstCategoryFor(g.gstRateBps)).toThrow(expect.objectContaining({ code: g.error }));
        return;
      }
      expect(gstCategoryFor(g.gstRateBps)).toBe(g.category);
      expect(gstCategoryFor(g.gstRateBps).startsWith("pharmacy")).toBe(true); // the T0b guard admits it
    });
  }
});
