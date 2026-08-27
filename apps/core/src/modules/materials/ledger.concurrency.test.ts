import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { formularyMedicines, stockBatches } from "../../kernel/db/schema";
import { registerItem } from "./items";
import { createStore } from "./stores";
import { balances, movementsFor, postMovement, postMovements } from "./ledger";
import type { MaterialsError } from "./errors";
import type { Pool } from "pg";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T5 — **A8 AND A9: THE LOCK, OBSERVED.**
 *
 * ═══ WHY THIS IS A SEPARATE FILE AND WHY IT USES TWO CONNECTIONS ═══
 *
 * `withTx` runs on the pool's own client, so two `withTx` calls awaited in sequence never overlap
 * and two started together may or may not — a `Promise.all` race is not a race, it is a
 * coin-flip whose result is usually "the second one lagged" (ledger §3.22). What discriminates a
 * real ordered set lock from a read-check-write is an EXTERNAL SESSION holding a row the correct
 * implementation must wait for, and the `versions.contention.test.ts` shape is that, transcribed.
 *
 * ═══ THE TIMING ASSERTION IS WRITTEN SO AN IDLE HOST CANNOT PASS IT BY LUCK (§2.99) ═══
 *
 * 09a shipped a race test that sat 9 s inside a 15 s budget: green on an idle host, red on a busy
 * one, and measuring neither. The legs below avoid that trap in the only way that actually works —
 * **they do not measure a duration at all.** They assert a STATE: with the lock held, the movement
 * is still PENDING after `PROBE_MS`; after the holder commits, it settles. A slow host makes
 * "pending" MORE true, not less, so the assertion cannot flip with load. The suite budget is
 * 30 s (the plan asks for ≥ 20 s) and is a ceiling on the whole file, not a threshold anything is
 * compared against.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const T0 = new Date("2026-08-27T06:00:00Z");
/**
 * How long a blocked movement must still be blocked for. Small on purpose: it is a floor on the
 * WAIT, and a longer one would only slow the suite. Nothing is asserted to complete WITHIN a
 * budget, so this number cannot make the test flaky in either direction.
 */
const PROBE_MS = 400;

jest.setTimeout(30_000);

const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

describe("the stock ledger under contention (Plan 14 T5, A8 + A9)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function anItem(code: string): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `Item ${code}`, class: "drug", formularyMedicineId: medicineId,
      baseUom: "tablet", batchTracked: true,
    }));
    return itemId;
  }

  async function aStore(code: string): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code, name: `Store ${code}` }));
    return resourceId;
  }

  async function aBatch(itemId: string, batchNo: string): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({
      id, itemId, batchNo, expiryDate: "2027-06-30", landedCostPaise: 100,
      ownership: "owned", createdBy: HEAD.id,
    });
    return id;
  }

  // ══════════════════════════════ A8 ══════════════════════════════

  /**
   * **A8, first half — AND IT DOES NOT DISCRIMINATE. Measured, not assumed.**
   *
   * The intuition is that a `postMovement` taking the ordered set lock must wait on a held row
   * while a read-check-write one sails past. **The mutant was built and it waited too**, so this
   * leg SURVIVED it: the lock-less implementation still ends in `ON CONFLICT DO UPDATE` on the same
   * `(resource, batch)` row, and THAT takes the row lock at write time. Both block; only the
   * moment of blocking differs, and nothing observable from outside can see which.
   *
   * `versions.contention.test.ts` records the mirror-image lesson — *"holding the TARGET's own row
   * cannot discriminate: the single-winner conditional UPDATE takes an exclusive lock on that same
   * row in BOTH implementations"* — and it applies here for the same reason with the roles
   * reversed. The Assertion Book row is corrected in the phase document.
   *
   * **The leg is KEPT**, because "a movement waits for a concurrent holder rather than proceeding
   * on stale data" is a real property worth pinning against a future refactor that drops the lock
   * AND the upsert. It is simply not the thing that tells the two implementations apart. The leg
   * below is.
   */
  it("A8: a movement BLOCKS while another session holds the balance row, and completes after release", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId, "B-001");
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 1, reason: "grn", occurredAt: T0,
    }));

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select resource_id, batch_id from stock_balances where resource_id = $1 and batch_id = $2 for update",
        [storeId, batchId],
      );

      const p = withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId, qtyDelta: -1, reason: "issue", occurredAt: T0,
      }));
      p.catch(() => { /* observed below; no unhandled rejection while it waits */ });

      // THE ASSERTION IS A STATE, NOT A DURATION (§2.99). A busy host makes this MORE true.
      const state = await Promise.race([
        p.then(() => "settled", () => "settled"),
        delay(PROBE_MS).then(() => "pending"),
      ]);
      expect(state).toBe("pending");

      await holder.query("commit");
      await p;
    } finally {
      holder.release();
    }
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(0);
  });

  /**
   * **A8, second half: THE OUTCOME — and this is the leg that kills the mutant.**
   *
   * Two concurrent outbound movements against a balance of ONE, both entering before either
   * commits. Exactly one succeeds, the other is refused with a CODE, and the balance ends at 0.
   *
   * ═══ WHAT THE MUTANT ACTUALLY DOES, MEASURED — AND WHY THE CHECK DOES NOT SAVE IT ═══
   *
   * The plan predicted the lock-less mutant would either trip
   * `stock_balances_non_negative_ck` at COMMIT or drive the balance negative. **It does neither.**
   * Executed against it: **BOTH racers FULFILLED, both returning `balanceAfter: 0`, and TWO `issue`
   * rows were written for ONE unit of stock.** Both read `on_hand = 1`, both computed `1 − 1 = 0`,
   * both wrote 0 — a classic lost update, whose result is a legal non-negative number. The CHECK
   * never fires, because there is nothing wrong with 0.
   *
   * That is the whole argument for the lock, sharper than the plan made it: **the constraint
   * defends against a negative balance, and the defect this row exists to catch is not a negative
   * balance. It is a balance that is merely WRONG** — one unit of stock physically gone twice, with
   * a ledger that says it left once. Only serialisation prevents it.
   *
   * The interleave is FORCED rather than hoped for: the holder's lock makes both racers queue on
   * the same row, so both are past their own pre-checks when the barrier lifts. A plain
   * `Promise.allSettled` never reliably reaches that state — its loser usually dies before the
   * winner has done anything, which measures nothing (ledger §3.22).
   */
  it("A8: two racers for the LAST unit — one wins, one is refused `insufficient_stock`, balance ends at 0", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId, "B-001");
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 1, reason: "grn", occurredAt: T0,
    }));

    const holder = await pool.connect();
    let results: PromiseSettledResult<{ ledgerEntryId: string; balanceAfter: number }>[] = [];
    try {
      await holder.query("begin");
      await holder.query(
        "select resource_id, batch_id from stock_balances where resource_id = $1 and batch_id = $2 for update",
        [storeId, batchId],
      );
      const a = withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId, qtyDelta: -1, reason: "issue", refId: "racer-a", occurredAt: T0,
      }));
      const b = withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId, qtyDelta: -1, reason: "issue", refId: "racer-b", occurredAt: T0,
      }));
      a.catch(() => {}); b.catch(() => {});
      // Both are now queued on the held row rather than racing to read it.
      await delay(PROBE_MS);
      await holder.query("commit");
      results = await Promise.allSettled([a, b]);
    } finally {
      holder.release();
    }

    expect(results).toHaveLength(2);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // The loser gets a CODE the screen can render — not a constraint name, and not a 500.
    const reason = (lost[0] as PromiseRejectedResult).reason as MaterialsError;
    expect(reason.code).toBe("insufficient_stock");

    // …and the invariant itself: ZERO, never −1, and exactly ONE issue row was written.
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(0);
    const issues = (await movementsFor(db, { batchId })).filter((r) => r.reason === "issue");
    expect(issues).toHaveLength(1);
  });

  /**
   * The control that stops the two legs above being read as "any serialisation will do":
   * **sequential calls cannot discriminate.** Run one after the other, a lock-less implementation
   * behaves identically — which is why the plan says so in as many words and why this leg is a
   * control rather than an assertion about the lock.
   */
  it("A8 control: SEQUENTIAL calls do not discriminate — both implementations agree", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId, "B-001");
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 1, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -1, reason: "issue", occurredAt: T0,
    }));
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -1, reason: "issue", occurredAt: T0,
    }))).rejects.toThrow(/available/);
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(0);
  });

  // ══════════════════════════════ A9 ══════════════════════════════

  /**
   * **A9: TWO MULTI-LINE ISSUES TOUCHING THE SAME TWO BATCHES IN OPPOSITE ORDERS DO NOT DEADLOCK.**
   *
   * The shipped `postMovements` locks by `(resource_id, batch_id)` in ONE ordered statement, so
   * both transactions acquire X and Y in the same order and the second simply waits. A
   * `postMovements` that locked in the CALLER'S line order would have transaction A holding X and
   * wanting Y while B holds Y and wants X — a genuine deadlock, which Postgres resolves by aborting
   * one with **SQLSTATE 40P01**.
   *
   * `40P01` is the assertion: not "both succeeded" (they do either way, once the deadlock detector
   * has killed one and the caller has not retried), but "**neither was aborted as a deadlock
   * victim**". **Single-line issues cannot discriminate** — there is only one row to order.
   *
   * The interleave is forced with an external holder on BOTH rows, so both transactions are queued
   * and start their lock acquisition at the same instant when it lifts. Without that, the first
   * transaction usually finishes before the second begins and no ordering question is ever asked.
   */
  it("A9: two multi-line issues over the same two batches, in OPPOSITE orders, do not deadlock", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const x = await aBatch(itemId, "B-X");
    const y = await aBatch(itemId, "B-Y");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: x, qtyDelta: 100, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: y, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));

    const holder = await pool.connect();
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await holder.query("begin");
      // Hold BOTH rows so neither racer can get ahead of the other.
      await holder.query(
        "select resource_id, batch_id from stock_balances where batch_id = any($1) order by resource_id, batch_id for update",
        [[x, y]],
      );

      // A takes the lines in the order [X, Y]; B in the order [Y, X].
      const a = withTx(db, (tx) => postMovements(tx, HEAD, [
        { resourceId: storeId, batchId: x, qtyDelta: -1, reason: "issue", refId: "a", occurredAt: T0 },
        { resourceId: storeId, batchId: y, qtyDelta: -1, reason: "issue", refId: "a", occurredAt: T0 },
      ]));
      const b = withTx(db, (tx) => postMovements(tx, HEAD, [
        { resourceId: storeId, batchId: y, qtyDelta: -1, reason: "issue", refId: "b", occurredAt: T0 },
        { resourceId: storeId, batchId: x, qtyDelta: -1, reason: "issue", refId: "b", occurredAt: T0 },
      ]));
      a.catch(() => {}); b.catch(() => {});

      // Both must be waiting on the holder — the same state assertion as A8, and the same reason it
      // cannot flip with load.
      const state = await Promise.race([
        Promise.race([a, b]).then(() => "settled", () => "settled"),
        delay(PROBE_MS).then(() => "pending"),
      ]);
      expect(state).toBe("pending");

      await holder.query("commit");
      results = await Promise.allSettled([a, b]);
    } finally {
      holder.release();
    }

    // NEITHER was aborted as a deadlock victim. `40P01` is what the caller-order mutant produces.
    const deadlocked = results.filter(
      (r) => r.status === "rejected"
        && (r.reason as { code?: string } | undefined)?.code === "40P01",
    );
    expect(deadlocked).toHaveLength(0);
    // Both succeeded — there was plenty of stock; the only question was the ORDER of acquisition.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await balances(db, { batchId: x }))[0]?.qtyOnHand).toBe(98);
    expect((await balances(db, { batchId: y }))[0]?.qtyOnHand).toBe(98);
  });

  /**
   * The A9 control, and it is the plan's own sentence: **single-line issues do not discriminate.**
   * With one row there is no ordering question, so a caller-order implementation and an ordered one
   * behave identically. Kept so the leg above is read as being about ORDER rather than about
   * locking in general.
   */
  it("A9 control: SINGLE-line issues cannot discriminate — one row has no ordering question", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const x = await aBatch(itemId, "B-X");
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId: x, qtyDelta: 100, reason: "grn", occurredAt: T0,
    }));
    const results = await Promise.allSettled([
      withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId: x, qtyDelta: -1, reason: "issue", occurredAt: T0,
      })),
      withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId: x, qtyDelta: -1, reason: "issue", occurredAt: T0,
      })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await balances(db, { batchId: x }))[0]?.qtyOnHand).toBe(98);
  });

  /**
   * The lock is taken over the DEDUPED pair set in `(resource_id, batch_id)` order regardless of how
   * many times a caller names the same pair — so a movement listing one batch twice takes one lock,
   * not two, and cannot deadlock against itself.
   */
  it("a movement naming one pair twice takes ONE lock and checks the NET", async () => {
    const itemId = await anItem("CROC500");
    const storeId = await aStore("MAIN");
    const x = await aBatch(itemId, "B-X");
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId: x, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: x, qtyDelta: -3, reason: "issue", occurredAt: T0 },
      { resourceId: storeId, batchId: x, qtyDelta: -3, reason: "issue", occurredAt: T0 },
    ]));
    expect((await balances(db, { batchId: x }))[0]?.qtyOnHand).toBe(4);
    expect(await movementsFor(db, { batchId: x })).toHaveLength(3);
  });
});
