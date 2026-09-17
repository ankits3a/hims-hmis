import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { adoptInteractions } from "../src/modules/formulary";
import { INTERACTION_RULES_2026_09_17 } from "./data/interaction-rules-2026-09-17";
import type { InteractionAdoptionReport } from "../src/modules/formulary";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/adopt-interactions.ts --resolution <ref> --as <username> [--apply]`
 * In the production image: `node dist/scripts/adopt-interactions.js …` (same flags).
 *
 * ═══ FORMULARY P21: THE CLINICAL MASTER'S DRUG–DRUG RULES, ADOPTED BY RESOLUTION ═══
 *
 * The owner's ruling of 2026-09-16 applies here too: a reference is adopted under one named
 * resolution, not reviewed pair by pair. The rules are `scripts/data/interaction-rules-2026-09-17.ts`,
 * which names its source and every correction made to it.
 *
 * - `--as` names the person adopting. The account must be active and hold `formulary.manage`.
 * - Every new pair's `source` names the resolution and the source rule.
 * - A pair already recorded is left exactly as it is.
 * - A name that is not a moiety yet is reported and skipped. Run this AFTER the substance adoption,
 *   and again after a new release is decided; it is idempotent.
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
  constructor(readonly report: InteractionAdoptionReport) { super("dry run"); }
}

function print(r: InteractionAdoptionReport): void {
  console.log(`  pairs created         ${String(r.created.severe)} severe · ${String(r.created.moderate)} moderate`);
  console.log(`  already recorded      ${String(r.alreadyRecorded)}  (left exactly as they are)`);
  console.log(`  waiting on a moiety   ${String(r.skipped)} pairs`);
  for (const m of r.missing) console.log(`    ${m.name.padEnd(24)} ${String(m.pairs)} pair(s)`);
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
      console.log(`interaction adoption · ${String(INTERACTION_RULES_2026_09_17.length)} pairs · resolution "${resolution.trim()}"`);
      console.log(`  recorded as           created_by = ${person.id} (${username}, ${person.fullName})`);
      let report: InteractionAdoptionReport;
      try {
        report = await withTx(db, async (tx) => {
          const r = await adoptInteractions(tx, actor, resolution, INTERACTION_RULES_2026_09_17);
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
