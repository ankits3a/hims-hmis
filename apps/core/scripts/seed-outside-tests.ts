import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedOutsideTests } from "../src/modules/ordering";

/**
 * `pnpm seed:outside-tests` — the owner's starting outside-test list (decision 0065): ECG, 2D echo,
 * TMT, PFT, EEG, NCV, upper GI endoscopy, colonoscopy, Holter and audiometry. Adds a code only when
 * it is missing and never changes a row the administrator has edited, so it runs on every deploy.
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const { added } = await seedOutsideTests(db, { type: "system", id: "seed-outside-tests" });
    console.log(`seed:outside-tests — ${String(added)} added`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
