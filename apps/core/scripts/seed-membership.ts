import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { registerMembershipApprovalTypes } from "../src/modules/membership";
import type { Actor } from "@hmis/contracts";

/**
 * Registers the O-1 grace-honor approval type (and nothing else).
 *
 * ═══ IT SEEDS NO CATALOG, AND THAT IS THE POINT (DD3 / owner ruling O-9) ═══
 *
 * Every plan, card, coupon, partner and rate this hospital will use is a CONFIGURATION ROW loaded
 * at commissioning from files the owner supplies out of git. Nothing in `apps/` may contain one,
 * and the property that makes that checkable without committing the forbidden values is stated as
 * its opposite: a freshly migrated database has empty catalogs, and no seed script fills them.
 * `modules/membership/catalogs-empty.test.ts` scans this directory for exactly that.
 *
 * So the only thing here is the approval type — which is not data about a partner, it is the
 * hospital's own decision procedure — and it exists because an approval type reaches a real
 * deployment ONLY through a `seed:*` script (`seed-roles.ts` says so in as many words). Without
 * this file the grace-honor path would be registered in tests and nowhere else, and a deployed
 * hospital would have an O-1 lane that nobody could ever approve (§6.0 S3).
 *
 * ═══ NON-DESTRUCTIVE ON RE-RUN, WHICH IS WHY IT LIVES IN THE DEPLOY PATH ═══
 *
 * `registerMembershipApprovalTypes` skips a type that already exists, so a second run drafts no
 * redundant workflow-definition version and registers nothing twice. That property is what lets
 * `docker/prod/deploy.sh` run it on EVERY deploy rather than once at bootstrap (§6.0 S14), beside
 * `seed:billing` and `seed:tariff` and BEFORE `seed:roles` — whose census counts what the other
 * seeds have already granted.
 *
 * Usage: pnpm --filter @hmis/core seed:membership
 */

/**
 * `registerApprovalType` and `activateDefinition` both require a "user"-typed actor structurally,
 * and neither checks a real `users` row (there is no FK on `draftedBy`/`activatedBy`), so a fixed
 * script identity is sufficient and needs no new env var — the `seed-billing.ts` convention. It
 * must differ from the module's own drafter id, because the SoD pair check is same-ID.
 */
const activator: Actor = { type: "user", id: "seed-membership" };

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await seedSodPairs(db);
    await registerMembershipApprovalTypes(db, activator);
    console.log("approval types ensured: membership_grace_honor");
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
