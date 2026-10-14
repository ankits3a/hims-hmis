import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { importIpdTariff, IPD_TARIFF_CSV_COLUMNS, resolveIpdImportActor } from "../src/modules/tariff";

/**
 * `node dist/scripts/import-ipd-tariff.js <file.csv> --by <username> [--apply]`
 *
 * ═══ E0.4 — THE INCUMBENT'S IPD TARIFF, LINE BY LINE, INTO A DRAFT (decision 0072 answer 2) ═══
 *
 * Columns: incumbent_code, incumbent_name, bed_class, component, rate_rupees. Leave bed_class AND
 * component blank on an incumbent line that is not a class × component daily rate: it is printed back
 * in the "unmapped lines" list, never dropped. Any bad row refuses the whole file and writes nothing.
 *
 * A valid file makes a NEW DRAFT tariff version copied from the one in force, with the IPD rates set on
 * it, and prints old vs new per item. Dry run by default. It never submits and never activates: the
 * owner reviews the draft in the billing office's price list (IPD rate card) and the approval road puts
 * it in force. `--by` must be an ACTIVE account holding `tariff.versions.draft`.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("import-ipd-tariff: DATABASE_URL is not set");
  const args = process.argv.slice(2);
  const byAt = args.indexOf("--by");
  const by = byAt >= 0 ? args[byAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && i !== byAt + 1);
  if (file === undefined || by === undefined || by.startsWith("--")) {
    throw new Error(`usage: import-ipd-tariff <file.csv> --by <username> [--apply]  (columns: ${IPD_TARIFF_CSV_COLUMNS.join(", ")})`);
  }
  const apply = args.includes("--apply");
  const csv = readFileSync(file, "utf8");
  const { db, pool } = createDb(url);
  try {
    const actor = await resolveIpdImportActor(db, by);
    const r = await importIpdTariff(db, actor, csv, { apply });
    const rupees = (p: number | null): string => (p === null ? "—" : `₹${(p / 100).toFixed(2)}`);
    if (!r.ok) {
      console.log(`REFUSED — ${r.errors.length} problem(s); nothing was written:`);
      for (const e of r.errors) console.log(`  ${e.line === null ? "file" : `line ${e.line}`}: ${e.problem}`);
    } else {
      console.log(`IPD rates (${r.items.length}) — old (version ${r.copiedFromVersionNo ?? "none in force"}) → new:`);
      for (const i of r.items) {
        console.log(`  line ${i.line}  ${i.serviceCode.padEnd(26)} ${rupees(i.oldPaise).padStart(12)} → ${rupees(i.pricePaise).padStart(12)}   [${i.incumbentCode} ${i.incumbentName}]`);
      }
      if (r.servicesCreated.length > 0) console.log(`services ${r.applied ? "created" : "to create"} (inactive until IPD go-live): ${r.servicesCreated.join(", ")}`);
    }
    console.log(`unmapped lines (${r.unmapped.length}) — incumbent IPD items that are not a class × component rate:`);
    for (const m of r.unmapped) console.log(`  line ${m.line}  ${m.incumbentCode}  ${m.incumbentName}  ${m.rateRupees}`);
    if (r.ok) {
      console.log(r.applied && r.draft !== null
        ? `DRAFT tariff version ${r.draft.versionNo} written (${r.draft.versionId}) — review it in Billing office → Prices → IPD rate card, then submit for approval`
        : "dry run: nothing written (add --apply to write the draft)");
    }
    if (!r.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
