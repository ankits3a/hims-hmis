import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { collectDeskProviders } from "../src/kernel/desk/registry";
import { LOOKBACK_DAYS, addDays, rollupAll } from "../src/kernel/desk/rollup";
import { istDayString as istDay } from "../src/kernel/approvals/cumulative";

/**
 * PHASE STAFF-REPORTS T2 — THE BACKFILL, AND IT IS A CLI OVER THE NIGHTLY ROLL RATHER THAN A
 * SECOND LOOP.
 *
 * ═══ WHY IT EXISTS ═══
 *
 * `user_day_facts` stores a bag of named integers per person per day, and the nightly job re-rolls
 * `LOOKBACK_DAYS` — THREE — days back. So a fact key added today (T1's `opd.visitsNew`,
 * `opd.visitsRevisit`, `opd.visitsRenewal`) is ABSENT for every day before that window, and the
 * brief renders an absent key as nothing at all.
 *
 * That silence is the dangerous part. `requireSubject`'s comment names the failure: an empty answer
 * is indistinguishable from a person who did nothing. A supervisor opening a six-month brief the
 * day after T1 ships would see three new figures that begin abruptly last Tuesday, and no part of
 * the screen would say why.
 *
 * ═══ WHY IT IS NOT ITS OWN FUNCTION ═══
 *
 * The plan asked for a runner over an explicit `--from`/`--to`. Measured at kickoff, `rollupAll`
 * ALREADY takes a `lookback` and already rolls that many days ending YESTERDAY — which is the only
 * shape a backfill needs — and its properties are already proven in `rollup.test.ts`: A2 that a
 * second roll of one day changes nothing and writes one row, A5 that a day which gained a visit
 * after it was rolled is correct again on the next roll, and A3 that TODAY IS NEVER WRITTEN.
 *
 * A separate backfill loop would have to re-earn all three, and `rollup.ts`'s own header says why
 * that is the wrong trade: *"There is no second query written 'the fast way' for the rollup and
 * 'the correct way' for today, because that pair is exactly how a pair of answers diverges."* A
 * backfill that drifted from the nightly job would write history the nightly job then disagreed
 * with, one day at a time, invisibly.
 *
 * So this file is argument parsing, a progress line and an exit code. The work is `rollupAll`.
 *
 * ═══ SAFE TO RE-RUN, AND SAFE TO INTERRUPT ═══
 *
 * `(user_id, day)` is the primary key and `rollupUserDay` upserts, so a run that dies halfway can
 * simply be run again. Nothing compensates, nothing accumulates.
 *
 * ═══ `--days` HAS NO DEFAULT, DELIBERATELY ═══
 *
 * The cost is users x days x every provider's queries. A year across a few dozen staff is tens of
 * thousands of rollups and takes a while — fine for a one-off, wrong to trigger by pressing enter
 * on a script whose name sounds harmless. The operator states the number.
 */
function parseDays(argv: string[]): number {
  const raw = argv.find((a) => a.startsWith("--days="))?.slice("--days=".length);
  if (raw === undefined) {
    throw new Error(
      "usage: backfill:facts --days=N\n"
      + "  N is how many days BACK FROM YESTERDAY to re-roll. 365 is the usual answer — it is the\n"
      + "  span the `year` period reads. Today is never written: it is still happening, and the\n"
      + "  window reader computes it live and marks it provisional.",
    );
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive whole number, got ${raw}`);
  return days;
}

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const now = new Date();
    const today = istDay(now);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    const providers = collectDeskProviders(registry);

    const oldest = addDays(today, -days);
    const newest = addDays(today, -1);
    console.log(`backfilling user_day_facts for ${oldest} .. ${newest} (${days} days ending yesterday)`);
    console.log(`today (${today}) is NOT written — it is computed live and marked provisional`);
    console.log(`the nightly job's own window is ${LOOKBACK_DAYS} days; this run is ${days}`);

    const started = Date.now();
    const report = await rollupAll(db, providers, today, now, days);
    const seconds = Math.round((Date.now() - started) / 1000);

    console.log(`rolled ${report.rows} row(s): ${report.users} active user(s) x ${report.days} day(s), in ${seconds}s`);
    console.log("safe to re-run: (user_id, day) is the primary key and every roll recomputes from the source tables");
  } finally {
    await pool.end();
  }
}

// Guarded so a test can import `parseDays` without the script running itself on import — the
// `seed-roles.ts` convention, and for its reason: apps/core declares no `"type": "module"`.
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

export { parseDays };
