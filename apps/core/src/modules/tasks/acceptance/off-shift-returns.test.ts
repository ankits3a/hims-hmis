import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, SUP2, W1, W2, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../../test/helpers/tasks";
import { alerts, taskEvents, tasks } from "../../../kernel/db/schema";
import { acceptTask, raiseTask, sweepTasks } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { TaskHospital } from "../../../../test/helpers/tasks";

/**
 * DONE MEANS (spec §2 edge case): "worker goes off shift with a task open (returns to the pool,
 * supervisor told)". The roster is the truth about shifts; the clock is the task sweep.
 */
describe("acceptance — a worker's shift ends with a task open", () => {
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

  it("the task returns to the pool, both supervisors are told, and the next shift's worker gets it", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 30));
    await putOnDuty(db, h, W2, minutes(t0, 30), minutes(t0, 600));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    expect(task.assigneeId).toBe(W1);
    await acceptTask(db, actorOf(W1), { taskId: task.id }, minutes(t0, 1));

    // Still W1's while the shift runs.
    await sweepTasks(db, minutes(t0, 29));
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.assigneeId).toBe(W1);

    const result = await sweepTasks(db, minutes(t0, 31));
    expect(result.returned).toBe(1);
    const returned = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.act, "returned")));
    expect(returned).toHaveLength(1);
    expect(returned[0]!.detail).toMatchObject({ from: W1, reason: "shift_ended" });

    const told = await db.select().from(alerts).where(and(eq(alerts.refId, task.id), eq(alerts.kind, "task.returned")));
    expect(told.map((a) => a.userId).sort()).toEqual([SUP1, SUP2].sort());

    // The pool pass of the same tick offers it to the worker now on duty — never back to W1.
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(row.state).toBe("assigned");
    expect(row.assigneeId).toBe(W2);
  });

  it("with nobody else on duty it waits in the pool; a second tick changes nothing", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 30));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    await acceptTask(db, actorOf(W1), { taskId: task.id }, minutes(t0, 1));

    await sweepTasks(db, minutes(t0, 31));
    const after = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(after.state).toBe("created");
    expect(after.assigneeId).toBeNull();
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    const alertsBefore = await db.select().from(alerts);

    await sweepTasks(db, minutes(t0, 31));
    expect(await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))).toHaveLength(events.length);
    expect(await db.select().from(alerts)).toHaveLength(alertsBefore.length);
  });

  it("a back-to-back duty keeps the task with its worker", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 30));
    await putOnDuty(db, h, W1, minutes(t0, 30), minutes(t0, 600));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    await acceptTask(db, actorOf(W1), { taskId: task.id }, minutes(t0, 1));

    const result = await sweepTasks(db, minutes(t0, 31));
    expect(result.returned).toBe(0);
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(row.assigneeId).toBe(W1);
    expect(row.state).toBe("accepted");
  });
});
