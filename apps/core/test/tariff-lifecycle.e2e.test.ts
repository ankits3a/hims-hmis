import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { registerApprovalType } from "../src/kernel/approvals/types";
import { approveRequest } from "../src/kernel/approvals/decisions";
import { activateDefinition, createDraft } from "../src/kernel/workflow/definitions";
import { withTx } from "../src/kernel/db/client";
import {
  TARIFF_REVISION_APPROVAL_TYPE,
  activateVersion,
  createDraftVersion,
  createService,
  loadPricingContext,
  priceInvoiceLines,
  resolveActiveTariffVersion,
  setTariffItem,
  simulateRevision,
  submitVersion,
  upsertAdjustmentRule,
  upsertGstCategory,
  upsertGstSettings,
  validateTariffConfig,
} from "../src/modules/tariff";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * T10 — lifecycle proof: THE ENTIRE TEST imports the tariff module ONLY from
 * "../src/modules/tariff" (the index). This is Plan 08's compile-time reality rehearsed now —
 * the proof that the index surface is sufficient for a real consumer. Kernel imports are
 * unrestricted (setupTestDb/truncateAll/seedSodPairs/createUser/createRole/assignRole and the
 * approvals + workflow governance functions).
 *
 * Function-level integration (merge.test.ts's shape: setupTestDb, no HTTP).
 */
describe("tariff lifecycle e2e — index-surface only (D5 lock, D-17 gate, §11.11 revision)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let drafter: Actor;
  let activator: Actor;
  let owner: Actor;
  let thirdActivator: Actor;
  let svcCons: string;
  let svcTab: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);

    const drafterUser = await createUser(db, { username: "drafter", fullName: "Drafter", password: "p1234567" });
    const activatorUser = await createUser(db, { username: "activator", fullName: "Activator", password: "p1234567" });
    const ownerUser = await createUser(db, { username: "owner_user", fullName: "Owner", password: "p1234567" });
    const thirdActivatorUser = await createUser(db, {
      username: "third_activator",
      fullName: "Third Activator",
      password: "p1234567",
    });
    drafter = { type: "user", id: drafterUser.id };
    activator = { type: "user", id: activatorUser.id };
    owner = { type: "user", id: ownerUser.id };
    thirdActivator = { type: "user", id: thirdActivatorUser.id };

    await createRole(db, "owner", "Owner");
    await assignRole(db, { userId: ownerUser.id, roleKey: "owner", scopeType: "hospital" });

    // Two-step runbook registration — T4's exact block (merge.test.ts precedent, §11.5):
    // builder -> Plan 03 draft -> activate (drafter != activator) -> registerApprovalType.
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

    // CONFIG_A (Fixture Book), seeded through the index surface: 2 services (svc-cons
    // consultation, svc-tab pharmacy), GST rows (consultation exempt/would-be 1800, pharmacy
    // 1200), settings, and ALL FOUR D-8 manual-caps rows. validateTariffConfig's
    // manual_caps_missing check fires once per category still missing a caps row — ok:true is
    // unreachable unless charity/scheme/negotiated_corporate/employee are all seeded.
    const cons = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "CONS-GEN", name: "General consultation", category: "consultation" }),
    );
    const tab = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "PHARM-TAB", name: "Paracetamol 500 strip", category: "pharmacy" }),
    );
    svcCons = cons.serviceId;
    svcTab = tab.serviceId;

    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "consultation",
        sacCode: "999312",
        exempt: true,
        rateBps: 1800,
        specialRule: null,
        thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, drafter, {
        category: "pharmacy",
        sacCode: "3004",
        exempt: false,
        rateBps: 1200,
        specialRule: null,
        thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, drafter, { compositeHealthcareExempt: true, caSigned: false }));

    const caps: [string, "charity" | "scheme" | "negotiated_corporate" | "employee", number, number | null][] = [
      ["CAP-CHARITY", "charity", 2500, 1000],
      ["CAP-EMPLOYEE", "employee", 1000, null],
      ["CAP-SCHEME", "scheme", 1500, 1000],
      ["CAP-CORP", "negotiated_corporate", 2000, 1500],
    ];
    for (const [ruleKey, discountCategory, maxBps, approvalAboveBps] of caps) {
      await withTx(db, (tx) =>
        upsertAdjustmentRule(tx, drafter, {
          ruleKey,
          sourceKey: "manual",
          title: ruleKey,
          params: { discountCategory, maxBps, approvalAboveBps },
        }),
      );
    }
  });

  /** D5 lifecycle helper: draft (optionally copied) -> price overrides -> submit -> approve -> activate. */
  async function draftSubmitApproveActivate(
    opts: { copyFromVersionId?: string; priceOverrides: [string, number][] },
    effectiveFrom: Date,
    activatorActor: Actor,
  ): Promise<{ versionId: string; versionNo: number }> {
    const draft = await withTx(db, (tx) =>
      createDraftVersion(
        tx,
        drafter,
        opts.copyFromVersionId !== undefined ? { copyFromVersionId: opts.copyFromVersionId } : {},
      ),
    );
    for (const [serviceId, price] of opts.priceOverrides) {
      await withTx(db, (tx) => setTariffItem(tx, drafter, draft.versionId, serviceId, price));
    }
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved for go-live" });
    await activateVersion(db, activatorActor, draft.versionId, effectiveFrom);
    return draft;
  }

  test("the D-17 ok:true direction: an activated, fully-seeded config validates clean through the same library the T9 script runs", async () => {
    await draftSubmitApproveActivate(
      {
        priceOverrides: [
          [svcCons, 50000],
          [svcTab, 18875],
        ],
      },
      new Date("2026-09-01T00:00:00Z"),
      activator,
    );

    const report = await validateTariffConfig(db, new Date("2026-09-15T00:00:00Z"));
    expect(report).toEqual({ ok: true, errors: [], caSigned: false });
  });

  test("pricing under v1 through the full impure-to-pure chain: loader then engine reproduce the Book's G01/G03 nets", async () => {
    await draftSubmitApproveActivate(
      {
        priceOverrides: [
          [svcCons, 50000],
          [svcTab, 18875],
        ],
      },
      new Date("2026-09-01T00:00:00Z"),
      activator,
    );

    const ctx = await loadPricingContext(db, { at: new Date("2026-09-15T00:00:00Z") });
    const priced = priceInvoiceLines(ctx, [
      { lineId: "L1", serviceId: svcCons, qty: 1 },
      { lineId: "L2", serviceId: svcTab, qty: 1 },
    ]);

    expect(priced[0]?.netPaise).toBe(50000);
    expect(priced[1]?.netPaise).toBe(21141);
  });

  test("revision with simulation: v2 copied from v1 with consultation raised, simulated before submit, then submitted/approved/activated", async () => {
    const v1 = await draftSubmitApproveActivate(
      {
        priceOverrides: [
          [svcCons, 50000],
          [svcTab, 18875],
        ],
      },
      new Date("2026-09-01T00:00:00Z"),
      activator,
    );

    const currentCtx = await loadPricingContext(db, { at: new Date("2026-09-15T00:00:00Z") });

    // Draft v2, copied from v1, with consultation raised — priced BEFORE submit via allowDraft.
    const v2Draft = await withTx(db, (tx) =>
      createDraftVersion(tx, drafter, { copyFromVersionId: v1.versionId }),
    );
    await withTx(db, (tx) => setTariffItem(tx, drafter, v2Draft.versionId, svcCons, 60000));
    const draftCtx = await loadPricingContext(db, {
      at: new Date("2026-09-15T00:00:00Z"),
      tariffVersionId: v2Draft.versionId,
      allowDraft: true,
    });

    const lines = [
      { lineId: "L1", serviceId: svcCons, qty: 1 },
      { lineId: "L2", serviceId: svcTab, qty: 1 },
    ];
    const impact = simulateRevision(currentCtx, draftCtx, lines);
    expect(impact.lines.find((l) => l.serviceId === svcCons)?.deltaPaise).toBe(10000);
    expect(impact.lines.find((l) => l.serviceId === svcTab)?.deltaPaise).toBe(0);

    // Now carry the SAME draft through submit -> approve -> activate.
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, v2Draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved for go-live" });
    await activateVersion(db, thirdActivator, v2Draft.versionId, new Date("2026-10-01T00:00:00Z"));

    const resolved = await resolveActiveTariffVersion(db, new Date("2026-10-02T00:00:00Z"));
    expect(resolved).not.toBeNull();
    expect(resolved?.versionId).toBe(v2Draft.versionId);

    const newCtx = await loadPricingContext(db, { at: new Date("2026-10-02T00:00:00Z") });
    const priced = priceInvoiceLines(newCtx, [{ lineId: "L1", serviceId: svcCons, qty: 1 }]);
    expect(priced[0]?.netPaise).toBe(60000);
  });

  test("the tariff lock (§7), both directions: a pinned old version still prices old after a newer activation, and a backdated resolution returns the old version", async () => {
    const v1 = await draftSubmitApproveActivate(
      {
        priceOverrides: [
          [svcCons, 50000],
          [svcTab, 18875],
        ],
      },
      new Date("2026-09-01T00:00:00Z"),
      activator,
    );
    await draftSubmitApproveActivate(
      { copyFromVersionId: v1.versionId, priceOverrides: [[svcCons, 60000]] },
      new Date("2026-10-01T00:00:00Z"),
      thirdActivator,
    );

    // Direction 1: an explicit pin to v1 still prices the OLD figure after v2 has activated —
    // the admitted-patient case Plan 08/IPD builds on.
    const pinnedCtx = await loadPricingContext(db, {
      at: new Date("2026-10-02T00:00:00Z"),
      tariffVersionId: v1.versionId,
    });
    const pinnedPriced = priceInvoiceLines(pinnedCtx, [{ lineId: "L1", serviceId: svcCons, qty: 1 }]);
    expect(pinnedPriced[0]?.netPaise).toBe(50000);

    // Direction 2: a backdated as-of resolution (after v1's effective date, before v2's) returns
    // v1 — a backdated OPD re-print resolves the version that was active then.
    const backdated = await resolveActiveTariffVersion(db, new Date("2026-09-20T00:00:00Z"));
    expect(backdated).not.toBeNull();
    expect(backdated?.versionId).toBe(v1.versionId);
  });
});
