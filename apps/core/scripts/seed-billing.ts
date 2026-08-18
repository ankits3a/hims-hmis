import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { billingConfig, roles } from "../src/kernel/db/schema";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { createService, listServices } from "../src/modules/tariff";
import { registerBillingApprovalTypes } from "../src/modules/billing/approval-types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * Seeds/updates the dev billing_config row (D-17 DEV PLACEHOLDERS — CA sign-off required, §19),
 * roles cashier + billing_manager, the two OPD-consult services the D8 fee branch needs (created
 * through the tariff module's public API if absent), and the five billing approval types.
 * Idempotent — safe to re-run (existing rows/registrations are left untouched, the seed-opd.ts
 * convention). Usage: pnpm --filter @hmis/core seed:billing
 */
const actor: Actor = { type: "system", id: "seed" };
// registerBillingApprovalTypes/activateDefinition require a "user"-typed actor structurally, but
// neither checks a real `users` row (no FK on draftedBy/activatedBy — kernel/db/schema/workflow.ts,
// approvals.ts), so a fixed script identity is sufficient and needs no new env var.
const activator: Actor = { type: "user", id: "seed-billing" };

async function ensureService(db: Db, code: string, name: string, category: string): Promise<string> {
  const existing = await listServices(db);
  const found = existing.find((s) => s.code === code);
  if (found) return found.id;
  const created = await withTx(db, (tx) => createService(tx, actor, { code, name, category }));
  return created.serviceId;
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await seedSodPairs(db);
    await db.insert(roles).values({ key: "cashier", title: "Cashier" }).onConflictDoNothing();
    await db.insert(roles).values({ key: "billing_manager", title: "Billing Manager" }).onConflictDoNothing();
    console.log("roles ensured: cashier, billing_manager");

    const consultNewId = await ensureService(db, "OPD-CONSULT-NEW", "OPD Consultation (New)", "consultation");
    const consultRenewalId = await ensureService(db, "OPD-CONSULT-RENEWAL", "OPD Consultation (Renewal)", "consultation");
    console.log(`services ensured: OPD-CONSULT-NEW (${consultNewId}), OPD-CONSULT-RENEWAL (${consultRenewalId})`);

    const cfg = await db
      .insert(billingConfig)
      .values({
        id: "main",
        cashWarnPaise: 15_000_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        cashBlockPaise: 20_000_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        panThresholdPaise: 5_000_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        refundBankAbovePaise: 1_000_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        creditCapPaise: 500_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        outstandingCapPaise: 2_000_000, // DEV PLACEHOLDER — CA sign-off required (§19)
        outstandingCapMode: "warn", // DEV PLACEHOLDER — CA sign-off required (§19)
        feeBps: { upi: 0, card: 150 }, // DEV PLACEHOLDER — CA sign-off required (§19)
        reconTolerancePaise: 100, // DEV PLACEHOLDER — CA sign-off required (§19)
        seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN", voucher: "RFV" },
        chargeRules: { opdConsult: { new: consultNewId, renewal: consultRenewalId } },
        degradedTender: false,
        caSigned: false, // flips only via the CA sign-off runbook step
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: billingConfig.id });
    console.log(cfg.length === 1 ? "billing_config seeded (ALL DEV PLACEHOLDERS — CA sign-off required, §19)" : "billing_config exists — left untouched");

    await registerBillingApprovalTypes(db, activator);
    console.log(
      "approval types ensured: billing_credit_extension, billing_discount, billing_clearance_discount, billing_refund, billing_variance",
    );
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
