import { sql } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { criticalReadbackByWeek } from "../src/modules/lab";

/**
 * E3.2 (#595) / goal G5 (decision 0064) — how long a lab critical waits for its read-back, per ISO
 * week (IST): count, median and p95 minutes of `closed_at − opened_at` over closed calls.
 *
 * READ-ONLY. The query runs inside `SET TRANSACTION READ ONLY`, so the database itself refuses any
 * write. Safe against production:
 *
 *   dev:   pnpm --filter @hmis/core exec tsx scripts/g5-critical-readback.ts [--since 2026-10-01]
 *   prod:  node dist/scripts/g5-critical-readback.js [--since 2026-10-01]
 */
async function main(): Promise<void> {
  const at = process.argv.indexOf("--since");
  const since = at > -1 && process.argv[at + 1] !== undefined ? new Date(`${process.argv[at + 1]!}T00:00:00+05:30`) : undefined;
  if (since !== undefined && Number.isNaN(since.getTime())) throw new Error("--since takes a date: YYYY-MM-DD");

  const { db, pool } = createDb(requireEnv("DATABASE_URL"), { defaultMax: 1 });
  try {
    const weeks = await withTx(db, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return criticalReadbackByWeek(tx, since === undefined ? {} : { since });
    });
    console.log("week       count  median_min  p95_min");
    for (const w of weeks) {
      console.log(`${w.week.padEnd(10)} ${String(w.count).padStart(5)}  ${w.medianMin.toFixed(1).padStart(10)}  ${w.p95Min.toFixed(1).padStart(7)}`);
    }
    if (weeks.length === 0) console.log("(no read-back critical calls in range)");
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
