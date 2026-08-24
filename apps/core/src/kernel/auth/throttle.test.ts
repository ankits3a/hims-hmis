import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  THROTTLE_BASE_MS, THROTTLE_MAX_MS, THROTTLE_THRESHOLD, THROTTLE_WINDOW_MS,
  backoffMs, clearThrottle, recordThrottleFailure, throttleRetryAt, throttleSubject,
} from "./throttle";
import { authThrottle } from "../db/schema";
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

  /**
   * PLAN 11g CLOSE REVIEW, MAJOR 2 — the key is BOUNDED, and it is a correctness bound.
   *
   * `loginSchema` puts no ceiling on `username` (deliberately — login verifies rather than
   * chooses) and the JSON body limit is 1 MB, so an unauthenticated caller could submit a
   * multi-kilobyte username. `subject` is half of a composite PRIMARY KEY, and Postgres rejects a
   * btree index tuple over ~2704 bytes outright — the INSERT would throw out of the login handler
   * and a route that answered a clean 401 would answer 500 to an anonymous request.
   */
  it("MAJOR 2 — a multi-kilobyte username is bounded, and recording its failure does not throw", async () => {
    const huge = "x".repeat(4000);
    expect(throttleSubject(huge)).toHaveLength(64);

    // The proof is that this RESOLVES. Before the bound it threw
    // `index row size … exceeds btree version 4 maximum 2704`, out of an unauthenticated route.
    const { failures } = await recordThrottleFailure(db, "login", huge, NOW);
    expect(failures).toBe(1);

    // …and a DIFFERENT 4000-character username sharing the first 64 characters shares the counter,
    // which can only make the throttle stricter.
    const sibling = `${"x".repeat(64)}${"y".repeat(3936)}`;
    expect((await recordThrottleFailure(db, "login", sibling, NOW)).failures).toBe(2);
  });

  /**
   * PLAN 11g CLOSE REVIEW, MAJOR 2 — the table REAPS ITSELF.
   *
   * Every failed attempt against a new submitted string writes a row and `clearThrottle` removes
   * one only on a successful authentication for that exact subject, so without the prune an
   * attacker spraying invented usernames grows the production database and its WAL archive
   * without limit. Nothing else reaps this table.
   */
  it("MAJOR 2 — rows whose window has passed are pruned, and live rows are NOT", async () => {
    for (const name of ["sprayed-1", "sprayed-2", "sprayed-3"]) {
      await recordThrottleFailure(db, "login", name, NOW);
    }
    expect(await db.select().from(authThrottle)).toHaveLength(3);

    // A steady attacker on ONE subject: its FIRST failure is ancient but its LAST is recent, so it
    // must survive. Keying the prune on `first_failed_at` would forget exactly this row.
    await recordThrottleFailure(db, "login", "steady", NOW);
    await recordThrottleFailure(db, "login", "steady", later(THROTTLE_WINDOW_MS + 2 * 60 * 1000));

    // One more failure an hour and a minute on. The three stale sprays go; `steady` stays because
    // it failed two minutes ago; the new subject's own row is written.
    const rows = await (async (): Promise<string[]> => {
      await recordThrottleFailure(db, "login", "current", later(THROTTLE_WINDOW_MS + 3 * 60 * 1000));
      return (await db.select().from(authThrottle)).map((r) => r.subject).sort();
    })();

    expect(rows).toEqual(["current", "steady"]);
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
