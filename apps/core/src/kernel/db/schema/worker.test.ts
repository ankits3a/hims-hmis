import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { alerts } from "./alerts";
import { users } from "./auth";
import { eventDeadLetters, eventDeliveries, schedulerHeartbeats } from "./worker";
import type { Db } from "../client";

const PROBE_USER = "01HWORKERTRUNCATEUSER0001";

describe("worker tables", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("round-trips a heartbeat row with its nullable columns empty", async () => {
    await db.insert(schedulerHeartbeats).values({
      job: "runDispatchCycle", lastStartedAt: new Date("2026-08-21T06:00:00Z"),
    });
    const rows = await db.select().from(schedulerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastOkAt).toBeNull();
    expect(rows[0]!.lastError).toBeNull();
    expect(rows[0]!.lastDurationMs).toBeNull();
  });

  it("rejects a second heartbeat row for the same job (job is the PK, so ticks upsert)", async () => {
    await db.insert(schedulerHeartbeats).values({ job: "runDueTimers", lastStartedAt: new Date() });
    await expect(
      db.insert(schedulerHeartbeats).values({ job: "runDueTimers", lastStartedAt: new Date() }),
    ).rejects.toThrow();
  });

  it("defaults a delivery claim's attempts to 0 and stamps updated_at", async () => {
    await db.insert(eventDeliveries).values({ consumer: "kernel.alerts", seq: 7, status: "done" });
    const rows = await db.select().from(eventDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.nextAttemptAt).toBeNull();
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it("keys a delivery claim on (consumer, seq) — the SAME seq still claims under another consumer", async () => {
    await db.insert(eventDeliveries).values({ consumer: "kernel.alerts", seq: 7, status: "done" });
    await db.insert(eventDeliveries).values({ consumer: "kernel.audit", seq: 7, status: "done" });
    expect(await db.select().from(eventDeliveries)).toHaveLength(2);
    await expect(
      db.insert(eventDeliveries).values({ consumer: "kernel.alerts", seq: 7, status: "retrying" }),
    ).rejects.toThrow();
  });

  it("accepts a delivery row for a seq no events row ever had", async () => {
    // The recorded trade in schema/worker.ts: no FK to events.seq, so nothing at the DB layer
    // stops this. Integrity is application-level — only the dispatcher writes these rows, and
    // only from rows it has just read. Asserted so the absence stays a decision, not a drift.
    await db.insert(eventDeliveries).values({ consumer: "kernel.alerts", seq: 999999, status: "done" });
    expect(await db.select().from(eventDeliveries)).toHaveLength(1);
  });

  it("round-trips a dead letter with parked_at defaulted", async () => {
    await db.insert(eventDeadLetters).values({
      consumer: "kernel.alerts", seq: 3, eventId: "01DEADLETTER00000000000001",
      name: "escalation.triggered", error: "handler always throws", attempts: 5,
    });
    const rows = await db.select().from(eventDeadLetters);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(5);
    expect(rows[0]!.parkedAt).toBeInstanceOf(Date);
  });

  // L15 — the truncate group. The property is "rows do not survive truncateAll", and no inbound
  // foreign key points at any of these four tables, so there is no FK error to assert: the
  // observable is the LEAKED ROW (§3.36). These two tests are a PAIR and run in declaration
  // order — the first writes, the second reads back after beforeEach has truncated.
  it("writes one row into each of migration 0014's four tables", async () => {
    await db.insert(users).values({
      id: PROBE_USER, username: "truncate-probe", fullName: "Truncate Probe", passwordHash: "x",
    });
    await db.insert(schedulerHeartbeats).values({ job: "runDailyClose", lastStartedAt: new Date() });
    await db.insert(eventDeliveries).values({ consumer: "kernel.alerts", seq: 11, status: "done" });
    await db.insert(eventDeadLetters).values({
      consumer: "kernel.alerts", seq: 12, eventId: "01TRUNCATEPROBE00000000001",
      name: "escalation.triggered", error: "poison", attempts: 5,
    });
    await db.insert(alerts).values({
      id: "01HALERTTRUNCATEPROBE0001", userId: PROBE_USER, kind: "escalation",
      title: "opd_wait · waiting · rung 0", sourceEventId: "01TRUNCATEPROBE00000000001",
    });
    expect(await db.select().from(schedulerHeartbeats)).toHaveLength(1);
    expect(await db.select().from(eventDeliveries)).toHaveLength(1);
    expect(await db.select().from(eventDeadLetters)).toHaveLength(1);
    expect(await db.select().from(alerts)).toHaveLength(1);
  });

  it("truncateAll leaves all four of migration 0014's tables empty", async () => {
    expect(await db.select().from(schedulerHeartbeats)).toHaveLength(0);
    expect(await db.select().from(eventDeliveries)).toHaveLength(0);
    expect(await db.select().from(eventDeadLetters)).toHaveLength(0);
    expect(await db.select().from(alerts)).toHaveLength(0);
  });
});
