import { applyDecorators, HttpException, HttpStatus, Inject, Injectable, Optional, SetMetadata, UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";

/**
 * REQUEST BUDGETS — a per-key fixed window on the few routes where volume itself is the harm: the copilot's ask and
 * speech-to-text call a paid model per request (the copilot also has its own daily spend cap), and the public sign-in
 * routes and the health probe answer anyone. A signed-in route is counted per person; a public one per source address
 * (`req.ip`, which `trust proxy` makes the client's, app.bootstrap.ts). A spent budget answers 429 with Retry-After.
 *
 * In-process by design: each api process keeps its own counts, so N processes allow at most N × the budget — a ceiling,
 * not an exact quota, which is what a budget against floods and runaway clients needs. The sign-in routes keep their
 * per-username lockout (`auth/throttle.ts`); this adds the per-address bound beside it.
 */
export const RATE_LIMIT_KEY = "hmis:rate-limit";

export type RateBucket = "copilot" | "speech" | "auth" | "health";
export const RATE_BUCKETS: Readonly<Record<RateBucket, { limit: number; windowMs: number; by: "actor" | "ip" }>> = {
  /** A person asks far fewer than one question every two seconds; a loop asks far more. */
  copilot: { limit: 30, windowMs: 60_000, by: "actor" },
  /** One dictation clip at a time, with retries. */
  speech: { limit: 20, windowMs: 60_000, by: "actor" },
  /** Every sign-in route from one address: a whole counter of staff signing in at shift change fits. */
  auth: { limit: 20, windowMs: 60_000, by: "ip" },
  /** The monitor polls every few seconds. */
  health: { limit: 120, windowMs: 60_000, by: "ip" },
};

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export type Hit = { ok: true } | { ok: false; retryAfterSec: number };

/** Fixed windows per key. Expired windows are swept when the table grows, so memory stays bounded by active keys. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): Hit {
    if (this.windows.size > 50_000) this.sweep(now, windowMs);
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (w.count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
    w.count += 1;
    return { ok: true };
  }

  private sweep(now: number, windowMs: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(k);
  }
}

/** One limiter per process, shared by every guard instance Nest creates. A test may pass its own (no provider exists). */
const PROCESS_LIMITER = new FixedWindowLimiter();
export const RATE_LIMITER = "hmis:rate-limiter";

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: FixedWindowLimiter;

  constructor(private readonly reflector: Reflector, @Optional() @Inject(RATE_LIMITER) limiter?: FixedWindowLimiter) {
    this.limiter = limiter ?? PROCESS_LIMITER;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const bucket = this.reflector.get<RateBucket | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    if (bucket === undefined) return true;
    const rule = RATE_BUCKETS[bucket];
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ hmisActor?: { id: string }; ip?: string }>();
    // The box's own loopback (the container healthcheck, in-host scripts, the test suites) is not a client: behind the
    // proxy, `req.ip` is the real client's address (`trust proxy`), so no outside request arrives as loopback.
    if (req.ip !== undefined && LOOPBACK.test(req.ip)) return true;
    const who = rule.by === "actor" && req.hmisActor !== undefined ? `u:${req.hmisActor.id}` : `ip:${req.ip ?? "unknown"}`;
    const hit = this.limiter.hit(`${bucket}|${who}`, rule.limit, rule.windowMs);
    if (hit.ok) return true;
    http.getResponse<{ setHeader: (k: string, v: string) => void }>().setHeader("Retry-After", String(hit.retryAfterSec));
    throw new HttpException(
      { statusCode: 429, code: "rate_limited", message: "Too many requests — try again shortly", retryAfterSec: hit.retryAfterSec },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Puts a route under a request budget (`RATE_BUCKETS`). */
export const RateLimited = (bucket: RateBucket): MethodDecorator => applyDecorators(SetMetadata(RATE_LIMIT_KEY, bucket), UseGuards(RateLimitGuard));
