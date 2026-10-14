import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { W1, actorOf, clockNow, minutes, seedBmwHospital } from "../../../../test/helpers/bmw";
import { bmwBags } from "../../../kernel/db/schema";
import { generateBag, renderBagLabelJob } from "../index";
import type { BmwCategory } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { BmwHospital } from "../../../../test/helpers/bmw";

/**
 * DONE MEANS (brief §7 iv): every bag has a unique bar-code label — generated together, at one place, in one minute,
 * of one colour, still unique; and each label carries its own code, category, place and the occupier.
 */
describe("acceptance — every bag has a unique bar-code label", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: BmwHospital;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    h = await seedBmwHospital(db, t0);
  });

  it("24 bags generated at once, same place, same minute: 24 different codes, each on its own label", async () => {
    const cats: BmwCategory[] = ["yellow", "red", "white_translucent", "blue"];
    const made = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      generateBag(db, actorOf(W1), { category: i < 12 ? "yellow" : cats[i % 4]!, placeResourceId: h.roomA }, t0)));
    const codes = made.map((m) => m.bag.barcode);
    expect(new Set(codes).size).toBe(24);
    for (const m of made) {
      expect(m.label.via).toBe("browser"); // no relay serves the label printer on a fresh box
      const html = m.label.via === "browser" ? m.label.document.html : "";
      expect(html).toContain(`data-barcode="${m.bag.barcode}"`);
      expect(html).toContain("Room 201");
      expect(codes.filter((c) => html.includes(c))).toEqual([m.bag.barcode]);
    }
    // The relay's reprint draws the same label from the bag row.
    const again = await renderBagLabelJob(db, { bagId: made[0]!.bag.id });
    expect(again?.html).toContain(made[0]!.bag.barcode);
  });

  it("the store refuses a second bag with a code already issued", async () => {
    const { bag } = await generateBag(db, actorOf(W1), { category: "red", placeResourceId: h.roomA }, minutes(t0, 1));
    await expect(db.execute(sql`insert into bmw_bags (id, barcode, category, place_resource_id, generated_at, generated_by)
      values ('dup', ${bag.barcode}, 'red', ${h.roomA}, now(), ${W1})`)).rejects.toThrow(/bmw_bags_barcode_uq/);
    expect(await db.select().from(bmwBags)).toHaveLength(1);
  });
});
