import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingStudies } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { cancelStudy, scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T4 — Assertion Book row **A1**, and it is its own file because a race needs two real
 * transactions and a single-connection suite cannot produce one.
 *
 * ═══ WHAT IS ACTUALLY BEING TESTED ═══
 *
 * Not "does the code check for a clash" — a read-then-write passes that reading of the requirement
 * and still books two patients onto one machine, which is B1. What is tested is that the SLOT IS
 * HELD BY THE DATABASE: `imaging_studies_slot_ux`, a partial unique on
 * `(device_resource_id, scheduled_at) WHERE status NOT IN ('cancelled','rescheduled','no_show')`.
 *
 * Two transactions racing for one slot must produce exactly one winner and one `slot_taken`, and
 * they must do so however the scheduler is written — which is what makes this an assertion about
 * the schema rather than about the function.
 */
describe("the imaging slot is held by the database, not by a read (18a T4 A1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const newStudy = () => {
    seq += 1;
    return placeAndCreateStudy(db, fx, "USG-ABDO", `c${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };

  const book = (studyId: string, at: Date = SLOT) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId, deviceResourceId: fx.devices.usg!, scheduledAt: at,
    }));

  /**
   * FIVE ROUNDS, because a single round of a race proves very little: a lucky interleaving can make
   * a broken implementation look correct once. `Promise.allSettled` rather than `all`, so the loser's
   * refusal is a value to assert on rather than an unhandled rejection.
   */
  it("A1: two concurrent bookings for one device and one instant — exactly ONE lands", async () => {
    /**
     * ═══ EACH ROUND TAKES ITS OWN INSTANT INSTEAD OF REBUILDING THE FIXTURE — §2.144 ═══
     *
     * The first version of this test called `truncateAll` + `setupRadiologyFixture` inside the loop,
     * five times. It passed in isolation and **timed out at 15 000 ms under a full workspace verify**
     * — and when it did, its abandoned async work raced the NEXT test's setup and produced a
     * `duplicate key on patients_pkey` that had nothing to do with anything.
     *
     * That is ledger §2.144's exact class: a test sitting close to its default budget is a test that
     * fails on a busy box and looks like an instrument problem. The fix is not a longer timeout — it
     * is to stop doing expensive work the assertion never needed. Rounds are independent because they
     * contend for DIFFERENT instants on the same machine, so one fixture serves all five.
     */
    for (let round = 0; round < 5; round += 1) {
      const at = new Date(SLOT.getTime() + round * 3_600_000);
      const a = await newStudy();
      const b = await newStudy();

      const settled = await Promise.allSettled([book(a.studyId, at), book(b.studyId, at)]);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");

      expect([round, fulfilled.length, rejected.length]).toEqual([round, 1, 1]);
      /**
       * F55 — the assertion is on the CODE, not on the sentence. The slot is an INTERVAL now, so
       * the loser is refused by the overlap check (which the device-row lock makes race-free)
       * rather than by the exact-instant unique index, and the message names the study it clashes
       * with. Both refusals are `slot_taken` and always were; matching the prose was pinning the
       * mechanism when the property is what this test is about.
       */
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "slot_taken" });

      /** And the DATABASE agrees: exactly one study holds that slot. */
      const held = await db.select({ id: imagingStudies.id })
        .from(imagingStudies)
        .where(eq(imagingStudies.scheduledAt, at));
      expect([round, held.length]).toEqual([round, 1]);
    }
  });

  /**
   * ═══ THE `WHERE` CLAUSE, WHICH IS THE HALF THAT IS EASY TO LOSE ═══
   *
   * A1's mutant is dropping the partial index's predicate, and the consequence it names is that a
   * cancelled booking blocks the slot for ever. That is not a tidiness point: the 09:00 CT a patient
   * cancels on Monday would be unbookable until somebody deleted a row by hand, and the first person
   * to notice would be a patient told there is no appointment on a machine standing idle.
   */
  it("A1: after the winner is CANCELLED, the loser's retry lands in the freed slot", async () => {
    const winner = await newStudy();
    const loser = await newStudy();

    await book(winner.studyId);
    await expect(book(loser.studyId)).rejects.toMatchObject({ code: "slot_taken" });

    await withTx(db, (tx) => cancelStudy(tx, fx.doctor, fx.decls, { studyId: winner.studyId }));

    const retry = await book(loser.studyId);
    expect(retry.scheduledAt).toEqual(SLOT);

    /** Both rows still exist — the cancelled one keeps its history, it just stops holding the slot. */
    const rows = await db.select({ id: imagingStudies.id, status: imagingStudies.status })
      .from(imagingStudies).where(eq(imagingStudies.scheduledAt, SLOT));
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "scheduled"]);
  });

  /**
   * The same property from the other side: a NO-SHOW frees the slot too, and it is the second of the
   * three statuses the index excludes. Asserting only `cancelled` would let a predicate that named
   * one status pass.
   */
  it("A1: a no-show ALSO frees the slot — all three excluded statuses matter", async () => {
    const first = await newStudy();
    const second = await newStudy();
    await book(first.studyId);
    await db.update(imagingStudies).set({ status: "no_show" }).where(eq(imagingStudies.id, first.studyId));

    const retry = await book(second.studyId);
    expect(retry.scheduledAt).toEqual(SLOT);
  });

  /** A different instant on the same machine is not a clash at all — the index is on the PAIR. */
  it("the same device at a DIFFERENT instant is not a clash", async () => {
    const a = await newStudy();
    const b = await newStudy();
    await book(a.studyId);
    const other = await book(b.studyId, new Date("2026-08-31T09:30:00.000Z"));
    expect(other.scheduledAt.toISOString()).toBe("2026-08-31T09:30:00.000Z");
  });
});
