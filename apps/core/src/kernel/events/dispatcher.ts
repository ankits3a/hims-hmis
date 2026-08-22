import { sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import { consumerPoisoned } from "../worker/events";
import { appendEvent } from "./append";
import type { SubscriptionBus, DispatchedEvent } from "./subscriptions";

/**
 * The look-back window, in seqs, measured rather than chosen (Plan 08.5 D4, resolved by the
 * spike report's question C). Through the application's own write path (`withTx` + `appendEvent`)
 * a 2-second stalled transaction let 939 / 2288 / 2665 seqs be allocated past it at pool
 * concurrency 1 / 4 / 8 — so the 500 the plan originally carried bought only ~0.4-1.1 s of stall.
 * 5000 covers that measured worst case with ~1.9x margin.
 *
 * TWO RESIDUALS REMAIN, DOCUMENTED RATHER THAN ENGINEERED AWAY (the same residual the tail
 * carries): a single bulk `insert … generate_series(1,10000)` burns 10 000 seqs in 175 ms, and a
 * 10 s stall was measured at 12 778. The structural fix is Plan 11's time floor
 * (`recorded_at >= …`), and the one-WHERE-chain shape of the query below is what keeps that ONE
 * added predicate (Global Constraint 7) — do not pre-empt it with a time floor here.
 */
const DEFAULT_LOOKBACK = 5000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 60;

const DISPATCHER_ACTOR: Actor = { type: "system", id: "event-dispatcher" };

export type DispatchCycleOptions = {
  batchSize?: number;
  lookback?: number;
  maxAttempts?: number;
  now?: Date;
};

/** `next_attempt_at = now + min(2^attempts, 60) s`, attempts counted AFTER this failure (D4). */
const backoffMs = (attempts: number): number => Math.min(2 ** attempts, MAX_BACKOFF_SECONDS) * 1000;

type WindowRow = {
  seq: number | string;
  eventId: string;
  name: string;
  payload: unknown;
  patientId: string | null;
  correlationId: string | null;
  occurredAt: Date | string;
  status: string | null;
  attempts: number | string | null;
  nextAttemptAt: Date | string | null;
};

/**
 * Parking, in ONE transaction (D4): the dead-letter record, the GUARDED status transition, and
 * `consumer.poisoned`. The guard is `where event_deliveries.status <> 'parked'` on the upsert's
 * DO UPDATE, so exactly one transitioning transaction exists even when two workers cross
 * maxAttempts on the same row at the same instant — the loser's RETURNING is empty and it appends
 * nothing. Requeue/replay tooling for dead letters is deliberately not built (D12).
 */
async function parkDelivery(
  db: Db,
  consumer: string,
  event: DispatchedEvent,
  error: string,
  attempts: number,
  now: Date,
): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.execute(sql`
      insert into event_dead_letters (consumer, seq, event_id, name, error, attempts, parked_at)
      values (${consumer}, ${event.seq}, ${event.eventId}, ${event.name}, ${error}, ${attempts},
              ${now.toISOString()}::timestamptz)
      on conflict (consumer, seq) do nothing
    `);
    const transitioned = (await tx.execute(sql`
      insert into event_deliveries (consumer, seq, status, attempts, last_error, next_attempt_at, updated_at)
      values (${consumer}, ${event.seq}, 'parked', ${attempts}, ${error}, null,
              ${now.toISOString()}::timestamptz)
      on conflict (consumer, seq) do update set
        status = 'parked', attempts = ${attempts}, last_error = ${error},
        next_attempt_at = null, updated_at = ${now.toISOString()}::timestamptz
      where event_deliveries.status <> 'parked'
      returning seq
    `)).rows;
    if (transitioned.length === 0) return; // another transaction parked this row first

    await appendEvent(
      tx,
      consumerPoisoned.make({
        actor: DISPATCHER_ACTOR,
        occurredAt: now,
        correlationId: event.correlationId ?? undefined,
        causationId: event.eventId,
        payload: { consumer, seq: event.seq, eventId: event.eventId, error, attempts },
      }),
    );
  });
}

/**
 * One dispatch cycle: for every consumer on the bus, read a WINDOW of unresolved events, hand
 * each to the handler, and record the per-(consumer, seq) delivery claim.
 *
 * THE CLAIM IS WRITTEN AFTER THE HANDLER SUCCEEDS, and that is deliberately the OPPOSITE
 * placement from billing's `withIdempotency` (D4/D5, and the two share no code). Billing claims
 * BEFORE the work because its nightmare is doing the work twice — a second receipt is a real
 * document. The dispatcher's nightmare is the mirror image: LOSING an event. A claim taken before
 * a handler that then dies marks an undelivered event delivered, which is the silent loss this
 * whole file exists to remove. Claim-on-success gives AT-LEAST-ONCE delivery with dedupe; the rare
 * double delivery under a race is absorbed by the consumer's own idempotency, which the
 * architecture already mandates. At-least-once + idempotent consumers is the contract, stated here
 * once and inherited by every consumer.
 *
 * The window (`seq > cursor - lookback`) is why a row whose seq was allocated early but committed
 * late is no longer skipped forever: the frontier read this replaced (`seq > cursor`) passed such a
 * row before it was visible and never looked back. It is the tail's approach (tail.ts:15-24) made
 * durable — the claims, not the cursor, are what stop a re-read row being delivered twice.
 */
export async function runDispatchCycle(
  db: Db,
  bus: SubscriptionBus,
  opts: DispatchCycleOptions = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = opts.now ?? new Date();
  let delivered = 0;

  for (const { consumer, events: names, handler } of bus.consumers()) {
    await db.execute(
      sql`insert into event_cursors (consumer) values (${consumer}) on conflict do nothing`,
    );
    const cursorRows = (await db.execute(
      sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
    )).rows as [{ lastSeq: number | string }];
    const cursor = Number(cursorRows[0]!.lastSeq);

    // PLAN 11's PARTITION FLOOR, and this lookup is its whole input: the IST month containing the
    // `recorded_at` of the CURSOR'S OWN seq. Month truncation is what absorbs seq/recorded_at skew
    // — `recorded_at` is transaction-start time, so a row committed late carries an earlier
    // instant than its seq suggests, and a floor at row granularity would skip it.
    // A MISSING ROW DEGRADES TO NO FLOOR (cursor 0, or a month retention has already dropped):
    // pruning is an optimization and the `seq >` predicate still bounds correctness on its own.
    const floorRows = (await db.execute(sql`
      select date_trunc('month', recorded_at at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' as "floor"
      from events where seq = ${cursor}
    `)).rows as { floor: Date | string }[];
    const floor = floorRows[0]?.floor ?? null;

    // ONE WHERE CHAIN (Global Constraint 7) so Plan 11's partition floor is one added predicate.
    // The LEFT JOIN is what drops already-resolved rows — `done` and `parked` both fall out, so a
    // window that re-reads far behind the cursor re-delivers nothing.
    const rows = (await db.execute(sql`
      select e.seq, e.event_id as "eventId", e.name, e.payload,
             e.patient_id as "patientId", e.correlation_id as "correlationId",
             e.occurred_at as "occurredAt",
             d.status, d.attempts, d.next_attempt_at as "nextAttemptAt"
      from events e
      left join event_deliveries d on d.consumer = ${consumer} and d.seq = e.seq
      where e.seq > ${Math.max(cursor - lookback, 0)}
        and e.recorded_at >= coalesce(${floor}::timestamptz, '-infinity'::timestamptz)
        and e.name = any(${sql.param(names)}::text[])
        and (d.status is null or d.status = 'retrying')
      order by e.seq asc
      limit ${batchSize}
    `)).rows as unknown as WindowRow[];

    // Rows arrive seq-ascending and the loop stops at the first UNRESOLVED one, so this is the
    // minimum unresolved seq in the batch by construction.
    let minUnresolved: number | null = null;
    let maxSeen = cursor;

    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq > maxSeen) maxSeen = seq;
      const attempts = row.attempts === null ? 0 : Number(row.attempts);
      const nextAttemptAt = row.nextAttemptAt === null ? null : new Date(row.nextAttemptAt);

      // Still backing off. NOT delivered, but not resolved either: it holds the cursor and stops
      // this consumer's batch, so nothing behind it is delivered while it is still owed. The
      // backoff is filtered HERE and never in the query — a row the query dropped could not hold
      // the cursor, and the cursor would advance past an event nobody has taken yet.
      if (nextAttemptAt !== null && nextAttemptAt.getTime() > now.getTime()) {
        minUnresolved = seq;
        break;
      }

      const event: DispatchedEvent = {
        seq,
        eventId: row.eventId,
        name: row.name,
        payload: row.payload,
        patientId: row.patientId,
        correlationId: row.correlationId,
        occurredAt: new Date(row.occurredAt),
      };

      try {
        await handler(event);
      } catch (err) {
        const attempted = attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        if (attempted >= maxAttempts) {
          await parkDelivery(db, consumer, event, message, attempted, now);
          continue; // parked is RESOLVED: the cursor moves on, and one poison event stops
          //          blocking its consumer forever (the shipped `break` never let it).
        }
        await db.execute(sql`
          insert into event_deliveries (consumer, seq, status, attempts, last_error, next_attempt_at, updated_at)
          values (${consumer}, ${seq}, 'retrying', ${attempted}, ${message},
                  ${new Date(now.getTime() + backoffMs(attempted)).toISOString()}::timestamptz,
                  ${now.toISOString()}::timestamptz)
          on conflict (consumer, seq) do update set
            status = 'retrying', attempts = ${attempted}, last_error = ${message},
            next_attempt_at = ${new Date(now.getTime() + backoffMs(attempted)).toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        `);
        minUnresolved = seq;
        break; // in-order per consumer: a failing event holds the ones behind it, until it parks
      }

      // THE CLAIM, and it is HERE — after the handler returned, never before it.
      await db.execute(sql`
        insert into event_deliveries (consumer, seq, status, attempts, last_error, next_attempt_at, updated_at)
        values (${consumer}, ${seq}, 'done', ${attempts + 1}, null, null,
                ${now.toISOString()}::timestamptz)
        on conflict (consumer, seq) do update set
          status = 'done', attempts = ${attempts + 1}, last_error = null,
          next_attempt_at = null, updated_at = ${now.toISOString()}::timestamptz
      `);
      delivered += 1;
    }

    // cursor := (min unresolved seq in the batch) - 1, else the max seq seen. `greatest` is what
    // makes "never decreased" hold against a concurrent cycle that already moved it on: the window
    // re-reads rows BELOW the cursor, so an unresolved one down there must not drag it backwards.
    await db.execute(sql`
      update event_cursors
      set last_seq = greatest(last_seq, ${minUnresolved === null ? maxSeen : minUnresolved - 1}),
          updated_at = ${now.toISOString()}::timestamptz
      where consumer = ${consumer}
    `);
  }

  return delivered;
}
