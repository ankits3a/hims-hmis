import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  THROTTLE_BASE_MS, THROTTLE_MAX_MS, THROTTLE_THRESHOLD, THROTTLE_WINDOW_MS,
  backoffMs, clearThrottle, recordThrottleFailure, throttleRetryAt, throttleSubject,
} from "./throttle";
import type { Db } from "../db/client";

/**
 * PLAN 11g / T-D4, DD4 — the unit half. The HTTP half is `test/auth.e2e.test.ts`.
 *
 * The clock is INJECTED everywhere (GC8), so the window and the cap are tested by arithmetic
 * rather than by waiting fifteen minutes, and no test here sleeps.
 */
const NOW = new Date("2026-08-25T09:00:00.000Z");
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

describe("auth throttle (Plan 11g / DD4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("the subject is trimmed and case-folded — changing a letter's case is not a bypass", () => {
    expect(throttleSubject("  Asha ")).toBe("asha");
    expect(throttleSubject("ASHA")).toBe(throttleSubject("asha"));
  });

  it("backoffMs: nothing below the threshold, doubling from the base, capped and never beyond", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(THROTTLE_THRESHOLD - 1)).toBe(0);
    expect(backoffMs(THROTTLE_THRESHOLD)).toBe(THROTTLE_BASE_MS);
    expect(backoffMs(THROTTLE_THRESHOLD + 1)).toBe(THROTTLE_BASE_MS * 2);
    expect(backoffMs(THROTTLE_THRESHOLD + 3)).toBe(THROTTLE_BASE_MS * 8);
    expect(backoffMs(THROTTLE_THRESHOLD + 4)).toBe(THROTTLE_MAX_MS); // 960s clamps to 900s
    expect(backoffMs(500)).toBe(THROTTLE_MAX_MS); // and it stays clamped, for ever
  });

  it("R1 — the 5th failure sets the backoff and the 4th does NOT", async () => {
    for (let i = 1; i <= THROTTLE_THRESHOLD - 1; i += 1) {
      const { failures, retryAfter } = await recordThrottleFailure(db, "login", "asha", later(i * 1000));
      expect(failures).toBe(i);
      expect(retryAfter).toBeNull();
    }
    // Four failures in, the account is still perfectly usable.
    expect(await throttleRetryAt(db, "login", "asha", later(5_000))).toBeNull();

    const fifth = await recordThrottleFailure(db, "login", "asha", later(5_000));
    expect(fifth.failures).toBe(THROTTLE_THRESHOLD);
    expect(fifth.retryAfter).toEqual(new Date(later(5_000).getTime() + THROTTLE_BASE_MS));

    expect(await throttleRetryAt(db, "login", "asha", later(6_000))).not.toBeNull();
  });

  it("R2 — a success CLEARS the counter, so four fumbles a week never accumulate into a refusal", async () => {
    for (let i = 1; i <= 4; i += 1) await recordThrottleFailure(db, "login", "asha", later(i * 1000));
    await clearThrottle(db, "login", "asha");

    // The next four must start from zero: if the counter had survived, this run's 1st failure
    // would be the 5th and would refuse.
    for (let i = 1; i <= 4; i += 1) {
      const { failures, retryAfter } = await recordThrottleFailure(db, "login", "asha", later(10_000 + i * 1000));
      expect(failures).toBe(i);
      expect(retryAfter).toBeNull();
    }
    expect(await throttleRetryAt(db, "login", "asha", later(20_000))).toBeNull();
  });

  it("the backoff EXPIRES on its own — nobody has to clear it (DD4: backoff, never lockout)", async () => {
    for (let i = 1; i <= THROTTLE_THRESHOLD; i += 1) await recordThrottleFailure(db, "login", "asha", NOW);

    expect(await throttleRetryAt(db, "login", "asha", later(THROTTLE_BASE_MS - 1))).not.toBeNull();
    expect(await throttleRetryAt(db, "login", "asha", later(THROTTLE_BASE_MS + 1))).toBeNull();
  });

  it("the window is ROLLING — failures older than it do not count toward the threshold", async () => {
    for (let i = 1; i <= 4; i += 1) await recordThrottleFailure(db, "login", "asha", NOW);

    // One more, but an hour and a second later: the window has passed, so this is failure 1 of a
    // new window and not failure 5 of the old one.
    const stale = await recordThrottleFailure(db, "login", "asha", later(THROTTLE_WINDOW_MS + 1000));
    expect(stale.failures).toBe(1);
    expect(stale.retryAfter).toBeNull();
  });

  it("R3 — `login` and `pin` are separate counters", async () => {
    for (let i = 1; i <= THROTTLE_THRESHOLD; i += 1) await recordThrottleFailure(db, "login", "asha", NOW);

    expect(await throttleRetryAt(db, "login", "asha", NOW)).not.toBeNull();
    // The terminal switch a clinician needs mid-shift is untouched by a poisoned password counter.
    expect(await throttleRetryAt(db, "pin", "asha", NOW)).toBeNull();
  });

  it("R4 — an UNKNOWN username is counted identically: the state cannot be used to enumerate", async () => {
    for (let i = 1; i <= THROTTLE_THRESHOLD; i += 1) {
      await recordThrottleFailure(db, "login", "nobody-here-at-all", NOW);
    }
    // No `users` row exists and none is needed: there is deliberately no FK.
    expect(await throttleRetryAt(db, "login", "nobody-here-at-all", NOW)).not.toBeNull();
  });

  it("CONCURRENCY — ten simultaneous failures count ten, not fewer (the row is locked)", async () => {
    // A read-modify-write would let parallel attempts read the same count and all write count+1,
    // which is exactly the traffic this exists to stop. §2.20: measured, not predicted.
    await Promise.all(
      Array.from({ length: 10 }, () => recordThrottleFailure(db, "login", "asha", NOW)),
    );
    const { failures } = await recordThrottleFailure(db, "login", "asha", NOW);
    expect(failures).toBe(11);
  });
});
