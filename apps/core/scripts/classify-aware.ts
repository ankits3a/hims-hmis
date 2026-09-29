import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { classifyAwareMedicines } from "../src/modules/formulary";
import { activeStewards } from "../src/modules/pharmacy";
import type { AwareClassificationReport } from "../src/modules/formulary";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * STAGE D5 GO-LIVE — `aware:classify`: write the WHO AWaRe 2023 class onto the catalogue and raise the restricted flag
 * on every Reserve antibiotic and carbapenem (`classifyAwareMedicines`; a class a pharmacist set is never
 * overwritten, the flag is only raised).
 *
 * This is deliberately NOT part of `seed:pharmacy`. Restricting a medicine turns on the D5 gate for it at both
 * counters, and deploy.sh runs `seed:pharmacy` on every deploy — so a classifying seed would refuse meropenem,
 * colistin and the rest in production the moment the code shipped. Run this by hand, once, after the hospital has
 * appointed its antimicrobial steward; it refuses before then, naming what to do. Idempotent: a second run changes
 * nothing.
 *
 *   pnpm --filter @hmis/core aware:classify        (prod: compose run --rm api node dist/scripts/classify-aware.js)
 */
const activator: Actor = { type: "user", id: "aware-classify" };

export async function classifyAwareGoLive(db: Db, actor: Actor): Promise<AwareClassificationReport> {
  if ((await activeStewards(db)).length === 0) {
    throw new Error(
      "refusing to classify: nobody holds the antimicrobial_steward role, so every restricted antimicrobial would be " +
        "refused at both counters with no one able to approve it. Appoint the steward at /admin/users first (the " +
        "infectious-disease physician, else the clinical microbiologist, else the AMSP lead the medical superintendent names).",
    );
  }
  return withTx(db, (tx) => classifyAwareMedicines(tx, actor));
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await classifyAwareGoLive(db, activator);
    console.log(JSON.stringify({ script: "aware:classify", ...report }));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
