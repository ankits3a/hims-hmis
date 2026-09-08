import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { events, labResults } from "../../kernel/db/schema";
import { activateGlucoseReflex, activateTshReflex } from "./verify.test.helpers";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ §9.2 F44 — A RULE THAT FIRES AND SILENTLY DOES NOT ORDER A TEST ═══
 *
 * A reflex is the laboratory acting on its own finding: a fasting glucose over 126 mg/dL adds an
 * HbA1c without waiting for anyone to ask. It is standard diabetic screening in every Indian
 * corporate lab, and it is the one place the laboratory orders a test on a patient's behalf.
 *
 * Close review M1 made the placement rollback-safe, and it was right to: before it, an unpriced
 * reflexed test rolled the VERIFICATION back with it, so *"a tariff row silenced a clinical
 * result"*. The fix put the reflex inside a savepoint — the verify may kill the reflex, the reflex
 * may not kill the verify — and RETURNED the refusal so the screen could show it.
 *
 * **What it could not do was record it**, and `verify.ts` says so in its own comment: `LAB_EVENTS`
 * was frozen for Plan 17, *"the durable record is owed and is recorded as §9.2 F44"*, with the
 * runbook's pilot harvest counting it by hand until some later phase declared `lab.reflex_refused`.
 *
 * So the state this closes is: **the pathologist sees a warning once, and nothing anywhere counts
 * it.** How often a reflex fails to place is exactly how a hospital learns its tariff has a hole in
 * it — and until it does, every glucose over 126 quietly fails to order an HbA1c.
 *
 * ═══ WHY THE FIXTURE IS THE GLUCOSE RULE AND NOT THE THYROID ONE ═══
 *
 * `TSH → TFT` cannot reproduce this: `TFT` is priced by `seedLabDeskBase`. `GLUF → HBA1C` can,
 * because `HBA1C` is deliberately NOT in `PRICED_LAB_CODES` — which is the ordinary go-live gap M1
 * describes in as many words: *"the counter never SELLS an FT4, so nobody notices it is unpriced
 * until a TSH reflexes onto it."* The fixture reproduces the defect's own conditions rather than
 * inventing them.
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("a reflex that fires and cannot place is COUNTED, not just shown (F44)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await activateGlucoseReflex(db);
  });
  afterEach(() => { fx.unregister(); });

  /**
   * **THE KILL.** Against the code this guards the verification succeeds, the refusal is returned,
   * the screen shows it once — and the `events` table has nothing to count.
   */
  it("F44: the refusal is EVENTED, naming the rule, the test it could not add, and why", async () => {
    const run = await runLabOrder(db, fx, ["GLUF"], { at: AT, values: { GLUF: "180" }, reflexConsent: true });

    const [ev] = await db.select().from(events).where(eq(events.name, "lab.reflex_refused"));
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({
      orderItemId: run.itemIds[0]!,
      addedServiceId: "LABSVC-HBA1C",
      /** The CODE, because "how often" is a question about a class of failure, not about prose. */
      code: "tariff_item_missing",
    });
    /** And the reason a human reads, verbatim from the server that refused. */
    expect(String((ev!.payload as { reason: string }).reason)).toMatch(/HBA1C|no price/i);
  });

  /**
   * ═══ THE HALF THAT MUST NOT BREAK — M1's ONE-WAY BOUNDARY ═══
   *
   * *"Money must never hold a clinical fact."* The reflex failing must leave the glucose SIGNED and
   * readable by the treating doctor. If appending the record had been done inside the savepoint it
   * would have rolled back with the placement and this test would still pass — which is why the
   * assertion below is paired with the one above rather than trusted on its own.
   */
  it("F44: the signature stands — a tariff hole does not hold the clinical result", async () => {
    const run = await runLabOrder(db, fx, ["GLUF"], { at: AT, values: { GLUF: "180" }, reflexConsent: true });

    const rows = await db.select().from(labResults)
      .where(eq(labResults.orderItemId, run.itemIds[0]!));
    expect(rows.map((r) => r.verificationStatus)).toEqual(["verified"]);
  });

  /**
   * A reflex that PLACES emits `lab.reflex_added` and must not also emit a refusal. The two events
   * are mutually exclusive by construction and the assertion says so, because a rule that reported
   * both would make the count this exists to produce useless.
   */
  it("F44: a reflex that places emits `reflex_added` and NO refusal", async () => {
    /** `TSH → TFT`, whose target IS priced — the same rule family, the other outcome. */
    await activateTshReflex(db);
    await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "9.9" }, reflexConsent: true });

    const added = await db.select().from(events).where(eq(events.name, "lab.reflex_added"));
    const refused = await db.select().from(events).where(eq(events.name, "lab.reflex_refused"));
    expect([added.length > 0, refused.length]).toEqual([true, 0]);
  });
});
