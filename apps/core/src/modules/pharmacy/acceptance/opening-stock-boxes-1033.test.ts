import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { seedPharmacyBase } from "../../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { grnLines } from "../../../kernel/db/schema";
import { captureOpeningStock, planOpeningStock, readOpeningSheet } from "../opening-stock";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1033, spec docs/specs/1033-opening-stock-boxes.md (owner APPROVED 2026-11-06).
 * The opening-stock sheet counts whole boxes too: total packs = boxes × packs_per_box + packs (the loose ones).
 * D5 (the grid) is the web half: apps/web/src/screens/acceptance/opening-stock-boxes-1033.test.tsx.
 */
describe("opening stock counts whole boxes (spec #1033)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    for (const p of ["materials.items.manage", "materials.vendors.manage"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
  });
  afterEach(() => { fx.unregister(); });

  const OLD = "brand,batch,expiry,mrp_per_pack,pack_size,packs";
  const NEW = `${OLD},boxes,packs_per_box`;
  const year = (): string => String(new Date().getUTCFullYear() + 1);
  const plan = async (text: string) => planOpeningStock(db, readOpeningSheet(text), text, new Date());

  it("spec #1033 D1: boxes 3 × 10 per box + 4 loose strips of 15 captures one GRN line of 34 strips = 510 tablets", async () => {
    const text = `${NEW}\nCrocin 500,BX1,08/${year()},35.50,15,4,3,10\n`;
    const p = await plan(text);
    expect(p.rows.flatMap((r) => r.reasons)).toEqual([]);
    expect(p.rows[0]!.packs).toBe(34);
    expect(p.units).toBe(510);
    const done = await captureOpeningStock(db, fx.incharge.actor, p, new Date());
    expect(done.captured).toHaveLength(1);
    const lines = await db.select().from(grnLines).where(eq(grnLines.grnId, done.captured[0]!.grnId));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.qtyInUom).toBe(34);
  });

  it("spec #1033 D2: boxes without packs_per_box (blank or 0) refuses the file, naming the line and the column", async () => {
    for (const per of ["", "0"]) {
      const p = await plan(`${NEW}\nCrocin 500,BX2,08/${year()},35.50,15,4,3,${per}\n`);
      expect(p.refusals).toBe(1);
      expect(p.rows[0]!.line).toBe(2); // the sheet's own line: the header is line 1
      expect(p.rows[0]!.reasons.join(" ")).toContain("packs_per_box");
    }
  });

  it("spec #1033 D3: a sheet without the two new columns captures exactly what it captures today", async () => {
    const p = await plan(`${OLD}\nCrocin 500,BX3,08/${year()},35.50,15,4\n`);
    expect(p.rows.flatMap((r) => r.reasons)).toEqual([]);
    expect(p.rows[0]!.packs).toBe(4);
    expect(p.units).toBe(60);
  });

  it("spec #1033 D4: boxes with packs blank is accepted; no boxes and no packs is refused as today", async () => {
    const ok = await plan(`${NEW}\nCrocin 500,BX4,08/${year()},35.50,15,,2,10\n`);
    expect(ok.rows.flatMap((r) => r.reasons)).toEqual([]);
    expect(ok.rows[0]!.packs).toBe(20);
    const none = await plan(`${NEW}\nCrocin 500,BX5,08/${year()},35.50,15,,,\n`);
    expect(none.refusals).toBe(1);
    expect(none.rows[0]!.reasons.join(" ")).toContain("packs");
  });

  it("spec #1033 D6: the CSV template and the runbook list both columns, with an example row", () => {
    const root = resolve(__dirname, "../../../../../..");
    const csv = readFileSync(resolve(root, "docs/runbooks/pharmacy-opening-stock-template.csv"), "utf8").trim().split("\n");
    const header = csv[0]!.split(",");
    expect(header).toEqual(expect.arrayContaining(["boxes", "packs_per_box"]));
    const bi = header.indexOf("boxes");
    expect(csv.slice(1).some((row) => (row.split(",")[bi] ?? "").trim() !== "")).toBe(true);
    const runbook = readFileSync(resolve(root, "docs/runbooks/pharmacy-opening-stock.md"), "utf8");
    expect(runbook).toContain("`boxes`");
    expect(runbook).toContain("`packs_per_box`");
  });
});
