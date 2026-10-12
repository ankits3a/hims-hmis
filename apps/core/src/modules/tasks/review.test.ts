import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkPatient } from "../../../test/helpers/opd";
import { SUP1, SUP2, W1, W2, actorOf, clockNow, minutes, putOnDuty, seedTaskHospital } from "../../../test/helpers/tasks";
import { alerts, registrationConfig, staffAbsences, taskEvents, tasks } from "../../kernel/db/schema";
import * as noticesMod from "../../kernel/alerts/notices";
import * as dispatchMod from "./dispatch";
import {
  SERVICES_SUPERVISOR_ROLE, TaskError, acceptTask, defineSkill, defineTaskKind, myTasks, raiseTask, sweepTasks, taskBoard,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { Pool } from "pg";
import type { TaskHospital } from "../../../test/helpers/tasks";

/**
 * PR #747 review findings, one test each (each red against the code before its fix): starvation in
 * the clock's batches, accepting off duty or out of skill, merging into a task closing under us, a
 * different patient never merging, the notice committed with its rung, one failing pass not stopping
 * the others, leave returning tasks, the board's counts and note, and the history's TRUNCATE guard.
 */
defineSkill("rev_unstaffed", ["no_such_role"]);
defineTaskKind({
  kind: "rev_unstaffed", label: "Nobody can do this", skill: "rev_unstaffed", acceptWithinMin: 5, doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE, proofNeeded: "none", verifyRequired: false,
});

jest.setTimeout(60_000);

async function refusal(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  if (!(e instanceof TaskError)) throw new Error(`expected a TaskError, got ${String(e)}`);
  return e.code;
}

describe("tasks — review findings (PR #747)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let t0: Date;
  let h: TaskHospital;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    jest.restoreAllMocks();
    await truncateAll(db);
    t0 = clockNow();
    h = await seedTaskHospital(db, t0);
  });

  /** Rows written straight to the table: the clock's batch tests need dozens. */
  async function insertTasks(n: number, over: Partial<typeof tasks.$inferInsert>): Promise<string[]> {
    const rows = Array.from({ length: n }, () => ({
      id: newId(), kind: "general", skill: "general", dueAt: t0, requestedBy: SUP1, createdAt: t0, updatedAt: t0, ...over,
    }));
    await db.insert(tasks).values(rows);
    return rows.map((r) => r.id);
  }
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;

  it("RED 1: fifty-one tasks already at the top rung do not starve a task due its first rung", async () => {
    await insertTasks(51, { dueAt: minutes(t0, -500), escalatedRung: 2 });
    const [fresh] = await insertTasks(1, { dueAt: minutes(t0, -1) });
    await sweepTasks(db, t0);
    expect((await row(fresh!)).escalatedRung).toBe(1);
  });

  it("RED 2a: accepting with no rostered duty now is refused not_on_duty", async () => {
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0);
    expect(await refusal(acceptTask(db, actorOf(W1), { taskId: task.id }, t0))).toBe("not_on_duty");
  });

  it("RED 2b: a held task with no shift end whose holder is off duty goes back to the pool", async () => {
    const [id] = await insertTasks(1, { state: "accepted", assigneeKind: "person", assigneeId: W1, assignedAt: t0, dueAt: minutes(t0, 60) });
    await sweepTasks(db, minutes(t0, 1));
    expect((await row(id!)).state).toBe("created");
  });

  it("3: accepting a task of a skill the worker's roles do not carry is refused wrong_skill", async () => {
    await putOnDuty(db, h, SUP1, minutes(t0, -60), minutes(t0, 300));
    const { task } = await raiseTask(db, actorOf(SUP2), { kind: "general" }, t0);
    expect(await refusal(acceptTask(db, actorOf(SUP1), { taskId: task.id }, t0))).toBe("wrong_skill");
  });

  it("4: a request that meets an open task being closed under it raises a new task, not a merge into the closed one", async () => {
    const first = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("update tasks set state = 'cancelled', cancel_reason = 'dup' where id = $1", [first.task.id]);
      const second = raiseTask(db, actorOf(W1), { kind: "general", placeResourceId: h.roomA }, minutes(t0, 1));
      await new Promise((r) => setTimeout(r, 300));
      await holder.query("commit");
      const res = await second;
      expect(res.merged).toBe(false);
      expect(res.task.id).not.toBe(first.task.id);
    } finally {
      holder.release();
    }
  });

  it("5: a pile of pool tasks nobody on duty can do does not starve a skill that has someone on", async () => {
    await insertTasks(51, { kind: "rev_unstaffed", skill: "rev_unstaffed", dueAt: minutes(t0, -100) });
    const [general] = await insertTasks(1, { dueAt: minutes(t0, 30) });
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 300));
    await sweepTasks(db, t0);
    expect((await row(general!)).assigneeId).toBe(W1);
  });

  it("6: a notice that fails rolls its rung back, so the next tick raises both; the sweep does not throw", async () => {
    const [late] = await insertTasks(1, { dueAt: minutes(t0, -1) });
    jest.spyOn(noticesMod, "raiseNotice").mockRejectedValueOnce(new Error("bell down"));
    await expect(sweepTasks(db, t0)).resolves.toBeDefined();
    expect((await row(late!)).escalatedRung).toBe(0);
    await sweepTasks(db, t0);
    expect((await row(late!)).escalatedRung).toBe(1);
    expect(await db.select().from(alerts).where(eq(alerts.refId, late!))).toHaveLength(2);
  });

  it("7: one pass throwing does not stop the escalation pass", async () => {
    const [late] = await insertTasks(1, { dueAt: minutes(t0, -1) });
    await insertTasks(1, { state: "created", dueAt: minutes(t0, 30) });
    jest.spyOn(dispatchMod, "pickWorker").mockRejectedValue(new Error("roster down"));
    jest.spyOn(dispatchMod, "onDutyForSkill").mockRejectedValue(new Error("roster down"));
    await expect(sweepTasks(db, t0)).resolves.toBeDefined();
    expect((await row(late!)).escalatedRung).toBe(1);
  });

  it("8: a worker on approved leave now hands their held tasks back", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 300));
    const { task } = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA }, t0);
    await acceptTask(db, actorOf(W1), { taskId: task.id }, t0);
    await db.insert(staffAbsences).values({
      id: newId(), userId: W1, kind: "CL", startsAt: minutes(t0, 5), endsAt: minutes(t0, 600), status: "approved",
      requestedBy: W1, approvedBy: SUP1, decidedAt: t0, createdBy: SUP1, updatedBy: SUP1,
    });
    await sweepTasks(db, minutes(t0, 10));
    const after = await row(task.id);
    expect(after.state).toBe("created");
    expect(after.assigneeId).toBeNull();
  });

  it("9: the board counts every open task in the database and says how many it did not send", async () => {
    await insertTasks(405, { dueAt: minutes(t0, -5) });
    const board = await taskBoard(db, t0);
    expect(board.counts.open).toBe(405);
    expect(board.counts.late).toBe(405);
    expect(board.counts.notShown).toBe(5);
  });

  it("10: a worker's pool puts a STAT task first even behind twenty earlier routine ones", async () => {
    await insertTasks(21, { dueAt: minutes(t0, 10) });
    const [stat] = await insertTasks(1, { dueAt: minutes(t0, 50), priority: "stat" });
    const view = await myTasks(db, W1, t0);
    expect(view.pool[0]!.id).toBe(stat);
  });

  it("11: the same place and kind for a different patient is a different task", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    const a = await mkPatient(db, actorOf(SUP1));
    const b = await mkPatient(db, actorOf(SUP1), { name: "Sita Kumari", phone: "9876500000" });
    const first = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA, patientId: a.id }, t0);
    const second = await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA, patientId: b.id }, minutes(t0, 1));
    expect(second.merged).toBe(false);
    expect(second.task.id).not.toBe(first.task.id);
  });

  it("12: the free-text note stays on the worker's own card and never reaches the board", async () => {
    await putOnDuty(db, h, W1, minutes(t0, -60), minutes(t0, 300));
    await raiseTask(db, actorOf(SUP1), { kind: "general", placeResourceId: h.roomA, note: "spill by the window" }, t0);
    expect((await myTasks(db, W1, t0)).mine[0]!.note).toBe("spill by the window");
    const board = await taskBoard(db, t0);
    expect(board.floors.flatMap((f) => f.tasks).every((c) => c.note === null)).toBe(true);
  });

  it("13: TRUNCATE of the history is refused outside the test harness, and the clock's indexes exist", async () => {
    await raiseTask(db, actorOf(SUP1), { kind: "general" }, t0);
    await expect(db.execute(sql`truncate table task_events cascade`)).rejects.toThrow(/append-only/);
    const idx = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'tasks'`);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(["tasks_shift_end_idx", "tasks_assigned_wait_idx"]));
    expect(await db.select().from(taskEvents).where(and(eq(taskEvents.act, "raised")))).toHaveLength(1);
  });
});
