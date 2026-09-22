import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { runDueTimers, cancelTimersOfKind, rescheduleBudget, DUTY_MANAGER_ROLE } from "./timers";
import { startInstance, transition } from "./instances";
import { createDraft, activateDefinition } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { events, workflowInstances, workflowTimers } from "../db/schema";
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T1 — PERCENT LADDERS, THE RESPOND CLOCK, AND THE PER-INSTANCE BUDGET
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The suite above pins the shipped `escalation` CHAIN and nothing here may move it: a chain rung
 * is a delta from the last one, anchored on the breach, laid one rung at a time. What follows is
 * a second, separate mechanism — percentages of a budget, anchored at STATE ENTRY, all laid at
 * once — and the two never appear on one state (`definition.test.ts` refuses that).
 *
 * The owner's own arithmetic check, from the phase doc: **a six-hour budget escalates at
 * 2 h 24 m, not at 6 h 30 m.**
 */
const LADDER_DEF = {
  key: "ladder_flow",
  title: "Ladder Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: {
        minutes: 360, // six hours
        alerting: "active",
        respondMinutes: 30,
        ladder: [
          { atPercent: 40, toRole: "supervisor" },
          { atPercent: 70, toRole: "department_head" },
          { atPercent: 100, toRole: "duty_manager" },
        ],
      },
    },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};

const MIN = 60_000;

describe("percent ladders, the respond clock and the budget (phase O T1)", () => {
  let db: Db; let teardown: () => Promise<void>;
  let admin: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "admin2", fullName: "A", password: "p1234567" });
    admin = { type: "user", id };
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, LADDER_DEF);
    await activateDefinition(db, admin, definitionId);
  });

  const start = async (): Promise<string> => {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, "ladder_flow", { type: "t", id: "s1", patientId: "01HPAT000000000000000000A" }),
    );
    return instanceId;
  };
  const timersOf = async (instanceId: string, kind?: string) =>
    db.select().from(workflowTimers).where(
      kind === undefined
        ? eq(workflowTimers.instanceId, instanceId)
        : and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, kind)),
    );
  const openTimers = async (instanceId: string) =>
    db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
  const escalations = async () =>
    db.select().from(events).where(eq(events.name, "escalation.triggered"));
  const backdate = async (ids: string[], to: Date): Promise<void> => {
    for (const id of ids) {
      await db.update(workflowTimers).set({ dueAt: to }).where(eq(workflowTimers.id, id));
    }
  };

  // ————————————————————————————— V2 —————————————————————————————

  it("V2: every rung is laid at STATE ENTRY, at entry + budget × percent — 40 % of six hours is 2 h 24 m", async () => {
    const instanceId = await start();
    const entered = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!.stateEnteredAt;

    const rungs = (await timersOf(instanceId, "escalation")).sort((a, b) => a.percent! - b.percent!);
    expect(rungs.map((r) => r.percent)).toEqual([40, 70, 100]);
    expect(rungs.map((r) => r.rung)).toEqual([0, 1, 2]);
    expect(rungs[0]!.dueAt.getTime() - entered.getTime()).toBe(144 * MIN); // 2 h 24 m, not 6 h 30 m
    expect(rungs[1]!.dueAt.getTime() - entered.getTime()).toBe(252 * MIN);
    expect(rungs[2]!.dueAt.getTime() - entered.getTime()).toBe(360 * MIN);

    // …and the resolve clock beside them, at 100 % of the same budget.
    const [slaTimer] = await timersOf(instanceId, "sla");
    expect(slaTimer!.dueAt.getTime() - entered.getTime()).toBe(360 * MIN);
    expect(slaTimer!.percent).toBeNull(); // the sla timer is not a rung
  });

  it("V2: a rung fires to its own role with its percent and budget on the payload, and lays no successor", async () => {
    const { id: sup } = await createUser(db, { username: "sup2", fullName: "S", password: "p1234567" });
    await createRole(db, "supervisor", "Supervisor");
    await assignRole(db, { userId: sup, roleKey: "supervisor", scopeType: "hospital" });
    const instanceId = await start();
    const rungs = (await timersOf(instanceId, "escalation")).sort((a, b) => a.percent! - b.percent!);
    await backdate([rungs[0]!.id], new Date(Date.now() - MIN));

    expect(await runDueTimers(db)).toBe(1);
    const fired = await escalations();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.payload as object).toMatchObject({
      rung: 0, role: "supervisor", percent: 40, budgetMinutes: 360,
      resolvedUserIds: [sup], fallback: false, fallbackExhausted: false,
    });
    // The chain lays rung k+1 when rung k fires. A ladder does NOT: all three existed already,
    // and a fourth timer here would be the double-schedule this design exists to avoid.
    expect(await timersOf(instanceId, "escalation")).toHaveLength(3);
  });

  it("V2: one transition cancels the whole ladder, the resolve clock and the respond clock together", async () => {
    const instanceId = await start();
    expect(await openTimers(instanceId)).toHaveLength(5); // sla + three rungs + respond
    await withTx(db, (tx) => transition(tx, instanceId, "done", SYSTEM));
    expect(await openTimers(instanceId)).toHaveLength(0);
  });

  // ————————————————————————————— V4 (C4) —————————————————————————————

  it("V4: three rungs due in one pass — the HIGHEST speaks, the lower two record superseded_by and emit nothing", async () => {
    await createRole(db, "supervisor", "Supervisor");
    await createRole(db, "department_head", "Department Head");
    const { id: dm } = await createUser(db, { username: "dm2", fullName: "D", password: "p1234567" });
    await createRole(db, DUTY_MANAGER_ROLE, "Duty Manager");
    await assignRole(db, { userId: dm, roleKey: DUTY_MANAGER_ROLE, scopeType: "hospital" });

    const instanceId = await start();
    const rungs = (await timersOf(instanceId, "escalation")).sort((a, b) => a.percent! - b.percent!);
    // The worker was down for hours; all three came due while nobody was listening.
    await backdate([rungs[0]!.id], new Date(Date.now() - 3 * 60 * MIN));
    await backdate([rungs[1]!.id], new Date(Date.now() - 2 * 60 * MIN));
    await backdate([rungs[2]!.id], new Date(Date.now() - 1 * 60 * MIN));

    expect(await runDueTimers(db)).toBe(3); // all three are claimed and closed…

    const fired = await escalations();
    expect(fired).toHaveLength(1); // …and exactly one of them speaks
    expect(fired[0]!.payload as object).toMatchObject({ percent: 100, role: DUTY_MANAGER_ROLE, resolvedUserIds: [dm] });

    const after = (await timersOf(instanceId, "escalation")).sort((a, b) => a.percent! - b.percent!);
    expect(after[0]!.supersededBy).toBe(rungs[2]!.id);
    expect(after[1]!.supersededBy).toBe(rungs[2]!.id);
    expect(after[2]!.supersededBy).toBeNull(); // the one that spoke points at nobody
    for (const t of after) expect(t.firedAt).not.toBeNull();
  });

  it("V4 not-over-broad: rungs due SEPARATELY each speak — coalescing is about one pass, not about the ladder", async () => {
    await createRole(db, "supervisor", "Supervisor");
    await createRole(db, "department_head", "Department Head");
    const instanceId = await start();
    const rungs = (await timersOf(instanceId, "escalation")).sort((a, b) => a.percent! - b.percent!);

    await backdate([rungs[0]!.id], new Date(Date.now() - MIN));
    expect(await runDueTimers(db)).toBe(1);
    expect(await escalations()).toHaveLength(1);

    await backdate([rungs[1]!.id], new Date(Date.now() - MIN));
    expect(await runDueTimers(db)).toBe(1);
    const fired = await escalations();
    expect(fired).toHaveLength(2);
    expect(fired[1]!.payload as object).toMatchObject({ percent: 70 });
    expect((await timersOf(instanceId, "escalation")).every((t) => t.supersededBy === null)).toBe(true);
  });

  // ————————————————————————————— V5 —————————————————————————————

  it("V5: the respond clock fires ONCE, says how long the silence was allowed, and is not the breach", async () => {
    const instanceId = await start();
    const entered = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!.stateEnteredAt;
    const [respond] = await timersOf(instanceId, "respond");
    expect(respond!.dueAt.getTime() - entered.getTime()).toBe(30 * MIN);

    await backdate([respond!.id], new Date(Date.now() - MIN));
    expect(await runDueTimers(db)).toBe(1);
    expect(await runDueTimers(db)).toBe(0); // once

    const overdue = await db.select().from(events).where(eq(events.name, "respond.overdue"));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.payload as object).toMatchObject({ state: "open", respondMinutes: 30, defKey: "ladder_flow" });
    // Silence is not lateness: nothing about the budget moved.
    expect(await db.select().from(events).where(eq(events.name, "sla.breached"))).toHaveLength(0);
    expect(await openTimers(instanceId)).toHaveLength(4); // sla + three rungs, all untouched
  });

  it("V5: an ack cancels the respond clock and NOTHING else — the budget's timers stand", async () => {
    const instanceId = await start();
    const cancelled = await withTx(db, (tx) => cancelTimersOfKind(tx, instanceId, "respond"));
    expect(cancelled).toBe(1);

    const open = await openTimers(instanceId);
    expect(open).toHaveLength(4);
    expect(open.map((t) => t.kind).sort()).toEqual(["escalation", "escalation", "escalation", "sla"]);
    // And the cancelled clock stays cancelled: a second ack is a no-op, not a second cancel.
    expect(await withTx(db, (tx) => cancelTimersOfKind(tx, instanceId, "respond"))).toBe(0);
  });

  it("V5 / C5: a respond clock never outlives the budget it sits inside", async () => {
    // A ten-minute budget with a thirty-minute promise: the promise is clamped, not honoured.
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, {
      ...LADDER_DEF, key: "tiny_flow",
      states: [{ name: "open", sla: { minutes: 10, alerting: "active", respondMinutes: 30 } }, { name: "done", terminal: true }],
    });
    await activateDefinition(db, admin, definitionId);
    const { instanceId } = await withTx(db, (tx) => startInstance(tx, "tiny_flow", { type: "t", id: "s9" }));
    const entered = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!.stateEnteredAt;
    const [respond] = await timersOf(instanceId, "respond");
    expect(respond!.dueAt.getTime() - entered.getTime()).toBe(10 * MIN);
  });

  // ————————————————————————————— V3 —————————————————————————————

  it("V3: rescheduleBudget stamps the column and leaves exactly ONE live ladder and ONE live sla timer", async () => {
    const instanceId = await start();
    const entered = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!.stateEnteredAt;

    const result = await withTx(db, (tx) => rescheduleBudget(tx, instanceId, 120));
    expect(result.ladderRungs).toBe(3);
    expect(result.respondRescheduled).toBe(true);

    const instance = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!;
    expect(instance.budgetMinutes).toBe(120);

    const open = await openTimers(instanceId);
    expect(open.filter((t) => t.kind === "sla")).toHaveLength(1);
    expect(open.filter((t) => t.kind === "escalation")).toHaveLength(3);
    expect(open.filter((t) => t.kind === "respond")).toHaveLength(1);
    expect(open).toHaveLength(5); // and nothing else — the old set is cancelled, not abandoned

    // Re-laid from STATE ENTRY, against the new budget: 40 % of two hours is 48 minutes.
    const rungs = open.filter((t) => t.kind === "escalation").sort((a, b) => a.percent! - b.percent!);
    expect(rungs[0]!.dueAt.getTime() - entered.getTime()).toBe(48 * MIN);
    expect(rungs[2]!.dueAt.getTime() - entered.getTime()).toBe(120 * MIN);
    expect(open.find((t) => t.kind === "sla")!.dueAt.getTime() - entered.getTime()).toBe(120 * MIN);

    // The cancelled ones are cancelled, not deleted: the record of what was promised survives.
    const all = await timersOf(instanceId);
    expect(all.filter((t) => t.cancelledAt !== null)).toHaveLength(5);
  });

  it("V3: a budget change does NOT resurrect a respond clock somebody already answered", async () => {
    const instanceId = await start();
    await withTx(db, (tx) => cancelTimersOfKind(tx, instanceId, "respond"));

    const result = await withTx(db, (tx) => rescheduleBudget(tx, instanceId, 120));
    expect(result.respondRescheduled).toBe(false);

    const open = await openTimers(instanceId);
    expect(open.filter((t) => t.kind === "respond")).toHaveLength(0);
    expect(open).toHaveLength(4); // sla + three rungs
  });

  it("V3: a rung whose new instant is already past is correct, and fires on the next tick", async () => {
    const instanceId = await start();
    // Backdate the ENTRY by two hours, then cut the budget to one: 40 % of 60 min is 24 min,
    // which is already ninety-six minutes ago. A fresh full budget here would be the bug.
    const twoHoursAgo = new Date(Date.now() - 120 * MIN);
    await db.update(workflowInstances).set({ stateEnteredAt: twoHoursAgo }).where(eq(workflowInstances.id, instanceId));

    await withTx(db, (tx) => rescheduleBudget(tx, instanceId, 60));
    const rungs = (await openTimers(instanceId)).filter((t) => t.kind === "escalation");
    expect(rungs.every((t) => t.dueAt.getTime() < Date.now())).toBe(true);
  });

  it("V3: rescheduleBudget refuses a finished instance — there is no budget left to change", async () => {
    const instanceId = await start();
    await withTx(db, (tx) => transition(tx, instanceId, "done", SYSTEM));
    await expect(withTx(db, (tx) => rescheduleBudget(tx, instanceId, 120))).rejects.toThrow(/not active/);
    // And nothing was re-laid: `transition` cancelled every clock and they stay cancelled.
    expect(await openTimers(instanceId)).toHaveLength(0);
  });

  it("V3: rescheduleBudget refuses a budget that is not a positive whole number of minutes", async () => {
    const instanceId = await start();
    await expect(withTx(db, (tx) => rescheduleBudget(tx, instanceId, 0))).rejects.toThrow(/positive integer/);
    await expect(withTx(db, (tx) => rescheduleBudget(tx, instanceId, -5))).rejects.toThrow(/positive integer/);
    await expect(withTx(db, (tx) => rescheduleBudget(tx, instanceId, 1.5))).rejects.toThrow(/positive integer/);
    expect((await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId)))[0]!.budgetMinutes).toBeNull();
  });
});
