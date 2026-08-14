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

  test("validFrom guards the future: a rule starting next month is invisible today, visible ON the day", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-FUTURE", sourceKey: "rule", title: "Starts Oct 1",
        params: { kind: "flat_paise", value: 100, discountCategory: "scheme", requiredTag: null },
        validFrom: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    // Deleting rules.ts's validFrom guard makes a campaign configured to start next month apply
    // TODAY — killed by the first assertion (M5: the guard line had never once executed under
    // test). Flipping > to >= excludes the boundary instant — killed by the second ("equal is
    // included", the module's stated D5 resolution convention).
    const before = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(before.rules.map((r) => r.ruleKey)).not.toContain("R-FUTURE");
    const onTheDay = await loadRuleConfig(db, new Date("2026-10-01T00:00:00Z"));
    expect(onTheDay.rules.map((r) => r.ruleKey)).toContain("R-FUTURE");
  });

  test("active: false retires a rule from the engine while it stays listed for admin", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-RETIRED", sourceKey: "rule", title: "Retired",
        params: { kind: "flat_paise", value: 100, discountCategory: "scheme", requiredTag: null },
        active: false,
      }),
    );
    // Removing loadRuleConfig's `.where(eq(active, true))` keeps a retired discount applying at the
    // counter (M8) — killed by the first assertion; the second pins that "retired" is not "deleted".
    const cfg = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(cfg.rules.map((r) => r.ruleKey)).not.toContain("R-RETIRED");
    const all = await listAdjustmentRules(db);
    expect(all.map((r) => r.ruleKey)).toContain("R-RETIRED");
  });

  test("upserting an existing ruleKey UPDATES in place — one row, new values, new updatedBy", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "R-TWICE", sourceKey: "rule", title: "First",
        params: { kind: "percent_bps", value: 500, discountCategory: "scheme", requiredTag: null },
      }),
    );
    const editor = { type: "user", id: "u2" } as const;
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, editor, {
        ruleKey: "R-TWICE", sourceKey: "rule", title: "Second",
        params: { kind: "percent_bps", value: 750, discountCategory: "scheme", requiredTag: null },
      }),
    );
    // Every prior test upserted each key exactly once after a truncate, so the onConflictDoUpdate
    // branch had NEVER executed (M7) — a plain-.insert() mutant passes the whole shipped suite and
    // throws a raw 23505 here instead — killed.
    const rows = await listAdjustmentRules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Second");
    expect((rows[0]?.params as { value: number }).value).toBe(750);
    expect(rows[0]?.updatedBy).toBe("u2");
    expect(rows[0]?.createdBy).toBe(actor.id);
  });

  test("duplicate active caps for one category: the engine resolves to the NEWEST row, deterministically", async () => {
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap",
        params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 },
      }),
    );
    await withTx(db, (tx) =>
      upsertAdjustmentRule(tx, actor, {
        ruleKey: "CAP-CHARITY-2025", sourceKey: "manual", title: "Charity cap FY25",
        params: { discountCategory: "charity", maxBps: 500, approvalAboveBps: null },
      }),
    );
    // HONESTY NOTE (discrimination audit): in a fresh table, heap order usually equals insertion
    // order, so an unordered implementation often passes this too. The assertion pins the stated
    // CONVENTION (newest wins, by ULID order); the load-bearing defense against duplicate caps is
    // validateTariffConfig's duplicate_manual_cap error, tested in context.test.ts.
    const { manualCaps } = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
    expect(manualCaps.charity).toEqual({ maxBps: 500, approvalAboveBps: null });
  });
});
