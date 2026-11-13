import { readControlFile, recountRows, rowUnits } from "./stock-entry-recount";
import type { CountedRow } from "./stock-entry-recount";
import type { WireStockItem } from "../../lib/stock-entry-api";

/** #1047 — the recount's control file, read and compared in the browser (pure). */
const item = (code: string, name: string): WireStockItem => ({
  itemId: `it-${code}`, code, name, baseUom: "tablet", packs: [], gstRateBps: 500, hsnCode: null, onSale: true, active: true,
  strength: null, form: null, schedule: null, rack: null, mrpPaise: null, mrpUom: null,
});
const row = (it: WireStockItem | null, over: Partial<CountedRow> = {}): CountedRow => ({
  item: it, packSize: "10", packs: "", freePacks: "", boxes: "", perBox: "", ...over,
});

describe("the recount control file (#1047)", () => {
  it("reads item and quantity under any of their names, adds a medicine's lines up, and names the lines it could not read", () => {
    const f = readControlFile("c.csv", "﻿Item Code,Qty\nDOLO650,60\n\"Pan 40, strip\",15\ndolo650,10\nBAD,ten\n,4\n");
    expect(f.rows).toEqual([{ key: "DOLO650", qty: 70 }, { key: "Pan 40, strip", qty: 15 }]);
    expect(f.errors).toEqual(["5", "6"]);
    expect(readControlFile("c.csv", "brand,units\nX,1\n").rows).toEqual([{ key: "X", qty: 1 }]);
    expect(readControlFile("c.csv", "medicine,count\nX,1\n").errors).toEqual(["header"]);
  });

  it("counts a row as (boxes × per box + packs + free) × pack size, and nothing while a cell is not a number", () => {
    expect(rowUnits(row(null, { boxes: "2", perBox: "10", packs: "3", freePacks: "1" }))).toBe(240);
    expect(rowUnits(row(null, { packs: "x" }))).toBeNull();
  });

  it("compares per medicine by code or exact name, and flags a difference on either side", () => {
    const dolo = item("DOLO650", "Dolo 650 tablet");
    const pan = item("PAN40", "Pan 40 tablet");
    const crocin = item("CROC500", "Crocin 500 tablet");
    const out = recountRows(
      [row(dolo, { packs: "3" }), row(dolo, { packs: "3" }), row(pan, { packs: "1" }), row(crocin, { packs: "2" })],
      [{ key: "dolo650", qty: 60 }, { key: "Pan 40 tablet", qty: 20 }, { key: "AZEE500", qty: 30 }],
    );
    expect(out.map((r) => [r.key, r.entered, r.control, r.differs])).toEqual([
      ["AZEE500", 0, 30, true], ["CROC500", 20, null, true], ["PAN40", 10, 20, true], ["DOLO650", 60, 60, false],
    ]);
  });
});
