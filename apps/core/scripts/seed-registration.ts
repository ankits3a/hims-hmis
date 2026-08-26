import { createDb } from "../src/kernel/db/client";
import { registrationConfig } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";

/**
 * Seeds/updates the registration config (idempotent — the seed:admin convention).
 * Usage: UHID_PREFIX=U pnpm --filter @hmis/core seed:registration
 * The production prefix is an owner-gated go-live decision (Class A); dev uses a placeholder.
 *
 * ONE LETTER IS LEGAL SINCE 2026-08-25 (production runs `U`, replacing `CRK`). The prefix stayed
 * DATA rather than becoming a hardcoded "U" precisely so this stays the owner's decision and not
 * a code change — and the test suites deliberately keep seeding `HMS`, which is what proves no
 * later edit quietly baked the letter into `formatUhid`.
 */
async function main(): Promise<void> {
  const prefix = requireEnv("UHID_PREFIX");
  if (!/^[A-Z]{1,5}$/.test(prefix)) {
    throw new Error(`UHID_PREFIX must be 1–5 uppercase letters, got "${prefix}"`);
  }
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    await db
      .insert(registrationConfig)
      .values({ id: "main", uhidPrefix: prefix, updatedBy: "seed" })
      .onConflictDoUpdate({ target: registrationConfig.id, set: { uhidPrefix: prefix, updatedBy: "seed", updatedAt: new Date() } });
    console.log(`registration_config seeded: uhid_prefix=${prefix}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed seed exits non-zero, loudly
