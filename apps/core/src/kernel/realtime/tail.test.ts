import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { requireEnv } from "../config";
import { appendEvent } from "../events/append";
import { createDb, withTx } from "../db/client";
import { EventTail } from "./tail";
import type { TailedEvent } from "./tail";
import type { Db } from "../db/client";
import type { Pool } from "pg";

const mkInput = (name: string, extra: { patientId?: string; encounterId?: string } = {}) => ({
  name,
  version: 1,
  occurredAt: new Date(),
  actor: { type: "system" as const, id: "tail-test" },
  module: "opd",
  payload: { n: name },
  siteId: "main",
  ...extra,
});

describe("EventTail", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dbB: Db;
  let poolB: Pool;
  let tails: EventTail[] = [];

  const mkTail = (target: Db, names: string[]): EventTail => {
    const tail = new EventTail(target, () => names);
    tails.push(tail);
    return tail;
  };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // setupTestDb derives "<base>_<JEST_WORKER_ID>" from TEST_DATABASE_URL — mirror it exactly for
    // the SECOND pool, which stands in for "another process" appending to the same events table.
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    ({ db: dbB, pool: poolB } = createDb(workerUrl.toString()));
  });

  afterAll(async () => { await poolB.end(); await teardown(); });

  beforeEach(async () => { await truncateAll(db); tails = []; });
  afterEach(() => { for (const t of tails) t.stop(); });

  it("never replays history and delivers each new event exactly once", async () => {
    for (const n of ["visit.opened", "visit.opened", "queue.called"]) {
      await withTx(db, (tx) => appendEvent(tx, mkInput(n)));
    }

    const tail = mkTail(db, ["visit.opened", "queue.called"]);
    const seen: TailedEvent[] = [];
    tail.on((e) => seen.push(e));
    await tail.start();

    expect(await tail.poll()).toBe(0); // the floor is max(seq) at start — history is never replayed
    expect(seen).toEqual([]);

    const first = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened", { patientId: "P1", encounterId: "E1" })));
    const second = await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));

    expect(await tail.poll()).toBe(2);
    expect(seen.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    expect(seen[0]!.eventId).toBe(first.eventId);
    expect(seen[0]!.name).toBe("visit.opened");
    expect(seen[0]!.occurredAt).toBeInstanceOf(Date);
    expect(seen[0]!.patientId).toBe("P1");
    expect(seen[0]!.encounterId).toBe("E1");
    expect(seen[0]!.payload).toEqual({ n: "visit.opened" });
    expect(seen[1]!.patientId).toBeNull();
    expect(seen[1]!.encounterId).toBeNull();

    expect(await tail.poll()).toBe(0); // nothing is ever delivered twice
    expect(seen).toHaveLength(2);
  });

  it("delivers only the names its filter names", async () => {
    const tail = mkTail(db, ["queue.called"]);
    const seen: TailedEvent[] = [];
    tail.on((e) => seen.push(e));
    await tail.start();

    await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    expect(await tail.poll()).toBe(1);
    expect(seen.map((e) => e.name)).toEqual(["queue.called"]);
  });

  it("the look-back window delivers a LOWER seq that committed after the cursor advanced — exactly once", async () => {
    const tail = mkTail(db, ["queue.called"]);
    const seen: number[] = [];
    tail.on((e) => seen.push(e.seq));
    await tail.start();

    // "Another process" holds an open transaction: seq N is ALLOCATED but not yet visible.
    const client = await poolB.connect();
    try {
      await client.query("begin");
      const late = await client.query<{ seq: string }>(
        `insert into events (event_id, name, occurred_at, actor_type, actor_id, module, payload)
         values ($1, 'queue.called', now(), 'system', 'tail-test', 'opd', $2::jsonb) returning seq`,
        ["evt-late-commit", JSON.stringify({ n: "late" })],
      );
      const lateSeq = Number(late.rows[0]!.seq);

      const ahead = await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
      expect(ahead.seq).toBe(lateSeq + 1); // the sequence is not transactional: N then N+1

      expect(await tail.poll()).toBe(1); // only the committed, HIGHER seq is visible; the cursor jumps past N
      expect(seen).toEqual([ahead.seq]);

      await client.query("commit");

      expect(await tail.poll()).toBe(1); // N is below the cursor but inside the look-back window
      expect(seen).toEqual([ahead.seq, lateSeq]);

      expect(await tail.poll()).toBe(0); // and the dedupe set refuses a second delivery of either
      expect(seen).toEqual([ahead.seq, lateSeq]);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("resets its cursor when the sequence restarts (truncate … restart identity)", async () => {
    const tail = mkTail(db, ["queue.called"]);
    const seen: number[] = [];
    tail.on((e) => seen.push(e.seq));
    await tail.start();

    for (let i = 0; i < 3; i += 1) await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
    expect(await tail.poll()).toBe(3);
    expect(seen).toEqual([1, 2, 3]);

    await db.execute(sql`truncate table events restart identity`);
    const fresh = await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
    expect(fresh.seq).toBe(1);

    expect(await tail.poll()).toBe(1);
    expect(seen).toEqual([1, 2, 3, 1]);
  });

  it("two tails on two pools both see one event — fan-out reads the table, never a process-local bus", async () => {
    const a = mkTail(db, ["queue.called"]);
    const b = mkTail(dbB, ["queue.called"]);
    const seenA: string[] = [];
    const seenB: string[] = [];
    a.on((e) => seenA.push(e.eventId));
    b.on((e) => seenB.push(e.eventId));
    await a.start();
    await b.start();

    const appended = await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));

    expect(await a.poll()).toBe(1);
    expect(await b.poll()).toBe(1);
    expect(seenA).toEqual([appended.eventId]);
    expect(seenB).toEqual([appended.eventId]);
  });

  it("a throwing listener does not stop delivery, and off() unsubscribes", async () => {
    const tail = mkTail(db, ["queue.called"]);
    const good: number[] = [];
    tail.on(() => { throw new Error("a listener blew up"); });
    const off = tail.on((e) => good.push(e.seq));
    await tail.start();

    await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
    expect(await tail.poll()).toBe(1);
    expect(good).toHaveLength(1);

    off();
    await withTx(db, (tx) => appendEvent(tx, mkInput("queue.called")));
    expect(await tail.poll()).toBe(1); // still delivered — to the throwing listener only
    expect(good).toHaveLength(1);
  });
});
