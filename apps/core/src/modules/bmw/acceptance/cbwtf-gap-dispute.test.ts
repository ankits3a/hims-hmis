import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, actorOf, bagInStore, clockNow, hours, minutes, seedBmwHospital } from "../../../../test/helpers/bmw";
import { bmwBags, bmwDisputes } from "../../../kernel/db/schema";
import { handOverManifest, recordCbwtfWeight, verifyManifestGap } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { BmwHospital } from "../../../../test/helpers/bmw";

/**
 * DONE MEANS (spec §11): "A 6 % gap between department and CBWTF weight creates a dispute record." DECIDED:
 * |cbwtf − dept| / dept ≥ 6 %, per manifest category — so 6.0 % disputes and 5.9 % does not.
 */
describe("acceptance — a 6 % weight gap opens a dispute", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: BmwHospital;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    h = await seedBmwHospital(db, hours(t0, -6));
  });

  async function manifestOf(barcodes: string[], at: Date): Promise<string> {
    const m = await handOverManifest(db, actorOf(SUP1), { barcodes, cbwtfName: "Bihar Biocare CBWTF", vehicleNo: "BR06GA1234" }, at);
    return m.id;
  }

  it("6.0 % (1000 g → 1060 g, per category slip) creates one dispute with both weights; the bags are disputed", async () => {
    const a = await bagInStore(db, h.roomA, "yellow", 600, hours(t0, -5));
    const b = await bagInStore(db, h.roomB, "yellow", 400, hours(t0, -5));
    const id = await manifestOf([a, b], hours(t0, -1));
    const r = await recordCbwtfWeight(db, actorOf(SUP1), { manifestId: id, byCategory: [{ category: "yellow", grams: 1060 }] }, t0);

    expect(r.disputes).toHaveLength(1);
    const rows = await db.select().from(bmwDisputes).where(eq(bmwDisputes.manifestId, id));
    expect(rows).toEqual([expect.objectContaining({ category: "yellow", deptGrams: 1000, cbwtfGrams: 1060, gapBasisPoints: 600, state: "open" })]);
    const bags = await db.select().from(bmwBags).where(eq(bmwBags.manifestId, id));
    expect(bags.map((x) => x.state)).toEqual(["disputed", "disputed"]);
    expect(bags.reduce((n, x) => n + x.cbwtfWeightGrams!, 0)).toBe(1060); // the slip, split over the bags, sums exactly
  });

  it("5.9 % (1000 g → 1059 g) creates no dispute; the bags are treated", async () => {
    const a = await bagInStore(db, h.roomA, "red", 1000, hours(t0, -5));
    const id = await manifestOf([a], hours(t0, -1));
    const r = await recordCbwtfWeight(db, actorOf(SUP1), { manifestId: id, byBag: [{ barcode: a, grams: 1059 }] }, t0);
    expect(r.disputes).toHaveLength(0);
    expect(await db.select().from(bmwDisputes)).toHaveLength(0);
    expect((await db.select().from(bmwBags).where(eq(bmwBags.barcode, a)))[0]).toMatchObject({ state: "treated", cbwtfWeightGrams: 1059 });
  });

  it("the gap is per category and either way: 6 % light disputes blue, red at 2 % stays clean", async () => {
    const red = await bagInStore(db, h.roomA, "red", 500, hours(t0, -5));
    const blue = await bagInStore(db, h.roomB, "blue", 500, hours(t0, -5));
    const id = await manifestOf([red, blue], minutes(t0, -30));
    await recordCbwtfWeight(db, actorOf(SUP1), { manifestId: id, byBag: [{ barcode: red, grams: 510 }, { barcode: blue, grams: 470 }] }, t0);
    expect((await db.select().from(bmwDisputes)).map((d) => [d.category, d.gapBasisPoints])).toEqual([["blue", -600]]);
    expect((await verifyManifestGap(db, id)).map((g) => [g.category, g.flagged])).toEqual([["red", false], ["blue", true]]);
  });
});
