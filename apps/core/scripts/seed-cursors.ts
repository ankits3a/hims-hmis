import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedCursors } from "../src/kernel/worker/seed-cursors";

/**
 * D10/D13 — the thin runner deploy.sh calls between migrations and the api/worker/caddy coming
 * up (`node dist/scripts/seed-cursors.js`), so a first boot against a database that already
 * carries history does not walk the entire event log through the dispatcher. Idempotent
 * (`seedCursors`'s `greatest()` never lowers an existing cursor — V11), so it stays in the
 * re-deploy path forever: a consumer already caught up is left exactly where it is.
 *
 * Usage: node dist/scripts/seed-cursors.js (production, via deploy.sh)
 *        pnpm --filter @hmis/core exec tsx scripts/seed-cursors.ts (dev, ad hoc)
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const seeded = await seedCursors(db);
    if (seeded.length === 0) {
      console.log("seed-cursors: no production consumers registered — nothing to seed");
      return;
    }
    for (const { consumer, lastSeq } of seeded) {
      console.log(`seed-cursors: ${consumer} -> last_seq=${lastSeq}`);
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
