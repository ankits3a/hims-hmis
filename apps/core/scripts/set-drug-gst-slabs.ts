import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { GST_NOTIFICATION, applyGstSlabPlan, gstSlabPlan } from "../src/modules/pharmacy";

/**
 * `node dist/scripts/set-drug-gst-slabs.js --as <username> [--apply] [--overwrite]`
 *
 * PHARMACY P16 — every active drug item's GST slab, from the notification (see
 * `modules/pharmacy/gst-slab.ts`): 5% for medicaments, nil for the 36 listed drugs.
 *   - a BLANK slab is set to the suggestion;
 *   - a slab that DIFFERS is reported and left alone, unless `--overwrite`;
 *   - a sale item whose tariff category no longer matches its item's slab is brought back to it,
 *     so the bill taxes at the slab.
 * Dry run by default: it prints the plan and writes nothing. `--as` names the person the change is
 * recorded against; they must hold `pharmacy.sale_items.manage`. An operator command, not a deploy
 * step: the rates belong to the hospital's CA to confirm, and this is the list to show them.
 */
function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const overwrite = args.includes("--overwrite");
  const username = arg(args, "--as");
  if (username === undefined) throw new Error("usage: --as <username> [--apply] [--overwrite]");
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const [person] = await db.select({ id: users.id, fullName: users.fullName, active: users.active }).from(users).where(eq(users.username, username));
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      if (!(await hasPermission(db, person.id, "pharmacy.sale_items.manage", "hospital"))) {
        throw new Error(`"${username}" does not hold pharmacy.sale_items.manage`);
      }
      const plan = await gstSlabPlan(db);
      const pct = (bps: number | null): string => (bps === null ? "blank" : `${String(bps / 100)}%`);
      console.log(`GST slabs · ${String(plan.length)} active drug items · rule: 5% for medicaments; nil per ${GST_NOTIFICATION}`);
      for (const verdict of ["set", "differs", "unknown"] as const) {
        const rows = plan.filter((p) => p.verdict === verdict);
        console.log(`  ${verdict.padEnd(8)} ${String(rows.length)}`);
        for (const r of rows.slice(0, 200)) console.log(`    ${r.code.padEnd(14)} ${pct(r.current)} → ${pct(r.suggested)}  ${r.name}${r.basis !== null && r.suggested === 0 ? `  [${r.basis}]` : ""}`);
      }
      console.log(`  ok       ${String(plan.filter((p) => p.verdict === "ok").length)}`);
      console.log(`  stale sale categories ${String(plan.filter((p) => p.categoryStale).length)}`);
      if (!apply) {
        console.log("\nDRY RUN — nothing written. Re-run with --apply (and --overwrite to replace the slabs that differ).");
        return;
      }
      const r = await applyGstSlabPlan(db, { type: "user", id: person.id }, plan, { overwrite });
      console.log(`\nAPPLIED as ${username} (${person.fullName}): ${String(r.slabsSet)} slab(s) set, ${String(r.categoriesSynced)} sale categor(ies) brought to their slab.`);
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
