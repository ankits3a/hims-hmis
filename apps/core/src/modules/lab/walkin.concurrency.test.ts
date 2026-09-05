import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase } from "../../../test/helpers/lab";
import { opdEncounters, printJobs } from "../../kernel/db/schema";
import { openLabWalkin } from "../opd";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17d CLOSE §9.2 — THE GUARD WAS A READ-THEN-WRITE, AND TWO CLERKS BEAT IT ═══
 *
 * 17d T4 put "one open lab walk-in per patient per day" on the server, and it closed the case the
 * browser could not: a second clerk, a reloaded tab, a retried request. It did not close the case
 * where those two arrive in the SAME INSTANT. `openLabWalkinInTx` selected for an open visit and
 * then inserted one, and nothing stood between the two statements — so both transactions read
 * nothing, both passed the guard, and both minted a `V` number for one attendance. Pass 1 recorded
 * it as MINOR-not-taken; this is it, taken.
 *
 * ═══ WHY A LOCK AND NOT A UNIQUE INDEX, WHICH IS WHAT §9.2 PROPOSED ═══
 *
 * The recorded fix was a partial unique index on
 * `(patient_id, department_id, service_date) WHERE status NOT IN ('completed','abandoned')`.
 * Measured against the tree, that is the wrong instrument, for two independent reasons:
 *
 * 1. **It cannot be scoped to the laboratory.** `department_id` is DATA — a ULID minted per
 *    install — so no immutable index predicate can name the LAB department, and an index without
 *    that predicate constrains EVERY department. `encounters.ts` rejects exactly that in as many
 *    words: *"A general same-day guard would change every department's behaviour."* `openVisitInTx`
 *    has no same-day guard and must not acquire one as a side effect of a lab fix.
 * 2. **It cannot see the merge chain.** The guard matches `inArray(patientId, chainIds)`, and a
 *    unique index on `patient_id` cannot express "or any registration merged into this one". The
 *    second test below is the one a unique index would still fail.
 *
 * `pg_advisory_xact_lock` is the house pattern for precisely this shape and it is already in five
 * places — `lab/desk.ts:285` (the order-group guard), `lab/reports.ts:697`, `kernel/ops/mode.ts`,
 * `users-admin.controller.ts`. `ops/mode.ts` even writes down WHY it is not `SELECT … FOR UPDATE`:
 * a row lock can only serialise callers that can find a row, and here the whole point is that
 * neither racer can find one. The lock is taken on the CANONICAL patient id, which both callers
 * have resolved before entering, so the chain is covered by construction.
 *
 * ═══ THE POOL MUST BE WARM, OR THE RACE DOES NOT RACE ═══
 *
 * Inherited from `opd/escalation.concurrency.test.ts`, where it was MEASURED rather than assumed:
 * starting both promises before awaiting either is necessary and NOT sufficient, because `pg.Pool`
 * opens connections lazily and caller #2's TCP-plus-auth is longer than caller #1's whole
 * transaction. That suite watched a mutant SURVIVE for this reason. A green race test that cannot
 * fail certifies the lock while proving nothing about it, so the connections are opened first and
 * the establishment cost is outside the measured window.
 *
 * **Both tests below were proved fail-first**: with the lock removed, each opens TWO visits.
 */
async function warmPool(db: Db, n = 4): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.execute(sql`select pg_sleep(0.05)`)));
}

const NOW = new Date("2026-08-29T06:00:00.000Z");

describe("17d §9.2 — the lab walk-in race", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await warmPool(db);
  });
  afterEach(() => { fx.unregister(); });

  async function labVisitCount(): Promise<number> {
    const rows = await db
      .select({ id: opdEncounters.id })
      .from(opdEncounters)
      .where(sql`${opdEncounters.departmentId} = ${fx.labDepartmentId}`);
    return rows.length;
  }

  /**
   * TWO CLERKS, ONE INSTANT. The ordinary morning shape at a busy reception: the patient hands the
   * prescription to whoever is free, and two counters register the same person while each believes
   * they are the first.
   */
  it("two walk-ins for one patient in the same instant open ONE visit, and the loser is told which", async () => {
    const settled = await Promise.allSettled([
      openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }, NOW),
      openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }, NOW),
    ]);

    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect([won.length, lost.length]).toEqual([1, 1]);

    /**
     * The loser gets the GUARD's refusal, naming the visit that won — not a raw Postgres error and
     * not a serialisation failure. A clerk who is told "already open (V…)" can re-find it; a clerk
     * shown a constraint name cannot.
     */
    const reason = (lost[0] as PromiseRejectedResult).reason as { code?: string; detail?: { visitNo?: string } };
    expect(reason.code).toBe("lab_walkin_already_open");
    const winner = (won[0] as PromiseFulfilledResult<{ encounter: { id: string; visitNo: string } }>).value;
    expect(reason.detail?.visitNo).toBe(winner.encounter.visitNo);

    /** THE KILL: two `V` numbers for one attendance. Unlocked, this is 2. */
    expect(await labVisitCount()).toBe(1);

    /**
     * ═══ AND THE LOSER LEFT NO PAPER BEHIND (front-desk's review of #76) ═══
     *
     * FD-24 T5 put `enqueuePrintJob` INSIDE this transaction, so the refused walk-in must roll its
     * slips back with it. That is the property the whole design leans on and nothing was asserting
     * it: a patient must never walk away holding a token slip for a visit that does not exist.
     *
     * Asserted PER ENCOUNTER rather than as a total, because a total would still pass if the
     * loser's jobs had been written against the winner's encounter.
     *
     * ═══ AND DELIBERATELY NOT AS AN ABSOLUTE COUNT ═══
     *
     * This asserted `[2, 0]` — two documents for the winner — and that `2` was a lims test pinning
     * a FRONT-DESK policy decision: how many documents a visit queues is theirs, and they are
     * actively changing it for the lab road (a lab walk-in should not be handed a slip telling it
     * to pay at a counter it just left). The next change to that number would have reddened a
     * concurrency test in another lane's module, for a reason having nothing to do with
     * concurrency.
     *
     * What this test is actually about is the ROLLBACK, and the rollback does not care how many
     * documents there are. So: the loser left NOTHING behind, and the winner left SOMETHING — which
     * keeps the assertion non-vacuous without borrowing a constant that is not ours to hold.
     */
    const jobs = await db.select({ encounterId: printJobs.encounterId }).from(printJobs);
    const forWinner = jobs.filter((j) => j.encounterId === winner.encounter.id).length;
    expect(jobs.length - forWinner).toBe(0);   // THE KILL: a refused visit that left paper behind
    expect(forWinner).toBeGreaterThan(0);      // and the enqueue really does run on this path
  });

  /**
   * ═══ THE SAME RACE, ACROSS THE MERGE CHAIN — AND THE REASON THE FIX IS NOT AN INDEX ═══
   *
   * One person, two registrations, the second merged into the first. The counter may hold either
   * card, and `openLabWalkin` resolves both to the same canonical id before the guard runs. So the
   * two racers carry DIFFERENT `patient_id` values into a guard that is supposed to treat them as
   * one person.
   *
   * A partial unique index on `(patient_id, …)` — §9.2's proposal — would let both through, because
   * at the row level these genuinely are two different patients. The lock does not, because it is
   * keyed on what the guard actually means: the canonical patient.
   */
  it("the race is closed across the MERGE CHAIN, where a unique index on patient_id would not be", async () => {
    const settled = await Promise.allSettled([
      openLabWalkin(db, fx.desk.actor, { patientId: fx.patientId }, NOW),
      openLabWalkin(db, fx.desk.actor, { patientId: fx.mergedLoserId }, NOW),
    ]);

    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(1);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { code?: string }).code).toBe("lab_walkin_already_open");

    /** THE KILL: the merged registration bought a second visit for one person. Unlocked, this is 2. */
    expect(await labVisitCount()).toBe(1);
  });
});
