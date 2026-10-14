/**
 * E3.3 review #764 — A PER-ADDRESS CAP ON THE FAMILY LINK'S PUBLIC ROUTES. The API has no global request limiter (the
 * credential paths use per-account backoff, `kernel/auth/throttle.ts`; search counts per actor). These routes have no
 * account, so they are capped per client address (`req.ip`, the edge's hop under `trust proxy`, `http-hardening.ts`).
 *
 * Generous on purpose: an attendant on a mobile network shares an address with strangers (carrier NAT), and the real
 * limits are per LINK and in the database (3 OTP sends and 5 wrong codes an hour). This cap only stops one address from
 * hammering the routes. Sliding window in memory, per process — the API runs one process; a second would double it, which
 * is still bounded.
 */
export const FAMILY_PUBLIC_WINDOW_MS = 10 * 60_000;
export const FAMILY_PUBLIC_MAX_PER_WINDOW = 120;

export class FamilyAddressThrottle {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = FAMILY_PUBLIC_MAX_PER_WINDOW, private readonly windowMs = FAMILY_PUBLIC_WINDOW_MS) {}

  /** True when this request may proceed; records it either way only when allowed. */
  allow(address: string, now: number = Date.now()): boolean {
    const since = now - this.windowMs;
    const kept = (this.hits.get(address) ?? []).filter((t) => t > since);
    if (kept.length >= this.max) { this.hits.set(address, kept); return false; }
    kept.push(now);
    this.hits.set(address, kept);
    if (this.hits.size > 50_000) this.sweep(since);
    return true;
  }

  private sweep(since: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
  }
}
