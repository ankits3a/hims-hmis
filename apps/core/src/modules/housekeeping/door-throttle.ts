/**
 * HK-1 (#973) — A PER-ADDRESS CAP ON THE PUBLIC DOOR (the family link's pattern, `ipd/family-throttle.ts`). The door has
 * no account, so it is capped per client address (`req.ip`, the edge's hop under `trust proxy`). Generous on purpose: a
 * ward's visitors share a carrier address; the real limit is per area, in the database (`HK_DOOR_PER_AREA_HOUR`).
 * Sliding window in memory, per process.
 */
export const DOOR_WINDOW_MS = 10 * 60_000;
export const DOOR_MAX_PER_WINDOW = 20;

export class DoorAddressThrottle {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = DOOR_MAX_PER_WINDOW, private readonly windowMs = DOOR_WINDOW_MS) {}

  /** True when this request may proceed; recorded only when allowed. */
  allow(address: string, now: number = Date.now()): boolean {
    const since = now - this.windowMs;
    const kept = (this.hits.get(address) ?? []).filter((t) => t > since);
    if (kept.length >= this.max) { this.hits.set(address, kept); return false; }
    kept.push(now);
    this.hits.set(address, kept);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
    return true;
  }
}
