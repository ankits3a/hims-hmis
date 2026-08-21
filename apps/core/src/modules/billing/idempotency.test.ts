import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { idempotencyKeys } from "../../kernel/db/schema";
import { requestHashOf, withIdempotency } from "./idempotency";
import type { Db } from "../../kernel/db/client";

/**
 * SERVER-SIDE IDEMPOTENCY (the follow-up to pipeline C's re-entrancy finding).
 *
 * `SubmitButton` closes the double click inside one tab. These tests are about everything it
 * cannot reach: a reload, a second tab, and a request the network duplicates after the client
 * stopped waiting. The claim is taken BEFORE the work, so the concurrent case is the one that
 * actually matters — a guard that only recognises a duplicate AFTER the work has run has already
 * let a second money document exist.
 */
describe("withIdempotency (server-side replay protection)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  const ACTOR = "u-cashier-1";
  const ROUTE = "POST /billing/receipts";
  const BODY = { patientId: "p-1", tenders: [{ mode: "cash", amountPaise: 30_000 }] };
  const NOW = new Date("2026-08-19T06:00:00Z");

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
  });

  /** A work function that records how many times it actually ran. */
  function counter<T>(result: T): { run: () => Promise<T>; calls: () => number } {
    let calls = 0;
    return {
      run: async () => {
        calls++;
        return await Promise.resolve(result);
      },
      calls: () => calls,
    };
  }

  it("a REPLAY returns the original result and the work runs exactly ONCE", async () => {
    const w = counter({ receiptId: "rcp-1", totalPaise: 30_000 });

    const first = await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);
    const second = await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);

    expect(w.calls()).toBe(1);
    expect(first).toEqual({ receiptId: "rcp-1", totalPaise: 30_000 });
    // The replay is served from `response` jsonb — the same VALUE, which at the HTTP boundary is
    // the same bytes. This is the contract the docstring states, asserted rather than assumed.
    expect(second).toEqual(first);

    const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, "k-1"));
    expect(row?.state).toBe("done");
    expect(row?.completedAt).not.toBeNull();
  });

  it("the SAME key with a DIFFERENT body is refused `idempotency_key_reused`, and the work does NOT run again", async () => {
    const w = counter({ receiptId: "rcp-1" });
    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);

    const other = { patientId: "p-1", tenders: [{ mode: "cash", amountPaise: 999_999 }] };
    await expect(
      withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, other, w.run, NOW),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });

    // The point of the hash: a client bug must NOT be answered with an unrelated document.
    expect(w.calls()).toBe(1);
  });

  it("a CONCURRENT duplicate never reaches the work — the loser of the claim is refused while the winner is still running", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => {
      signalStarted = r;
    });
    const slow = async (): Promise<{ receiptId: string }> => {
      calls++;
      signalStarted();
      await gate;
      return { receiptId: "rcp-1" };
    };

    const winner = withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, slow, NOW);
    await started; // the claim is committed and the work is in flight

    // The duplicate is launched while the winner is still inside `work`. Its outcome is CAPTURED
    // rather than awaited-as-rejected: under a claim-AFTER-the-work implementation it does not
    // reject at all, it quietly does the work a second time, and `await expect().rejects` would
    // then hang to a jest timeout — a kill with no assertion behind it (§2.26).
    const loser = withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, slow, NOW)
      .then(() => "settled" as const, (e: unknown) => e);

    release();
    await expect(winner).resolves.toEqual({ receiptId: "rcp-1" });
    const outcome = await loser;

    /*
     * THE INVARIANT, NOT THE LOSER'S DIAGNOSIS (§3.13). Whether the duplicate is refused
     * `idempotency_key_in_progress` or served the finished result depends on whether the winner
     * committed first — both are correct, and pinning one would be a timing assertion dressed up
     * as a behavioural one. What is true in every interleaving is that THE WORK RAN ONCE.
     * Claiming after the work instead of before leaves this at 2 — two receipts, the whole defect.
     */
    expect(calls).toBe(1);
    if (outcome !== "settled") expect(outcome).toMatchObject({ code: "idempotency_key_in_progress" });
  });

  it("a FAILED write RELEASES the key, so a corrected retry with the same key still works (§3.44)", async () => {
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls++;
      await Promise.resolve();
      throw new Error("cash_threshold_blocked");
    };

    await expect(
      withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, failing, NOW),
    ).rejects.toThrow("cash_threshold_blocked");

    // the claim must be gone — otherwise the cashier's corrected retry is stranded forever
    const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, "k-1"));
    expect(rows).toHaveLength(0);

    const w = counter({ receiptId: "rcp-2" });
    const retried = await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);
    expect(retried).toEqual({ receiptId: "rcp-2" });
    expect(calls).toBe(1);
    expect(w.calls()).toBe(1);
  });

  /**
   * NOT-OVER-BROAD (§3.44), and the case that matters most on a cash counter: two genuinely
   * separate payments of the SAME amount for the SAME patient must both go through. A guard keyed
   * on the request CONTENT rather than a client key would silently swallow the second one, and the
   * hospital would keep money with no document naming it.
   */
  it("distinct keys run distinct work, and an ABSENT key never suppresses anything", async () => {
    const w = counter({ receiptId: "rcp-n" });

    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);
    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-2" }, BODY, w.run, NOW);
    expect(w.calls()).toBe(2); // same actor, same route, same BODY — two real payments

    // no key at all: the pre-existing behaviour, unchanged
    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: undefined }, BODY, w.run, NOW);
    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "" }, BODY, w.run, NOW);
    expect(w.calls()).toBe(4);
    expect(await db.select().from(idempotencyKeys)).toHaveLength(2); // and nothing was claimed
  });

  it("the same key is scoped per ACTOR and per ROUTE — one cashier's key cannot replay another's", async () => {
    const w = counter({ receiptId: "rcp-n" });

    await withIdempotency(db, { actorId: ACTOR, route: ROUTE, key: "k-1" }, BODY, w.run, NOW);
    await withIdempotency(db, { actorId: "u-cashier-2", route: ROUTE, key: "k-1" }, BODY, w.run, NOW);
    await withIdempotency(db, { actorId: ACTOR, route: "POST /billing/invoices", key: "k-1" }, BODY, w.run, NOW);

    expect(w.calls()).toBe(3);
  });

  it("the request hash is canonical: key ORDER cannot change it, but a VALUE change must", () => {
    expect(requestHashOf({ a: 1, b: 2 })).toBe(requestHashOf({ b: 2, a: 1 }));
    expect(requestHashOf({ a: { x: 1, y: 2 } })).toBe(requestHashOf({ a: { y: 2, x: 1 } }));
    expect(requestHashOf({ a: 1 })).not.toBe(requestHashOf({ a: 2 }));
    // arrays are ORDERED — two tenders swapped is a different request, not the same one reordered
    expect(requestHashOf([1, 2])).not.toBe(requestHashOf([2, 1]));
  });
});
