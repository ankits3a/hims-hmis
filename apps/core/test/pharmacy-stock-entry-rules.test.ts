import { and, eq, sql } from "drizzle-orm";
import { withTx } from "../src/kernel/db/client";
import { grnLines, stockBatches } from "../src/kernel/db/schema";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { availableQty, getGrn, postGrn, runGateQc, saleAmountPaise } from "../src/modules/materials";
import { captureOpeningStock, planOpeningStock, readOpeningSheet } from "../src/modules/pharmacy/opening-stock";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ STOCK ENTRY (2026-09-29) — THE RULES EVERY ROW IS JUDGED BY, THROUGH THE SHEET'S OWN DOOR ═══
 *
 * These go through the CSV door on purpose: it is the door that existed before the on-screen grid, so each
 * test here was run against the code before this change and failed there (the loose MRP was refused, the
 * discount and free-packs columns were unknown, a free line could value a pile at nothing). The grid is
 * judged by the same function (`pharmacy-stock-entry.test.ts` proves the grid reaches it).
 *
 *   · LOOSE MRP (owner ruling 2026-09-22, money): ₹35.50 on a strip of 15 is RECEIVED, through QC and post;
 *     a full strip bills ₹35.50 and a loose tablet ₹2.36, rounded down.
 *   · TRADE DISCOUNT lowers the COST only: cost/unit = rate × (1 − d/100) ÷ pack, rounded down.
 *   · FREE PACKS are a free-goods line at cost 0 on the same batch, and the pile keeps the PAID cost.
 */
describe("stock entry — the row rules (loose MRP, trade discount, free packs)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    // The in-charge captures (and adds pack sizes / the OPENING STOCK vendor); the pharmacist QCs and posts.
    for (const p of ["materials.items.manage", "materials.vendors.manage"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
  });
  afterEach(() => { fx.unregister(); });

  const HEADER = "brand,batch,expiry,mrp_per_pack,pack_size,packs,rack,supplier_name,purchase_rate_per_pack,pack_type,free_packs,trade_discount_pct";
  const sheet = (rows: string[]): string => `${HEADER}\n${rows.join("\n")}\n`;
  const year = (): string => String(new Date().getUTCFullYear() + 1);

  async function receive(text: string, now: Date, beforeQc?: (grnId: string) => Promise<void>): Promise<string> {
    const plan = await planOpeningStock(db, readOpeningSheet(text), text, now);
    expect(plan.rows.flatMap((r) => r.reasons)).toEqual([]);
    const done = await captureOpeningStock(db, fx.incharge.actor, plan, now);
    expect(done.captured).toHaveLength(1);
    const grnId = done.captured[0]!.grnId;
    if (beforeQc !== undefined) await beforeQc(grnId);
    const qc = await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, grnId));
    expect(qc.verdicts.map((v) => v.rule ?? v.verdict)).toEqual(qc.verdicts.map(() => "pass"));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, grnId, now));
    return grnId;
  }

  it("LOOSE MRP: ₹35.50 on a strip of 15 is received through QC and post, and bills ₹35.50 a strip and ₹2.36 a loose tablet", async () => {
    const now = new Date();
    // The sheet's original nine columns: this row is exactly what the pharmacist could send before the grid.
    const text = `${HEADER.split(",").slice(0, 9).join(",")}\nCrocin 500,L1,08/${year()},35.50,15,2,,,24.00\n`;
    const plan = await planOpeningStock(db, readOpeningSheet(text), text, now);
    expect(plan.refusals).toBe(0);
    expect(plan.rows[0]).toMatchObject({ uom: "strip15", newUom: true, mrpPaise: 3550, costPerBasePaise: 160 });

    await receive(text, now);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBe(30);
    const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.batchNo, "L1"));
    expect(batch).toMatchObject({ mrpPaise: 3550, mrpUom: "strip15" });
    // The ruling's two prices, from the sale-pricing function the counter uses.
    expect(saleAmountPaise({ mrpPaise: 3550, packMultiplier: 15, qtyBase: 15 }).amountPaise).toBe(3550);
    expect(saleAmountPaise({ mrpPaise: 3550, packMultiplier: 15, qtyBase: 1 }).amountPaise).toBe(236);
  });

  it("TRADE DISCOUNT lowers the cost only — ₹28.00 a strip of 10 less 10% is 252 paise a tablet; the MRP is untouched", async () => {
    const now = new Date();
    const text = sheet([`Crocin 500,D1,08/${year()},40.00,10,3,,,28.00,tablet_strip,,10`]);
    const plan = await planOpeningStock(db, readOpeningSheet(text), text, now);
    expect(plan.rows[0]).toMatchObject({ ratePaise: 2800, discountBps: 1000, costPerBasePaise: 252, mrpPaise: 4000, uom: "strip", newUom: false });

    // A rate above MRP is refused — unless the discount brings the cost to or under it (QC's own comparison).
    const over = sheet([`Crocin 500,D2,08/${year()},40.00,10,1,,,45.00,,,`]);
    expect((await planOpeningStock(db, readOpeningSheet(over), over, now)).rows[0]!.reasons.join()).toMatch(/cost after discount is above MRP/);
    const under = sheet([`Crocin 500,D2,08/${year()},40.00,10,1,,,45.00,,,20`]);
    expect((await planOpeningStock(db, readOpeningSheet(under), under, now)).rows[0]!.reasons).toEqual([]);
    // A discount of 100% or more, or a word, is refused by name.
    const bad = sheet([`Crocin 500,D3,08/${year()},40.00,10,1,,,28.00,,,100`, `Crocin 500,D4,08/${year()},40.00,10,1,,,28.00,,,ten`]);
    expect((await planOpeningStock(db, readOpeningSheet(bad), bad, now)).rows.map((r) => r.reasons.join())).toEqual([
      expect.stringMatching(/trade_discount_pct must be a percentage/), expect.stringMatching(/trade_discount_pct must be a percentage/),
    ]);

    const grnId = await receive(text, now);
    const grn = await getGrn(db, grnId);
    expect(grn?.lines.map((l) => [l.qtyInUom, l.unitCostPaise, l.mrpPaise, l.freeGoods])).toEqual([[3, 252, 4000, false]]);
  });

  it("FREE PACKS are a free-goods line at cost 0 on the same batch, and the pile keeps the PAID cost even when the free line sorts first", async () => {
    const now = new Date();
    const text = sheet([`Crocin 500,F1,08/${year()},40.00,10,3,,,28.00,,1,`]);
    const plan = await planOpeningStock(db, readOpeningSheet(text), text, now);
    expect(plan).toMatchObject({ units: 40, zeroCost: 0 });
    // A row of only free goods is received too; a row of nothing is refused.
    const onlyFree = sheet([`Crocin 500,F2,08/${year()},40.00,10,0,,,,,2,`, `Crocin 500,F3,08/${year()},40.00,10,0,,,,,,`]);
    expect((await planOpeningStock(db, readOpeningSheet(onlyFree), onlyFree, now)).rows.map((r) => r.reasons.length)).toEqual([0, 1]);

    await receive(text, now, async (grnId) => {
      const grn = await getGrn(db, grnId);
      expect(grn?.lines.map((l) => [l.qtyInUom, l.unitCostPaise, l.freeGoods]).sort()).toEqual([[1, 0, true], [3, 280, false]].sort());
      // ulid order is random inside a millisecond: make the free line sort FIRST, the case that valued the pile at 0.
      await db.execute(sql`update ${grnLines} set id = '00000000000000000000000000' where ${and(eq(grnLines.grnId, grnId), eq(grnLines.freeGoods, true))}`);
    });
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBe(40);
    const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.batchNo, "F1"));
    expect(batch?.landedCostPaise).toBe(280);
  });
});
