import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PharmacyError } from "./errors";
import { gstCategoryFor, priceForBatch } from "./price";
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
  it("the fixture file carries every winner and both refusals", () => {
    const winners = new Set(FIXTURE.cases.map((c) => ("winner" in c.expect ? c.expect.winner : `error:${c.expect.error}`)));
    expect([...winners].sort()).toEqual(["batch_mrp", "ceiling", "error:price_unknown"]);
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const input: BatchPriceInput = { uoms: c.uoms, batch: c.batch, regulation: c.regulation };
      if ("error" in c.expect) {
        expect(() => priceForBatch(input)).toThrow(expect.objectContaining({ code: c.expect.error }));
        return;
      }
      expect(priceForBatch(input)).toEqual(c.expect);
    });
  }

  it("A2 — a cap never exceeds either term, and the winner is the lower one", () => {
    // The property behind the golden rows: for every priced case cap === min(mrp ?? ceiling, ceiling ?? mrp).
    for (const c of FIXTURE.cases) {
      if ("error" in c.expect) continue;
      const p = priceForBatch({ uoms: c.uoms, batch: c.batch, regulation: c.regulation });
      const terms = [p.mrpPaisePerBase, p.ceilingPaisePerBase].filter((x): x is number => x !== null);
      expect(p.capUnitPaise).toBe(Math.min(...terms));
      expect(p.capUnitPaise).toBeLessThanOrEqual(p.batchUnitPaise);
    }
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
