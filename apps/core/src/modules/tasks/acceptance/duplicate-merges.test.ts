import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, W1, actorOf, clockNow, minutes, seedTaskHospital } from "../../../../test/helpers/tasks";
import { taskEvents, tasks } from "../../../kernel/db/schema";
import { raiseTask } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { TaskHospital } from "../../../../test/helpers/tasks";

/**
 * DONE MEANS (spec §2 edge case): "duplicate requests for one place within 10 minutes (merged)".
 */
describe("acceptance — a second request for the same place within ten minutes", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: TaskHospital;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    h = await seedTaskHospital(db, t0);
  });

  it("merges into the open task: same id, merged_count grows, a merged event names who asked", async () => {
    const first = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    const second = await raiseTask(db, actorOf(W1), { kind: "general", placeResourceId: h.roomA, note: "again" }, minutes(t0, 9));
    expect(first.merged).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.mergedCount).toBe(1);
    expect(await db.select().from(tasks)).toHaveLength(1);
    const merged = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, first.task.id), eq(taskEvents.act, "merged")));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actorId).toBe(W1);
  });

  it("does not merge after ten minutes, at another place, or without a place", async () => {
    const first = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    const late = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, minutes(t0, 11));
    const other = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomB }, minutes(t0, 1));
    const noPlace1 = await raiseTask(db, actorOf(SUP1), { kind: "general" }, minutes(t0, 1));
    const noPlace2 = await raiseTask(db, actorOf(SUP1), { kind: "general" }, minutes(t0, 2));
    expect([late, other, noPlace1, noPlace2].map((r) => r.merged)).toEqual([false, false, false, false]);
    expect(new Set([first, late, other, noPlace1, noPlace2].map((r) => r.task.id)).size).toBe(5);
  });

  it("two requests at the same instant become one task", async () => {
    const [a, b] = await Promise.all([
      raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0),
      raiseTask(db, actorOf(W1), { kind: "general", placeResourceId: h.roomA }, t0),
    ]);
    expect(a.task.id).toBe(b.task.id);
    expect([a.merged, b.merged].sort()).toEqual([false, true]);
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
});
