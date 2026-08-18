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

  it("a tick that races shutdown raises no unhandled rejection — and a genuine failure is still loud", async () => {
    // The rejection is captured at its SOURCE (`escaped` below), never left to jest's incidental attribution to
    // whichever suite the worker picks up next. A process listener is kept as belt-and-braces only: jest-environment-node
    // hands the test a sandboxed `process`, and node emits "unhandledRejection" on the real one, so this listener is inert
    // here (probed: 0 deliveries after 210 ms) — it must never be the load-bearing assertion.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // This test's own pool, so ending it disturbs nothing else in the suite.
      const url = new URL(requireEnv("TEST_DATABASE_URL"));
      url.pathname = `${url.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
      const { db: dbC, pool: poolC } = createDb(url.toString());

      // Nest's shutdown interleaving, driven by hand instead of waited for: a scheduled tick is PAST its first query
      // when RealtimeModule's onModuleDestroy stops the tail and AppModule's onModuleDestroy ends the pool underneath it.
      let tickIsPastItsFirstQuery!: () => void;
      let shutdownIsDone!: () => void;
      const inFlight = new Promise<void>((res) => { tickIsPastItsFirstQuery = res; });
      const shutdown = new Promise<void>((res) => { shutdownIsDone = res; });
      let queries = 0;
      const escaped: unknown[] = []; // every rejection the tail's own fire-and-forget tick would have leaked, caught here
      const gated = {
        execute: async (q: Parameters<Db["execute"]>[0]) => {
          queries += 1;
          const nth = queries;
          const res = await dbC.execute(q).catch((err: unknown) => { escaped.push(err); throw err; });
          if (nth === 2) { tickIsPastItsFirstQuery(); await shutdown; } // 1 = start()'s floor read, 2 = the tick's maxSeq()
          return res;
        },
      } as unknown as Db;

      const tail = new EventTail(gated, () => ["queue.called"], { intervalMs: 5, lookback: 500, batch: 1000 });
      tails.push(tail);
      await tail.start();

      await inFlight;
      tail.stop();       // RealtimeModule.onModuleDestroy — the interval is cleared, the in-flight tick is not awaited
      await poolC.end(); // AppModule.onModuleDestroy — the pool the tick's NEXT query would acquire from
      shutdownIsDone();
      await new Promise((res) => setTimeout(res, 50)); // let the tick finish and node emit any rejection nobody owns

      expect(escaped).toEqual([]);   // pre-fix: [Error: Cannot use a pool after calling end on the pool] — nobody owned it
      expect(queries).toBe(2);       // the second query is never issued once stop() has run
      expect(unhandled).toEqual([]); // inert here (see above), kept so a stricter environment would still catch a leak

      // The other half: a tick's failure that is NOT shutdown stays loud — poll() propagates it, unswallowed (§3.6).
      const boom = new Error('relation "events" does not exist');
      let broken = 0;
      const brokenDb = {
        execute: async () => { broken += 1; if (broken === 1) return { rows: [{ m: 0 }] }; throw boom; },
      } as unknown as Db;
      const loud = new EventTail(brokenDb, () => ["queue.called"], { intervalMs: 60_000, lookback: 500, batch: 1000 });
      tails.push(loud);
      await loud.start();
      await expect(loud.poll()).rejects.toBe(boom);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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
