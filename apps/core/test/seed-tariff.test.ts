import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedTariffConfig } from "../scripts/seed-tariff";
import { registerTariffApprovalTypes, TARIFF_APPROVAL_TYPES } from "../src/modules/tariff/approval-types";
import { listGstCategories, upsertGstCategory } from "../src/modules/tariff/gst-config";
import { listAdjustmentRules, upsertAdjustmentRule } from "../src/modules/tariff/rules";
import { getApprovalType } from "../src/kernel/approvals/types";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { withTx } from "../src/kernel/db/client";
import { gstSettings, roles } from "../src/kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11g / T-D2, Book row R1 — A DEPLOY MUST NEVER BE ABLE TO OVERWRITE A CORRECTED MONEY OR
 * TAX VALUE.
 *
 * `deploy.sh` runs `seed:tariff` on every deploy now. Before this task the script wrote every row
 * through `upsertGstSettings` / `upsertGstCategory` / `upsertAdjustmentRule`, all three
 * `onConflictDoUpdate` — idempotent BY VALUE, which is a different property from non-destructive.
 * The discriminating input is a CORRECTED row: seed, change a rate, seed again. The old behaviour
 * restores the DEV PLACEHOLDER; the shipped behaviour leaves the correction alone.
 *
 * The second half is report D7's gap 2: `submitVersion` gates on the `tariff_revision` approval
 * type and NO seed registered it, so a tariff could be drafted on a real deployment and never
 * submitted. Four test fixtures registered it inline; production had to be fixed by hand.
 */
const ACTIVATOR: Actor = { type: "user", id: "seed-tariff" };

describe("seed:tariff (Plan 11g / DD2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("a FIRST run on an empty database seeds settings, all five categories and all four caps", async () => {
    const report = await seedTariffConfig(db);

    expect(report.settings).toBe("seeded");
    expect(report.categoriesSeeded.sort()).toEqual(
      ["consultation", "device", "pharmacy", "procedure", "room_rent"],
    );
    expect(report.categoriesLeft).toEqual([]);
    expect(report.capsSeeded.sort()).toEqual(
      ["CAP-CHARITY", "CAP-EMPLOYEE", "CAP-NEGOTIATED-CORPORATE", "CAP-SCHEME"],
    );

    // The CONTROL for R1: the row cannot pass by writing nothing.
    expect(await db.select().from(gstSettings).where(eq(gstSettings.id, "main"))).toHaveLength(1);
    expect(await listGstCategories(db)).toHaveLength(5);
    expect(await listAdjustmentRules(db)).toHaveLength(4);
  });

  it("R1 — a SECOND run over a CORRECTED gst_config row leaves the correction alone", async () => {
    await seedTariffConfig(db);

    // The CA corrects one rate through the module's own upsert — which keeps its set semantics on
    // purpose: that is how a value is deliberately changed.
    await withTx(db, (tx) =>
      upsertGstCategory(tx, { type: "user", id: "the-ca" }, {
        category: "consultation", sacCode: "999312", exempt: false, rateBps: 500,
        specialRule: null, thresholdPaise: null,
      }),
    );

    const report = await seedTariffConfig(db);

    expect(report.settings).toBe("left untouched");
    expect(report.categoriesSeeded).toEqual([]);
    expect(report.categoriesLeft.sort()).toEqual(
      ["consultation", "device", "pharmacy", "procedure", "room_rent"],
    );
    expect(report.capsSeeded).toEqual([]);

    const consultation = (await listGstCategories(db)).find((c) => c.category === "consultation");
    // The DEV PLACEHOLDER is 1800bps/exempt:true. Anything that restored it failed this row.
    expect(consultation?.rateBps).toBe(500);
    expect(consultation?.exempt).toBe(false);
    // …and nothing was duplicated on the way.
    expect(await listGstCategories(db)).toHaveLength(5);
  });

  it("R1 — a SECOND run over a CORRECTED discount cap leaves the correction alone", async () => {
    await seedTariffConfig(db);
    const before = (await listAdjustmentRules(db)).find((r) => r.ruleKey === "CAP-CHARITY");
    expect((before?.params as { maxBps: number }).maxBps).toBe(2500); // the DEV PLACEHOLDER

    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, { type: "user", id: "the-ca" }, {
        ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity discount cap",
        params: { discountCategory: "charity", maxBps: 800, approvalAboveBps: 400 },
      }),
    );

    await seedTariffConfig(db);

    const after = (await listAdjustmentRules(db)).find((r) => r.ruleKey === "CAP-CHARITY");
    expect((after?.params as { maxBps: number }).maxBps).toBe(800);
    expect(await listAdjustmentRules(db)).toHaveLength(4);
  });

  it("D7 gap 2 — registers tariff_revision, and a second call is a no-op rather than a duplicate_type throw", async () => {
    await db.insert(roles).values({ key: "owner", title: "owner" }).onConflictDoNothing();
    await seedSodPairs(db);

    expect(await withTx(db, (tx) => getApprovalType(tx, "tariff_revision"))).toBeNull();

    await registerTariffApprovalTypes(db, ACTIVATOR);
    const row = await withTx(db, (tx) => getApprovalType(tx, "tariff_revision"));
    expect(row).not.toBeNull();
    expect(row?.approverRole).toBe("owner");
    expect(row?.defKey).toBe("approval_tariff_revision");

    // Idempotent: the deploy path runs this on every deploy for ever.
    await expect(registerTariffApprovalTypes(db, ACTIVATOR)).resolves.toBeUndefined();
    expect(await withTx(db, (tx) => getApprovalType(tx, "tariff_revision"))).not.toBeNull();
  });

  it("the spec matches the one four shipped fixtures already register by hand", () => {
    // NOT a restatement of the source: `test/helpers/billing.ts`, `tariff.e2e.test.ts`,
    // `tariff-lifecycle.e2e.test.ts` and `context.test.ts` all register this exact shape inline,
    // and this task's whole claim is that the seed now does what they do.
    expect(TARIFF_APPROVAL_TYPES).toHaveLength(1);
    expect(TARIFF_APPROVAL_TYPES[0]).toEqual({
      typeKey: "tariff_revision", title: "Tariff Revision", approverRole: "owner",
      urgencyClass: "routine", actFirstAllowed: false, closureSlaMinutes: 1440,
    });
  });
});
