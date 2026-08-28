import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { resources } from "../db/schema";
import { KERNEL_RESOURCE_KINDS } from "./kinds";
import { assignResource, createResource, releaseResource } from "./registry";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 15 T5 — **THE REGISTRY'S OCCUPANCY LOCK, OBSERVED. This file is a DEFECT REPORT that became
 * a regression test, and the defect was the kernel's (finding T5-a).**
 *
 * ═══ WHAT THE PLAN ASSUMED, AND WHAT THE TREE HELD ═══
 *
 * Plan 15's A12 and A19 both say the theatre and bay races *"go through the registry's `assign`,
 * which owns that lock"*. **It did not own one.** `assignResource` read the row through a private
 * `requireResource` that issued a plain `SELECT`, checked `occupant_ref IS NULL`, and then wrote —
 * a read-check-write with nothing between the check and the write. Two concurrent assigns on one
 * resource therefore BOTH passed the check (neither had committed when the other read), and the
 * second `UPDATE` overwrote the first: the theatre ended up occupied by the second case while the
 * first case's sign-in had already returned success.
 *
 * That is not an OT bug. Every occupancy in this system runs through these two functions — the two
 * recovery bays here, every ward bed when the IPD cluster lands, every chair a future OPD queue
 * assigns. It is fixed where it lives.
 *
 * ═══ WHY `already_occupied` ALONE PROVED NOTHING (the A2 test that existed) ═══
 *
 * `registry.test.ts` A2 already asserted that assigning an OCCUPIED resource throws
 * `already_occupied`. It passes on both implementations, because it assigns twice in SEQUENCE — the
 * first assign has committed by the time the second reads. A sequential test cannot see a
 * read-check-write; only an overlapping one can.
 *
 * ═══ WHY "IT BLOCKS" ALSO PROVES NOTHING — Plan 14's A8 lesson, transcribed ═══
 *
 * The obvious probe is to hold the row in an external session and watch the assign wait. Plan 14's
 * `ledger.concurrency.test.ts` recorded why that does not discriminate: *"the lock-less
 * implementation still ends in `ON CONFLICT DO UPDATE` on the same row, and THAT takes the row lock
 * at write time. Both block; only the moment of blocking differs."* The same is true here: the
 * unlocked version blocks at its `UPDATE` instead of at its `SELECT`, and nothing outside can tell
 * those apart.
 *
 * **What discriminates is the OUTCOME of an overlap**, and the test below is built to produce one
 * deterministically rather than by racing two promises and hoping (§3.22: a `Promise.all` race is a
 * coin flip). Transaction A assigns and then WAITS on a barrier the test controls, so B's read is
 * guaranteed to happen while A is uncommitted. With a locked read B waits and then sees the truth;
 * without one B reads a free resource that is already spoken for.
 */
const ACTOR: Actor = { type: "user", id: "01HREGISTRYCONCURRENCY00001" };
const PROBE_MS = 400;

jest.setTimeout(30_000);

const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

describe("the registry under contention (Plan 15 T5, finding T5-a)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function aBed(code: string): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, {
      kind: "bed", code, name: `Bed ${code}`,
    }));
    return resourceId;
  }

  /**
   * THE DISCRIMINATING TEST. Exactly one assign wins; the other is refused `already_occupied`; and
   * the row's occupant is the winner's.
   */
  it("two OVERLAPPING assigns on one resource: exactly one wins, and the row holds the winner", async () => {
    const bedId = await aBed("RB-RACE");

    let releaseBarrier: () => void = () => { /* replaced below */ };
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    // A: assigns, then holds its transaction open until the test lets it commit.
    const a = withTx(db, async (tx) => {
      await assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {
        occupantType: "daycare_encounter", occupantRef: "ENC-A",
      });
      await barrier;
    });
    a.catch(() => { /* observed below */ });

    // Give A time to have done its write but not its commit.
    await delay(50);

    // B: overlaps A. On the LOCK-LESS implementation its SELECT sees a free bed here.
    const b = withTx(db, (tx) => assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {
      occupantType: "daycare_encounter", occupantRef: "ENC-B",
    }));
    b.catch(() => { /* observed below */ });

    /**
     * B MUST STILL BE PENDING — a STATE assertion, never a duration (§2.99). A busy host makes this
     * more true, not less. It is what proves B is waiting on A rather than having sailed past it.
     */
    const state = await Promise.race([
      b.then(() => "settled", () => "settled"),
      delay(PROBE_MS).then(() => "pending"),
    ]);
    expect(state).toBe("pending");

    releaseBarrier();
    const [aResult, bResult] = await Promise.allSettled([a, b]);

    // EXACTLY ONE. The lock-less implementation fulfils both.
    const outcomes = [aResult.status, bResult.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    expect(aResult.status).toBe("fulfilled");
    expect(bResult.status).toBe("rejected");
    expect(String((bResult as PromiseRejectedResult).reason)).toMatch(/already occupied/);

    // …and the row holds A's occupant, not B's. This is the half that makes the failure VISIBLE:
    // under the lock-less implementation both promises fulfil AND the bed belongs to B, while A's
    // caller has already been told it succeeded.
    const row = (await db.select().from(resources).where(eq(resources.id, bedId)))[0]!;
    expect({ status: row.status, occupantType: row.occupantType, occupantRef: row.occupantRef })
      .toEqual({ status: "occupied", occupantType: "daycare_encounter", occupantRef: "ENC-A" });
  });

  /** The mirror: two overlapping RELEASES of one resource. Exactly one wins; the loser is refused. */
  it("two OVERLAPPING releases on one resource: exactly one wins", async () => {
    const bedId = await aBed("RB-REL");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {
      occupantType: "daycare_encounter", occupantRef: "ENC-A",
    }));

    let releaseBarrier: () => void = () => { /* replaced below */ };
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    const a = withTx(db, async (tx) => {
      await releaseResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {});
      await barrier;
    });
    a.catch(() => { /* observed below */ });
    await delay(50);
    const b = withTx(db, (tx) => releaseResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {}));
    b.catch(() => { /* observed below */ });

    releaseBarrier();
    const [aResult, bResult] = await Promise.allSettled([a, b]);
    expect([aResult.status, bResult.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((bResult as PromiseRejectedResult).reason)).toMatch(/has no occupant to release/);
    // A bed released twice would go available → cleaning → cleaning, and the second release's
    // history row would claim a transition that did not happen.
    const row = (await db.select().from(resources).where(eq(resources.id, bedId)))[0]!;
    expect({ status: row.status, occupantRef: row.occupantRef }).toEqual({ status: "cleaning", occupantRef: null });
  });

  /**
   * The NON-discriminating leg, kept and labelled: two SEQUENTIAL assigns. `registry.test.ts` A2
   * already asserts this and it passes on both implementations — it is here so that a reader
   * comparing the two files can see why the overlapping version had to exist.
   */
  it("two SEQUENTIAL assigns are refused by both implementations — this leg discriminates NOTHING", async () => {
    const bedId = await aBed("RB-SEQ");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {
      occupantType: "daycare_encounter", occupantRef: "ENC-A",
    }));
    await expect(withTx(db, (tx) => assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, bedId, {
      occupantType: "daycare_encounter", occupantRef: "ENC-B",
    }))).rejects.toThrow(/already occupied/);
  });
});
