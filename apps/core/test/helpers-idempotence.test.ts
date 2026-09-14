import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedOpdBase } from "./helpers/opd";
import { opdConfig } from "../src/kernel/db/schema";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ A FIXTURE HELPER THAT INSERTS A FIXED-ID ROW MUST BE RE-ENTRANT ═══
 *
 * `seedOpdBase` writes `registration_config` and `opd_config`, both keyed `'main'`. The first was
 * guarded and the second was not, so a second call against the same database died on
 * `duplicate key value violates unique constraint "opd_config_pkey"` — **two adjacent statements
 * that had to agree about re-entrancy, one carrying the guard and one not.**
 *
 * ═══ THE GUARD HAD TO BE `DoUpdate`, AND THAT IS THE WHOLE POINT OF THE SECOND CASE ═══
 *
 * `onConflictDoNothing` — what `registration_config` correctly uses — would have been the wrong
 * repair here, and wrong in the dangerous direction. **`seedOpdBase` takes OVERRIDES**
 * (`perkEveryNth`, `slotMinutes`, `extensionCap`, `maxSkips`), so DoNothing makes a second call
 * silently keep the FIRST config: a test asking for `perkEveryNth: 5` would run against the default
 * `null` **and pass**, which is a green failure and strictly worse than the duplicate key it
 * replaced. `registration_config`'s DoNothing is right precisely because it takes no overrides — the
 * distinction is whether the row is parameterised, not whether the insert repeats.
 *
 * So the second case below is the load-bearing one: it is what separates DoUpdate from DoNothing,
 * and a suite carrying only the first would go green against the wrong fix.
 *
 * Measured 2026-09-14: `opd_config` is the ONLY fixed-id insert under `test/helpers/` lacking a
 * guard. `billing.ts:135`'s `billing_config` already carries DoNothing and takes no overrides, so it
 * is correct as it stands. An earlier sweep reported it unguarded — a false positive from reading a
 * fixed 600-character window of a 677-character statement, which is a lesson about the search and
 * not about the code.
 */
describe("test fixture helpers are re-entrant", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  /**
   * **THE ORIGINAL FAILURE.** Any file that seeds twice — or seeds without truncating after another
   * file left `opd_config` standing — hit this, and it presents as an order-dependent flake rather
   * than an honest error.
   */
  it("seedOpdBase can be called twice against one database", async () => {
    await seedOpdBase(db);
    await expect(seedOpdBase(db)).resolves.toBeUndefined();
    expect(await db.select().from(opdConfig).where(eq(opdConfig.id, "main"))).toHaveLength(1);
  });

  /**
   * **THE ASSERTION THAT REFUSES THE WRONG FIX.** Against `onConflictDoNothing` this reads
   * `perkEveryNth: null` — the first call's value — and the caller's override is silently discarded
   * while the suite stays green. A re-entrant helper must be re-entrant with the caller's INTENT,
   * not merely with the caller's row.
   */
  it("a second call APPLIES its overrides rather than silently keeping the first config", async () => {
    await seedOpdBase(db);
    await seedOpdBase(db, { perkEveryNth: 5, slotMinutes: 20, extensionCap: 7, maxSkips: 2 });

    const [cfg] = await db.select().from(opdConfig).where(eq(opdConfig.id, "main"));
    expect({
      perkEveryNth: cfg!.perkEveryNth,
      slotMinutes: cfg!.slotMinutes,
      extensionCapPerDoctorPerMonth: cfg!.extensionCapPerDoctorPerMonth,
      maxSkipsBeforeLeft: cfg!.maxSkipsBeforeLeft,
    }).toEqual({
      perkEveryNth: 5,
      slotMinutes: 20,
      extensionCapPerDoctorPerMonth: 7,
      maxSkipsBeforeLeft: 2,
    });
  });

  /** And the first call still writes what it says, so the update path has not eaten the insert path. */
  it("a single call still writes the defaults it declares", async () => {
    await seedOpdBase(db);
    const [cfg] = await db.select().from(opdConfig).where(eq(opdConfig.id, "main"));
    expect({ slotMinutes: cfg!.slotMinutes, perkEveryNth: cfg!.perkEveryNth }).toEqual({
      slotMinutes: 10, perkEveryNth: null,
    });
  });
});
