import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SUP1, W1, W2, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../test/helpers/tasks";
import { taskEvents, tasks } from "../../kernel/db/schema";
import { myTasks, raiseTask, returnToPool, sweepTasks, taskBoard, acceptTask } from "./index";
import type { Db } from "../../kernel/db/client";
import type { TaskHospital } from "../../../test/helpers/tasks";

describe("tasks — the clock and the read models", () => {
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

  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

  it("not accepted within the window: offered to the next worker once per window", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -90), minutes(t0, 300));
    await putOnDuty(db, h, W2, minutes(t0, -30), minutes(t0, 300));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0);
    expect(task.assigneeId).toBe(W1);

    await sweepTasks(db, minutes(t0, 4));
    expect((await row(task.id)).assigneeId).toBe(W1);
    const r = await sweepTasks(db, minutes(t0, 5));
    expect(r.redispatched).toBe(1);
    expect((await row(task.id)).assigneeId).toBe(W2);
    await sweepTasks(db, minutes(t0, 6));
    expect((await row(task.id)).assigneeId).toBe(W2);
    const moves = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.act, "redispatched")));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.detail).toMatchObject({ from: W1, to: W2, reason: "not_accepted" });
  });

  it("a task handed back is not offered straight back to the same worker", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -90), minutes(t0, 300));
    await putOnDuty(db, h, W2, minutes(t0, -30), minutes(t0, 300));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0);
    await acceptTask(db, actorOf(W1), { taskId: task.id }, minutes(t0, 1));
    await returnToPool(db, actorOf(W1), { taskId: task.id, reason: "cannot lift" }, minutes(t0, 2));
    await sweepTasks(db, minutes(t0, 3));
    expect((await row(task.id)).assigneeId).toBe(W2);
  });

  it("someone coming on duty picks up the pool on the next tick", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0);
    expect(task.state).toBe("created");
    await putOnDuty(db, h, W1, minutes(t0, 10), minutes(t0, 300));
    await sweepTasks(db, minutes(t0, 5));
    expect((await row(task.id)).state).toBe("created");
    await sweepTasks(db, minutes(t0, 10));
    expect((await row(task.id)).assigneeId).toBe(W1);
  });

  it("my list: the pool of my skill, then my held tasks", async () => {
    const t = (await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0)).task;
    const before = await myTasks(db, W1, minutes(t0, 1));
    expect(before.mine).toEqual([]);
    expect(before.pool.map((c) => c.id)).toEqual([t.id]);
    expect(before.pool[0]).toMatchObject({ placeName: "Room 201", placeCode: "201", floorName: "Floor 2", label: "General task" });
    expect((await myTasks(db, SUP1, minutes(t0, 1))).pool).toEqual([]); // a supervisor holds no worker skill
    await putOnDuty(db, h, W1, minutes(t0, 1), minutes(t0, 300));
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    const after = await myTasks(db, W1, minutes(t0, 2));
    expect(after.mine.map((c) => c.id)).toEqual([t.id]);
    expect(after.pool).toEqual([]);
    expect((await myTasks(db, W2, minutes(t0, 2))).mine).toEqual([]);
  });

  it("the board: grouped by floor, late first, worker load, no money and no patient", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 300));
    const early = (await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA, dueAt: minutes(t0, -5).toISOString() }, t0)).task;
    const later = (await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomB }, t0)).task;
    const floorless = (await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0)).task;
    const board = await taskBoard(db, t0);
    expect(board.counts).toMatchObject({ open: 3, late: 1 });
    expect(board.floors[0]!.floorName).toBe("Floor 2");
    expect(board.floors[0]!.tasks.map((c) => c.id)).toEqual([early.id, later.id]);
    expect(board.floors[1]!.tasks.map((c) => c.id)).toEqual([floorless.id]);
    expect(board.workers.find((w) => w.userId === W1)).toMatchObject({ onDuty: true, open: 3 });
    const text = JSON.stringify(board);
    expect(text).not.toMatch(/paise|amount|price|patientName|uhid/i);
  });
});
