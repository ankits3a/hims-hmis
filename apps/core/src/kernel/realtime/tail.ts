import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export type TailedEvent = { seq: number; eventId: string; name: string; occurredAt: Date; patientId: string | null; encounterId: string | null; payload: unknown };
export type TailListener = (e: TailedEvent) => void;

/**
 * pg's two shutdown signatures. Nest closes leaf modules first, so the gateway stops the tail before AppModule ends the
 * pool — but stop() cannot un-issue a query that is already in flight, and that query can find the pool gone underneath it.
 * That is shutdown, not a fault. NOTHING else is suppressed: a tick that cannot read `events` (a missing relation, a broken
 * query) still surfaces exactly as loudly as it did before — a loud failure on missing schema is the point (§3.6).
 */
const SHUTDOWN_MESSAGE = /pool after calling end on the pool|Client was closed and is not queryable/i;
const isShutdownError = (err: unknown): boolean => err instanceof Error && SHUTDOWN_MESSAGE.test(err.message);

/**
 * A PER-PROCESS tail over events.seq — the realtime fan-out's only source of truth (spec §4: the event log is the spine;
 * roadmap: WebSocket fan-out reads events, never in-memory single-process state). Every process runs its own tail against
 * the shared table, so an event appended by ANY process reaches EVERY process's sockets. Not the dispatcher (whose cursor is
 * shared and claims each event once) — this is a read-only cursor: floor = max(seq) at start (history is never replayed);
 * each poll reads seq > max(floor, cursor − lookback) so a row whose seq was allocated earlier but committed later (the
 * out-of-order-commit window dispatcher.ts does not defend against) is still delivered; a bounded `seen` set dedupes.
 * If max(seq) ever drops below the cursor (test truncation with RESTART IDENTITY) the cursor resets. The timer is unref()'d.
 * Deliveries are hints: subscribing screens also poll their read models every 15 s.
 */
export class EventTail {
  private cursor = 0;
  private floor = 0;
  private started = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<number>();
  private readonly listeners = new Set<TailListener>();

  constructor(
    private readonly db: Db,
    private readonly names: () => string[],
    private readonly opts: { intervalMs: number; lookback: number; batch: number } = { intervalMs: 300, lookback: 500, batch: 1000 },
  ) {}

  on(l: TailListener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private async maxSeq(): Promise<number> {
    const rows = (await this.db.execute(sql`select coalesce(max(seq), 0)::bigint as m from events`)).rows as [{ m: number | string }];
    return Number(rows[0]!.m);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.floor = await this.maxSeq();
    this.cursor = this.floor;
    // Fire-and-forget, so nothing owns the promise: a tick that raced shutdown (the tail already stopped, or its pool
    // ended under an in-flight query) must not become an unhandled rejection that jest then attributes to whichever
    // suite the worker picks up next. Every OTHER failure is rethrown unchanged — it stays exactly as loud as it was.
    this.timer = setInterval(() => {
      void this.poll().catch((err: unknown) => { if (this.started && !isShutdownError(err)) throw err; });
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** One tick. Exported for tests and callable while a scheduled tick is in flight (re-entrancy guarded). Returns deliveries. */
  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const names = this.names();
      if (names.length === 0) return 0;
      const m = await this.maxSeq();
      if (!this.started) return 0; // stop() ran while that query was in flight — never issue the next one at a closing pool
      if (m < this.cursor) { this.cursor = 0; this.floor = 0; this.seen.clear(); } // sequence restarted (tests) — deliver from the beginning
      const from = Math.max(this.floor, this.cursor - this.opts.lookback);
      const rows = (await this.db.execute(sql`
        select seq, event_id as "eventId", name, occurred_at as "occurredAt", patient_id as "patientId",
               encounter_id as "encounterId", payload
        from events
        where seq > ${from} and name = any(${sql.param(names)}::text[])
        order by seq asc
        limit ${this.opts.batch}
      `)).rows as unknown as (Omit<TailedEvent, "seq" | "occurredAt"> & { seq: number | string; occurredAt: Date | string })[];
      if (!this.started) return 0; // same re-check after the batch read: a stopped tail delivers nothing
      let delivered = 0;
      for (const r of rows) {
        const seq = Number(r.seq);
        if (this.seen.has(seq)) continue;
        this.seen.add(seq);
        if (seq > this.cursor) this.cursor = seq;
        const e: TailedEvent = { seq, eventId: r.eventId, name: r.name, occurredAt: new Date(r.occurredAt), patientId: r.patientId, encounterId: r.encounterId, payload: r.payload };
        for (const l of this.listeners) { try { l(e); } catch { /* a listener's failure is its own */ } }
        delivered += 1;
      }
      const prune = this.cursor - this.opts.lookback;
      for (const s of this.seen) if (s <= prune) this.seen.delete(s);
      return delivered;
    } finally {
      this.polling = false;
    }
  }
}
