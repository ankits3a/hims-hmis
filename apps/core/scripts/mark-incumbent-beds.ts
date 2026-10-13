import { readFileSync } from "node:fs";
import { createDb } from "../src/kernel/db/client";
import { IPD_BEDS_MANAGE, markIncumbentBeds } from "../src/modules/ipd";
import { argValue, hasFlag, resolvePerson } from "./pharmacy-shelf-common";
import type { IncumbentBedLine, IncumbentBedReport } from "../src/modules/ipd";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/mark-incumbent-beds.ts --file <beds.txt> --by <username> [--apply]`
 * (in the server image: `node dist/scripts/mark-incumbent-beds.js …`).
 *
 * E1.1 (#718) — CUTOVER NIGHT (spec §4.1, §4.10 edge 28): beds still holding the old system's patients are shown
 * occupied as "incumbent" and released by a tap on the board when the old system discharges the patient.
 *
 * The file is one bed code per line, optionally followed by a comma and the patient's gender (M or F), which
 * fixes a twin-share room's gender for the next admission: `F05-ORT-M-B12` or `F05-ORT-T-R3-B1,F`. Blank lines and
 * lines starting with # are skipped. Dry run by default: every line is checked and nothing is written. `--apply`
 * marks every bed in one transaction, and only when no line has a problem. Re-running is a no-op.
 *
 * NOT a seed (`docker/prod/deploy.sh` runs every seed on every deploy). `--by` must hold `ipd.beds.manage`.
 */
export function parseIncumbentLines(text: string): { lines: IncumbentBedLine[]; problems: string[] } {
  const lines: IncumbentBedLine[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) return;
    const [code, sex, ...extra] = t.split(",").map((c) => c.trim());
    const g = (sex ?? "").toUpperCase();
    if (!code || extra.length > 0 || (g !== "" && g !== "M" && g !== "F")) {
      problems.push(`line ${String(i + 1)}: expected "BEDCODE" or "BEDCODE,M|F", got "${t}"`);
      return;
    }
    lines.push(g === "" ? { code } : { code, gender: g === "M" ? "male" : "female" });
  });
  return { lines, problems };
}

export function formatIncumbentReport(r: IncumbentBedReport, applied: boolean): string {
  const out = [
    `${applied && r.problems.length === 0 ? "Marked" : "Would mark"} ${String(r.mark.length)} bed(s) incumbent; already incumbent: ${String(r.already.length)}.`,
    ...r.problems.map((p) => `PROBLEM ${p.code}: ${p.problem}`),
  ];
  if (r.problems.length > 0) out.push("Nothing was written: fix every problem and run again.");
  else if (!applied) out.push("Dry run: nothing written. Add --apply to mark.");
  return out.join("\n");
}

export async function runMarkIncumbentBeds(
  db: Db, argv: readonly string[], readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<{ report: IncumbentBedReport; text: string; ok: boolean }> {
  const file = argValue(argv, "--file");
  if (file === undefined) throw new Error("usage: --file <beds.txt> --by <username> [--apply]");
  const person = await resolvePerson(db, argValue(argv, "--by"), IPD_BEDS_MANAGE, "--by");
  const parsed = parseIncumbentLines(readFile(file));
  if (parsed.problems.length > 0) throw new Error(parsed.problems.join("\n"));
  const apply = hasFlag(argv, "--apply");
  const report = await markIncumbentBeds(db, { type: "user", id: person.id }, parsed.lines, { apply });
  return { report, text: formatIncumbentReport(report, apply), ok: report.problems.length === 0 };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("mark-incumbent-beds: DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    const { text, ok } = await runMarkIncumbentBeds(db, process.argv.slice(2));
    console.log(text);
    if (!ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
