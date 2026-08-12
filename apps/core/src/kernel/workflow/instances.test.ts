import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { startInstance, transition, WorkflowError } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { workflowInstances, workflowTransitions, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF_V1 = {
  key: "test_flow",
  title: "Test Flow v1",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "active", escalation: [{ afterMinutes: 10, toRole: "duty_manager" }] } },
    { name: "in_progress", sla: { minutes: 60, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", roles: ["nurse"] },
    { from: "in_progress", to: "done", roles: ["doctor"] },
  ],
};

describe("workflow instances", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor; let nurse: Actor; let doctor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    admin = await mk("admin1"); nurse = await mk("nurse1"); doctor = await mk("doc1");
    await createRole(db, "nurse", "Nurse");
    await createRole(db, "doctor", "Doctor");
    await assignRole(db, { userId: nurse.id, roleKey: "nurse", scopeType: "department", scopeId: "opd" });
    await assignRole(db, { userId: doctor.id, roleKey: "doctor", scopeType: "hospital" });
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF_V1);
    await activateDefinition(db, admin, definitionId);
  });

  async function start(): Promise<string> {
    const { instanceId, state } = await withTx(db, (tx) =>
      startInstance(tx, "test_flow", { type: "test_subject", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    expect(state).toBe("open");
    return instanceId;
  }

  it("starts an instance pinned to the active version with the initial SLA timer", async () => {
    const instanceId = await start();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("open");
    expect(instance!.status).toBe("active");
    expect(instance!.patientId).toBe("01HPAT000000000000000000A");
    const timers = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.kind).toBe("sla");
    expect(timers[0]!.state).toBe("open");
    // dueAt = stateEnteredAt + 30 min
    expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 30 * 60_000);
  });

  it("throws no_active_definition for an unknown key", async () => {
    await expect(
      withTx(db, (tx) => startInstance(tx, "missing_flow", { type: "t", id: "s" })),
    ).rejects.toMatchObject({ code: "no_active_definition" });
  });

  it("transitions with an allowed role: history row, timer swap, state move", async () => {
    const instanceId = await start();
    const result = await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    expect(result).toEqual({ state: "in_progress", completed: false });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("in_progress");
    const history = await db.select().from(workflowTransitions).where(eq(workflowTransitions.instanceId, instanceId));
    expect(history).toHaveLength(1);
    expect(history[0]!).toMatchObject({ fromState: "open", toState: "in_progress", actorType: "user", actorId: nurse.id });
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(1); // old timer cancelled, exactly one new SLA timer
    expect(open[0]!.state).toBe("in_progress");
  });

  it("denies a user without an allowed role, an agent, and an undeclared transition", async () => {
    const instanceId = await start();
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", doctor)),
    ).rejects.toMatchObject({ code: "role_denied" });
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", { type: "agent", id: "a1" })),
    ).rejects.toMatchObject({ code: "role_denied" });
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "done", nurse)), // open→done is not declared
    ).rejects.toMatchObject({ code: "unknown_transition" });
  });

  it("a system actor bypasses the role check (automated moves)", async () => {
    const instanceId = await start();
    const result = await withTx(db, (tx) =>
      transition(tx, instanceId, "in_progress", { type: "system", id: "test-automation" }),
    );
    expect(result.state).toBe("in_progress");
  });

  it("terminal transition completes the instance, cancels timers, schedules nothing", async () => {
    const instanceId = await start();
    await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    const result = await withTx(db, (tx) => transition(tx, instanceId, "done", doctor));
    expect(result).toEqual({ state: "done", completed: true });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("completed");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse)),
    ).rejects.toMatchObject({ code: "instance_not_active" });
  });

  it("an in-flight instance keeps running on its pinned version after a new version activates (§10.2)", async () => {
    const instanceId = await start();
    // v2 renames the middle state — an instance on v1 must still follow v1's transitions
    const V2 = {
      ...DEF_V1,
      title: "Test Flow v2",
      states: [
        { name: "open", sla: { minutes: 5, alerting: "record_only" } },
        { name: "triaged", sla: { minutes: 5, alerting: "record_only" } },
        { name: "done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "triaged", roles: ["nurse"] },
        { from: "triaged", to: "done", roles: ["doctor"] },
      ],
    };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V2);
    await activateDefinition(db, admin, definitionId);
    const result = await withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    expect(result.state).toBe("in_progress"); // v1 transition still valid for this instance
    await expect(
      withTx(db, (tx) => transition(tx, instanceId, "triaged", nurse)), // v2 state — unknown to v1
    ).rejects.toMatchObject({ code: "unknown_transition" });
  });

  it("rolls back atomically with the caller's transaction", async () => {
    const before = await db.select().from(workflowInstances);
    await expect(
      withTx(db, async (tx) => {
        await startInstance(tx, "test_flow", { type: "t", id: "s2" });
        throw new Error("caller rollback");
      }),
    ).rejects.toThrow("caller rollback");
    const after = await db.select().from(workflowInstances);
    expect(after).toHaveLength(before.length); // no instance, and (by FK) no timer survived
  });

  it("exactly one of two concurrent transitions of the same instance applies (single-winner)", async () => {
    const instanceId = await start();
    const attempt = (): Promise<{ state: string; completed: boolean }> =>
      withTx(db, (tx) => transition(tx, instanceId, "in_progress", nurse));
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails as stale_transition (raced the conditional UPDATE) or
    // unknown_transition (its read ran after the winner committed) — both are
    // WorkflowError, and the assertions below prove only ONE move applied either way.
    expect(rejected[0]!.reason).toBeInstanceOf(WorkflowError);
    const history = await db.select().from(workflowTransitions).where(eq(workflowTransitions.instanceId, instanceId));
    expect(history).toHaveLength(1);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.currentState).toBe("in_progress");
  });
});
