import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "./append";
import { withTx, Db } from "../db/client";
import { events } from "../db/schema";
import { sql } from "drizzle-orm";

const input = (over: Partial<Parameters<typeof appendEvent>[1]> = {}) => ({
  name: "visit.opened", version: 1, occurredAt: new Date(),
  actor: { type: "user" as const, id: "u1" }, module: "opd",
  payload: { visitId: "v1" }, siteId: "main", ...over,
});

describe("appendEvent", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("writes the event inside the caller's transaction", async () => {
    const { eventId } = await withTx(db, (tx) => appendEvent(tx, input()));
    expect(eventId).toHaveLength(26);
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
  });

  it("rolls back with the enclosing transaction", async () => {
    await expect(
      withTx(db, async (tx) => {
        await appendEvent(tx, input());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent on idempotency_key", async () => {
    const a = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    const b = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    expect(b.eventId).toBe(a.eventId);
    const [{ count }] = (await db.execute(sql`select count(*)::int as count from events`)).rows as [{ count: number }];
    expect(count).toBe(1);
  });
});
