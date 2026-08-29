import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  deskAndLabel, NON_OVERLAPPING_PAIRS, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { events, labSpecimens } from "../../kernel/db/schema";
import { deskOrder } from "./desk";
import { printLabels } from "./specimens";
import { receive } from "./accession";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T5 — THE TWO CONCURRENCY ROWS, **A1 and A2**, each measured over ≥ 8 rounds.
 *
 * They are in their own file because they are the two assertions whose value is entirely in the
 * REPETITION: a race that is asserted once has been observed once, and the interleaving that breaks
 * it is by construction the one that did not happen that time. AGENT-RULES §2.3 makes the stated
 * count a FLOOR, and the observed rate is reported rather than the target.
 *
 * `pgrep -af jest` was READ (not counted) and `uptime` quoted in the phase document before each
 * run — rule 20, and Lane B shares this checkout.
 */
const ROUNDS = 8;

describe("lab accession, concurrency (17a T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  /* ─────────────────────────── A1 — TWO BENCHES, ONE TUBE ─────────────────────────── */

  it("A1: two concurrent receives — one wins, the other gets already_received, ONE event per item", async () => {
    const observed: { received: number; started: number; won: number }[] = [];
    /** A different orderable each round keeps the duplicate detector out of the measurement. */
    const CODES = ["CBC", "LFT", "RFT", "LIPID", "TSH", "GLUF", "UPT", "HBSAG"] as const;

    for (const code of CODES) {
      const placed = await deskAndLabel(db, fx, [code]);
      const specimenNo = placed.specimens[0]!.specimenNo;
      const before = {
        received: (await db.select().from(events).where(eq(events.name, "lab.specimen_received"))).length,
        started: (await db.select().from(events).where(eq(events.name, "order_item.started"))).length,
      };

      const settled = await Promise.allSettled([
        withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo })),
        withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo })),
      ]);

      observed.push({
        received: (await db.select().from(events).where(eq(events.name, "lab.specimen_received"))).length - before.received,
        started: (await db.select().from(events).where(eq(events.name, "order_item.started"))).length - before.started,
        won: settled.filter((s) => s.status === "fulfilled").length,
      });

      /**
       * The loser's refusal is `already_received` whichever way the race went — the pre-CAS status
       * read catches it when the winner has committed, and the CAS itself catches it when it has
       * not. Both paths are the same sentence to the bench, which is the point.
       */
      const loser = settled.find((s) => s.status === "rejected");
      if (loser && loser.status === "rejected") {
        /**
         * ═══ THIS IS THE LEG `receive`'s OWN CAS OWNS, AND IT TOOK THREE MUTANTS TO FIND OUT ═══
         *
         * The "exactly one winner" property survives removing this CAS, the envelope's item CAS AND
         * the workflow engine's — `isLegalItemTransition` plus Postgres row locking still hold it
         * (finding F21). What does NOT survive is the SENTENCE: without this CAS the loser reads
         * `stale_state` or `stale_transition`, which is an error about a state machine a bench has
         * never heard of, on the busiest surface in the laboratory.
         */
        expect((loser.reason as { code?: string }).code).toBe("already_received");
      }
    }

    /** ONE received event and ONE started event per round, and exactly ONE winner. */
    expect(observed.map((o) => o.received)).toEqual(Array(ROUNDS).fill(1));
    expect(observed.map((o) => o.started)).toEqual(Array(ROUNDS).fill(1));
    expect(observed.map((o) => o.won)).toEqual(Array(ROUNDS).fill(1));
  }, 300_000);

  /* ───────────── A2 — `S` NUMBERS ARE UNIQUE ACROSS CONCURRENT PRINTS ───────────── */

  it("A2: concurrent label prints on the same day mint DISTINCT S numbers, over 8 rounds", async () => {
    const uhid = await uhidOf(db, fx.patientId);
    /**
     * Two DIFFERENT order groups printed at once — the real shape of the race, since two prints of
     * the SAME group are refused by `lab_specimen_items_active_ux` rather than by the counter.
     * Phase 0 measured this row lock over 12 rounds directly; this row measures it through the
     * lab's own caller, which is the only thing 17a adds to it.
     */
    const pairs = NON_OVERLAPPING_PAIRS;
    const allNumbers: string[] = [];
    const perRound: number[] = [];

    for (const [left, right] of pairs) {
      const groups = await Promise.all([left, right].map((code) =>
        withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
          patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
          orderingClinicianId: fx.pathologist.id, credit: { reason: "counter" },
          items: [{ serviceId: serviceIdForLabCode(code) }],
          acknowledgedDuplicates: [],
        }))));

      const live = groups;
      /**
       * Every pair is analyte-disjoint from every other, so the duplicate detector has nothing to
       * say and all EIGHT rounds race. An earlier version reused codes and silently observed only
       * four — the `>= ROUNDS - 1` floor below is what caught it, and §2.3's rule is that the count
       * is a FLOOR to keep running toward, never a window to engineer.
       */
      expect(live).toHaveLength(2);

      const printed = await Promise.all(live.map((g) =>
        printLabels(db, fx.bench.actor, {
          orderGroupId: g.orderGroupId, scannedUhid: uhid,
        })));
      const numbers = printed.flatMap((p) => p.specimens.map((s) => s.specimenNo));
      allNumbers.push(...numbers);
      perRound.push(new Set(numbers).size);
      expect(numbers.every((n) => /^S\d{10}$/.test(n))).toBe(true);
    }

    /** OBSERVED, not targeted (§2.3): the rounds that actually raced, and every number distinct. */
    expect(perRound.length).toBeGreaterThanOrEqual(ROUNDS);
    expect(perRound).toEqual(perRound.map(() => 2));
    expect(new Set(allNumbers).size).toBe(allNumbers.length);

    /** And the database agrees — the UNIQUE on `specimen_no` never had to refuse anything. */
    const rows = await db.select().from(labSpecimens);
    expect(new Set(rows.map((r) => r.specimenNo)).size).toBe(rows.length);
  }, 300_000);
});
