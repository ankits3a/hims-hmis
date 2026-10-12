import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, SUP2, W2, actorOf, clockNow, minutes, seedTaskHospital } from "../../../../test/helpers/tasks";
import { tasks } from "../../../kernel/db/schema";
import { SERVICES_SUPERVISOR_ROLE, TaskError, acceptTask, completeTask, defineTaskKind, raiseTask, startTask, verifyTask } from "../index";
import type { Db } from "../../../kernel/db/client";

/**
 * DONE MEANS (spec §2 "verify step", §11 "a terminal clean that only a supervisor can verify"):
 * the person who did a task never verifies it, and a verifier holds the kind's permission.
 */
defineTaskKind({
  kind: "acc_checked_clean", label: "Checked clean", skill: "general", acceptWithinMin: 5, doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "none", verifyRequired: true, verifierPermission: "tasks.supervise",
});

describe("acceptance — the verifier cannot be the doer", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let t0: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    t0 = clockNow();
    await seedTaskHospital(db, t0);
  });

  it("the doer is refused verifier_is_doer; another supervisor verifies; a worker without the permission is refused", async () => {
    const { task } = await raiseTask(db, actorOf(SUP2), { kind: "acc_checked_clean" }, t0);
    await acceptTask(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 1));
    await startTask(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 2));
    await completeTask(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 10));

    const own = await verifyTask(db, actorOf(SUP1), { taskId: task.id }, minutes(t0, 11)).catch((e: unknown) => e);
    expect(own).toBeInstanceOf(TaskError);
    expect((own as TaskError).code).toBe("verifier_is_doer");

    const worker = await verifyTask(db, actorOf(W2), { taskId: task.id }, minutes(t0, 11)).catch((e: unknown) => e);
    expect((worker as TaskError).code).toBe("not_permitted");

    const ok = await verifyTask(db, actorOf(SUP2), { taskId: task.id }, minutes(t0, 12));
    expect(ok.state).toBe("verified");
    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
    expect(row.doneBy).toBe(SUP1);
    expect(row.verifiedBy).toBe(SUP2);
  });
});
