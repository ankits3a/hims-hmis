import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { adjustmentRules as adjustmentRulesTable } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { registerApprovalType } from "../../kernel/approvals/types";
import { approveRequest } from "../../kernel/approvals/decisions";
import { activateDefinition, createDraft } from "../../kernel/workflow/definitions";
import { appendRegulatedPrice, createService } from "./services";
import {
  TARIFF_REVISION_APPROVAL_TYPE, activateVersion, createDraftVersion, setTariffItem, submitVersion,
} from "./versions";
import { upsertGstCategory, upsertGstSettings } from "./gst-config";
import { upsertAdjustmentRule } from "./rules";
import { manualDiscountSource, standingRuleSource } from "./contest";
import { loadPricingContext, validateTariffConfig } from "./context";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

describe("context (D5 lock, D7 config gate): loadPricingContext + validateTariffConfig", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let drafter: Actor;
  let activator: Actor;
  let owner: Actor;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);

    // Exactly the merge.test.ts / versions.test.ts precedent: builder -> draft -> activate ->
    // registerApprovalType, so a draft version can be carried all the way to `activated`.
    const drafterUser = await createUser(db, { username: "drafter", fullName: "Drafter", password: "p1234567" });
    const activatorUser = await createUser(db, { username: "activator", fullName: "Activator", password: "p1234567" });
    const ownerUser = await createUser(db, { username: "owner_user", fullName: "Owner", password: "p1234567" });
    drafter = { type: "user", id: drafterUser.id };
    activator = { type: "user", id: activatorUser.id };
    owner = { type: "user", id: ownerUser.id };

    await createRole(db, "owner", "Owner");
    await assignRole(db, { userId: ownerUser.id, roleKey: "owner", scopeType: "hospital" });

    const def = approvalFlowDefinition({
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      closureSlaMinutes: 1440,
    });
    const draftDef = await createDraft(db, drafter, def);
    await activateDefinition(db, activator, draftDef.definitionId);
    await registerApprovalType(db, activator, {
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      urgencyClass: "routine",
      actFirstAllowed: false,
    });
  });

  async function activateFullVersion(
    prices: [string, number][],
    effectiveFrom: Date,
  ): Promise<{ versionId: string; versionNo: number }> {
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, drafter, {});
      for (const [serviceId, price] of prices) await setTariffItem(tx, drafter, d.versionId, serviceId, price);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });
    await activateVersion(db, activator, draft.versionId, effectiveFrom);
    return draft;
  }

  // Reproduces the four-breaks test's seeding block verbatim: two services (one regulated + its
  // price row), both GST categories, settings, R-EMP10, all four caps, then activateFullVersion
  // at 2026-02-01. The existing four-breaks test keeps its own inline copy, untouched.
  async function seedFullValidConfig(): Promise<void> {
    const svcCons = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-CONS", name: "Consultation", category: "consultation" }),
    );
    const svcDrug = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-DRUG", name: "Drug A", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, drafter, {
        serviceId: svcDrug.serviceId, mrpPaise: 10000, ceilingPaise: 15000, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "R-EMP10",
        sourceKey: "rule",
        title: "Employee discount",
        params: { kind: "percent_bps", value: 1000, discountCategory: "employee", requiredTag: "employee" },
      }),
    );
    const caps: [string, "charity" | "scheme" | "negotiated_corporate" | "employee", number, number | null][] = [
      ["CAP-CHARITY", "charity", 2500, 1000],
      ["CAP-EMPLOYEE", "employee", 1000, null],
      ["CAP-SCHEME", "scheme", 1500, 1000],
      ["CAP-CORP", "negotiated_corporate", 2000, 1500],
    ];
    for (const [ruleKey, category, maxBps, approvalAboveBps] of caps) {
      await withTx(db, (tx) =>
        upsertAdjustmentRule(tx, drafter, {
          ruleKey,
          sourceKey: "manual",
          title: ruleKey,
          params: { discountCategory: category, maxBps, approvalAboveBps },
        }),
      );
    }

    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    await activateFullVersion(
      [
        [svcCons.serviceId, 50000],
        [svcDrug.serviceId, 12000],
      ],
      effectiveFrom,
    );
  }

  test("full load happy path: every field of the loaded context deep-equals the expectation", async () => {
    const svc1 = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-CONS", name: "Consultation", category: "consultation" }),
    );
    const svc2 = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-DRUG", name: "Drug A", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, drafter, {
        serviceId: svc2.serviceId,
        mrpPaise: 10000,
        ceilingPaise: 15000,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "R-EMP10",
        sourceKey: "rule",
        title: "Employee discount",
        params: { kind: "percent_bps", value: 1000, discountCategory: "employee", requiredTag: "employee" },
      }),
    );
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "CAP-EMPLOYEE",
        sourceKey: "manual",
        title: "Employee cap",
        params: { discountCategory: "employee", maxBps: 1000, approvalAboveBps: null },
      }),
    );

    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    const version = await activateFullVersion(
      [
        [svc1.serviceId, 50000],
        [svc2.serviceId, 12000],
      ],
      effectiveFrom,
    );

    const at = new Date("2026-03-01T00:00:00Z");
    const ctx = await loadPricingContext(db, { at });

    expect(ctx.asOf).toEqual(at);
    expect(ctx.tariff).toEqual({
      versionId: version.versionId,
      versionNo: version.versionNo,
      items: { [svc1.serviceId]: 50000, [svc2.serviceId]: 12000 },
    });
    expect(ctx.services[svc1.serviceId]).toEqual({
      id: svc1.serviceId, code: "SVC-CONS", name: "Consultation", category: "consultation", regulated: false, active: true,
    });
    expect(ctx.services[svc2.serviceId]).toEqual({
      id: svc2.serviceId, code: "SVC-DRUG", name: "Drug A", category: "pharmacy", regulated: true, active: true,
    });
    expect(ctx.regulatedPrices).toEqual({ [svc2.serviceId]: { mrpPaise: 10000, ceilingPaise: 15000 } });
    expect(ctx.gst.categories.consultation).toEqual({
      category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
    });
    expect(ctx.gst.categories.pharmacy).toEqual({
      category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
    });
    expect(ctx.gst.settings).toEqual({ compositeHealthcareExempt: true, caSigned: false });
    expect(ctx.rules).toEqual([
      {
        ruleKey: "R-EMP10", title: "Employee discount", kind: "percent_bps", value: 1000,
        discountCategory: "employee", requiredTag: "employee", serviceCategory: null, serviceId: null,
      },
    ]);
    expect(ctx.manualCaps).toEqual({ employee: { maxBps: 1000, approvalAboveBps: null } });
    expect(ctx.sources.map((s) => s.key)).toEqual(["rule", "manual"]);
    expect(ctx.sources[0]).toBe(standingRuleSource);
    expect(ctx.sources[1]).toBe(manualDiscountSource);
    expect(ctx.tags).toEqual([]);
  });

  test("the lock: an explicit tariffVersionId for an OLDER activated version wins over what `at` would resolve", async () => {
    const svc = await withTx(db, (tx) => createService(tx, drafter, { code: "SVC-1", name: "Consultation", category: "consultation" }));
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));

    const v1 = await activateFullVersion([[svc.serviceId, 10000]], new Date("2026-02-01T00:00:00Z"));
    const v2 = await activateFullVersion([[svc.serviceId, 12000]], new Date("2026-03-01T00:00:00Z"));

    const at = new Date("2026-04-01T00:00:00Z"); // `at` alone resolves v2
    const naturallyResolved = await loadPricingContext(db, { at });
    expect(naturallyResolved.tariff.versionId).toBe(v2.versionId);

    const locked = await loadPricingContext(db, { at, tariffVersionId: v1.versionId });
    expect(locked.tariff.versionId).toBe(v1.versionId);
    expect(locked.tariff.items[svc.serviceId]).toBe(10000);
  });

  test("version_not_active for a draft tariffVersionId without allowDraft; loads with allowDraft: true", async () => {
    const svc = await withTx(db, (tx) => createService(tx, drafter, { code: "SVC-1", name: "Consultation", category: "consultation" }));
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));

    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, drafter, {});
      await setTariffItem(tx, drafter, d.versionId, svc.serviceId, 15000);
      return d;
    });

    await expect(
      loadPricingContext(db, { at: new Date("2026-03-01T00:00:00Z"), tariffVersionId: draft.versionId }),
    ).rejects.toMatchObject({ code: "version_not_active" });

    const ctx = await loadPricingContext(db, {
      at: new Date("2026-03-01T00:00:00Z"),
      tariffVersionId: draft.versionId,
      allowDraft: true,
    });
    expect(ctx.tariff.versionId).toBe(draft.versionId);
    expect(ctx.tariff.items[svc.serviceId]).toBe(15000);
  });

  test("unknown_version for a nonexistent tariffVersionId", async () => {
    await expect(
      loadPricingContext(db, { at: new Date("2026-03-01T00:00:00Z"), tariffVersionId: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "unknown_version" });
  });

  test("regulated resolution is as-of-date faithful: a row effective Mar-1 is invisible at Feb-1", async () => {
    const svc = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-DRUG", name: "Drug A", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, drafter, {
        serviceId: svc.serviceId, mrpPaise: 10000, ceilingPaise: null, effectiveFrom: new Date("2026-03-01T00:00:00Z"),
      }),
    );

    await activateFullVersion([[svc.serviceId, 12000]], new Date("2026-01-01T00:00:00Z"));

    const beforeCtx = await loadPricingContext(db, { at: new Date("2026-02-01T00:00:00Z") });
    expect(beforeCtx.regulatedPrices[svc.serviceId]).toBeUndefined();

    const afterCtx = await loadPricingContext(db, { at: new Date("2026-03-15T00:00:00Z") });
    expect(afterCtx.regulatedPrices[svc.serviceId]).toEqual({ mrpPaise: 10000, ceilingPaise: null });
  });

  test("validateTariffConfig: fully-seeded config is ok; breaking it four ways accumulates named errors and never throws", async () => {
    const svcCons = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-CONS", name: "Consultation", category: "consultation" }),
    );
    const svcDrug = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-DRUG", name: "Drug A", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, drafter, {
        serviceId: svcDrug.serviceId, mrpPaise: 10000, ceilingPaise: 15000, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "R-EMP10",
        sourceKey: "rule",
        title: "Employee discount",
        params: { kind: "percent_bps", value: 1000, discountCategory: "employee", requiredTag: "employee" },
      }),
    );
    const caps: [string, "charity" | "scheme" | "negotiated_corporate" | "employee", number, number | null][] = [
      ["CAP-CHARITY", "charity", 2500, 1000],
      ["CAP-EMPLOYEE", "employee", 1000, null],
      ["CAP-SCHEME", "scheme", 1500, 1000],
      ["CAP-CORP", "negotiated_corporate", 2000, 1500],
    ];
    for (const [ruleKey, category, maxBps, approvalAboveBps] of caps) {
      await withTx(db, (tx) =>
        upsertAdjustmentRule(tx, drafter, {
          ruleKey,
          sourceKey: "manual",
          title: ruleKey,
          params: { discountCategory: category, maxBps, approvalAboveBps },
        }),
      );
    }

    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    await activateFullVersion(
      [
        [svcCons.serviceId, 50000],
        [svcDrug.serviceId, 12000],
      ],
      effectiveFrom,
    );

    const at = new Date("2026-03-01T00:00:00Z");
    const happy = await validateTariffConfig(db, at);
    expect(happy).toEqual({ ok: true, errors: [], caSigned: false });

    // Break 1: an active service with no price in the resolved version.
    await withTx(db, (tx) => createService(tx, drafter, { code: "SVC-UNPRICED", name: "Unpriced", category: "consultation" }));
    const break1 = await validateTariffConfig(db, at);
    expect(break1.ok).toBe(false);
    expect(break1.errors.some((e) => e.code === "tariff_item_missing" && e.detail.startsWith('active service "SVC-UNPRICED"'))).toBe(true);

    // Break 2: an active service whose category has no gst_config row.
    await withTx(db, (tx) => createService(tx, drafter, { code: "SVC-NOCONFIG", name: "No GST Config", category: "device" }));
    const break2 = await validateTariffConfig(db, at);
    expect(break2.ok).toBe(false);
    expect(break2.errors.some((e) => e.code === "gst_config_missing")).toBe(true);

    // Break 3: an active regulated service with no effective regulated_prices row.
    await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-REG-NOROW", name: "Regulated, no row", category: "pharmacy", regulated: true }),
    );
    const break3 = await validateTariffConfig(db, at);
    expect(break3.ok).toBe(false);
    expect(break3.errors.some((e) => e.code === "regulated_price_missing")).toBe(true);

    // Break 4: corrupt params via a raw db update — bypasses upsertAdjustmentRule's zod gate on write.
    await db.update(adjustmentRulesTable).set({ params: { bogus: true } }).where(eq(adjustmentRulesTable.ruleKey, "R-EMP10"));
    const break4 = await validateTariffConfig(db, at);
    expect(break4.ok).toBe(false);
    expect(break4.errors.some((e) => e.code === "invalid_rule_params")).toBe(true);

    // Accumulation, not first-error-wins: the final run still carries every earlier code too.
    expect(break4.errors.some((e) => e.code === "tariff_item_missing")).toBe(true);
    expect(break4.errors.some((e) => e.code === "gst_config_missing")).toBe(true);
    expect(break4.errors.some((e) => e.code === "regulated_price_missing")).toBe(true);
  });

  test("the gate reads the ENGINE's caps: a deactivated or expired cap row flips ok to false", async () => {
    await seedFullValidConfig();
    const at = new Date("2026-03-01T00:00:00Z");
    expect((await validateTariffConfig(db, at)).ok).toBe(true);

    // Deactivate the charity cap THROUGH THE SHIPPED API — the exact stress-test scenario: the old
    // raw-table gate still saw this row and printed ok=true while the engine dropped it and every
    // charity waiver died unknown_category with the patient billed full price (M1).
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "CAP-CHARITY",
        params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 }, active: false,
      }),
    );
    const deactivated = await validateTariffConfig(db, at);
    expect(deactivated.ok).toBe(false);
    expect(deactivated.errors.some((e) => e.code === "manual_caps_missing" && e.detail.includes('"charity"'))).toBe(true);

    // Re-activate with a validity window that already CLOSED — the hole that opens by itself as
    // time passes (validTo elapses; nobody touched anything).
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "CAP-CHARITY",
        params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 },
        validTo: new Date("2026-01-31T00:00:00Z"), active: true,
      }),
    );
    const expired = await validateTariffConfig(db, at);
    expect(expired.ok).toBe(false);
    expect(expired.errors.some((e) => e.code === "manual_caps_missing" && e.detail.includes('"charity"'))).toBe(true);
  });

  test("a second active cap row for one category is REPORTED as duplicate_manual_cap, not silently resolved", async () => {
    await seedFullValidConfig();
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, drafter, {
        ruleKey: "CAP-CHARITY-2025", sourceKey: "manual", title: "Charity cap FY25",
        params: { discountCategory: "charity", maxBps: 500, approvalAboveBps: null },
      }),
    );
    const report = await validateTariffConfig(db, new Date("2026-03-01T00:00:00Z"));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "duplicate_manual_cap" && e.detail.includes('"charity"'))).toBe(true);
  });
});
