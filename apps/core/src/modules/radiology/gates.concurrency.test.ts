import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { events, imagingSafetyScreenings } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { checkIn } from "./checkin";
import { gateState, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T5 — Assertion Book row **A7**, and it is its own file because a race needs two real
 * transactions and a single-connection suite cannot produce one.
 *
 * ═══ WHAT IS ACTUALLY BEING TESTED ═══
 *
 * Not "does `satisfyGate` check the state first" — it does, and that check is a KINDNESS for the
 * sequential caller (`gate_already_terminal`, a 409 that names the state). It is not the control,
 * and a suite that only proved the check would pass against a read-then-write implementation in
 * which two technologists at two consoles both read `open`, both compute, and both write.
 *
 * What is tested is that the gate rides **`transition`'s compare-and-set** — the conditional UPDATE
 * `where id = ? and status = 'active' and current_state = <the state we validated against>`. The
 * loser's UPDATE touches zero rows, the engine raises `stale_transition`, and this module maps it to
 * `stale_state` (409). The plan names no mutant for this row on purpose: the assertion IS that the
 * mechanism is the engine's CAS rather than a check.
 *
 * ═══ EACH ROUND TAKES ITS OWN STUDY AND THE FIXTURE IS BUILT ONCE — §2.144 / F17 ═══
 *
 * The T4 lane's version of this file rebuilt the whole radiology fixture inside its loop: green in
 * isolation, `Exceeded timeout of 15000 ms` under a full workspace verify, and a `patients_pkey`
 * collision in the NEXT test from the abandoned async work. Rounds here are independent because
 * they contend for DIFFERENT GATES on different studies, so one fixture serves all of them.
 */
describe("a gate is moved by the engine's CAS, not by a read (18a T5 A7)", () => {
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

  /** A checked-in ultrasound: one gate, `identity_two_factor`, and it is the one two callers race. */
  const arriveWithOneGate = async (): Promise<string> => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, "USG-ABDO", `r${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return (await requireStudyGate(db, study.studyId, "identity_two_factor")).id;
  };

  const IDENTITY_OK = { secondIdentifier: "uhid" as const, value: "HMS-00000001-5" };

  /**
   * ═══ THE HOLD IS WHAT CONSTRUCTS THE OVERLAP, AND IT IS NOT A HACK TO MAKE A FLAKE PASS ═══
   *
   * The first version of this file raced two plain `withTx(satisfyGate)` calls and the loser came
   * back `gate_already_terminal` — because under READ COMMITTED the two transactions had simply
   * SERIALISED: the winner committed before the loser's pre-read ran, so the loser saw `satisfied`
   * and refused at the kindness check without ever reaching the CAS. That measured the Node
   * scheduler, not the database.
   *
   * Holding each transaction open for 200 ms AFTER its write forces the interleaving the assertion
   * is actually about — **both callers read `open`, both compute, and only then does either
   * commit**. The loser's conditional UPDATE then blocks on the winner's row lock, re-evaluates
   * after the commit, matches nothing, and the engine raises `stale_transition`. That is the exact
   * sequence two technologists at two consoles produce, and it is the one a read-then-write
   * implementation gets wrong.
   */
  const HOLD_MS = 200;
  const race = (gateId: string) =>
    withTx(db, async (tx) => {
      const result = await satisfyGate(tx, fx.radiographer, gateId, IDENTITY_OK, NOW);
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return result;
    });

  /**
   * FIVE ROUNDS, because one round of a race proves very little: a lucky interleaving makes a broken
   * implementation look correct once. `allSettled` rather than `all`, so the loser's refusal is a
   * value to assert on rather than an unhandled rejection.
   */
  it("A7: two concurrent satisfyGate on one gate — exactly ONE lands, the other is stale_state", async () => {
    for (let round = 0; round < 5; round += 1) {
      const gateId = await arriveWithOneGate();

      const settled = await Promise.allSettled([race(gateId), race(gateId)]);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");
      expect([round, fulfilled.length, rejected.length]).toEqual([round, 1, 1]);

      /**
       * The loser's code is the RACE code and not the sequential one. `gate_already_terminal` here
       * would mean the pre-read had somehow serialised the two, and `stale_state` is what says the
       * conditional UPDATE is the thing that decided.
       */
      const loser = (rejected[0] as PromiseRejectedResult).reason as { code: string };
      expect([round, loser.code]).toEqual([round, "stale_state"]);

      expect([round, await gateState(db, gateId)]).toEqual([round, "satisfied"]);
    }
  });

  /**
   * The half a winner-count cannot see: the LOSER must have written nothing. The evidence UPDATE is
   * deliberately after the transition, so a loser that got as far as computing its evidence still
   * rolls back — and exactly one `imaging.gate_evaluated` reaches the bus, because 18a-iii's
   * escalation ladder and any future projection both count these.
   */
  it("A7: the loser writes NO evidence and emits NO event — one gate, one row, one event", async () => {
    const gateId = await arriveWithOneGate();
    await Promise.allSettled([race(gateId), race(gateId)]);

    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
    expect(row!.satisfiedBy).toBe(fx.radiographer.id);
    expect(row!.evidence).toMatchObject({ kind: "identity_two_factor", secondIdentifier: "uhid" });
    expect(row!.override).toBeNull();

    const emitted = (await db.select().from(events))
      .filter((e) => e.name === "imaging.gate_evaluated"
        && (e.payload as { kind: string }).kind === "identity_two_factor");
    expect(emitted).toHaveLength(1);
  });

  /**
   * The SEQUENTIAL case takes the other lane, and both must exist: a caller who clicks twice, one
   * second apart, gets `gate_already_terminal` naming the state it is already in — which is an
   * answer a console can render — while the racing caller gets `stale_state`, which is a retry.
   */
  it("the sequential second call is gate_already_terminal, not stale_state", async () => {
    const gateId = await arriveWithOneGate();
    await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gateId, IDENTITY_OK, NOW));
    await expect(withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gateId, IDENTITY_OK, NOW)))
      .rejects.toMatchObject({ code: "gate_already_terminal" });
  });
});
