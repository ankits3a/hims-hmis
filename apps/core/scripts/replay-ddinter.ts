/**
 * ═══ REPLAY STORED PRESCRIPTIONS WITH AND WITHOUT THE DDINTER REFERENCE LAYER (#617, decision 0052) ═══
 *
 *   DATABASE_URL=… tsx scripts/replay-ddinter.ts [--days 90]
 *
 * Reads only. Counts, over the active prescriptions issued in the last `--days` days, the prescriptions warned and the
 * warnings with the curated book alone and with the DDInter reference pairs added, and the ratio. Decision 0052: if the
 * warning rate more than doubles, the numbers go to the owner before `DDINTER_REFERENCE_ENABLED` is turned on.
 */
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { countReferenceInteractions, ddinterReferenceEnabled, replayReferenceInteractions } from "../src/modules/formulary";

const DAY_MS = 24 * 60 * 60 * 1000;

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf("--days");
  const days = i < 0 ? 90 : Number(args[i + 1]);
  if (!Number.isInteger(days) || days < 1) throw new Error("usage: [--days <whole number ≥ 1>]");
  const until = new Date();
  const since = new Date(until.getTime() - days * DAY_MS);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
      console.log(`reference pairs loaded ${String(await countReferenceInteractions(db))} · switch ${ddinterReferenceEnabled() ? "ON" : "OFF"}`);
      const r = await replayReferenceInteractions(db, { since, until });
      console.log(`window  ${since.toISOString()} → ${until.toISOString()} · ${String(r.prescriptions)} prescriptions`);
      console.log(`curated only     warned ${String(r.curatedOnly.prescriptionsWarned)} (${pct(r.rateCurated)}) · warnings ${String(r.curatedOnly.warnings)}`);
      console.log(`with reference   warned ${String(r.withReference.prescriptionsWarned)} (${pct(r.rateWithReference)}) · warnings ${String(r.withReference.warnings)}`);
      console.log(`ratio ${r.ratio === null ? "n/a (curated warned on none)" : r.ratio.toFixed(2)} · ${r.moreThanDoubles ? "MORE THAN DOUBLES — owner decides before switching on" : "within twice — owner still decides"}`);
      for (const p of r.topReferencePairs) console.log(`  ${String(p.prescriptions).padStart(5)}  ${p.note}`);
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
