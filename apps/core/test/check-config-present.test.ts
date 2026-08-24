import { setupTestDb, truncateAll } from "./helpers/db";
import { checkConfigPresent } from "../scripts/check-config-present";
import { seedTariffConfig } from "../scripts/seed-tariff";
import { registerTariffApprovalTypes } from "../src/modules/tariff/approval-types";
import { registerBillingApprovalTypes } from "../src/modules/billing/approval-types";
import { createService } from "../src/modules/tariff/services";
import { getGstSettings } from "../src/modules/tariff/gst-config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { runConfigValidation } from "../src/kernel/ops/validate";
import { withTx } from "../src/kernel/db/client";
import { billingConfig, roles, tariffVersions } from "../src/kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11g / T-D2, Book row R2 — THE DEPLOY GATE.
 *
 * The 2026-08-24 synthetic smoke test found production deployed with `billing_config` EMPTY. Every
 * invoice threw `billing_not_configured`, the nightly close had been failing for a day, and a
 * doctor could not start a consultation — and the deploy had reported healthy, because nothing in
 * it ever asked. This gate asks, positively, through the modules' own loaders.
 *
 * THE THIRD LEG IS THE ONE THAT KEEPS IT USABLE, and it is asserted rather than trusted: the gate
 * must NOT demand CA sign-off or an ACTIVE TARIFF VERSION. `validate:config` demands both — it is
 * the go-live gate — and both are correctly false in production today, so a deploy gate wired to
 * that verdict would refuse every deploy between now and the CA's signature.
 */
const ACTOR: Actor = { type: "user", id: "seed-test" };

async function seedEverything(db: Db): Promise<void> {
  await db.insert(roles).values({ key: "owner", title: "owner" }).onConflictDoNothing();
  await db.insert(roles).values({ key: "billing_manager", title: "Billing Manager" }).onConflictDoNothing();
  await seedSodPairs(db);
  const consultNew = await withTx(db, (tx) =>
    createService(tx, { type: "system", id: "seed" }, { code: "OPD-CONSULT-NEW", name: "New", category: "consultation" }),
  );
  const consultRenewal = await withTx(db, (tx) =>
    createService(tx, { type: "system", id: "seed" }, { code: "OPD-CONSULT-RENEWAL", name: "Renewal", category: "consultation" }),
  );
  await db.insert(billingConfig).values({
    id: "main",
    cashWarnPaise: 15_000_000, cashBlockPaise: 20_000_000, panThresholdPaise: 5_000_000,
    refundBankAbovePaise: 1_000_000, creditCapPaise: 500_000, outstandingCapPaise: 2_000_000,
    outstandingCapMode: "warn", feeBps: { upi: 0, card: 150 }, reconTolerancePaise: 100,
    seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN", voucher: "RFV" },
    chargeRules: { opdConsult: { new: consultNew.serviceId, renewal: consultRenewal.serviceId } },
    degradedTender: false, caSigned: false, updatedAt: new Date(),
  }).onConflictDoNothing();
  await registerBillingApprovalTypes(db, ACTOR);
  await seedTariffConfig(db);
  await registerTariffApprovalTypes(db, ACTOR);
}

describe("check:config-present (Plan 11g / DD2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("R2 — refuses an EMPTY database and NAMES every missing row", async () => {
    const { ok, problems } = await checkConfigPresent(db);

    expect(ok).toBe(false);
    const codes = problems.map((p) => p.code);
    expect(codes).toContain("billing_config_missing");
    expect(codes).toContain("gst_settings_missing");
    expect(codes).toContain("gst_config_empty");
    // Five billing types + tariff_revision, every one unregistered on an empty database.
    expect(codes.filter((c) => c === "approval_type_unregistered")).toHaveLength(6);

    // The refusal carries the ENGINE'S OWN error text, seed command included — that is the point
    // of reading through `loadBillingConfig` rather than a SELECT of this script's own.
    const billing = problems.find((p) => p.code === "billing_config_missing");
    expect(billing?.detail).toContain("seed:billing");
  });

  it("R2 CONTROL — admits a fully seeded database, so the row cannot pass by refusing everything", async () => {
    await seedEverything(db);

    const { ok, problems } = await checkConfigPresent(db);
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it("does NOT demand CA sign-off or an active tariff version — the two `validate:config` demands", async () => {
    await seedEverything(db);

    // Production's exact state: nothing signed, no tariff version activated at all.
    expect((await getGstSettings(db)).caSigned).toBe(false);
    expect(await db.select().from(tariffVersions)).toHaveLength(0);

    // `validate:config` is RED in this state, by design. This gate must be GREEN in it, or every
    // deploy between now and the CA's signature would refuse.
    const goLive = await runConfigValidation(db);
    expect(goLive.ok).toBe(false);

    expect((await checkConfigPresent(db)).ok).toBe(true);
  });

  it("catches the single-row deletion the seeds cannot see — a hand-deleted billing_config", async () => {
    await seedEverything(db);
    expect((await checkConfigPresent(db)).ok).toBe(true);

    // The failure class the seeds alone do not cover: no seed failed, and the hospital cannot
    // issue an invoice. A restore from a pre-configuration backup has the same shape.
    await db.delete(billingConfig);

    const { ok, problems } = await checkConfigPresent(db);
    expect(ok).toBe(false);
    expect(problems.map((p) => p.code)).toEqual(["billing_config_missing"]);
  });
});
