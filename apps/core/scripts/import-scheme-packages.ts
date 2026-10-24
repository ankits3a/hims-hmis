import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { IPD_PAYER_TERMS, importSchemePackages } from "../src/modules/ipd";
import { argValue, hasFlag, resolvePerson } from "./pharmacy-shelf-common";
import type { IpdPackageImportResult } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/import-scheme-packages.ts --file <hbp.csv> --scheme pmjay|state_scheme --by <username> [--apply]`
 * (in the server image: `node dist/scripts/import-scheme-packages.js …`).
 *
 * #604 (decision 0075) — loads the PM-JAY Health Benefit Package list (NHA HBP) or a state scheme's list into the package
 * master. Column names follow NHA's sheet ("Procedure Code", "Procedure Name", "Speciality", "Procedure Price",
 * "Procedure Type", "Pre-auth Required"); see `src/modules/ipd/tpa-packages.ts`. Dry run by default; `--apply` writes in
 * one transaction. It adds and updates; it never retires a package the file leaves out.
 *
 * NOT a seed: the scheme's list is data the owner downloads and chooses to load. `scripts/data/nha-hbp-sample.csv` is
 * eight SYNTHETIC rows for a rehearsal — it is not the NHA list.
 *
 * `--by` must hold `ipd.payer.terms` (the billing manager): a package rate is the payer amount of every stay that picks it.
 */
export async function runSchemePackageImport(
  db: Db, argv: readonly string[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<IpdPackageImportResult> {
  const file = argValue(argv, "--file");
  const scheme = argValue(argv, "--scheme");
  if (file === undefined || (scheme !== "pmjay" && scheme !== "state_scheme")) {
    throw new Error("usage: --file <hbp.csv> --scheme pmjay|state_scheme --by <username> [--apply]");
  }
  const person = await resolvePerson(db, argValue(argv, "--by"), IPD_PAYER_TERMS, "--by");
  return importSchemePackages(db, { type: "user", id: person.id }, { scheme, csv: readFile(file), apply: hasFlag(argv, "--apply") });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("import-scheme-packages: DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    const r = await runSchemePackageImport(db, process.argv.slice(2));
    console.log(`${r.applied ? "applied" : "dry run"}: ${String(r.rows)} rows — ${String(r.added)} new, ${String(r.changed)} changed, ${String(r.unchanged)} unchanged (batch ${r.batch})`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const detail = (e as { detail?: { problems?: string[] } }).detail?.problems;
    console.error(e instanceof Error ? e.message : e);
    if (detail !== undefined) for (const p of detail) console.error(`  ${p}`);
    process.exit(1);
  });
}
