import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { opdDoctors } from "../src/kernel/db/schema";
import { updateDoctor } from "../src/modules/opd/masters";
import { publisher } from "./seed-roster-demo";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core fix:designations` (dry run) · `… --apply` — **MOVE A DESIGNATION OUT OF
 * THE SPECIALTY** (2026-10-04).
 *
 * Until migration 0177 there was no `opd_doctors.designation`, so staging's provisioning on 2026-10-04
 * typed designations into `specialty`: "Guest Faculty", "Assistant Professor & Deputy Superintendent",
 * "Assistant Professor (Neurosurgeon)". A specialty is a clinical fact (Neurosurgeon) and a designation
 * is a post in this hospital; the desk shows the second as a tag. This moves a KNOWN designation out:
 *
 *   · the whole specialty is a designation      → designation = it, specialty = none;
 *   · "<designation> (<specialty>)"             → designation = the first, specialty = the bracket
 *                                                 ("Assistant Professor (Neurosurgeon)" keeps Neurosurgeon);
 *   · anything else ("Cardiology")              → untouched.
 *
 * A designation already on file that DIFFERS is reported and left; one that is the same just has the
 * specialty cleared. Writes go through `updateDoctor`, as the MS. Dry run by default; idempotent — a
 * second run finds nothing to move.
 */

const DESIGNATION = /^(visiting\s*\/\s*)?(guest faculty|visiting faculty|professor|associate professor|assistant professor|senior resident|junior resident|(emergency )?medical officer|tutor|demonstrator)\b/i;

export interface DesignationMove { doctorId: string; name: string; specialty: string; designation: string; keepSpecialty: string | null }
export interface DesignationReport { apply: boolean; moves: DesignationMove[]; skipped: string[]; moved: number }

/** What `specialty` splits into, or null when it does not start with a known designation. */
export function splitSpecialty(specialty: string): { designation: string; specialty: string | null } | null {
  const text = specialty.trim();
  if (!DESIGNATION.test(text)) return null;
  const bracket = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text);
  if (bracket !== null && !DESIGNATION.test(bracket[2]!.trim())) {
    return { designation: bracket[1]!.trim(), specialty: bracket[2]!.trim() };
  }
  return { designation: text, specialty: null };
}

export async function fixDesignations(db: Db, opts: { apply: boolean }): Promise<DesignationReport> {
  const report: DesignationReport = { apply: opts.apply, moves: [], skipped: [], moved: 0 };
  const rows = await db.select({ id: opdDoctors.id, name: opdDoctors.displayName, specialty: opdDoctors.specialty, designation: opdDoctors.designation })
    .from(opdDoctors).where(eq(opdDoctors.active, true));
  for (const r of rows) {
    if (r.specialty === null) continue;
    const split = splitSpecialty(r.specialty);
    if (split === null) continue;
    if (r.designation !== null && r.designation !== split.designation) {
      report.skipped.push(`${r.name}: specialty "${r.specialty}" reads as designation "${split.designation}", but "${r.designation}" is on file — left as is`);
      continue;
    }
    report.moves.push({ doctorId: r.id, name: r.name, specialty: r.specialty, designation: split.designation, keepSpecialty: split.specialty });
  }
  if (opts.apply && report.moves.length > 0) {
    const actor = await publisher(db);
    await withTx(db, async (tx) => {
      for (const m of report.moves) {
        await updateDoctor(tx, actor, m.doctorId, { designation: m.designation, specialty: m.keepSpecialty });
        report.moved += 1;
      }
    });
  }
  return report;
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const url = requireEnv("DATABASE_URL");
  const { db, pool } = createDb(url);
  try {
    const r = await fixDesignations(db, { apply });
    const out = (s: string): void => { process.stdout.write(s); };
    out(`fix:designations — ${apply ? "APPLY" : "DRY RUN (nothing written; add --apply)"} · database "${new URL(url).pathname.slice(1)}"\n`);
    if (r.moves.length === 0) out("  nothing to move\n");
    for (const m of r.moves) {
      out(`  ${apply ? "" : "WOULD "}${m.name}: specialty "${m.specialty}" → designation "${m.designation}", specialty ${m.keepSpecialty === null ? "cleared" : `"${m.keepSpecialty}"`}\n`);
    }
    for (const s of r.skipped) out(`  ! ${s}\n`);
    out(`moved ${r.moved}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
