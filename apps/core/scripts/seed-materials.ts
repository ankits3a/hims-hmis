import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { registerMaterialsApprovalTypes } from "../src/modules/materials/approval-types";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 14 T2 / DD10 — registers the materials module's TWO approval types, and nothing else.
 *
 * ═══ WHY THIS SCRIPT EXISTS, AND WHY IT IS IN `deploy.sh` ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries. An approval
 * type therefore reaches a deployment ONLY through a seed script in the deploy path, and the
 * repository has paid for that lesson twice: `patient_merge` went unregistered from Plan 05 until
 * 2026-08-26 and every merge request on the live box threw the whole time; `tariff_revision` made a
 * tariff undraftable in production (11g report D7, gap 2). Both were found by a human looking.
 *
 * Without this script, `postGrn` on a near-expiry line and `requestBankChange` on a vendor would
 * both throw `unknown_type` on the live box — the first at a bay with a lorry in it.
 *
 * The parallel-session protocol §5 states the general rule this obeys: **"a commit that needs an
 * operator step is a defect on a shared branch — put the step in `deploy.sh` instead."** Nobody has
 * to remember to run this.
 *
 * ═══ IT SEEDS NO CONTENT, DELIBERATELY ═══
 *
 * No item, no vendor, no store. The three are hospital-specific master data with a GST rate, a
 * legal name and a physical location attached, and a seed that invented them would put placeholder
 * commercial data in a live hospital's item master — the failure mode `seed-tariff.ts` had to be
 * rewritten to avoid ("a deploy must never be able to overwrite a corrected money or tax value").
 * The owner registers the first store and the first vendor through `/materials/*` (T9), which is
 * exactly why DD16 ruled the screens IN.
 *
 * **Note for the first bring-up, and it is a MEASURED dependency rather than a defect** (Spike Q2,
 * answered 2026-08-27): production holds ZERO `formulary_medicines`. DD3 makes
 * `formulary_medicine_id` mandatory for `class = 'drug'`, so no DRUG-class item can be registered
 * on the live box until a medicine exists. Non-drug classes — including `implant`, which is what
 * the mini-OT's first consignment challan carries — are unaffected. The medicine mining track is
 * the owner's (16a spec D2).
 *
 * ═══ IDEMPOTENT, AND `approval-types.test.ts` PROVES IT BY EXECUTION ═══
 *
 * `deploy.sh` runs this on EVERY deploy. A second run registers nothing and drafts no new workflow
 * definition VERSION — the second half being the one that would go unnoticed, since a duplicate
 * version is not an error, just a growing lie about how many times the flow changed.
 *
 * Usage: DATABASE_URL=postgres://... pnpm --filter @hmis/core seed:materials
 */

/**
 * `registerMaterialsApprovalTypes` needs a "user"-typed actor whose id differs from its fixed
 * system drafter's; neither checks a real `users` row (no FK on draftedBy/activatedBy), so a fixed
 * script identity is sufficient — the `seed-tariff.ts` / `seed-billing.ts` `activator` precedent,
 * verbatim.
 */
const activator: Actor = { type: "user", id: "seed-materials" };

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    // The SoD pair rows the workflow drafter/activator check reads must exist before the
    // registration below can draft-then-activate a definition (kernel/auth/sod.ts). `seedSodPairs`
    // is an ensure and both `seed:billing` and `seed:tariff` already call it; running it here makes
    // THIS script self-sufficient rather than dependent on seed order — which matters because
    // `deploy.sh` runs the seeds in a fixed sequence that a later phase may reorder.
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, activator);
    console.log("approval types ensured: materials_near_expiry_acceptance, materials_vendor_bank_change");
    console.log("no item, vendor or store seeded — master data is registered through /materials/* (DD16)");
  } finally {
    await pool.end();
  }
}

// Guarded so a test can import from this file without the script running itself on import — the
// `seed-roles.ts` / `seed-admin.ts` / `seed-tariff.ts` house convention. `tsx scripts/seed-materials.ts`
// still runs it: apps/core declares no `"type": "module"`, so this file is CommonJS and
// `require.main` is this module.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  }); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
}
