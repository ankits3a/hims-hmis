import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SUP1, SUP2, W1, W2, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../test/helpers/tasks";
import { taskEvents } from "../../kernel/db/schema";
import {
  SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, acceptTask, assignTask, completeTask, defineSkill, defineTaskKind, myTasks,
  raiseTask, rejectTask, returnToPool, startTask, verifyTask,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { TaskHospital } from "../../../test/helpers/tasks";

/**
 * HK-1 (#973) — the engine's two additions: a failed check (`rejectTask`) and a kind's eligibility (who may hold a task,
 * and whether new tasks wait in the pool for their group). Every instant is relative to the real clock's `t0`.
 */
defineSkill("unit_both", [SUPPORT_STAFF_ROLE, SERVICES_SUPERVISOR_ROLE]);
defineTaskKind({
  kind: "unit_checked", label: "Checked", skill: "unit_both", acceptWithinMin: 5, doneWithinMin: 30,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "tap", verifyRequired: true,
});
defineTaskKind({
  kind: "unit_placed", label: "Placed", skill: "general", acceptWithinMin: 5, doneWithinMin: 30,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "none", verifyRequired: false,
  eligible: async () => ({ userIds: [W2] }),
});
let held = false;
defineTaskKind({
  kind: "unit_pooled", label: "Pooled", skill: "general", acceptWithinMin: 5, doneWithinMin: 30,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "none", verifyRequired: false,
  eligible: async () => ({ userIds: [W2] }),
  poolOnly: async () => held,
});

describe("tasks — a failed check and a kind's eligibility (HK-1)", () => {
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
    for (const u of [W1, W2, SUP1, SUP2]) await putOnDuty(db, h, u, minutes(t0, -60), minutes(t0, 600));
    held = false;
  });

  async function doIt(taskId: string, by: string, at: Date) {
    const who = actorOf(by);
    await acceptTask(db, who, { taskId }, at);
    await startTask(db, who, { taskId }, at);
    return completeTask(db, who, { taskId, proof: { kind: "tap" } }, at);
  }

  it("a fail needs a reason, goes back to the doer on duty, and bars every doer of every round from checking", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "unit_checked" }, t0);
    await assignTask(db, actorOf(SUP1), { taskId: task.id, userId: SUP2 }, t0);
    await doIt(task.id, SUP2, t0);
    await expect(rejectTask(db, actorOf(SUP1), { taskId: task.id }, t0)).rejects.toMatchObject({ code: "reason_required" });
    await expect(rejectTask(db, actorOf(SUP2), { taskId: task.id, reason: "Mine" }, t0)).rejects.toMatchObject({ code: "verifier_is_doer" });
    const back = await rejectTask(db, actorOf(SUP1), { taskId: task.id, reason: "Floor wet" }, minutes(t0, 1));
    expect(back).toMatchObject({ state: "assigned", assigneeId: SUP2, doneBy: null });
    const ev = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.act, "rejected")));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ reason: "Floor wet", from: SUP2, to: SUP2 });
    // Round two by someone else: the first doer is still barred.
    await returnToPool(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 2), { asSupervisor: true });
    await assignTask(db, actorOf(SUP1), { taskId: task.id, userId: W1 }, minutes(t0, 2));
    await doIt(task.id, W1, minutes(t0, 3));
    await expect(verifyTask(db, actorOf(SUP2), { taskId: task.id }, minutes(t0, 4))).rejects.toMatchObject({ code: "verifier_is_doer" });
    await expect(verifyTask(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 4))).resolves.toMatchObject({ state: "verified" });
  });

  it("a fail whose doer is off duty goes to the pool", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "unit_checked" }, t0);
    await assignTask(db, actorOf(SUP1), { taskId: task.id, userId: W1 }, t0);
    await doIt(task.id, W1, t0);
    // At t0 + 11 h every duty has ended: nobody to give it to.
    const back = await rejectTask(db, actorOf(SUP1), { taskId: task.id, reason: "Smell remains" }, minutes(t0, 660));
    expect(back).toMatchObject({ state: "created", assigneeId: null });
  });

  it("an eligible kind dispatches only to its people; a pool-only kind waits, and only its people may take it", async () => {
    const placed = (await raiseTask(db, actorOf(SUP1), { kind: "unit_placed" }, t0)).task;
    expect(placed).toMatchObject({ state: "assigned", assigneeId: W2 });
    held = true;
    const pooled = (await raiseTask(db, actorOf(SUP1), { kind: "unit_pooled" }, t0)).task;
    expect(pooled).toMatchObject({ state: "created", assigneeId: null });
    expect((await myTasks(db, W1, t0)).pool.map((c) => c.id)).not.toContain(pooled.id);
    expect((await myTasks(db, W2, t0)).pool.map((c) => c.id)).toContain(pooled.id);
    await expect(acceptTask(db, actorOf(W1), { taskId: pooled.id }, t0)).rejects.toMatchObject({ code: "not_your_area" });
    await expect(acceptTask(db, actorOf(W2), { taskId: pooled.id }, t0)).resolves.toMatchObject({ assigneeId: W2 });
  });
});
