import { and, eq, like } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, SUP2, W1, actorOf, bagInStore, clockNow, hours, seedBmwHospital } from "../../../../test/helpers/bmw";
import { alerts } from "../../../kernel/db/schema";
import { generateBag, sweepBmwStorage } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { BmwHospital } from "../../../../test/helpers/bmw";

/**
 * DONE MEANS (spec §11): "A waste bag older than 48 hours in storage raises an alert; one at 36 hours warns."
 * The clock is driven with an explicit `now` (t0, rounded off the real clock); bags are generated relative to it.
 */
describe("acceptance — the 48-hour storage clock", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: BmwHospital;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    h = await seedBmwHospital(db, hours(t0, -72));
  });

  const bell = (kind: string) => db.select().from(alerts).where(and(eq(alerts.kind, kind), like(alerts.sourceEventId, "bmw:storage:%")));

  it("49 h in storage alerts every BMW supervisor; 37 h warns; 35 h says nothing", async () => {
    await bagInStore(db, h.roomA, "yellow", 1500, hours(t0, -49));
    await bagInStore(db, h.roomB, "red", 800, hours(t0, -37));
    await bagInStore(db, h.roomB, "blue", 400, hours(t0, -35));

    const r = await sweepBmwStorage(db, t0);
    expect(r).toMatchObject({ alert: 1, warning: 1 });

    const alerted = await bell("bmw.storage_alert");
    expect(alerted.map((a) => a.userId).sort()).toEqual([SUP1, SUP2].sort());
    expect(alerted[0]!.title).toContain("48 h");
    const warned = await bell("bmw.storage_warning");
    expect(warned.map((a) => a.userId).sort()).toEqual([SUP1, SUP2].sort());
    expect(warned[0]!.title).toContain("37 h");
    expect(await db.select().from(alerts).where(like(alerts.sourceEventId, "bmw:storage:%"))).toHaveLength(4);
  });

  it("the boundary: 35 h 59 min is quiet, 36 h warns, 47 h 59 min still only warns, 48 h alerts", async () => {
    await bagInStore(db, h.roomA, "yellow", 1000, hours(t0, -48));
    expect(await sweepBmwStorage(db, new Date(t0.getTime() - 12 * 3_600_000 - 60_000))).toMatchObject({ warning: 0, alert: 0 });
    expect(await sweepBmwStorage(db, hours(t0, -12))).toMatchObject({ warning: 1, alert: 0 });
    expect(await sweepBmwStorage(db, new Date(t0.getTime() - 60_000))).toMatchObject({ warning: 1, alert: 0 });
    expect(await sweepBmwStorage(db, t0)).toMatchObject({ warning: 0, alert: 1 });
  });

  it("a second tick raises nothing twice; a bag never collected is on the clock too", async () => {
    await generateBag(db, actorOf(W1), { category: "white_translucent", placeResourceId: h.roomA, deptWeightGrams: 300 }, hours(t0, -50));
    const first = await sweepBmwStorage(db, t0);
    const second = await sweepBmwStorage(db, hours(t0, 0.5));
    expect(first.noticesRaised).toBe(2);
    expect(second).toMatchObject({ alert: 1, noticesRaised: 0 });
    expect(await bell("bmw.storage_alert")).toHaveLength(2);
  });
});
