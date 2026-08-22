import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { requireEnv } from "../config";
import { appendEvent } from "./append";
import { SubscriptionBus } from "./subscriptions";
import { runDispatchCycle } from "./dispatcher";
import { createDb, withTx, Db } from "../db/client";
import { eventCursors, eventDeliveries, events } from "../db/schema";
import type { Pool } from "pg";

const mkInput = (name: string) => ({
  name, version: 1, occurredAt: new Date(),
  actor: { type: "system" as const, id: "test" }, module: "opd",
  payload: { n: name }, siteId: "main",
});

// The floor tests below need `recorded_at` PINNED, and `appendEvent` deliberately does not take
// it — the column is the append's own transaction-start time everywhere else in the system. They
// insert the envelope directly instead, which is the only way to stage a row in a past month.
const recordedRow = (eventId: string, recordedAt: Date) => ({
  eventId, name: "visit.opened", version: 1, occurredAt: recordedAt, recordedAt,
  actorType: "system", actorId: "test", module: "opd", payload: { eventId }, siteId: "main",
});

// Every cycle below is driven by an EXPLICIT `now` (Global Constraint 9), so the backoff
// arithmetic is arithmetic and not a wait: there is no sleep anywhere in this file.
const T0 = new Date("2026-08-21T06:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const cursorOf = async (db: Db, consumer: string): Promise<number> => {
  const rows = (await db.execute(
    sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
  )).rows as { lastSeq: number | string }[];
  return rows.length === 0 ? 0 : Number(rows[0]!.lastSeq);
};

const deliveriesOf = async (
  db: Db,
  consumer: string,
): Promise<{ seq: number; status: string; attempts: number }[]> => {
  const rows = (await db.execute(sql`
    select seq, status, attempts from event_deliveries where consumer = ${consumer} order by seq asc
  `)).rows as { seq: number | string; status: string; attempts: number }[];
  return rows.map((r) => ({ seq: Number(r.seq), status: r.status, attempts: Number(r.attempts) }));
};

const countEvents = async (db: Db, name: string): Promise<number> => {
  const rows = (await db.execute(
    sql`select count(*)::int as n from events where name = ${name}`,
  )).rows as [{ n: number }];
  return rows[0]!.n;
};

/**
 * A two-party latch: both cycles must ARRIVE before either proceeds, which is what makes the
 * interleaving deterministic rather than raced (no sleeps, no timing assumptions). It is safe for
 * every implementation this file runs against precisely BECAUSE the claim is written after the
 * handler — an implementation that claimed before the handler would never let the second cycle
 * read the row, and would hang here instead. Do not reuse it against one.
 */
const barrier = (parties: number): (() => Promise<void>) => {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((res) => { open = res; });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await gate;
  };
};

describe("runDispatchCycle", () => {
  let db: Db; let teardown: () => Promise<void>;
  let dbB: Db; let poolB: Pool;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // setupTestDb derives "<base>_<JEST_WORKER_ID>" from TEST_DATABASE_URL — mirror it exactly for
    // the SECOND pool (tail.test.ts:37), which stands in for another process: one holding a
    // transaction open, and one running a competing dispatch cycle.
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    ({ db: dbB, pool: poolB } = createDb(workerUrl.toString()));
  });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await poolB.end(); await teardown(); });

  it("delivers matching events once and advances the cursor", async () => {
    const seen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("billing.autoCharge", "visit.opened", async (e) => { seen.push(e.eventId); });

    const first = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered")));
    const last = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    expect(await runDispatchCycle(db, bus, { now: T0 })).toBe(2);
    expect(seen).toHaveLength(2);
    expect(await cursorOf(db, "billing.autoCharge")).toBe(last.seq); // nothing unresolved: max seq seen
    expect(await runDispatchCycle(db, bus, { now: T0 })).toBe(0); // nothing redelivered
    expect(seen).toHaveLength(2);
    expect(await deliveriesOf(db, "billing.autoCharge")).toEqual([
      { seq: first.seq, status: "done", attempts: 1 },
      { seq: last.seq, status: "done", attempts: 1 },
    ]);
  });

  it("does not advance the cursor past a failing handler", async () => {
    let calls = 0;
    const bus = new SubscriptionBus();
    bus.on("flaky.consumer", "visit.opened", async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    });

    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus, { now: T0 }); // handler throws; swallowed per-consumer
    expect(calls).toBe(1);
    expect(await cursorOf(db, "flaky.consumer")).toBe(e1.seq - 1); // min unresolved − 1
    // Below the poison threshold the row is redelivered next cycle, exactly as it always was —
    // the one thing that sharpened is that the retry is DRIVEN (attempts = 1 ⇒ +2 s, D4) instead
    // of being immediate, so the second cycle carries the advanced `now`.
    expect(await runDispatchCycle(db, bus, { now: at(2_000) })).toBe(1); // redelivered
    expect(calls).toBe(2);
    expect(await cursorOf(db, "flaky.consumer")).toBe(e1.seq);
  });

  it("isolates consumers — one failing consumer does not block another", async () => {
    const okSeen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("bad.consumer", "visit.opened", async () => { throw new Error("always"); });
    bus.on("good.consumer", "visit.opened", async (e) => { okSeen.push(e.eventId); });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus, { now: T0 });
    expect(okSeen).toHaveLength(1);
  });

  // L1 — the defect this file exists to remove, and the spike's own reproduction (report question
  // C: against the frontier read the delivered list was [2] and seq 1 was never delivered).
  it("delivers a row whose seq was allocated early and committed late, exactly once", async () => {
    const delivered: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("late.consumer", "visit.opened", async (e) => { delivered.push(e.seq); });

    let allocated!: () => void; let release!: () => void;
    const allocatedP = new Promise<void>((res) => { allocated = res; });
    const heldOpen = new Promise<void>((res) => { release = res; });

    // A: BEGIN + INSERT (allocates N) and HOLD, on its own pool.
    let seqN = 0;
    const txA = withTx(dbB, async (tx) => {
      seqN = (await appendEvent(tx, mkInput("visit.opened"))).seq;
      allocated();
      await heldOpen;
    });
    await allocatedP;

    // B: INSERT N+1 and COMMIT while A is still open.
    const seqN1 = (await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")))).seq;
    expect(seqN1).toBe(seqN + 1);

    await runDispatchCycle(db, bus, { now: T0 });
    expect(delivered).toEqual([seqN1]); // N is not visible yet — only N+1 can be delivered

    release(); await txA; // A commits — N appears BEHIND a cursor that already passed it

    await runDispatchCycle(db, bus, { now: at(1_000) });
    await runDispatchCycle(db, bus, { now: at(2_000) });

    expect([...delivered].sort((a, b) => a - b)).toEqual([seqN, seqN1]); // each exactly once
    expect(await deliveriesOf(db, "late.consumer")).toEqual([
      { seq: seqN, status: "done", attempts: 1 },
      { seq: seqN1, status: "done", attempts: 1 },
    ]);
  });

  // L2 — the decision this whole file encodes, and the one an inverted implementation would lose.
  it("records the delivery claim on SUCCESS, not before the handler", async () => {
    const effects: number[] = [];
    let calls = 0;
    const bus = new SubscriptionBus();
    bus.on("claim.consumer", "visit.opened", async (e) => {
      calls += 1;
      if (calls === 1) throw new Error("the handler died before it did anything");
      effects.push(e.seq);
    });

    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    // The outcome is CAPTURED and the INVARIANT asserted — never `await expect(...).rejects` on a
    // promise a wrong implementation could make resolve, which hangs instead of failing (§2.45).
    expect(await runDispatchCycle(db, bus, { now: T0 })).toBe(0);
    expect(effects).toEqual([]);

    // Claim-before-work would have marked this event delivered above; claim-on-success has not,
    // so the second cycle still owes it. THIS is at-least-once, and it is why the placement is the
    // opposite of billing's withIdempotency (D4/D5).
    expect(await runDispatchCycle(db, bus, { now: at(2_000) })).toBe(1);
    expect(effects).toEqual([e1.seq]); // the delivered EFFECT happened exactly once
    expect(calls).toBe(2);
    expect(await deliveriesOf(db, "claim.consumer")).toEqual([
      { seq: e1.seq, status: "done", attempts: 2 },
    ]);
  });

  // L3 — poison parks, and the consumer moves on. The shipped `break` never let it.
  it("parks a poison event after maxAttempts and the consumer moves on", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    const e2 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    const seen: number[] = [];
    let invocations = 0;
    const bus = new SubscriptionBus();
    bus.on("poison.consumer", "visit.opened", async (e) => {
      if (e.seq === e1.seq) { invocations += 1; throw new Error("always throws"); }
      seen.push(e.seq);
    });

    // Five cycles, each driven exactly onto the previous next_attempt_at (2 · 4 · 8 · 16 s).
    for (const ms of [0, 2_000, 6_000, 14_000, 30_000]) {
      await runDispatchCycle(db, bus, { now: at(ms) });
    }

    expect(invocations).toBe(5);
    expect(seen).toEqual([e2.seq]); // the later event is delivered once the poison parks
    const dead = (await db.execute(sql`
      select seq, event_id as "eventId", error, attempts
      from event_dead_letters where consumer = 'poison.consumer'
    `)).rows as { seq: number | string; eventId: string; error: string; attempts: number }[];
    expect(dead).toHaveLength(1);
    expect(Number(dead[0]!.seq)).toBe(e1.seq);
    expect(dead[0]!.eventId).toBe(e1.eventId);
    expect(dead[0]!.error).toBe("always throws");
    expect(Number(dead[0]!.attempts)).toBe(5);
    expect(await countEvents(db, "consumer.poisoned")).toBe(1);
    expect(await deliveriesOf(db, "poison.consumer")).toEqual([
      { seq: e1.seq, status: "parked", attempts: 5 },
      { seq: e2.seq, status: "done", attempts: 1 },
    ]);
    expect(await cursorOf(db, "poison.consumer")).toBe(e2.seq); // strictly past the parked row
  });

  // L4 — the guard on the parking transition. Note the interleaving: the plan's stated input
  // (further cycles after a park) cannot exercise the guard at all, because a parked row is
  // filtered out of the window and is never re-parked SEQUENTIALLY. What the guard is for — D4's
  // own words, "so exactly one transitioning transaction exists" — is two cycles crossing
  // maxAttempts on the same row TOGETHER. Both legs are asserted; the concurrent one has the teeth.
  it("appends consumer.poisoned exactly once per parked row, even when two cycles park it together", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    const arrive = barrier(2);
    let racing = false;
    let invocations = 0;
    const bus = new SubscriptionBus();
    bus.on("race.consumer", "visit.opened", async () => {
      invocations += 1;
      if (racing) await arrive(); // hold BOTH cycles past their read, before either parks
      throw new Error("always throws");
    });

    for (const ms of [0, 2_000, 6_000, 14_000]) {
      await runDispatchCycle(db, bus, { now: at(ms) });
    }
    expect(await deliveriesOf(db, "race.consumer")).toEqual([
      { seq: e1.seq, status: "retrying", attempts: 4 }, // one failure short of the threshold
    ]);

    racing = true;
    const outcomes = await Promise.allSettled([
      runDispatchCycle(db, bus, { now: at(30_000) }),
      runDispatchCycle(dbB, bus, { now: at(30_000) }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(invocations).toBe(6);

    expect(await countEvents(db, "consumer.poisoned")).toBe(1);
    expect(await deliveriesOf(db, "race.consumer")).toEqual([
      { seq: e1.seq, status: "parked", attempts: 5 },
    ]);
    const dead = (await db.execute(
      sql`select count(*)::int as n from event_dead_letters where consumer = 'race.consumer'`,
    )).rows as [{ n: number }];
    expect(dead[0]!.n).toBe(1);

    // The plan's own leg: nothing re-parks it on any later cycle either.
    racing = false;
    for (const ms of [40_000, 50_000, 60_000]) {
      await runDispatchCycle(db, bus, { now: at(ms) });
    }
    expect(await countEvents(db, "consumer.poisoned")).toBe(1);
    expect(invocations).toBe(6); // a parked row is not handed to the handler again
  });

  // L5 — two concurrent cycles over one event.
  it("resolves two concurrent cycles to ONE claim row, with both cycles completing", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    const arrive = barrier(2);
    const invocations: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("concurrent.consumer", "visit.opened", async (e) => {
      invocations.push(e.seq);
      await arrive(); // both cycles are past their read and neither has claimed
    });

    const outcomes = await Promise.allSettled([
      runDispatchCycle(db, bus, { now: T0 }),
      runDispatchCycle(dbB, bus, { now: T0 }),
    ]);

    // §3.13: nothing here asserts WHICH cycle did the work — the loser's diagnosis is not a
    // property of the system. Both outcomes are captured and only the invariant is asserted.
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await deliveriesOf(db, "concurrent.consumer")).toEqual([
      { seq: e1.seq, status: "done", attempts: 1 },
    ]);
    // Handler invocations are REPORTED, not pinned: at-least-once makes 1 and 2 both correct.
    expect([1, 2]).toContain(invocations.length);
  });

  it("moves the cursor to (min unresolved seq) − 1, else the max seq seen, and never decreases it", async () => {
    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    const e2 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    const e3 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    let failOn: number | null = null;
    const seen: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("cursor.consumer", "visit.opened", async (e) => {
      if (e.seq === failOn) throw new Error("held");
      seen.push(e.seq);
    });

    failOn = e2.seq;
    await runDispatchCycle(db, bus, { now: T0 });
    expect(seen).toEqual([e1.seq]);
    expect(await cursorOf(db, "cursor.consumer")).toBe(e2.seq - 1); // min unresolved − 1

    failOn = null;
    await runDispatchCycle(db, bus, { now: at(2_000) });
    expect(seen).toEqual([e1.seq, e2.seq, e3.seq]);
    expect(await cursorOf(db, "cursor.consumer")).toBe(e3.seq); // else the max seq seen

    // An unresolved row BELOW the cursor — a state only a concurrent cycle produces, staged
    // directly here — must not drag the cursor backwards.
    await db.execute(sql`
      update event_deliveries set status = 'retrying', next_attempt_at = ${at(-1_000).toISOString()}::timestamptz
      where consumer = 'cursor.consumer' and seq = ${e1.seq}
    `);
    failOn = e1.seq;
    await runDispatchCycle(db, bus, { now: at(4_000) });
    expect(await cursorOf(db, "cursor.consumer")).toBe(e3.seq);
  });

  // The not-over-broad companion (§3.44): no mutant in this set catches a window that is too WIDE.
  it("does not redeliver an already-resolved row that the look-back window re-reads", async () => {
    const seen: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("window.consumer", "visit.opened", async (e) => { seen.push(e.seq); });

    const e1 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    const e2 = await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    expect(await runDispatchCycle(db, bus, { now: T0, lookback: 5_000 })).toBe(2);
    expect(seen).toEqual([e1.seq, e2.seq]);

    // cursor − 5000 is far below seq 1, so the second cycle genuinely RE-READS both rows: it is
    // the delivery claims, not the cursor, that stop them being delivered a second time.
    expect(await runDispatchCycle(db, bus, { now: at(60_000), lookback: 5_000 })).toBe(0);
    expect(seen).toEqual([e1.seq, e2.seq]);
    expect(await deliveriesOf(db, "window.consumer")).toEqual([
      { seq: e1.seq, status: "done", attempts: 1 },
      { seq: e2.seq, status: "done", attempts: 1 },
    ]);
    expect(await cursorOf(db, "window.consumer")).toBe(e2.seq);
  });

  /**
   * N11 — THE ENVELOPE WIDENING (Plan 10 D5). Every scheduling and staleness decision the notify
   * consumer makes reads `e.occurredAt`, so what this field CONTAINS is load-bearing: the row's
   * own `occurred_at`, never the dispatcher's clock. Selecting `now()` instead — or dropping the
   * column and letting `new Date(undefined)` produce an Invalid Date — turns every replay into a
   * fresh, live message to a patient about an appointment that is already over.
   *
   * The instant below is deliberately MONTHS in the past and is written by the appending
   * transaction itself (§3.41: a pinned date must reach the writer), so "the handler received
   * the row's own time" and "the handler received a clock reading" cannot look alike.
   */
  it("hands the handler the inserted row's OWN occurred_at, not the dispatch clock", async () => {
    const OCCURRED = new Date("2026-05-04T09:17:23.000Z");
    const received: Date[] = [];
    const bus = new SubscriptionBus();
    bus.on("occurredAt.consumer", "visit.opened", async (e) => { received.push(e.occurredAt); });

    const e1 = await withTx(db, (tx) =>
      appendEvent(tx, { ...mkInput("visit.opened"), occurredAt: OCCURRED }),
    );

    expect(await runDispatchCycle(db, bus, { now: T0 })).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(OCCURRED);
    // The fixture proof for the assertion above (§3.14): the stored row really does carry that
    // instant, and T0 — the clock this cycle ran on — is a different one, so an implementation
    // that read the clock could not accidentally pass.
    const stored = (await db.execute(
      sql`select occurred_at as "occurredAt" from events where seq = ${e1.seq}`,
    )).rows as [{ occurredAt: Date | string }];
    expect(new Date(stored[0].occurredAt)).toEqual(OCCURRED);
    expect(received[0]).not.toEqual(T0);
  });

  /**
   * V1 — THE PARTITION FLOOR PRUNES AND DOES NOT SKIP (Plan 11a D5, Assertion Book V1).
   *
   * `events` is RANGE-partitioned by IST month, and the window query gained ONE predicate:
   * `recorded_at >= date_trunc('month', <recorded_at of the cursor's seq>)`. The floor is taken
   * from THE CURSOR'S OWN ROW and never from the clock, and that distinction is the whole test.
   * A floor computed from `now` looks identical on the day it is written and starts silently
   * dropping events on the first of every month: the cursor is still in month M, the events
   * behind it are still in month M, and the floor has moved to M+1.
   *
   * The three rows below make the two halves separable:
   *   · one row in month M-1, undelivered — BELOW the floor, and not delivered. That is the
   *     pruning half, and it is why an implementation with NO floor at all also fails here.
   *   · the cursor's own row in month M, already claimed `done`.
   *   · one row LATER in month M, undelivered — inside the floor, and delivered. That is the
   *     not-skipping half.
   * `now` is in M+1 throughout, so a clock-derived floor excludes all three.
   *
   * Recorded instants are written by the INSERT itself (§3.41) rather than defaulted, because
   * `recorded_at` is exactly the column under test.
   */
  it("delivers an undelivered event in the CURSOR'S OWN month, and skips the month below it (V1)", async () => {
    const OLDER_MONTH = new Date("2026-06-20T04:30:00.000Z"); // IST 2026-06-20 10:00 — month M-1
    const CURSOR_AT = new Date("2026-07-10T04:30:00.000Z"); // IST 2026-07-10 10:00 — month M
    const LATER_IN_MONTH = new Date("2026-07-25T04:30:00.000Z"); // IST 2026-07-25 10:00 — month M
    const NOW_NEXT_MONTH = new Date("2026-08-05T04:30:00.000Z"); // IST 2026-08-05 10:00 — M+1

    const seen: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("floor.consumer", "visit.opened", async (e) => { seen.push(e.seq); });

    const rows = await db.insert(events).values([
      recordedRow("01HFLOOR0000000000000OLD", OLDER_MONTH),
      recordedRow("01HFLOOR000000000000CURS", CURSOR_AT),
      recordedRow("01HFLOOR00000000000LATER", LATER_IN_MONTH),
    ]).returning({ seq: events.seq });
    const [older, atCursor, later] = rows;

    // The cursor sits on the middle row and that row is already resolved, so the only thing the
    // floor decides is which of the OTHER two the window can still see.
    await db.insert(eventDeliveries).values({
      consumer: "floor.consumer", seq: atCursor!.seq, status: "done", attempts: 1, updatedAt: CURSOR_AT,
    });
    await db.insert(eventCursors).values({ consumer: "floor.consumer", lastSeq: atCursor!.seq });

    expect(await runDispatchCycle(db, bus, { now: NOW_NEXT_MONTH })).toBe(1);
    expect(seen).toEqual([later!.seq]);
    // The pruned row is not merely undelivered — it is still unclaimed, so nothing marked it
    // resolved on its way past.
    expect(await deliveriesOf(db, "floor.consumer")).toEqual([
      { seq: atCursor!.seq, status: "done", attempts: 1 },
      { seq: later!.seq, status: "done", attempts: 1 },
    ]);
    expect(seen).not.toContain(older!.seq);
  });

  /**
   * The floor's month boundary is IST (+05:30), not UTC — the same fact the partition bounds
   * carry (Plan 11a D5: the retention unit is an IST concept). The row below is recorded at
   * 2026-06-30T20:00:00Z, which is 2026-07-01 01:30 IST: it belongs to IST month July and is
   * delivered, while a UTC truncation would put the floor at 2026-07-01T00:00:00Z — four hours
   * LATER than the row — and lose it. Nothing else in this file separates those two.
   */
  it("truncates the floor on the IST month, not the UTC one", async () => {
    const JUST_INTO_IST_JULY = new Date("2026-06-30T20:00:00.000Z"); // IST 2026-07-01 01:30
    const CURSOR_AT = new Date("2026-07-10T04:30:00.000Z");
    const NOW_NEXT_MONTH = new Date("2026-08-05T04:30:00.000Z");

    const seen: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("ist.consumer", "visit.opened", async (e) => { seen.push(e.seq); });

    const rows = await db.insert(events).values([
      recordedRow("01HFLOORIST00000000EDGE0", JUST_INTO_IST_JULY),
      recordedRow("01HFLOORIST0000000CURSOR", CURSOR_AT),
    ]).returning({ seq: events.seq });
    const [edge, atCursor] = rows;

    await db.insert(eventDeliveries).values({
      consumer: "ist.consumer", seq: atCursor!.seq, status: "done", attempts: 1, updatedAt: CURSOR_AT,
    });
    await db.insert(eventCursors).values({ consumer: "ist.consumer", lastSeq: atCursor!.seq });

    expect(await runDispatchCycle(db, bus, { now: NOW_NEXT_MONTH })).toBe(1);
    expect(seen).toEqual([edge!.seq]);
  });

  /**
   * The degrade case the plan names explicitly: cursor 0 (a brand-new consumer) has no row to
   * read a floor from, so there is NO floor and the window is bounded by `seq` alone. An
   * implementation that defaulted a missing floor to `now`'s month — or to anything but "no
   * floor" — would deliver nothing at all to a new consumer over historical events.
   */
  it("degrades to NO floor when the cursor names no row", async () => {
    const LONG_AGO = new Date("2024-02-11T04:30:00.000Z");
    const seen: number[] = [];
    const bus = new SubscriptionBus();
    bus.on("newcomer.consumer", "visit.opened", async (e) => { seen.push(e.seq); });

    const rows = await db.insert(events).values([
      recordedRow("01HFLOORNONE0000000000A1", LONG_AGO),
    ]).returning({ seq: events.seq });

    // No cursor row is seeded: `runDispatchCycle` inserts one at 0, and seq 0 exists nowhere.
    expect(await runDispatchCycle(db, bus, { now: T0 })).toBe(1);
    expect(seen).toEqual([rows[0]!.seq]);
  });
});
