import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { formatBedLayoutReport, loadBedLayout, parseBedLayoutCsv } from "../src/modules/ipd";
import { argValue, hasFlag, resolvePerson } from "./pharmacy-shelf-common";
import type { BedLayoutReport } from "../src/modules/ipd";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/load-bed-layout.ts --file <layout.csv> --by <username> [--apply]`
 * (in the server image: `node dist/scripts/load-bed-layout.js …`).
 *
 * E0.3 — puts the hospital's floors, wards, halls, rooms and beds into the resource registry from one
 * spreadsheet (one row per bed; columns in `BED_LAYOUT_COLUMNS`, `src/modules/ipd/bed-layout.ts`).
 * Dry run by default: it validates the whole file, prints counts per class and per unit type and the
 * diff against the registry, and writes nothing. `--apply` writes, in one transaction. It never
 * deletes or retires a place.
 *
 * NOT a seed, and deliberately run by nobody but a person: `docker/prod/deploy.sh` runs every seed on
 * every deploy, and the hospital's bed list is data someone chooses to load.
 *
 * `--by` names the person the rows are recorded against. DECIDED (E0.3): until the bed board lane
 * declares IPD's own bed-master permission, that person must hold `auth.users.manage` — the
 * technical administrator who sets the hospital up.
 */
export const BED_LAYOUT_LOADER_PERMISSION = "auth.users.manage";

export async function runBedLayoutLoad(
  db: Db, argv: readonly string[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<{ report: BedLayoutReport; text: string }> {
  const file = argValue(argv, "--file");
  if (file === undefined) throw new Error("usage: --file <layout.csv> --by <username> [--apply]");
  const person = await resolvePerson(db, argValue(argv, "--by"), BED_LAYOUT_LOADER_PERMISSION, "--by");
  const rows = parseBedLayoutCsv(readFile(file));
  const report = await loadBedLayout(db, { type: "user", id: person.id }, rows, { apply: hasFlag(argv, "--apply") });
  return { report, text: formatBedLayoutReport(report) };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("load-bed-layout: DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    const { text } = await runBedLayoutLoad(db, process.argv.slice(2));
    console.log(text);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
