import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { events } from "./events";
import type { Db } from "../client";
import type { Pool } from "pg";

describe("events table", () => {
  let db: Db; let pool: Pool; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("inserts a full envelope row and reads it back", async () => {
    await db.insert(events).values({
      eventId: "01TESTULID0000000000000000",
      name: "patient.registered",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
      actorType: "user",
      actorId: "u1",
      module: "registration",
      payload: { uhid: "H0001" },
    });
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("patient.registered");
    expect(rows[0]!.siteId).toBe("main");
    expect(rows[0]!.recordedAt).toBeInstanceOf(Date);
  });

  it("enforces idempotency_key uniqueness", async () => {
    const base = {
      name: "sample.collected", occurredAt: new Date(), actorType: "user", actorId: "u1",
      module: "lab", payload: {}, idempotencyKey: "edge-1",
    };
    await db.insert(events).values({ ...base, eventId: "01A" });
    await expect(db.insert(events).values({ ...base, eventId: "01B" })).rejects.toThrow();
  });
});
