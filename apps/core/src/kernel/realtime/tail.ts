import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export type TailedEvent = { seq: number; eventId: string; name: string; occurredAt: Date; patientId: string | null; encounterId: string | null; payload: unknown };
export type TailListener = (e: TailedEvent) => void;

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
    this.timer = setInterval(() => { void this.poll(); }, this.opts.intervalMs);
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
