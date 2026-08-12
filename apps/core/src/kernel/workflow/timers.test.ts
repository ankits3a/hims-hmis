import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { runDueTimers, DUTY_MANAGER_ROLE } from "./timers";
import { startInstance, transition } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { events, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF = {
  key: "timer_flow",
  title: "Timer Flow",
  changeClass: "C",
  initialState: "waiting",
  states: [
    {
      name: "waiting",
      sla: {
        minutes: 30,
        alerting: "active",
        escalation: [
          { afterMinutes: 10, toRole: "supervisor" },
          { afterMinutes: 20, toRole: "department_head" },
        ],
      },
    },
    { name: "quiet", sla: { minutes: 15, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [
    { from: "waiting", to: "quiet", roles: ["nurse"] },
    { from: "waiting", to: "done", roles: ["nurse"] },
    { from: "quiet", to: "done", roles: ["nurse"] },
  ],
};

const SYSTEM: Actor = { type: "system", id: "test-automation" };

describe("runDueTimers", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "admin1", fullName: "A", password: "p1234567" });
    admin = { type: "user", id };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF);
    await activateDefinition(db, admin, definitionId);
  });

  async function startBreached(): Promise<string> {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, "timer_flow", { type: "t", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(eq(workflowTimers.instanceId, instanceId));
    return instanceId;
  }

  async function openTimersOf(instanceId: string) {
    return db.select().from(workflowTimers).where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    );
  }

  it("fires a due SLA timer once: sla.breached with the full envelope, then idempotent", async () => {
    const instanceId = await startBreached();
    expect(await runDueTimers(db)).toBe(1);
    expect(await runDueTimers(db)).toBe(0); // idempotent
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    expect(breached[0]!.correlationId).toBe(instanceId);
    expect(breached[0]!.patientId).toBe("01HPAT000000000000000000A");
    expect(breached[0]!.actorType).toBe("system");
    const payload = breached[0]!.payload as { state: string; alerting: string; slaMinutes: number };
    expect(payload).toMatchObject({ state: "waiting", alerting: "active", slaMinutes: 30 });
  });

  it("schedules escalation rung 0 after an active-alerting breach, anchored on dueAt", async () => {
    const instanceId = await startBreached();
    const [slaTimer] = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    await runDueTimers(db);
    const escalations = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")),
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.rung).toBe(0);
    expect(escalations[0]!.dueAt.getTime()).toBe(slaTimer!.dueAt.getTime() + 10 * 60_000);
  });

  it("a record_only breach emits the event but never escalates (§10.3)", async () => {
    const { instanceId } = await withTx(db, (tx) => startInstance(tx, "timer_flow", { type: "t", id: "s2" }));
    await withTx(db, (tx) => transition(tx, instanceId, "quiet", SYSTEM));
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 60_000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.cancelledAt)));
    expect(await runDueTimers(db)).toBe(1);
    const breached = await db.select().from(events).where(eq(events.name, "sla.breached"));
    expect(breached).toHaveLength(1);
    expect(await openTimersOf(instanceId)).toHaveLength(0); // no escalation scheduled
  });

  it("escalation resolves static role holders; ladder climbs rung by rung across calls", async () => {
    const { id: sup } = await createUser(db, { username: "sup1", fullName: "S", password: "p1234567" });
    await createRole(db, "supervisor", "Supervisor");
    await createRole(db, "department_head", "Department Head");
    await assignRole(db, { userId: sup, roleKey: "supervisor", scopeType: "hospital" });
    const instanceId = await startBreached();
    await runDueTimers(db); // fires SLA breach, schedules rung 0
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    expect(await runDueTimers(db)).toBe(1); // fires rung 0, schedules rung 1
    let escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.payload as object).toMatchObject({
      rung: 0, role: "supervisor", resolvedUserIds: [sup], fallback: false, fallbackExhausted: false,
    });
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation"), isNull(workflowTimers.firedAt)));
    expect(await runDueTimers(db)).toBe(1); // fires rung 1 (department_head — empty role)
    escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated).toHaveLength(2);
    // rung 1: department_head has no holders and duty_manager doesn't exist either → exhausted
    expect(escalated[1]!.payload as object).toMatchObject({
      rung: 1, role: "department_head", resolvedUserIds: [], fallback: true, fallbackExhausted: true,
    });
    expect(await openTimersOf(instanceId)).toHaveLength(0); // ladder exhausted, nothing further
  });

  it("falls back to duty_manager holders when a rung's role is empty (fix 11)", async () => {
    const { id: dm } = await createUser(db, { username: "dm1", fullName: "D", password: "p1234567" });
    await createRole(db, DUTY_MANAGER_ROLE, "Duty Manager");
    await assignRole(db, { userId: dm, roleKey: DUTY_MANAGER_ROLE, scopeType: "hospital" });
    // 'supervisor' role never created — rung 0 resolves empty and falls back
    const instanceId = await startBreached();
    await runDueTimers(db);
    await db.update(workflowTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "escalation")));
    await runDueTimers(db);
    const escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(escalated[0]!.payload as object).toMatchObject({
      role: "supervisor", resolvedUserIds: [dm], fallback: true, fallbackExhausted: false,
    });
  });

  it("cancelled timers never fire; a manually-claimed timer is skipped (claim semantics)", async () => {
    const instanceId = await startBreached();
    await withTx(db, (tx) => transition(tx, instanceId, "done", SYSTEM)); // cancels the backdated timer
    expect(await runDueTimers(db)).toBe(0);
    const instanceId2 = await startBreached();
    await db.update(workflowTimers)
      .set({ firedAt: new Date() }) // simulate another process having claimed it
      .where(eq(workflowTimers.instanceId, instanceId2));
    expect(await runDueTimers(db)).toBe(0);
    expect(await db.select().from(events).where(eq(events.name, "sla.breached"))).toHaveLength(0);
  });
});
