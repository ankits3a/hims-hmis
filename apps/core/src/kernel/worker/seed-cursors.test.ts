import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "../events/append";
import { SubscriptionBus } from "../events/subscriptions";
import { runDispatchCycle } from "../events/dispatcher";
import { withTx, Db } from "../db/client";
import { ALERTS_CONSUMER } from "../alerts/consumer";
import { NOTIFY_CONSUMER } from "../notify/consumer";
import { seedCursors } from "./seed-cursors";

const mkInput = (name: string) => ({
  name, version: 1, occurredAt: new Date(),
  actor: { type: "system" as const, id: "test" }, module: "opd",
  payload: { n: name }, siteId: "main",
});

const cursorOf = async (db: Db, consumer: string): Promise<number> => {
  const rows = (await db.execute(
    sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
  )).rows as { lastSeq: number | string }[];
  return rows.length === 0 ? 0 : Number(rows[0]!.lastSeq);
};

describe("seedCursors", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("enumerates workerConsumers(db)'s keys — kernel.alerts and kernel.notify, and no others", async () => {
    const seeded = await seedCursors(db);
    expect(seeded.map((s) => s.consumer).sort()).toEqual([ALERTS_CONSUMER, NOTIFY_CONSUMER].sort());
  });

  /**
   * V10 — THE FLOOD THIS EXISTS TO PREVENT, PROVEN AGAINST HISTORY SEEDED FIRST.
   *
   * The plan's own words: "the flood has never actually been observed because the dev DB holds
   * no subscribed events — so a test that does not seed history first is asserting nothing."
   * History goes in BEFORE `seedCursors` runs, so the cursor it produces is a real answer to a
   * real backlog, not an artefact of an empty table where `max(seq)` and "no history" look
   * identical.
   *
   * THE EXPLICIT `lookback: 0`, AND WHY IT IS NOT A DIFFERENT CLAIM. `runDispatchCycle`'s window
   * is `seq > max(cursor − lookback, 0)` (dispatcher.ts), never `seq > cursor` directly — the
   * look-back exists to catch a row that committed late (dispatcher.test.ts's L1). At the
   * DEFAULT lookback (5000) a fixture with only a handful of history rows floors at 0 either
   * way, seeded or not, which would make this test pass under the mutant too (both leave the
   * whole tiny backlog inside the window) and prove nothing (rule 21). In production the
   * distinction is real the moment subscribed history exceeds 5000 rows — exactly the volume
   * D10 exists for. `lookback: 0` reproduces that same floor (`seq > cursor`) without paying for
   * 5000 inserts, the same knob dispatcher.test.ts's own suite overrides explicitly for
   * determinism (its "does not redeliver ... re-reads" case sets `lookback: 5_000`).
   */
  it("V10 — leaves a newly-seeded consumer at max(seq); the next cycle delivers nothing", async () => {
    for (let i = 0; i < 4; i += 1) {
      await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    }
    const last = await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));

    const seeded = await seedCursors(db);
    const alertsSeed = seeded.find((s) => s.consumer === ALERTS_CONSUMER);
    expect(alertsSeed).toBeDefined();
    expect(alertsSeed!.lastSeq).toBe(last.seq); // max(seq) at seed time — the whole backlog
    expect(await cursorOf(db, ALERTS_CONSUMER)).toBe(last.seq);

    const delivered: number[] = [];
    const bus = new SubscriptionBus();
    bus.on(ALERTS_CONSUMER, "alert.raised", async (e) => { delivered.push(e.seq); });

    expect(await runDispatchCycle(db, bus, { lookback: 0 })).toBe(0); // shipped: nothing replayed
    expect(delivered).toEqual([]);
  });

  /**
   * V11 — SEEDING NEVER LOWERS AN EXISTING CURSOR.
   *
   * Staged directly rather than produced by a race (matching dispatcher.test.ts's own precedent
   * for a cursor state only a concurrent process can reach): an existing cursor ahead of
   * `max(seq)` — a live dispatch cycle already past the current backlog — must survive a seeding
   * run untouched. An unconditional overwrite would drag it back to `max(seq)`, and everything
   * between the regressed cursor and the value it held would be delivered again next cycle.
   */
  it("V11 — never lowers an existing cursor that already sits ahead of max(seq)", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    const aheadOfHistory = e1.seq + 1000;
    await db.execute(sql`
      insert into event_cursors (consumer, last_seq) values (${ALERTS_CONSUMER}, ${aheadOfHistory})
    `);

    const seeded = await seedCursors(db);
    const alertsSeed = seeded.find((s) => s.consumer === ALERTS_CONSUMER);
    expect(alertsSeed).toBeDefined();
    expect(alertsSeed!.lastSeq).toBe(aheadOfHistory); // untouched
    expect(await cursorOf(db, ALERTS_CONSUMER)).toBe(aheadOfHistory);
  });

  it("is idempotent: seeding twice with no new history leaves the cursor exactly where it was", async () => {
    await withTx(db, (tx) => appendEvent(tx, mkInput("alert.raised")));
    const first = await seedCursors(db);
    const second = await seedCursors(db);
    expect(second).toEqual(first);
  });
});
