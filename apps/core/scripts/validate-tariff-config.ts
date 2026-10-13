// scripts/validate-tariff-config.ts — D-17: run before first live invoice; go-live requires ok:true printed by THIS script.
import { createDb, withTx } from "../src/kernel/db/client";
import { appendEvent } from "../src/kernel/events/append";
import { requireEnv } from "../src/kernel/config";
import { configValidated, ipdRateCardWarnings, validateTariffConfig } from "../src/modules/tariff";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await validateTariffConfig(db, new Date());
    for (const err of report.errors) console.log(`ERROR ${err.code}: ${err.detail}`);
    // E0.4 — the IPD rate card go-live check. WARNINGS only while IPD is not live: they never change ok or the exit code.
    for (const w of await ipdRateCardWarnings(db, new Date())) console.log(`WARN ${w.code}: ${w.detail}`);
    console.log(`config-validation: ok=${String(report.ok)} errors=${report.errors.length} caSigned=${String(report.caSigned)}`);
    const { eventId } = await withTx(db, (tx) =>
      appendEvent(tx, configValidated.make({
        actor: { type: "system", id: "validate-tariff-config" },
        payload: { scope: "tariff", ok: report.ok, errorCount: report.errors.length, caSigned: report.caSigned },
      })),
    );
    console.log(`config.validated emitted: ${eventId}`);
    if (!report.ok) process.exit(1);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); }); // seed-script convention: fail loud, exit non-zero
