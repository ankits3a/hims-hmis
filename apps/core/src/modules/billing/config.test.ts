import { withTx } from "../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { updateService } from "../tariff";
import { loadBillingConfig, updateBillingConfig, validateBillingConfig } from "./config";
import type { Db } from "../../kernel/db/client";

describe("config: loadBillingConfig / updateBillingConfig / validateBillingConfig (D-17)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
  });

  test("load hard-fails billing_not_configured on a missing row", async () => {
    await expect(loadBillingConfig(db)).rejects.toMatchObject({ code: "billing_not_configured" });
  });

  test("round-trip: a patch through updateBillingConfig is read back verbatim by loadBillingConfig", async () => {
    await seedBillingBase(db);
    const patched = await withTx(db, (tx) => updateBillingConfig(tx, { cashWarnPaise: 16_000_000, outstandingCapMode: "block" }));
    expect(patched.cashWarnPaise).toBe(16_000_000);
    expect(patched.outstandingCapMode).toBe("block");
    const reloaded = await loadBillingConfig(db);
    expect(reloaded.cashWarnPaise).toBe(16_000_000);
    expect(reloaded.outstandingCapMode).toBe("block");
    expect(reloaded.cashBlockPaise).toBe(20_000_000); // untouched fields survive the partial patch
  });

  test("patch validates through the SAME schemas loadBillingConfig reads through: a bad outstandingCapMode is refused", async () => {
    await seedBillingBase(db);
    await expect(
      withTx(db, (tx) => updateBillingConfig(tx, { outstandingCapMode: "not_a_real_mode" as unknown as "warn" })),
    ).rejects.toThrow();
    const reloaded = await loadBillingConfig(db);
    expect(reloaded.outstandingCapMode).toBe("warn"); // the refused patch never touched the stored row
  });

  test("validateBillingConfig returns ok:true on the seeded config", async () => {
    await seedBillingBase(db);
    const report = await validateBillingConfig(db);
    expect(report).toEqual({ ok: true, errors: [] });
  });

  test("break 1: chargeRules serviceId absent from services -> charge_rule_service_missing, introduced through updateBillingConfig", async () => {
    const fixture = await seedBillingBase(db);
    await withTx(db, (tx) =>
      updateBillingConfig(tx, {
        chargeRules: { opdConsult: { new: "no-such-service-id", renewal: fixture.consultRenewalServiceId } },
      }),
    );
    const report = await validateBillingConfig(db);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "charge_rule_service_missing" }));
  });

  test("break 2: a fee-branch service that is INACTIVE -> charge_rule_service_inactive, introduced through tariff's updateService", async () => {
    const fixture = await seedBillingBase(db);
    await withTx(db, (tx) => updateService(tx, fixture.drafter, fixture.consultRenewalServiceId, { active: false }));
    const report = await validateBillingConfig(db);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "charge_rule_service_inactive" }));
  });

  test("break 3: warn >= block (threshold inversion) -> cash_threshold_inverted, introduced through updateBillingConfig", async () => {
    await seedBillingBase(db);
    await withTx(db, (tx) => updateBillingConfig(tx, { cashWarnPaise: 20_000_000, cashBlockPaise: 20_000_000 }));
    const report = await validateBillingConfig(db);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "cash_threshold_inverted" }));
  });

  test("break 4: seriesPrefixes missing a key -> series_prefix_missing, introduced through updateBillingConfig", async () => {
    await seedBillingBase(db);
    await withTx(db, (tx) => updateBillingConfig(tx, { seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN" } }));
    const report = await validateBillingConfig(db);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "series_prefix_missing", detail: expect.stringContaining("voucher") }));
  });
});
