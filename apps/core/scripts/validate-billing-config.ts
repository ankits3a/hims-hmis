// scripts/validate-billing-config.ts — D-17: run before the first live invoice; go-live requires
// ok:true printed by THIS script.
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { validateBillingConfig } from "../src/modules/billing/config";

/**
 * Unlike scripts/validate-tariff-config.ts, this emits NO event: billing's catalog is a CLOSED
 * set of exactly twenty D-Events names (Global Constraints — catalog discipline), and
 * config-validation is not one of them.
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await validateBillingConfig(db);
    for (const err of report.errors) console.log(`ERROR ${err.code}: ${err.detail}`);
    console.log(`config-validation: ok=${String(report.ok)} errors=${report.errors.length}`);
    if (!report.ok) process.exit(1);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // seed-script convention: fail loud, exit non-zero
