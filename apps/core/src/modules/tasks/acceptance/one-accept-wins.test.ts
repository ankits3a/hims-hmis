import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { W1, W2, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../../test/helpers/tasks";
import { taskEvents, tasks } from "../../../kernel/db/schema";
import { TaskError, acceptTask, raiseTask } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { Pool } from "pg";

/**
 * DONE MEANS (spec SPEC-ipd-companions §11): "Two workers accepting one task: exactly one gets it."
 *
 * The overlap is MADE, not hoped for: a third session holds the task's row lock while both accepts are
 * sent, so both are in flight against an uncommitted world when the lock is released. A read-check-write
 * accept (read "created", then write) lets both through; the one conditional UPDATE lets exactly one.
 */
jest.setTimeout(30_000);

describe("acceptance — two workers tap Accept on one task", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let t0: Date;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    const h = await seedTaskHospital(db, t0);
    // Both come on duty a minute after t0: tasks raised AT t0 wait in the pool, and both may accept from t0 + 1.
    for (const w of [W1, W2]) await putOnDuty(db, h, w, minutes(t0, 1), minutes(t0, 600));
  });

  async function outcomes(taskId: string): Promise<PromiseSettledResult<unknown>[]> {
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tasks where id = $1 for update", [taskId]);
      const both = Promise.allSettled([
        acceptTask(db, actorOf(W1), { taskId }, minutes(t0, 1)),
        acceptTask(db, actorOf(W2), { taskId }, minutes(t0, 1)),
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query("commit");
      return await both;
    } finally {
      holder.release();
    }
  }

  it("exactly one wins; the other is told already_taken; the row and the history name the winner", async () => {
    // Nobody is on duty yet at t0, so the task waits in the pool where both workers can see it.
    const { task } = await raiseTask(db, actorOf(W1), { kind: "general" }, t0);
    expect(task.state).toBe("created");

    const results = await outcomes(task.id);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(TaskError);
    expect((reason as TaskError).code).toBe("already_taken");

    const winner = (won[0] as PromiseFulfilledResult<{ assigneeId: string }>).value.assigneeId;
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(row.state).toBe("accepted");
    expect(row.assigneeId).toBe(winner);
    const accepted = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.act, "accepted")));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.actorId).toBe(winner);
  });

  it("holds over many rounds of a plain Promise.all race", async () => {
    for (let i = 0; i < 8; i++) {
      const { task } = await raiseTask(db, actorOf(W1), { kind: "general" }, t0);
      const results = await Promise.allSettled([
        acceptTask(db, actorOf(W1), { taskId: task.id }, minutes(t0, 1)),
        acceptTask(db, actorOf(W2), { taskId: task.id }, minutes(t0, 1)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as TaskError).code).toBe("already_taken");
    }
  });
});
