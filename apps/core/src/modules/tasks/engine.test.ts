import { asc, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SUP1, SUP2, W1, W2, W3, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../test/helpers/tasks";
import { taskEvents, tasks } from "../../kernel/db/schema";
import {
  SERVICES_SUPERVISOR_ROLE, TaskError, acceptTask, assignTask, cancelTask, cancelTasksForPlace, completeTask,
  defineTaskKind, raiseTask, returnToPool, startTask, taskHttpStatus, verifyTask,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { TaskHospital } from "../../../test/helpers/tasks";

/** One test per refusal, plus dispatch and the history's shape. */
defineTaskKind({
  kind: "unit_scan_proof", label: "Scan proof", skill: "general", acceptWithinMin: 5, doneWithinMin: 30,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "scan", verifyRequired: false,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  if (!(e instanceof TaskError)) throw new Error(`expected a TaskError, got ${String(e)}`);
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.fix.length).toBeGreaterThan(0);
  return e.code;
}

describe("tasks — intents and refusals", () => {
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

  const raise = (over: Record<string, unknown> = {}) => raiseTask(db, actorOf(SUP1), { kind: "general", ...over }, t0).then((r) => r.task);
  /**
   * W1 and W2 come on duty a minute after t0: a task raised AT t0 waits in the pool, and both may take it
   * from t0 + 1 (accepting off duty is refused `not_on_duty`).
   */
  const onDutySoon = async () => { for (const w of [W1, W2]) await putOnDuty(db, h, w, minutes(t0, 1), minutes(t0, 600)); };
  /** A task W1 holds in progress. */
  const inProgress = async (kind = "general") => {
    await onDutySoon();
    const t = await raise({ kind });
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    return startTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 2));
  };

  it("bad_input: a malformed request", async () => {
    expect(await refusal(raiseTask(db, actorOf(SUP1), { kind: "general", priority: "whenever" }, t0))).toBe("bad_input");
  });

  it("unknown_kind", async () => {
    expect(await refusal(raise({ kind: "no_such_kind" }))).toBe("unknown_kind");
  });

  it("unknown_place", async () => {
    expect(await refusal(raise({ placeResourceId: "01NOSUCHPLACE00000000000000" }))).toBe("unknown_place");
  });

  it("unknown_worker: a supervisor assigns to nobody", async () => {
    const t = await raise();
    expect(await refusal(assignTask(db, actorOf(SUP1), { taskId: t.id, userId: "01NOBODY000000000000000000" }, t0))).toBe("unknown_worker");
  });

  it("not_found", async () => {
    expect(await refusal(acceptTask(db, actorOf(W1), { taskId: "01NOTASK00000000000000000" }, t0))).toBe("not_found");
    expect(await refusal(startTask(db, actorOf(W1), { taskId: "01NOTASK00000000000000000" }, t0))).toBe("not_found");
  });

  it("already_taken: accepting a task someone else holds", async () => {
    await onDutySoon();
    const t = await raise();
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    expect(await refusal(acceptTask(db, actorOf(W2), { taskId: t.id }, minutes(t0, 1)))).toBe("already_taken");
  });

  it("not_yours: starting, finishing or handing back another worker's task", async () => {
    await onDutySoon();
    const t = await raise();
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    expect(await refusal(startTask(db, actorOf(W2), { taskId: t.id }, minutes(t0, 2)))).toBe("not_yours");
    expect(await refusal(returnToPool(db, actorOf(W2), { taskId: t.id }, minutes(t0, 2)))).toBe("not_yours");
    await startTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 2));
    expect(await refusal(completeTask(db, actorOf(W2), { taskId: t.id }, minutes(t0, 3)))).toBe("not_yours");
  });

  it("wrong_state: start before accept, done before start, accept twice", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 120));
    const t = await raise();
    expect(t.assigneeId).toBe(W1);
    expect(await refusal(startTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1)))).toBe("wrong_state");
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    expect(await refusal(completeTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 2)))).toBe("wrong_state");
    expect(await refusal(acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 2)))).toBe("wrong_state");
  });

  it("not_open: acting on a finished or cancelled task", async () => {
    const t = await inProgress();
    await completeTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 5));
    expect(await refusal(cancelTask(db, actorOf(SUP1), { taskId: t.id, reason: "late" }, minutes(t0, 6)))).toBe("not_open");
    expect(await refusal(acceptTask(db, actorOf(W2), { taskId: t.id }, minutes(t0, 6)))).toBe("not_open");
    const c = await raise();
    await cancelTask(db, actorOf(SUP1), { taskId: c.id, reason: "raised in error" }, minutes(t0, 1));
    expect(await refusal(assignTask(db, actorOf(SUP1), { taskId: c.id, userId: W1 }, minutes(t0, 2)))).toBe("not_open");
  });

  it("stale: a version that is no longer the task's", async () => {
    await onDutySoon();
    const t = await raise();
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    expect(await refusal(cancelTask(db, actorOf(SUP1), { taskId: t.id, version: t.version, reason: "dup" }, minutes(t0, 2)))).toBe("stale");
  });

  it("proof_missing: a kind that needs a scan, finished without one", async () => {
    const t = await inProgress("unit_scan_proof");
    expect(await refusal(completeTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 5)))).toBe("proof_missing");
    expect(await refusal(completeTask(db, actorOf(W1), { taskId: t.id, proof: { kind: "tap" } }, minutes(t0, 5)))).toBe("proof_missing");
    const done = await completeTask(db, actorOf(W1), { taskId: t.id, proof: { kind: "scan", code: "BED-201" } }, minutes(t0, 5));
    expect(done.state).toBe("done");
    expect(done.proof).toEqual({ kind: "scan", code: "BED-201" });
  });

  it("no_verify_step: verifying a kind with no check", async () => {
    const t = await inProgress();
    await completeTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 5));
    expect(await refusal(verifyTask(db, actorOf(SUP2), { taskId: t.id }, minutes(t0, 6)))).toBe("no_verify_step");
  });

  it("reason_required: cancel and cancel-for-place without a reason", async () => {
    const t = await raise();
    expect(await refusal(cancelTask(db, actorOf(SUP1), { taskId: t.id, reason: "   " }, t0))).toBe("reason_required");
    expect(await refusal(cancelTasksForPlace(db, actorOf(SUP1), { placeResourceId: h.roomA }, t0))).toBe("reason_required");
  });

  it("refusals map to HTTP statuses", () => {
    expect(taskHttpStatus("not_found")).toBe(404);
    expect(taskHttpStatus("verifier_is_doer")).toBe(403);
    expect(taskHttpStatus("already_taken")).toBe(409);
    expect(taskHttpStatus("proof_missing")).toBe(400);
  });

  it("dispatch: the least-loaded on-duty worker, ties by earliest shift start; off-duty and on-leave never", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -30), minutes(t0, 300));
    await putOnDuty(db, h, W2, minutes(t0, -90), minutes(t0, 300));
    // W3 holds the role but is not rostered: never dispatched to.
    const a = await raise();
    expect(a.assigneeId).toBe(W2); // both hold 0; W2 came on first
    const b = await raise();
    expect(b.assigneeId).toBe(W1); // W2 now holds 1
    const c = await raise();
    expect(c.assigneeId).toBe(W2); // 1 each; earliest start again
    expect([a, b, c].every((x) => x.assigneeId !== W3)).toBe(true);
  });

  it("nobody on duty: the task waits in the pool as `created`", async () => {
    const t = await raise();
    expect(t.state).toBe("created");
    expect(t.assigneeId).toBeNull();
  });

  it("cancelTasksForPlace cancels every open task at that place and none elsewhere", async () => {
    const a = await raise({ placeResourceId: h.roomA });
    const other = await raise({ kind: "unit_scan_proof", placeResourceId: h.roomA });
    const b = await raise({ placeResourceId: h.roomB });
    const ids = await cancelTasksForPlace(db, actorOf(SUP1), { placeResourceId: h.roomA, reason: "bed re-occupied" }, minutes(t0, 1));
    expect(ids.sort()).toEqual([a.id, other.id].sort());
    const rows = await db.select().from(tasks);
    expect(rows.find((r) => r.id === b.id)!.state).toBe("created");
    expect(rows.filter((r) => r.state === "cancelled").every((r) => r.cancelReason === "bed re-occupied")).toBe(true);
  });

  it("returnToPool: the worker hands back; a supervisor may take any task back", async () => {
    await onDutySoon();
    const t = await raise();
    await acceptTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 1));
    const back = await returnToPool(db, actorOf(W1), { taskId: t.id, reason: "lift not working" }, minutes(t0, 2));
    expect(back.state).toBe("created");
    expect(back.assigneeId).toBeNull();
    await acceptTask(db, actorOf(W2), { taskId: t.id }, minutes(t0, 3));
    const taken = await returnToPool(db, actorOf(SUP1), { taskId: t.id }, minutes(t0, 4), { asSupervisor: true });
    expect(taken.state).toBe("created");
  });

  it("every change writes exactly one event, seq = version, no gaps", async () => {
    const t = await inProgress();
    await completeTask(db, actorOf(W1), { taskId: t.id }, minutes(t0, 5));
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, t.id)).orderBy(asc(taskEvents.seq));
    expect(events.map((e) => e.act)).toEqual(["raised", "accepted", "started", "done"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const row = (await db.select().from(tasks).where(eq(tasks.id, t.id)))[0]!;
    expect(row.version).toBe(4);
  });

  it("task_events is append-only: UPDATE and DELETE are refused by the database", async () => {
    const t = await raise();
    await expect(db.execute(sql`update task_events set act = 'done' where task_id = ${t.id}`)).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`delete from task_events where task_id = ${t.id}`)).rejects.toThrow(/append-only/);
  });
});
