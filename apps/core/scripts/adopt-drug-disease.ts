import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { adoptDrugDisease } from "../src/modules/formulary";
import { DRUG_DISEASE_RULES_2026_09_17 } from "./data/drug-disease-rules-2026-09-17";
import type { DrugDiseaseAdoptionReport } from "../src/modules/formulary";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/adopt-drug-disease.ts --resolution <ref> --as <username> [--apply]`
 * In the production image: `node dist/scripts/adopt-drug-disease.js …` (same flags).
 *
 * ═══ FORMULARY P24: WHAT THE PATIENT'S DIAGNOSIS FORBIDS, ADOPTED BY RESOLUTION ═══
 *
 * The owner's ruling of 2026-09-16 applies here as it did to substances and to interaction pairs: a
 * reference is adopted under one named resolution, not reviewed row by row. The rules are
 * `scripts/data/drug-disease-rules-2026-09-17.ts`, which names its source and every departure from
 * it.
 *
 * - `--as` names the person adopting. The account must be active and hold `formulary.manage`.
 * - Every new row's `source` names the resolution and the source rule.
 * - A row already recorded is left exactly as it is, severity included.
 * - A name that is not a moiety yet is reported and skipped. Run this AFTER the substance adoption,
 *   and again after a new release is decided; it is idempotent.
 *
 * ═══ READ TWO LINES OF THE REPORT BEFORE YOU PASS `--apply` ═══
 *
 * `waiting on a moiety` should be 0. It was 0 when measured against `hmis_formulary_prodlike` on
 * 2026-09-17; anything else means a name in the book no longer resolves here, which is a defect to
 * report and not a thing to adopt around.
 *
 * `offers that cannot resolve` should be 0 too. Each one is a safer drug this book would have
 * offered the prescriber and cannot, because the name is not a moiety in this formulary. The row is
 * still adopted — the warning is what protects the patient, and the offer is a convenience — but an
 * alert that says "use X instead" while X cannot be picked is worth knowing about.
 *
 * The dry run does the whole adoption inside a transaction, prints the report and rolls back.
 * `--apply` commits the same transaction.
 */
function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

class DryRun extends Error {
  constructor(readonly report: DrugDiseaseAdoptionReport) { super("dry run"); }
}

function print(r: DrugDiseaseAdoptionReport): void {
  console.log(`  rows created            ${String(r.created.severe)} severe · ${String(r.created.moderate)} moderate`);
  console.log(`  already recorded        ${String(r.alreadyRecorded)}  (left exactly as they are)`);
  console.log(`  waiting on a moiety     ${String(r.skipped)} rows`);
  for (const m of r.missing) console.log(`    ${m.name.padEnd(24)} ${String(m.rows)} row(s)`);
  console.log(`  offers that cannot resolve  ${String(r.alternativesUnknown.length)}`);
  for (const n of r.alternativesUnknown) console.log(`    ${n}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const resolution = arg(args, "--resolution");
  const username = arg(args, "--as");
  if (resolution === undefined || username === undefined) {
    throw new Error("usage: --resolution <ref> --as <username> [--apply]");
  }
  const rules = DRUG_DISEASE_RULES_2026_09_17;
  const rows = rules.reduce((n, r) => n + r.moieties.length, 0);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const found = await db.select({ id: users.id, fullName: users.fullName, active: users.active })
        .from(users).where(eq(users.username, username));
      const person = found[0];
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      if (!(await hasPermission(db, person.id, "formulary.manage", "hospital"))) {
        throw new Error(`"${username}" does not hold formulary.manage, and only a formulary curator may adopt`);
      }
      const actor = { type: "user" as const, id: person.id };
      const prefixes = new Set(rules.map((r) => r.prefix)).size;
      console.log(
        `drug-disease adoption · ${String(rules.length)} rules over ${String(prefixes)} ICD-10 prefixes` +
        ` · ${String(rows)} rows · resolution "${resolution.trim()}"`,
      );
      console.log(`  recorded as             created_by = ${person.id} (${username}, ${person.fullName})`);
      let report: DrugDiseaseAdoptionReport;
      try {
        report = await withTx(db, async (tx) => {
          const r = await adoptDrugDisease(tx, actor, resolution, rules);
          if (!apply) throw new DryRun(r);
          return r;
        });
      } catch (e) {
        if (!(e instanceof DryRun)) throw e;
        print(e.report);
        console.log("\nDRY RUN — rolled back, nothing written. Re-run with --apply.");
        return;
      }
      print(report);
      console.log("\nAPPLIED.");
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
