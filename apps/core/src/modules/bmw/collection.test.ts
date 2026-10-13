import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SUP1, W1, W2, actorOf, clockNow, minutes, seedBmwHospital } from "../../../test/helpers/bmw";
import { putOnDuty } from "../../../test/helpers/tasks";
import { bmwBagEvents, tasks } from "../../kernel/db/schema";
import { BmwError, collectBag, generateBag, recordDeptWeight, storeBag } from "./index";
import type { Db } from "../../kernel/db/client";
import type { BmwHospital } from "../../../test/helpers/bmw";

/**
 * E1.7 — the bag's road and its collection task: two bags at one place raise ONE task (merged); collecting the last
 * waiting bag closes it with the scan as proof when the collector is on duty with the skill, and cancels it when not.
 */
describe("bmw — collect, store and the collection task", () => {
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

  const placeTasks = () => db.select().from(tasks).where(and(eq(tasks.kind, "bmw_collection"), eq(tasks.placeResourceId, h.roomA)));

  it("on duty: one merged task, done with the last bag's scan; the history has one row per act", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 480));
    const a = await generateBag(db, actorOf(SUP1), { category: "yellow", placeResourceId: h.roomA }, t0);
    const b = await generateBag(db, actorOf(SUP1), { category: "red", placeResourceId: h.roomA, deptWeightGrams: 400 }, minutes(t0, 2));
    expect(b.taskId).toBe(a.taskId);
    await expect(collectBag(db, actorOf(W1), { barcode: a.bag.barcode }, minutes(t0, 5))).rejects.toMatchObject({ code: "weight_needed" });
    await recordDeptWeight(db, actorOf(W1), { barcode: a.bag.barcode, grams: 900 }, minutes(t0, 5));
    await collectBag(db, actorOf(W1), { barcode: a.bag.barcode }, minutes(t0, 6));
    expect((await placeTasks())[0]!.state).not.toBe("done");
    await collectBag(db, actorOf(W1), { barcode: b.bag.barcode.toLowerCase() }, minutes(t0, 7));
    const [task] = await placeTasks();
    expect(task).toMatchObject({ state: "done", doneBy: W1, proof: { kind: "scan", code: b.bag.barcode } });
    const stored = await storeBag(db, actorOf(W1), { barcode: a.bag.barcode, grams: 960 }, minutes(t0, 20));
    expect(stored.centralGap).toBe(true); // 6.7 % over the ward's 900 g
    const events = await db.select().from(bmwBagEvents).where(eq(bmwBagEvents.bagId, a.bag.id));
    expect(events.map((e) => [e.seq, e.act])).toEqual([[1, "generated"], [2, "dept_weighed"], [3, "collected"], [4, "stored"]]);
  });

  it("not on duty: the bags are still taken and the task is cancelled, not left open", async () => {
    const a = await generateBag(db, actorOf(SUP1), { category: "blue", placeResourceId: h.roomA }, t0);
    await collectBag(db, actorOf(W2), { barcode: a.bag.barcode, grams: 300 }, minutes(t0, 3));
    expect((await placeTasks())[0]).toMatchObject({ state: "cancelled", cancelReason: "Bags collected" });
  });

  it("refusals name the step: a stored bag cannot be collected again; cytotoxic is yellow only", async () => {
    const a = await generateBag(db, actorOf(W1), { category: "red", placeResourceId: h.roomA, deptWeightGrams: 200 }, t0);
    await collectBag(db, actorOf(W1), { barcode: a.bag.barcode }, minutes(t0, 1));
    await expect(collectBag(db, actorOf(W1), { barcode: a.bag.barcode }, minutes(t0, 2))).rejects.toMatchObject({ code: "wrong_state" });
    await expect(generateBag(db, actorOf(W1), { category: "red", cytotoxic: true, placeResourceId: h.roomA }, t0)).rejects.toBeInstanceOf(BmwError);
  });
});
