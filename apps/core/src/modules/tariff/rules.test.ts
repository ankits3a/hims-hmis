import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { listAdjustmentRules, loadRuleConfig, upsertAdjustmentRule } from "./rules";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const actor: Actor = { type: "user", id: "u1" };

describe("adjustment-rule config (D-8): rules.ts", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  test("upsertAdjustmentRule + listAdjustmentRules round-trip (filter by sourceKey)", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-CAMP5",
        sourceKey: "rule",
        title: "Camp 2026 procedure scheme",
        params: { kind: "percent_bps", value: 500, discountCategory: "scheme", requiredTag: "camp2026" },
        serviceCategory: "procedure",
      }),
    );
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-EMPLOYEE",
        sourceKey: "manual",
        title: "Employee cap",
        params: { discountCategory: "employee", maxBps: 1000, approvalAboveBps: null },
      }),
    );

    const all = await listAdjustmentRules(db);
    expect(all).toHaveLength(2);

    const ruleRows = await listAdjustmentRules(db, { sourceKey: "rule" });
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]?.ruleKey).toBe("R-CAMP5");
    expect(ruleRows[0]?.serviceCategory).toBe("procedure");

    const manualRows = await listAdjustmentRules(db, { sourceKey: "manual" });
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]?.ruleKey).toBe("CAP-EMPLOYEE");
  });

  test("bad params rejected by name: invalid_rule_params for percent>10000, flat=0, unknown category, missing requiredTag", async () => {
    await expect(
      withTx(db, (tx) =>
        upsertAdjustmentRule(tx, actor, {
          ruleKey: "BAD-PCT",
          sourceKey: "rule",
          title: "t",
          params: { kind: "percent_bps", value: 10001, discountCategory: "scheme", requiredTag: null },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_rule_params" });

    await expect(
      withTx(db, (tx) =>
        upsertAdjustmentRule(tx, actor, {
          ruleKey: "BAD-FLAT",
          sourceKey: "rule",
          title: "t",
          params: { kind: "flat_paise", value: 0, discountCategory: "scheme", requiredTag: null },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_rule_params" });

    await expect(
      withTx(db, (tx) =>
        upsertAdjustmentRule(tx, actor, {
          ruleKey: "BAD-CAT",
          sourceKey: "rule",
          title: "t",
          params: { kind: "flat_paise", value: 100, discountCategory: "not_a_category", requiredTag: null },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_rule_params" });

    await expect(
      withTx(db, (tx) =>
        upsertAdjustmentRule(tx, actor, {
          ruleKey: "BAD-TAG",
          sourceKey: "rule",
          title: "t",
          params: { kind: "flat_paise", value: 100, discountCategory: "scheme" }, // requiredTag key missing
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_rule_params" });
  });

  test("params survive a jsonb round-trip and parse under the source schema", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-EMP10",
        sourceKey: "rule",
        title: "Employee discount",
        params: { kind: "percent_bps", value: 1000, discountCategory: "employee", requiredTag: null },
      }),
    );

    const { rules } = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule).toEqual({
      ruleKey: "R-EMP10",
      title: "Employee discount",
      kind: "percent_bps",
      value: 1000,
      discountCategory: "employee",
      requiredTag: null,
      serviceCategory: null,
      serviceId: null,
    });
    // The §3.14-style defense this test owns (flag ⑤): requiredTag must survive the jsonb
    // round trip as `null`, never silently become `undefined`.
    expect(rule?.requiredTag).toBe(null);
    expect(rule?.requiredTag).not.toBe(undefined);
    expect(Object.prototype.hasOwnProperty.call(rule, "requiredTag")).toBe(true);
  });

  test("validity window: rule excluded once `at` is past validTo, included at an earlier `at`", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-EXPIRING",
        sourceKey: "rule",
        title: "Expiring rule",
        params: { kind: "flat_paise", value: 100, discountCategory: "scheme", requiredTag: null },
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: new Date("2026-06-30T23:59:59Z"),
      }),
    );

    const before = await loadRuleConfig(db, new Date("2026-03-01T00:00:00Z"));
    expect(before.rules.map((r) => r.ruleKey)).toContain("R-EXPIRING");

    const after = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(after.rules.map((r) => r.ruleKey)).not.toContain("R-EXPIRING");
  });

  test("manual caps keyed by discountCategory, approvalAboveBps: null surviving", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-EMPLOYEE",
        sourceKey: "manual",
        title: "Employee cap",
        params: { discountCategory: "employee", maxBps: 1000, approvalAboveBps: null },
      }),
    );

    const { manualCaps } = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(manualCaps.employee).toEqual({ maxBps: 1000, approvalAboveBps: null });
    expect(manualCaps.employee?.approvalAboveBps).toBe(null);
  });
});
