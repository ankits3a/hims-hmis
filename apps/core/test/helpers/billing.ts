import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { billingConfig, roles } from "../../src/kernel/db/schema";
import { createUser } from "../../src/kernel/auth/identity";
import { createSession } from "../../src/kernel/auth/sessions";
import { assignRole } from "../../src/kernel/auth/permissions";
import { seedSodPairs } from "../../src/kernel/auth/sod";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { registerApprovalType } from "../../src/kernel/approvals/types";
import { approvalFlowDefinition } from "../../src/kernel/approvals/flow";
import { activateDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { loadConfig } from "../../src/kernel/config";
import { withTx } from "../../src/kernel/db/client";
import {
  activateVersion, createDraftVersion, createService, setTariffItem, submitVersion,
  TARIFF_REVISION_APPROVAL_TYPE, upsertAdjustmentRule, upsertGstCategory, upsertGstSettings,
} from "../../src/modules/tariff";
import { registerBillingApprovalTypes } from "../../src/modules/billing/approval-types";
import { openSession } from "../../src/modules/billing/sessions";
import { issueInvoice, previewInvoice } from "../../src/modules/billing/invoices";
import type { Db } from "../../src/kernel/db/client";
import type { IssueInvoiceResult } from "../../src/modules/billing/invoices";

export const testCfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

async function ensureRole(db: Db, key: string): Promise<void> {
  await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
}

/** A user holding the given role keys at hospital scope, with a live session token — the
 * test/helpers/opd.ts `mkUser` precedent, kept local here so billing's test helper carries no
 * cross-module test import. */
async function mkUser(db: Db, username: string, roleKeys: string[]): Promise<{ id: string; token: string; actor: Actor }> {
  const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
  for (const key of roleKeys) {
    await ensureRole(db, key);
    await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
  }
  const { token } = await createSession(db, testCfg, id);
  return { id, token, actor: { type: "user", id } };
}

export type BillingBaseFixture = {
  consultNewServiceId: string;
  consultRenewalServiceId: string;
  genericServiceId: string;
  tariffVersionId: string;
  drafter: Actor;
  activator: Actor;
  owner: Actor;
};

/**
 * Everything most billing tests start from: billing_config 'main' (D-17 dev defaults) + roles
 * cashier/billing_manager + the five billing approval types + a fully activated tariff context —
 * two OPD-consult services + one generic taxable service (all priced 50000 paise, restated by
 * T5), the exempt-healthcare "consultation" GST category + the taxable 1200bps "pharmacy"
 * category, and one D-8 charity discount cap (maxBps 5000, approvalAboveBps 3000 — T5's Step 1
 * restates these exact numbers). Every row is built through the OWNING module's public API (the
 * Plan 06 e2e registration pattern, tariff/context.test.ts's seedFullValidConfig) — never a
 * hand-rolled insert into another module's table (spec §4 module isolation).
 */
export async function seedBillingBase(db: Db): Promise<BillingBaseFixture> {
  await seedSodPairs(db);
  await ensureRole(db, "cashier");
  await ensureRole(db, "billing_manager");

  const drafter = await mkUser(db, "billing_seed_drafter", []);
  const activator = await mkUser(db, "billing_seed_activator", []);
  const owner = await mkUser(db, "billing_seed_owner", ["owner"]);

  // tariff_revision approval type (the Plan 06 e2e registration pattern, context.test.ts's
  // beforeEach) — needed so a draft tariff version below can be submitted and activated.
  const tariffDef = await createDraft(
    db,
    drafter.actor,
    approvalFlowDefinition({
      typeKey: TARIFF_REVISION_APPROVAL_TYPE, title: "Tariff Revision", approverRole: "owner", closureSlaMinutes: 1440,
    }),
  );
  await activateDefinition(db, activator.actor, tariffDef.definitionId);
  await registerApprovalType(db, activator.actor, {
    typeKey: TARIFF_REVISION_APPROVAL_TYPE, title: "Tariff Revision", approverRole: "owner",
    urgencyClass: "routine", actFirstAllowed: false,
  });

  // Two consult services (the D8 fee branch) + one generic taxable service.
  const consultNew = await withTx(db, (tx) =>
    createService(tx, drafter.actor, { code: "OPD-CONSULT-NEW", name: "OPD Consultation (New)", category: "consultation" }),
  );
  const consultRenewal = await withTx(db, (tx) =>
    createService(tx, drafter.actor, { code: "OPD-CONSULT-RENEWAL", name: "OPD Consultation (Renewal)", category: "consultation" }),
  );
  const generic = await withTx(db, (tx) =>
    createService(tx, drafter.actor, { code: "GENERIC-SERVICE", name: "Generic taxable service", category: "pharmacy" }),
  );

  await withTx(db, (tx) =>
    upsertGstCategory(tx, drafter.actor, {
      category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
    }),
  );
  await withTx(db, (tx) =>
    upsertGstCategory(tx, drafter.actor, {
      category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
    }),
  );
  await withTx(db, (tx) => upsertGstSettings(tx, drafter.actor, { compositeHealthcareExempt: true, caSigned: false }));

  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, drafter.actor, {
      ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity discount cap",
      params: { discountCategory: "charity", maxBps: 5000, approvalAboveBps: 3000 },
    }),
  );

  const draft = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, drafter.actor, {});
    await setTariffItem(tx, drafter.actor, d.versionId, consultNew.serviceId, 50000);
    await setTariffItem(tx, drafter.actor, d.versionId, consultRenewal.serviceId, 50000);
    await setTariffItem(tx, drafter.actor, d.versionId, generic.serviceId, 50000);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, drafter.actor, draft.versionId));
  await approveRequest(db, owner.actor, { approvalId: submitted.approvalId, note: "seed-billing base" });
  await activateVersion(db, activator.actor, draft.versionId, new Date("2026-01-01T00:00:00Z"));

  // billing_config 'main' — DEV PLACEHOLDERS, CA sign-off required (D-17/§19); mirrors
  // seed-billing.ts's own values so a test config and the seeded runtime config never drift.
  await db
    .insert(billingConfig)
    .values({
      id: "main",
      cashWarnPaise: 15_000_000,
      cashBlockPaise: 20_000_000,
      panThresholdPaise: 5_000_000,
      refundBankAbovePaise: 1_000_000,
      creditCapPaise: 500_000,
      outstandingCapPaise: 2_000_000,
      outstandingCapMode: "warn",
      feeBps: { upi: 0, card: 150 },
      reconTolerancePaise: 100,
      seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN", voucher: "RFV" },
      chargeRules: { opdConsult: { new: consultNew.serviceId, renewal: consultRenewal.serviceId } },
      degradedTender: false,
      caSigned: false,
      updatedAt: new Date(),
    })
    .onConflictDoNothing();

  await registerBillingApprovalTypes(db, activator.actor);

  return {
    consultNewServiceId: consultNew.serviceId,
    consultRenewalServiceId: consultRenewal.serviceId,
    genericServiceId: generic.serviceId,
    tariffVersionId: draft.versionId,
    drafter: drafter.actor,
    activator: activator.actor,
    owner: owner.actor,
  };
}

/** A user holding the cashier role, with a live session token. */
export async function mkCashier(db: Db, username: string): Promise<{ id: string; token: string; actor: Actor }> {
  return mkUser(db, username, ["cashier"]);
}

/**
 * REAL as of T4 (this function no longer shapes the row directly — it calls the shipped
 * `openSession`, the ACTING cashier's own open session, D9). The signature is unchanged from
 * T3's placeholder, so every caller (T5-T8's fixtures) needs no changes.
 */
export async function openSessionFor(db: Db, cashier: { id: string }, floatPaise: number): Promise<{ id: string }> {
  const { id } = await openSession(db, { type: "user", id: cashier.id }, floatPaise);
  return { id };
}

/**
 * A fully settled invoice for one service, paid in EXACT cash - the fixture T6-T8 start from.
 * The cashier must ALREADY hold an open session (`openSessionFor`): a receipt is drawer-bound
 * (D9), and opening one inside a fixture would hide the very requirement T5 asserts. The line is
 * priced through `previewInvoice` first so the tender matches `netPayable` exactly and nothing is
 * left unallocated.
 */
export async function issuePaidInvoice(
  db: Db,
  cashier: { id: string; actor: Actor },
  input: { patientId: string; serviceId: string; qty?: number; encounterId?: string },
): Promise<IssueInvoiceResult> {
  const lines = [{ lineId: newId(), serviceId: input.serviceId, qty: input.qty ?? 1 }];
  const preview = await previewInvoice(db, { encounterId: input.encounterId, lines });
  return issueInvoice(db, cashier.actor, {
    draftId: newId(),
    patientId: input.patientId,
    encounterId: input.encounterId,
    lines,
    receipt: { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] },
  });
}
