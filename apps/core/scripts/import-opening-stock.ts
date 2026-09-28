import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { applyOpeningStock, planOpeningStock } from "../src/modules/pharmacy/opening-stock";
import { argValue, hasFlag, parseCsv, resolvePerson } from "./pharmacy-shelf-common";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/import-opening-stock.ts --file opening-stock.csv --as <storekeeper> --qc <pharmacist> [--head <materials_head>] [--apply]`
 *
 * The engineer's door to the opening-stock sheet. The planner, the refusals and the capture → QC → post
 * all live in `src/modules/pharmacy/opening-stock.ts` (gap closure A1, 2026-09-28), which the screen at
 * `/materials/grn` → Opening stock also calls. This file only names the people and prints the plan.
 * A sheet the screen already captured is picked up here and QC'd and posted, never captured twice.
 */

export {
  OPENING_VENDOR_CODE, applyOpeningStock, expiryOf, namesFor, norm, planOpeningStock, rupeesToPaise, similarity,
} from "../src/modules/pharmacy/opening-stock";
export type { OpeningGrn, OpeningPlan, OpeningRow } from "../src/modules/pharmacy/opening-stock";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const filePath = argValue(argv, "--file");
  if (filePath === undefined) throw new Error("usage: --file <opening-stock.csv> --as <storekeeper> --qc <pharmacist> [--head <materials_head>] [--apply]");
  const text = readFileSync(filePath, "utf8");
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const storekeeper = await resolvePerson(db, argValue(argv, "--as"), "materials.grn.capture", "--as");
    const qc = await resolvePerson(db, argValue(argv, "--qc"), "materials.grn.qc", "--qc");
    await resolvePerson(db, argValue(argv, "--qc"), "pharmacy.sale_items.manage", "--qc");
    const headName = argValue(argv, "--head");
    const head = headName === undefined ? null : await resolvePerson(db, headName, "materials.items.manage", "--head");
    if (head !== null) await resolvePerson(db, headName, "materials.vendors.manage", "--head");
    const now = new Date();
    const plan = await planOpeningStock(db, parseCsv(text), text, now);
    for (const r of plan.rows) {
      const tag = r.reasons.length > 0 ? "REFUSE" : r.near ? "near" : "ok";
      process.stdout.write(`  line ${String(r.line).padStart(4)}  ${tag.padEnd(6)} ${(r.itemCode ?? r.brand).padEnd(16)} ${r.batch.padEnd(14)} ${r.expiryDate}  ${String(r.packs)} × ${String(r.packSize)}${r.newUom ? " (new pack size)" : ""}  ${r.reasons.join("; ")}\n`);
    }
    process.stdout.write(
      `\nopening stock · file ${plan.fileHash} · ${String(plan.rows.length)} rows · REFUSE ${String(plan.refusals)} · ${String(plan.units)} units\n` +
      `  GRNs: ${plan.grns.map((g) => `${g.challanNo} (${String(g.rows.length)} lines, ${g.state})`).join(" · ") || "none"}\n` +
      `  new pack sizes ${String(plan.newUoms)} · racks to set ${String(plan.racks.length)} · rows with no purchase rate (cost 0) ${String(plan.zeroCost)}${plan.needsVendor ? " · the OPENING STOCK vendor will be created" : ""}\n`,
    );
    if (plan.refusals > 0) { process.stdout.write("\nNOTHING WAS WRITTEN — fix the refused rows; the sheet is received whole or not at all.\n"); process.exitCode = 1; return; }
    if (!hasFlag(argv, "--apply")) { process.stdout.write("\nDRY RUN — nothing written. Re-run with --apply.\n"); return; }
    const done = await applyOpeningStock(db, { storekeeper, qc, head }, plan, now);
    process.stdout.write(
      `\nAPPLIED in one transaction: ${String(done.posted)} GRN(s) posted (${String(done.unitsPosted)} units), ${String(done.awaiting)} awaiting near-expiry approval in /approvals, ` +
      `${String(done.uomsAdded)} pack size(s) added, ${String(done.racksSet)} rack(s) set${done.vendorCreated ? ", OPENING STOCK vendor created" : ""}.\n`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
