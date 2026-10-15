import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { backfillCdsRxLines } from "../src/modules/opd/cds-rx-lines";

/**
 * Decision 0050, phase P0 — `pnpm --filter @hmis/core exec tsx scripts/backfill-cds-rx-lines.ts`
 *
 * Rewrites `cds_rx_lines` (the countable copy of every visit's standing prescription) from the
 * stored prescriptions and prints how much of the history read cleanly: how many doses parsed into
 * an amount and a unit, how many frequencies fell outside the closed set, and the commonest dose
 * texts that did not parse. Idempotent — a second run writes the same rows and prints the same
 * numbers. It reads prescriptions and writes only `cds_rx_lines`; no prescription is changed.
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const r = await backfillCdsRxLines(db);
    const share = r.lines === 0 ? 0 : Math.round((r.doseUnparsed / r.lines) * 1000) / 10;
    process.stdout.write(`prescriptions ${r.prescriptions} · lines ${r.lines} · dose parsed ${r.doseParsed} · dose not parsed ${r.doseUnparsed} (${share}%) · frequency outside the closed set ${r.frequencyOther}\n`);
    for (const u of r.unparsedDoses) process.stdout.write(`  not parsed ×${u.times}: ${JSON.stringify(u.dose)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
