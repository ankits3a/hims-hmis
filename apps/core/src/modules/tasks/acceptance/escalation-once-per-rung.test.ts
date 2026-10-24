import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, SUP2, actorOf, clockNow, minutes, seedTaskHospital } from "../../../../test/helpers/tasks";
import { alerts, taskEvents } from "../../../kernel/db/schema";
import { raiseTask, sweepTasks } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { TaskHospital } from "../../../../test/helpers/tasks";

/**
 * DONE MEANS (spec §2: "escalation ladder per kind"): a late task climbs each rung of its ladder ONCE,
 * however many ticks find it late. `general`: due 60 min after raising; rungs at due and due + 30.
 */
describe("acceptance — escalation fires once per rung", () => {
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

  const escalations = (taskId: string) =>
    db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.act, "escalated")));
  const notices = (taskId: string) =>
    db.select().from(alerts).where(and(eq(alerts.refId, taskId), eq(alerts.kind, "task.late")));

  it("rung 1 at due, rung 2 thirty minutes on, each once, each to every supervisor", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);

    await sweepTasks(db, minutes(t0, 59));
    expect(await escalations(task.id)).toHaveLength(0);

    await sweepTasks(db, minutes(t0, 60));
    await sweepTasks(db, minutes(t0, 61));
    await sweepTasks(db, minutes(t0, 75));
    const one = await escalations(task.id);
    expect(one).toHaveLength(1);
    expect(one[0]!.detail).toMatchObject({ rung: 1 });
    expect((await notices(task.id)).map((a) => a.userId).sort()).toEqual([SUP1, SUP2].sort());

    await sweepTasks(db, minutes(t0, 90));
    await sweepTasks(db, minutes(t0, 90));
    await sweepTasks(db, minutes(t0, 200));
    const two = await escalations(task.id);
    expect(two.map((e) => (e.detail as { rung: number }).rung)).toEqual([1, 2]);
    expect(await notices(task.id)).toHaveLength(4);
  });

  it("a sweep that was down jumps to the highest rung reached, once", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    await sweepTasks(db, minutes(t0, 120));
    await sweepTasks(db, minutes(t0, 121));
    const events = await escalations(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ rung: 2 });
    expect(await notices(task.id)).toHaveLength(2);
  });
});
