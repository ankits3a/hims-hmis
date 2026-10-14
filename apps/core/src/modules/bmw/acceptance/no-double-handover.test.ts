import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, SUP2, actorOf, bagInStore, clockNow, hours, seedBmwHospital } from "../../../../test/helpers/bmw";
import { bmwBagEvents, bmwBags, bmwManifests } from "../../../kernel/db/schema";
import { BmwError, handOverManifest } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { BmwHospital } from "../../../../test/helpers/bmw";

/** DONE MEANS (brief §7 v): a bag cannot be handed over twice — not in sequence, not in a race. */
describe("acceptance — a bag cannot be handed over twice", () => {
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

  const slip = (barcodes: string[]) => ({ barcodes, cbwtfName: "Bihar Biocare CBWTF", vehicleNo: "BR06GA1234" });

  it("the second manifest naming a bag already gone is refused, and writes nothing", async () => {
    const a = await bagInStore(db, h.roomA, "yellow", 900, hours(t0, -4));
    const b = await bagInStore(db, h.roomB, "red", 300, hours(t0, -4));
    const first = await handOverManifest(db, actorOf(SUP1), slip([a]), hours(t0, -1));
    const err = await handOverManifest(db, actorOf(SUP2), slip([b, a]), t0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BmwError);
    expect((err as BmwError).code).toBe("already_handed_over");
    expect(await db.select().from(bmwManifests)).toHaveLength(1);
    expect((await db.select().from(bmwBags).where(eq(bmwBags.barcode, a)))[0]!.manifestId).toBe(first.id);
    expect((await db.select().from(bmwBags).where(eq(bmwBags.barcode, b)))[0]!.state).toBe("stored");
  });

  it("two supervisors hand the same bag over at once: exactly one manifest gets it", async () => {
    const a = await bagInStore(db, h.roomA, "blue", 700, hours(t0, -4));
    const results = await Promise.allSettled([
      handOverManifest(db, actorOf(SUP1), slip([a]), t0),
      handOverManifest(db, actorOf(SUP2), slip([a]), t0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as BmwError).code).toBe("already_handed_over");
    const bag = (await db.select().from(bmwBags).where(eq(bmwBags.barcode, a)))[0]!;
    expect((await db.select().from(bmwBagEvents).where(eq(bmwBagEvents.bagId, bag.id))).filter((e) => e.act === "handed_over")).toHaveLength(1);
  });
});
