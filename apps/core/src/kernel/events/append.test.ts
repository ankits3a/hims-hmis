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

const idempotencyRows = async (db: Db) => (await db.execute(
  sql`select event_id as "eventId", seq::int as seq from event_idempotency order by seq`,
)).rows as { eventId: string; seq: number }[];

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

  it("records the claimed key in event_idempotency", async () => {
    const { eventId, seq } = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    expect(await idempotencyRows(db)).toEqual([{ eventId, seq }]);
  });

  it("keeps one event and one claim when the same key repeats", async () => {
    const a = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    const b = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    expect(b).toEqual(a);
    expect(await db.select().from(events)).toHaveLength(1);
    expect(await idempotencyRows(db)).toEqual([{ eventId: a.eventId, seq: a.seq }]);
  });

  it("claims nothing when no idempotency key is given", async () => {
    await withTx(db, (tx) => appendEvent(tx, input()));
    expect(await db.select().from(events)).toHaveLength(1);
    expect(await idempotencyRows(db)).toEqual([]);
  });

  it("claims one row per distinct idempotency key", async () => {
    const a = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    const b = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k2" })));
    expect(await db.select().from(events)).toHaveLength(2);
    expect(await idempotencyRows(db)).toEqual([
      { eventId: a.eventId, seq: a.seq },
      { eventId: b.eventId, seq: b.seq },
    ]);
  });
});
