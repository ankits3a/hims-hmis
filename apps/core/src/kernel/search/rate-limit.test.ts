import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { searchAudit } from "../db/schema";
import { checkSearchRate } from "./rate-limit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

const desk: Actor = { type: "user", id: "user-1" };
const other: Actor = { type: "user", id: "user-2" };
const NOW = new Date("2026-08-25T10:00:00Z");

describe("search rate limit (DD8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); seq = 0; });

  let seq = 0;
  async function seed(actorId: string, count: number, secondsAgo: number): Promise<void> {
    if (count === 0) return;
    await db.insert(searchAudit).values(
      Array.from({ length: count }, () => ({
        // A monotonic counter, not a derived string: the derived form collided once truncated,
        // which is a fixture bug that looks exactly like a limiter bug.
        id: `AUD${String((seq += 1)).padStart(23, "0")}`,
        actorId, rawQuery: "q", queryHash: "h", entityCounts: {}, totalHits: 0, tookMs: 1,
        source: "text", restrictedSurfaced: false, at: new Date(NOW.getTime() - secondsAgo * 1000),
      })),
    );
  }

  it("a desk under the limit is allowed", async () => {
    await seed("user-1", 50, 10);
    expect(await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW })).toMatchObject({ allowed: true, used: 50 });
  });

  it("AT the limit it refuses, with a Retry-After in seconds", async () => {
    await seed("user-1", 120, 30);
    const v = await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW });
    expect(v.allowed).toBe(false);
    // The oldest request was 30 s ago, so the window clears in ~30 s — not a flat cooldown.
    expect(v.retryAfterSec).toBeGreaterThan(25);
    expect(v.retryAfterSec).toBeLessThanOrEqual(31);
  });

  it("REQUESTS OUTSIDE THE WINDOW DO NOT COUNT — it slides, it does not accumulate", async () => {
    await seed("user-1", 200, 3600); // an hour ago
    expect(await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW })).toMatchObject({ allowed: true, used: 0 });
  });

  it("ONE BUSY COUNTER NEVER THROTTLES ANOTHER — the limit is per actor", async () => {
    await seed("user-1", 200, 10);
    expect((await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW })).allowed).toBe(false);
    expect((await checkSearchRate(db, other, { limit: 120, windowSec: 60, now: NOW })).allowed).toBe(true);
  });

  it("Retry-After is never zero — a 0 would invite an immediate retry", async () => {
    await seed("user-1", 120, 60); // exactly at the boundary
    const v = await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW });
    if (!v.allowed) expect(v.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("an actor who has never searched is allowed", async () => {
    expect(await checkSearchRate(db, desk, { limit: 120, windowSec: 60, now: NOW })).toEqual({ allowed: true, used: 0, retryAfterSec: 0 });
  });
});
