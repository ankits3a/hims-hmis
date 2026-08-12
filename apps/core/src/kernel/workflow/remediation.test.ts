import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { migrateInstance, abortInstance } from "./remediation";
import { startInstance, WorkflowError } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const V1 = {
  key: "mig_flow",
  title: "Mig Flow v1",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const V2 = {
  ...V1,
  title: "Mig Flow v2",
  initialState: "received",
  states: [
    { name: "received", sla: { minutes: 10, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "received", to: "done", roles: ["nurse"] }],
};

describe("workflow remediation", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor; let remediator: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    admin = await mk("admin1");
    remediator = await mk("rem1");
    const v1 = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V1);
    await activateDefinition(db, admin, v1.definitionId);
  });

  async function startOnV1(): Promise<string> {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, "mig_flow", { type: "t", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    return instanceId;
  }

  async function activateV2(): Promise<void> {
    const v2 = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, V2);
    await activateDefinition(db, admin, v2.definitionId);
  }

  it("migrates an active instance to the active version at the mapped state, with fresh timers", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const result = await migrateInstance(db, remediator, {
      instanceId, stateMapping: { open: "received" }, reason: "definition fix",
    });
    expect(result.toVersion).toBe(2);
    expect(result.state).toBe("received");
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.definitionId).toBe(result.toDefinitionId);
    expect(instance!.currentState).toBe("received");
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("received");
    expect(open[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 10 * 60_000); // v2's 10-min SLA
    const migrated = await db.select().from(events).where(eq(events.name, "instance.migrated"));
    expect(migrated).toHaveLength(1);
    expect(migrated[0]!.correlationId).toBe(instanceId);
    expect(migrated[0]!.payload as object).toMatchObject({
      fromVersion: 1, toVersion: 2, fromState: "open", toState: "received", reason: "definition fix",
    });
  });

  it("refuses migration when already on the active version, or when the mapping is unusable", async () => {
    const instanceId = await startOnV1();
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { open: "open" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "already_on_active_version" });
    await activateV2();
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { other: "received" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "mapping_incomplete" }); // current state 'open' not covered
    await expect(
      migrateInstance(db, remediator, { instanceId, stateMapping: { open: "nowhere" }, reason: "r" }),
    ).rejects.toMatchObject({ code: "mapping_unknown_state" });
  });

  it("a terminal mapping completes the instance during migration", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const result = await migrateInstance(db, remediator, {
      instanceId, stateMapping: { open: "done" }, reason: "already finished on paper",
    });
    expect(result.state).toBe("done");
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("completed");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
  });

  it("aborts an active instance: status, endedAt, cancelled timers, instance.aborted event", async () => {
    const instanceId = await startOnV1();
    await abortInstance(db, remediator, { instanceId, reason: "started in error" });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).toBe("aborted");
    expect(instance!.endedAt).not.toBeNull();
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0);
    const aborted = await db.select().from(events).where(eq(events.name, "instance.aborted"));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.correlationId).toBe(instanceId);
    expect(aborted[0]!.payload as object).toMatchObject({ state: "open", reason: "started in error" });
    await expect(
      abortInstance(db, remediator, { instanceId, reason: "twice" }),
    ).rejects.toMatchObject({ code: "instance_not_active" });
  });

  it("exactly one of two concurrent migrations of the same instance applies (single-winner)", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const attempt = (): Promise<{ toDefinitionId: string; toVersion: number; state: string }> =>
      migrateInstance(db, remediator, { instanceId, stateMapping: { open: "received" }, reason: "race" });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails as stale_transition (raced the conditional UPDATE) or
    // already_on_active_version (its read of getActiveDefinition ran after the winner
    // committed, so instance.definitionId already equals the target) — both are
    // WorkflowError, and the assertion below proves only ONE move applied either way.
    expect(rejected[0]!.reason).toBeInstanceOf(WorkflowError);
    expect(["stale_transition", "already_on_active_version"]).toContain((rejected[0]!.reason as WorkflowError).code);
    const migrated = await db.select().from(events).where(
      and(eq(events.name, "instance.migrated"), eq(events.correlationId, instanceId)),
    );
    expect(migrated).toHaveLength(1);
  });

  it("exactly one of two concurrent aborts of the same instance applies (single-winner)", async () => {
    const instanceId = await startOnV1();
    const attempt = (): Promise<void> =>
      abortInstance(db, remediator, { instanceId, reason: "race" });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WorkflowError);
    expect((rejected[0]!.reason as WorkflowError).code).toBe("instance_not_active");
    const aborted = await db.select().from(events).where(
      and(eq(events.name, "instance.aborted"), eq(events.correlationId, instanceId)),
    );
    expect(aborted).toHaveLength(1);
  });

  it("refuses migrateInstance when the reason is missing or whitespace-only", async () => {
    const instanceId = await startOnV1();
    await activateV2();
    const input: { instanceId: string; stateMapping: Record<string, string>; reason: string } = {
      instanceId, stateMapping: { open: "received" }, reason: "",
    };
    await expect(migrateInstance(db, remediator, input)).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      migrateInstance(db, remediator, { ...input, reason: "   " }),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("refuses abortInstance when the reason is missing or whitespace-only", async () => {
    const instanceId = await startOnV1();
    const input: { instanceId: string; reason: string } = { instanceId, reason: "" };
    await expect(abortInstance(db, remediator, input)).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      abortInstance(db, remediator, { ...input, reason: "   " }),
    ).rejects.toMatchObject({ code: "reason_required" });
  });
});
