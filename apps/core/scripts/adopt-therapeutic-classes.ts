import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { adoptTherapeuticClasses } from "../src/modules/formulary";
import { THERAPEUTIC_CLASS_BOOK_2026_09_17 } from "./data/therapeutic-classes-2026-09-17";
import type { TherapeuticClassAdoptionReport } from "../src/modules/formulary";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/adopt-therapeutic-classes.ts --resolution <ref> --as <username> [--apply]`
 * In the production image: `node dist/scripts/adopt-therapeutic-classes.js …` (same flags).
 *
 * ═══ FORMULARY P23: THE CLINICAL MASTER'S DUPLICATE-THERAPY GROUPS, ADOPTED BY RESOLUTION ═══
 *
 * The owner's ruling of 2026-09-16 applies here too: a reference is adopted under one named
 * resolution. The classes are `scripts/data/therapeutic-classes-2026-09-17.ts`, which names its
 * source and every departure from it.
 *
 * - `--as` names the person adopting. The account must be active and hold `formulary.manage`.
 * - A moiety's `drug_class` is set only where none is recorded. A different recorded class is
 *   printed as a conflict and left for a person. Every setting is an event naming the resolution.
 * - A name that is not a moiety yet is reported and skipped. Run this AFTER the substance adoption,
 *   and again after a new release is decided; it is idempotent. After the substance adoption a
 *   reported name is a defect: report it rather than applying around it.
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
  constructor(readonly report: TherapeuticClassAdoptionReport) { super("dry run"); }
}

function print(r: TherapeuticClassAdoptionReport): void {
  console.log(`  moieties given a class  ${String(r.assigned)}`);
  console.log(`  already in that class   ${String(r.alreadyRecorded)}`);
  console.log(`  in another class        ${String(r.conflicts.length)}  (left as they are; a person decides)`);
  for (const c of r.conflicts) console.log(`    ${c.name.padEnd(26)} ${c.current} (book: ${c.wanted})`);
  console.log(`  not a moiety here       ${String(r.missing.length)}`);
  for (const m of r.missing) console.log(`    ${m.drugClass.padEnd(26)} ${m.name}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const resolution = arg(args, "--resolution");
  const username = arg(args, "--as");
  if (resolution === undefined || username === undefined) {
    throw new Error("usage: --resolution <ref> --as <username> [--apply]");
  }
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
      const memberships = THERAPEUTIC_CLASS_BOOK_2026_09_17.reduce((n, e) => n + e.moieties.length, 0);
      console.log(`therapeutic class adoption · ${String(THERAPEUTIC_CLASS_BOOK_2026_09_17.length)} classes, ${String(memberships)} moieties · resolution "${resolution.trim()}"`);
      console.log(`  recorded as             updated_by = ${person.id} (${username}, ${person.fullName})`);
      let report: TherapeuticClassAdoptionReport;
      try {
        report = await withTx(db, async (tx) => {
          const r = await adoptTherapeuticClasses(tx, actor, resolution, THERAPEUTIC_CLASS_BOOK_2026_09_17);
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
