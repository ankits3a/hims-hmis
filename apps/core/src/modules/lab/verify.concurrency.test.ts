import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { events, labResults } from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import { deskOrder } from "./desk";
import { duplicateWarnings } from "./duplicates";
import { LabError } from "./errors";
import { enterResult } from "./results";
import { printLabels } from "./specimens";
import { verifyResult } from "./verify";
import { labAnalytes } from "../../kernel/db/schema";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T6 — **A2, THE TWO-VERIFIER RACE**, measured over ≥ 8 rounds.
 *
 * It is in its own file for the reason 17a's `accession.concurrency.test.ts` gives: a race asserted
 * once has been observed once, and the interleaving that breaks it is by construction the one that
 * did not happen that time. AGENT-RULES §2.3 makes the stated count a FLOOR and the OBSERVED rate
 * is what gets reported.
 *
 * ═══ WHAT A LOST RACE WOULD COST, WHICH IS WHY THIS IS A CRITICAL ROW ═══
 *
 * Read-then-write lets both verifiers past the status check, and then BOTH place the reflex order
 * and BOTH bill the patient for it — two invoices for one clinical decision, on a path where the
 * second half is an analyser actually running the added test. The CAS is transcribed from
 * `workflow/instances.ts:136-157` and the loser reports rather than re-reading and overwriting.
 *
 * ═══ THE EXPLICIT TIMEOUT, AND THE MEASURED IDLE COST (ledger §2.144) ═══
 *
 * Eight rounds of (desk → label → draw → receive → enter → two concurrent verifies) is the most
 * expensive single row in this phase. **Measured on an idle box (load average 1.55): 4 835 ms**,
 * which is 32% of the 15 000 ms default — and §2.144 is the ledger entry about two lanes spending
 * six full verifies calling the instrument broken because ONE test sat at 72% of that default. The
 * explicit 180 s is deliberate headroom on a loaded CI box, not a measurement.
 */
const ROUNDS = 8;

describe("lab verification, concurrency (17b T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  it("A2: two concurrent verifies — ONE lab.result_verified, the loser already_verified", async () => {
    /**
     * Eight single-analyte orderables the fixture PRICES, each reporting one analyte whose code is
     * the orderable's own — and each with a value inside its own absurd envelope, which the first
     * run of this row proved is enforced (a GLUF of 2.0 was refused: the envelope is 5 … 1500).
     *
     * **17d T1 swapped `UPT` for `ESR`.** The fixture patient is male and the catalogue now declares
     * the urine pregnancy test female-only, so a UPT round would be refused `analyte_not_applicable`
     * before any verify raced anything — the applicability rule working, and A2 measuring nothing.
     * `ESR` is the remaining priced orderable that shares no analyte with the other seven, which is
     * the property this round needs (the duplicate detector refuses an overlapping re-order).
     * `PSA` STAYS: male-only against a male patient is applicable, and the round proves it.
     */
    const ROUND: readonly (readonly [string, string])[] = [
      ["TSH", "2.0"], ["GLUF", "90"], ["ESR", "12"], ["HBSAG", "Non-reactive"],
      ["HCV", "Non-reactive"], ["VDRL", "Non-reactive"], ["PSA", "1.2"], ["VITD", "30"],
    ];
    const analytes = new Map(
      (await db.select({ code: labAnalytes.code, id: labAnalytes.id }).from(labAnalytes))
        .map((r) => [r.code, r.id] as const),
    );
    /**
     * ═══ THE REFUSAL IS RECORDED, NOT COUNTED ═══
     *
     * This held `losers: number` — a count of rejections whose reason WAS `already_verified`. A
     * rejection for any other reason did not fail loudly; it silently decremented that count and
     * threw the reason away. So when this suite failed on #90 (a docs-only PR) with
     * `{winners: 1, losers: 0, events: 1}`, the log recorded that one fewer thing was
     * `already_verified` and **nothing anywhere recorded what it actually was** — and would not have
     * recorded it next time either.
     *
     * Keeping the REASONS is the same instinct as reporting the whole per-round array below rather
     * than a total, one level deeper: the round was already visible in the failure output, and the
     * reason was not. A count can only ever say "one fewer than expected"; a list says what arrived.
     */
    const observed: { winners: number; refusals: string[]; events: number }[] = [];

    for (const [code, value] of ROUND) {
      const at = new Date("2026-08-30T06:00:00Z");
      const serviceIds = [serviceIdForLabCode(code)];
      const warnings = await withTx(db, (tx) =>
        duplicateWarnings(tx, fx.desk.actor, fx.patientId, serviceIds, at));
      const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: serviceIds.map((serviceId) => ({ serviceId })),
        credit: { reason: "counter order" },
        acknowledgedDuplicates: warnings.map((w) => w.duplicateOfItemId),
        placedAt: at,
      }, at));
      const { specimens } = await printLabels(db, fx.bench.actor, {
        orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
      }, at);
      for (const s of specimens) {
        await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }, at));
        await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, at));
      }
      const entered = await enterResult(db, fx.bench.actor, {
        orderItemId: placed.itemIds[0]!, analyteId: analytes.get(code)!, value, entryMode: "manual",
      }, at);

      const before = (await db.select().from(events).where(eq(events.name, "lab.result_verified"))).length;

      const settled = await Promise.allSettled([
        verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, at),
        verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId }, at),
      ]);
      const winners = settled.filter((s) => s.status === "fulfilled").length;
      /**
       * A `LabError` reports its CODE; anything else reports its type and message, truncated. The
       * second branch is the one that matters — a `pg` serialization failure (40001) or a deadlock
       * (40P01) surfacing instead of the domain error is a candidate nobody could confirm precisely
       * because the old classifier discarded it.
       */
      const refusals = settled
        .filter((s): s is PromiseRejectedResult => s.status === "rejected")
        .map((s) => {
          const r: unknown = s.reason;
          if (r instanceof LabError) return r.code;
          const name = r instanceof Error ? r.constructor.name : typeof r;
          const msg = r instanceof Error ? r.message : String(r);
          return `${name}: ${msg.slice(0, 120)}`;
        });
      const after = (await db.select().from(events).where(eq(events.name, "lab.result_verified"))).length;
      observed.push({ winners, refusals, events: after - before });

      /** And the row itself carries ONE verifier and ONE instant, whoever won. */
      const [row] = await db.select().from(labResults).where(eq(labResults.id, entered.resultId));
      expect([row!.verificationStatus, row!.verifiedBy]).toEqual(["verified", fx.pathologist.id]);
    }

    expect(observed).toHaveLength(ROUNDS);
    /**
     * EVERY round is 1 winner / 1 loser / 1 event. Reported as the whole array rather than as a
     * count, so a run where the race did not open is VISIBLE in the failure output instead of being
     * averaged away — §2.3's "report the observed rate, never engineer the window".
     */
    expect(observed).toEqual(
      Array.from({ length: ROUNDS }, () => ({ winners: 1, refusals: ["already_verified"], events: 1 })),
    );
  }, 180_000);
});
