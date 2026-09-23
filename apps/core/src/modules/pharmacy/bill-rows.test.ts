import { displayDraft } from "./bill";
import { mergeBillRows, residueLinesOf } from "./bill-rows";
import type { PricedDraft } from "../billing";
import type { RowLine } from "./bill-rows";

/**
 * ONE ROW PER DRUG (loose-MRP ruling, owner 2026-09-22). 20 tablets of ₹35.50/15 are STORED as
 * `20 × 236 = 4720` and a pack residue `1 × 10`; a person must read ONE Dolo row of ₹47.30 in
 * "1 strip + 5 tablet", never a ₹0.10 row that looks like a twenty-first tablet.
 */
const main: RowLine = { id: "l1", serviceName: "Dolo 650 tablet", qty: 20, unitPaise: 236, grossPaise: 4720, discountPaise: 0, cgstPaise: 112, sgstPaise: 112, netPaise: 4720, sacCode: "3004", rateBps: 500, exempt: false };
const residue: RowLine = { id: "l2", serviceName: "Dolo 650 tablet", qty: 1, unitPaise: 10, grossPaise: 10, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, netPaise: 10, sacCode: "3004", rateBps: 500, exempt: false };
const other: RowLine = { id: "l3", serviceName: "Crocin 500 tablet", qty: 10, unitPaise: 1200, grossPaise: 12000, discountPaise: 0, cgstPaise: 643, sgstPaise: 643, netPaise: 12000, sacCode: "3004", rateBps: 1200, exempt: false };
const strip15 = { uom: "strip", multiplier: 15, baseUom: "tablet" };

describe("mergeBillRows — the residue never shows as its own row", () => {
  it("20 tablets of ₹35.50/15: one Dolo row of 4730, read as 1 strip + 5 tablet at ₹35.50 a strip", () => {
    const rows = mergeBillRows([main, residue, other], [
      { mainId: "l1", residueId: "l2", pack: strip15 },
      { mainId: "l3", residueId: null, pack: { uom: "strip", multiplier: 10, baseUom: "tablet" } },
    ]);
    expect(rows.map((r) => [r.serviceName, r.netPaise])).toEqual([["Dolo 650 tablet", 4730], ["Crocin 500 tablet", 12000]]);
    expect(rows.some((r) => r.netPaise === 10)).toBe(false);
    expect(rows[0]).toMatchObject({
      lineIds: ["l1", "l2"], qty: 20, grossPaise: 4730, cgstPaise: 112, sgstPaise: 112, unitPaise: 236,
      pack: { uom: "strip", packs: 1, loose: 5, baseUom: "tablet", packPaise: 3550 },
    });
    // The stored heads are summed, never re-derived: the rows reconcile to the lines exactly.
    const sum = (xs: { grossPaise: number; cgstPaise: number; sgstPaise: number }[]) => xs.reduce((n, x) => n + x.grossPaise + x.cgstPaise + x.sgstPaise, 0);
    expect(sum(rows)).toBe(sum([main, residue, other]));
  });

  it("a line no group names still prints — a bill never loses a line", () => {
    expect(mergeBillRows([other], []).map((r) => r.lineIds)).toEqual([["l3"]]);
  });

  it("the residue of a STORED invoice is the unowned same-service line right after its main line", () => {
    const stored = [
      { id: "a", serviceId: "s-dolo", lineNo: 1 }, { id: "b", serviceId: "s-dolo", lineNo: 2 },
      { id: "c", serviceId: "s-dolo", lineNo: 3 }, { id: "d", serviceId: "s-croc", lineNo: 4 },
    ];
    // a and c are two sale lines of the same drug (two batches): b is a's residue; c has none.
    expect([...residueLinesOf(stored, new Set(["a", "c", "d"])).entries()].map(([k, v]) => [k, v.id])).toEqual([["a", "b"]]);
  });
});

describe("displayDraft — the counter's preview reads one row per drug", () => {
  it("folds the residue draft line into its drug; the totals are billing's, untouched", () => {
    const line = (lineId: string, qty: number, unitPaise: number, cgst: number) => ({
      lineId, serviceId: "s", serviceName: "Dolo 650 tablet", category: "pharmacy_5", qty, unitPaise, grossPaise: qty * unitPaise,
      regulatedClamp: null, candidates: [], winner: null, discountPaise: 0, taxableBasePaise: qty * unitPaise - 2 * cgst,
      gst: { sacCode: "3004", rateBps: 500, exempt: false, exemptReason: null, cgstPaise: cgst, sgstPaise: cgst }, netPaise: qty * unitPaise,
    });
    const draft = {
      tariffVersionId: "v", intendedPayer: "self",
      lines: [line("m", 20, 236, 112), line("r", 1, 10, 0)],
      totals: { grossPaise: 4730, discountPaise: 0, taxableBasePaise: 4506, cgstPaise: 112, sgstPaise: 112, rawTotalPaise: 4730, netPayablePaise: 4700, roundingPaise: -30 },
    } as unknown as PricedDraft;
    const shown = displayDraft(draft, [{
      itemId: "dolo",
      input: { lineId: "m", serviceId: "s", qty: 20 },
      residual: { lineId: "r", serviceId: "s", qty: 1 },
    }], new Map([["dolo", strip15]]));
    expect(shown.lines).toHaveLength(1);
    expect(shown.lines[0]).toMatchObject({ lineId: "m", qty: 20, grossPaise: 4730, netPaise: 4730, taxableBasePaise: 4506, pack: { packs: 1, loose: 5, packPaise: 3550 } });
    expect(shown.totals).toEqual(draft.totals);
  });
});
