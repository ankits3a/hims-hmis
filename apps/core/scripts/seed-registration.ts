import { createDb } from "../src/kernel/db/client";
import { registrationConfig } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";

/**
 * Seeds/updates the registration config (idempotent — the seed:admin convention).
 * Usage: UHID_PREFIX=HMS pnpm --filter @hmis/core seed:registration
 * The production prefix is an owner-gated go-live decision (Class A); dev uses a placeholder.
 */
async function main(): Promise<void> {
  const prefix = requireEnv("UHID_PREFIX");
  if (!/^[A-Z]{2,5}$/.test(prefix)) {
    throw new Error(`UHID_PREFIX must be 2–5 uppercase letters, got "${prefix}"`);
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
