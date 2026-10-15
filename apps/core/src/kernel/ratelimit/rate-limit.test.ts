import { HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthController } from "../auth/auth.controller";
import { CopilotController } from "../copilot/copilot.controller";
import { SpeechController } from "../inference/speech.controller";
import { HealthController } from "../../health/health.controller";
import { FixedWindowLimiter, RATE_BUCKETS, RATE_LIMIT_KEY, RateLimitGuard } from "./rate-limit";
import type { ExecutionContext } from "@nestjs/common";

/**
 * Request budgets on the routes that cost money or invite guessing: the copilot's ask and speech-to-text per person,
 * the public sign-in routes and the health probe per source address. A spent budget answers 429 with Retry-After.
 */
describe("request budgets", () => {
  it("a fixed window allows its limit, refuses the next with the seconds left, and opens again in the next window", () => {
    const l = new FixedWindowLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(l.hit("k", 3, 60_000, t0 + i).ok).toBe(true);
    expect(l.hit("k", 3, 60_000, t0 + 10_000)).toEqual({ ok: false, retryAfterSec: 50 });
    expect(l.hit("other", 3, 60_000, t0 + 10_000).ok).toBe(true);
    expect(l.hit("k", 3, 60_000, t0 + 60_000).ok).toBe(true);
  });

  const ctxFor = (handler: object, req: Record<string, unknown>, headers: Record<string, string>): ExecutionContext => ({
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: (k: string, v: string) => { headers[k] = v; } }) }),
  }) as unknown as ExecutionContext;

  it("the guard keys a signed-in route by the person and a public one by the address, and answers 429 with Retry-After", () => {
    const guard = new RateLimitGuard(new Reflector(), new FixedWindowLimiter());
    const ask = (CopilotController.prototype as unknown as Record<string, object>).ask!;
    const login = (AuthController.prototype as unknown as Record<string, object>).login!;
    const headers: Record<string, string> = {};
    const asA = ctxFor(ask, { hmisActor: { type: "user", id: "u-a" }, ip: "10.0.0.1" }, headers);
    for (let i = 0; i < RATE_BUCKETS.copilot.limit; i += 1) expect(guard.canActivate(asA)).toBe(true);
    let refused: unknown = null;
    try { guard.canActivate(asA); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    // Another person on the same address is not charged for the first one's use.
    expect(guard.canActivate(ctxFor(ask, { hmisActor: { type: "user", id: "u-b" }, ip: "10.0.0.1" }, {}))).toBe(true);
    // A public route counts by address.
    for (let i = 0; i < RATE_BUCKETS.auth.limit; i += 1) expect(guard.canActivate(ctxFor(login, { ip: "203.0.113.9" }, {}))).toBe(true);
    expect(() => guard.canActivate(ctxFor(login, { ip: "203.0.113.9" }, {}))).toThrow(HttpException);
    expect(guard.canActivate(ctxFor(login, { ip: "203.0.113.10" }, {}))).toBe(true);
    // The box's own loopback is never counted.
    for (let i = 0; i < RATE_BUCKETS.auth.limit + 5; i += 1) expect(guard.canActivate(ctxFor(login, { ip: "::ffff:127.0.0.1" }, {}))).toBe(true);
  });

  it("the costly and the guessable routes carry a budget", () => {
    const bucketOf = (cls: { prototype: object }, method: string): unknown =>
      Reflect.getMetadata(RATE_LIMIT_KEY, (cls.prototype as Record<string, object>)[method]!);
    expect(bucketOf(CopilotController, "ask")).toBe("copilot");
    expect(bucketOf(SpeechController, "transcribe")).toBe("speech");
    expect(bucketOf(AuthController, "login")).toBe("auth");
    expect(bucketOf(AuthController, "switchPin")).toBe("auth");
    expect(bucketOf(AuthController, "switchBadge")).toBe("auth");
    expect(bucketOf(HealthController, "health")).toBe("health");
  });
});
