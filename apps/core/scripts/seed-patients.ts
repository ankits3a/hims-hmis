import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { roles } from "../src/kernel/db/schema";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { registerPatientApprovalTypes, PATIENT_APPROVAL_TYPES } from "../src/modules/patients/approval-types";
import type { Actor } from "@hmis/contracts";

/**
 * `pnpm --filter @hmis/core seed:patients` — the patients module's approval types and the two role
 * KEYS the merge lane needs. The `seed-billing.ts` shape, followed cell for cell.
 *
 * ═══ WHY A NEW SEED SCRIPT RATHER THAN A LINE IN `seed-registration.ts` ═══
 *
 * `seed:registration` is runbook STEP ZERO: it takes `UHID_PREFIX`, it is an operator command, and
 * **`deploy.sh` does not run it**. Putting an idempotent registration there would make the merge
 * lane depend on somebody remembering a manual step on every environment — which is exactly the
 * failure this session already paid for once, when `auth.elevation.review` shipped to a live box
 * with no holder because `seed:admin` is likewise not in the deploy path.
 *
 * So this is its own script, in `deploy.sh` beside `seed:billing`, and `deploy-parity.test.ts`'s
 * `SEED_STEP_SCRIPTS` census asserts it is there. A registration that runs on every deploy cannot
 * be forgotten on the next environment.
 *
 * ═══ WHAT IT DOES, ALL IDEMPOTENT ═══
 *
 *   1. ensures the SoD pairs (`registerApprovalType` reads `workflow_drafter_activator` and fails
 *      loudly if the pair row is absent — the `seed-billing.ts` precondition, unchanged);
 *   2. ensures the two role KEYS the lane names — `mrd_officer`, the requester, and
 *      `medical_superintendent`, the approver — because `approval_types.approver_role` is a plain
 *      string with no FK and a type pointing at a role nobody created is an approval nobody can
 *      ever decide. GRANTS are `seed:roles`'s business, never this script's: "give Asha the MRD
 *      role" and "change what an MRD officer may do" must not be one act (seed-roles.ts's rule);
 *   3. registers `patient_merge` and `patient_unmerge`, skipping either that already exists.
 *
 * IT ASSIGNS NOBODY, deliberately, exactly as `seed:roles` does not.
 */
// `registerApprovalType` and `activateDefinition` require a "user"-typed actor structurally, but
// neither checks a real `users` row (no FK on draftedBy/activatedBy), so a fixed script identity is
// sufficient and needs no new env var — the `seed-billing.ts` note, and the same reasoning.
const activator: Actor = { type: "user", id: "seed-patients" };

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await seedSodPairs(db);

    await db.insert(roles).values({ key: "mrd_officer", title: "MRD Officer" }).onConflictDoNothing();
    await db
      .insert(roles)
      .values({ key: "medical_superintendent", title: "Medical Superintendent" })
      .onConflictDoNothing();
    console.log("roles ensured: mrd_officer, medical_superintendent");

    await registerPatientApprovalTypes(db, activator);
    console.log(`approval types ensured: ${PATIENT_APPROVAL_TYPES.map((t) => t.typeKey).join(", ")}`);
    console.log(
      "NOTE: this script GRANTS nothing and ASSIGNS nobody — run seed:roles for the grants, and " +
        "assign holders at /admin/users. An approval type whose approverRole has no holder is an " +
        "approval nobody can decide.",
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
