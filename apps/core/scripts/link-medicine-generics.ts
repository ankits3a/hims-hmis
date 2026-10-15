/**
 * ═══ FILL `formulary_medicines.generic_sctid` FROM THE BUNDLE THE BRANDS CAME FROM (owner 2026-10-02) ═══
 *
 *   DATABASE_URL=… tsx scripts/link-medicine-generics.ts --bundle <cds-bundle.sql>            # dry run
 *   DATABASE_URL=… tsx scripts/link-medicine-generics.ts --bundle <cds-bundle.sql> --apply
 *
 * `import-cds-catalogue` wrote every brand without the generic the bundle names for it. This reads the same
 * bundle's `medicines_brands (medicine_sctid, generic_sctid)` pairs and hands them to
 * `linkMedicinesToGenerics`, which fills only EMPTY links and links each generic's own row to itself.
 *
 * The dry run does the whole act inside a transaction and rolls it back, so the counts it prints are the
 * counts the apply will print: a plan that can differ from the act is not a plan. Run it again after any
 * catalogue import; a second run changes nothing.
 */
import { readFileSync } from "node:fs";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { linkMedicinesToGenerics } from "../src/modules/formulary";
import { rowsOf } from "./import-cds-catalogue";
import type { GenericLinkReport } from "../src/modules/formulary";

class DryRun extends Error {
  constructor(readonly report: GenericLinkReport) { super("dry run"); }
}

/**
 * The bundle's brand → generic pairs. A brand with no generic named is left out, not passed as an empty link:
 * both ids must be SNOMED CT ids (digits), which also drops the bundle's unquoted NULL.
 */
export function brandGenericPairs(bundleText: string): { medicineSctid: string; genericSctid: string }[] {
  return rowsOf(bundleText, "medicines_brands")
    .map((r) => ({ medicineSctid: (r["medicine_sctid"] ?? "").trim(), genericSctid: (r["generic_sctid"] ?? "").trim() }))
    .filter((p) => /^\d+$/.test(p.medicineSctid) && /^\d+$/.test(p.genericSctid));
}

function main(): void {
  const args = process.argv.slice(2);
  const bundle = args[args.indexOf("--bundle") + 1];
  const apply = args.includes("--apply");
  if (!args.includes("--bundle") || bundle === undefined || bundle.startsWith("--")) throw new Error("usage: --bundle <cds-bundle.sql> [--apply]");
  const pairs = brandGenericPairs(readFileSync(bundle, "utf8"));
  console.log(`bundle: ${String(pairs.length)} brand → generic pairs`);

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    let report: GenericLinkReport;
    try {
      report = await withTx(db, async (tx) => {
        const r = await linkMedicinesToGenerics(tx, pairs);
        if (!apply) throw new DryRun(r);
        return r;
      });
    } catch (e) {
      if (!(e instanceof DryRun)) { await pool.end(); throw e; }
      report = e.report;
    }
    console.log(`  brands linked           ${String(report.linkedBrands)}`);
    console.log(`  generic rows self-linked ${String(report.linkedOwnRows)}`);
    console.log(`  generics not in formulary ${String(report.unknownGeneric)} (their brands stay unlinked)`);
    console.log(apply ? "APPLIED." : "DRY RUN — rolled back, nothing written. Re-run with --apply.");
    await pool.end();
  })();
}

if (require.main === module) main();
