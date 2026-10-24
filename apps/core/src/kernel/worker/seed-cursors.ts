import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { workerBackfills, workerConsumers } from "./worker.module";
import { isModuleOn } from "../modules/switch";

/**
 * D10 — first-boot cursor seeding, the step 08.5 booked and 10 re-booked.
 *
 * `event_cursors.last_seq` defaults to 0 and `runDispatchCycle` creates the row on first sight
 * (dispatcher.ts:130-136), so the first cycle after a consumer is registered walks the ENTIRE
 * event history at 100 rows/tick. That is a volume concern, not a correctness one — every
 * consumer is idempotent — but it belongs in a deployment step, not in cursor-creation
 * semantics (08.5's deliberate refusal to pre-empt this stands).
 *
 * THE SHIPPED PRECEDENT IS `realtime/tail.ts:20` — "floor = max(seq) at start (history is never
 * replayed)". The tail solved this for itself on day one; the dispatcher's cursor is SHARED and
 * CLAIMING (two processes agree on one row, and a claim is a permanent record), so seeding it
 * cannot live beside the tail's own per-process floor — it has to run once, deliberately, from
 * the outside.
 *
 * THE CONSUMER LIST COMES FROM THE ONE IMPORTABLE PLACE IT EXISTS: `workerConsumers(db)`'s keys
 * (Plan 10 T5's seam). Calling it here costs nothing beyond the closures it builds — the
 * consumers themselves are never invoked — and it is the only way to seed exactly the consumers
 * production registers, with no second list to drift out of step with `worker.module.ts`.
 * Today that is `kernel.alerts` and `kernel.notify`.
 *
 * ONLY A BRAND-NEW CONSUMER IS WRITTEN (`on conflict do nothing`). Its first value IS `max(seq)`
 * (V10). An existing cursor is never moved in either direction: lowering it would replay what it
 * already resolved (V11), and RAISING it — what `greatest(...)` did until 2026-10-13 — skipped
 * every event a lagging consumer had not yet delivered. deploy.sh runs this on every deploy,
 * while the worker is restarting, so a consumer behind at that moment lost its backlog (V12).
 */
export type SeededCursor = { consumer: string; lastSeq: number };

export async function seedCursors(db: Db, now: Date = new Date()): Promise<SeededCursor[]> {
  const consumers = Object.keys(workerConsumers(db));
  const seeded: SeededCursor[] = [];
  for (const consumer of consumers) {
    await db.execute(sql`
      with m as (select coalesce(max(seq), 0)::bigint as "maxSeq" from events)
      insert into event_cursors (consumer, last_seq, updated_at)
      select ${consumer}, m."maxSeq", ${now.toISOString()}::timestamptz from m
      on conflict (consumer) do nothing
    `);
    const rows = (await db.execute(sql`
      select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}
    `)).rows as [{ lastSeq: number | string }];
    seeded.push({ consumer, lastSeq: Number(rows[0]!.lastSeq) });
  }
  // E1.4 — the state a seeded cursor skipped, rebuilt (idempotent; see `workerBackfills`).
  for (const [consumer, backfill] of Object.entries(workerBackfills(db))) {
    // Decision 0085 — a backfill writes its module's rows: none while that module (the consumer key's prefix) is off.
    if (!isModuleOn(consumer.split(".")[0] ?? consumer)) continue;
    const n = await backfill();
    if (n > 0) console.log(`seed-cursors: ${consumer} backfilled ${n}`);
  }
  return seeded;
}
