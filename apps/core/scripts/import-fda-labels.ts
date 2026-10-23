/**
 * ═══ LOAD US FDA LABEL TEXT AS THE DRUG REFERENCE LAYER (#616, decision 0051) ═══
 *
 *   DATABASE_URL=… tsx scripts/import-fda-labels.ts --choices <coverage.json> --labels <drug-label-0001-of-0014.json> [--labels …]
 *       --retrieved <YYYY-MM-DD> --as <username> [--source "openFDA drug/label bulk export"] [--apply]
 *
 * `--choices` is the coverage run's file (`/opt/hmis-context/fda-coverage-2026-10-07/coverage.json`): for each US substance
 * key the best label, and which formulary substance names read as that key. `--labels` are the openFDA bulk files
 * (https://open.fda.gov/apis/downloads/ — `drug/label`, public domain, CC0), unzipped, as published (`{"results": […]}`)
 * or as JSON lines. Only the chosen labels are kept; a file is read one at a time. `--retrieved` is the date the export
 * was downloaded and is stored on every row. Dry run unless `--apply`. A second run with the same files changes nothing.
 *
 * Reference only: nothing loaded here feeds a dose or a safety check.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { importReferenceLabels } from "../src/modules/formulary";

const arg = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  const v = i < 0 ? undefined : args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
};
const all = (args: readonly string[], name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));

/** The chosen label ids of a coverage file. */
export function chosenLabelIds(choicesJson: string): Set<string> {
  const c = JSON.parse(choicesJson) as { substances?: Record<string, { label_id?: string }>; combinations?: Record<string, { label_id?: string }> };
  return new Set([...Object.values(c.substances ?? {}), ...Object.values(c.combinations ?? {})].flatMap((v) => (v.label_id === undefined ? [] : [v.label_id])));
}

/** One bulk file (published JSON or JSON lines) → the JSON lines of the chosen labels only. Pure. */
export function chosenLabelLines(fileText: string, wanted: ReadonlySet<string>): string[] {
  let records: unknown[];
  try {
    const whole = JSON.parse(fileText) as { results?: unknown[] } | unknown[];
    records = Array.isArray(whole) ? whole : Array.isArray(whole.results) ? whole.results : [whole];
  } catch {
    records = fileText.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
  }
  return records.filter((r): r is { id: string } => typeof (r as { id?: unknown }).id === "string" && wanted.has((r as { id: string }).id))
    .map((r) => JSON.stringify(r));
}

function main(): void {
  const args = process.argv.slice(2);
  const choicesPath = arg(args, "--choices");
  const files = all(args, "--labels");
  const retrievedOn = arg(args, "--retrieved");
  const username = arg(args, "--as");
  const source = arg(args, "--source") ?? "openFDA drug/label bulk export";
  const apply = args.includes("--apply");
  if (choicesPath === undefined || files.length === 0 || retrievedOn === undefined || username === undefined) {
    throw new Error("usage: --choices <coverage.json> --labels <file> [--labels <file> …] --retrieved <YYYY-MM-DD> --as <username> [--source <text>] [--apply]");
  }
  const choicesJson = readFileSync(choicesPath, "utf8");
  const wanted = chosenLabelIds(choicesJson);
  const lines: string[] = [];
  for (const f of files) {
    const got = chosenLabelLines(readFileSync(f, "utf8"), wanted);
    console.log(`  ${f}: ${String(got.length)} chosen labels`);
    lines.push(...got);
  }
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const person = (await db.select({ id: users.id, fullName: users.fullName, active: users.active }).from(users).where(eq(users.username, username)))[0];
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      if (!(await hasPermission(db, person.id, "formulary.manage", "hospital"))) throw new Error(`"${username}" does not hold formulary.manage`);
      const r = await importReferenceLabels(db, { type: "user", id: person.id }, { choicesJson, labelsJsonl: lines.join("\n"), source, retrievedOn, apply });
      console.log(`labels  added ${String(r.labels.added)} · changed ${String(r.labels.changed)} · unchanged ${String(r.labels.unchanged)} · chosen but not in the files ${String(r.labels.missing)}`);
      console.log(`names   added ${String(r.names.added)} · changed ${String(r.names.changed)} · unchanged ${String(r.names.unchanged)}`);
      console.log(apply ? `APPLIED (batch ${r.batch}).` : "DRY RUN — nothing written. Re-run with --apply.");
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
