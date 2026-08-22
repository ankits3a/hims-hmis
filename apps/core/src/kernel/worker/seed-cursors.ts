import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { workerConsumers } from "./worker.module";

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
 * EVERY WRITE USES `greatest(event_cursors.last_seq, excluded.last_seq)` — the SAME idiom
 * `dispatcher.ts`'s own cursor advance uses for the same reason (V11): a cursor a live
 * dispatch cycle has already moved past `max(seq)` (because it is still consuming a batch when
 * this script runs) must never be dragged backwards into replaying what it has already resolved.
 * A brand-new consumer has no existing row to compare against, so its FIRST value simply IS
 * `max(seq)` (V10) — `on conflict` never fires for it.
 */
export type SeededCursor = { consumer: string; lastSeq: number };

export async function seedCursors(db: Db, now: Date = new Date()): Promise<SeededCursor[]> {
  const consumers = Object.keys(workerConsumers(db));
  const seeded: SeededCursor[] = [];
  for (const consumer of consumers) {
    const rows = (await db.execute(sql`
      with m as (select coalesce(max(seq), 0)::bigint as "maxSeq" from events)
      insert into event_cursors (consumer, last_seq, updated_at)
      select ${consumer}, m."maxSeq", ${now.toISOString()}::timestamptz from m
      on conflict (consumer) do update
        set last_seq = greatest(event_cursors.last_seq, excluded.last_seq),
            updated_at = ${now.toISOString()}::timestamptz
      returning last_seq as "lastSeq"
    `)).rows as [{ lastSeq: number | string }];
    seeded.push({ consumer, lastSeq: Number(rows[0]!.lastSeq) });
  }
  return seeded;
}
