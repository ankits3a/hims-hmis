import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { adoptDecisions } from "../src/modules/formulary";
import type { AdoptionItem, AdoptionReport } from "../src/modules/formulary";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/adopt-substance-mappings.ts`
 *     `--decisions <file.json> --resolution <ref> --as <username> [--apply]`
 * In the production image: `node dist/scripts/adopt-substance-mappings.js …` (same flags).
 *
 * ═══ THE OWNER'S RULING, 2026-09-16: NOTHING LEFT PENDING (phase-3 doc §1) ═══
 *
 * Every pending release substance is decided under one named resolution, from a decisions file:
 * release drafts and model drafts, each checked by a second, independent model pass. The account
 * named by `--as` is the person adopting. It must be active and hold `formulary.manage`, and it
 * is recorded as `mapped_by` on every row, with the resolution in `adopted_under`. Nothing here
 * records a decision as anyone else's.
 *
 * It follows the loaders' doctrine: the dry run does the WHOLE adoption inside a transaction,
 * prints the report, and rolls back. So what it prints is what `--apply` will write, projection
 * counts included. `--apply` commits the same transaction. It is all or nothing.
 *
 * DECISIONS FILE:
 *
 *     { "release": "nrces-2026-09",
 *       "items": [ { "sctid": "…", "decision": "moiety", "moietyName": "…", "reason": "…" },
 *                  { "sctid": "…", "decision": "unmappable", "reason": "…" } ] }
 */
export const decisionsFileSchema = z.object({
  release: z.string().trim().min(1),
  items: z.array(z.discriminatedUnion("decision", [
    z.object({
      sctid: z.string().trim().min(1), decision: z.literal("moiety"),
      moietyName: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000),
    }).passthrough(),
    z.object({
      sctid: z.string().trim().min(1), decision: z.literal("unmappable"),
      reason: z.string().trim().min(1).max(1000),
    }).passthrough(),
  ])).min(1),
});

/** Only the fields the module reads: a file's extra annotations (confidence, basis) stay in the file. */
export function adoptionItems(file: z.infer<typeof decisionsFileSchema>): AdoptionItem[] {
  return file.items.map((i) => (i.decision === "moiety"
    ? { sctid: i.sctid, decision: "moiety", moietyName: i.moietyName, reason: i.reason }
    : { sctid: i.sctid, decision: "unmappable", reason: i.reason }));
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

class DryRun extends Error {
  constructor(readonly report: AdoptionReport) { super("dry run"); }
}

function print(r: AdoptionReport): void {
  console.log(`  mapped                ${String(r.mapped)}`);
  console.log(`    new moieties        ${String(r.createdMoieties)}`);
  console.log(`    own release entry   ${String(r.ownEntries)}`);
  console.log(`    redirected          ${String(r.redirected.length)}  (named another substance's entry; its moiety used)`);
  console.log(`    vs the draft        ${String(r.agreedWithDraft)} agreed · ${String(r.disagreedWithDraft)} differed · ${String(r.noDraft)} had none`);
  console.log(`  ruled unmappable      ${String(r.ruledUnmappable)}`);
  console.log(`  already decided       ${String(r.alreadyDecided.length)}  (left exactly as they are)`);
  console.log(`  refused               ${String(r.refused.length)}`);
  for (const x of r.refused.slice(0, 50)) console.log(`    ${x.sctid} → "${x.moietyName}": ${x.why}`);
  console.log(`  products moved        ${String(r.projection.medicinesMoved)} (${String(r.projection.rowsMoved)} rows; ${String(r.projection.medicinesBlocked)} held back by a collision)`);
  console.log(`  pending afterwards    ${String(r.pendingAfter)}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const path = arg(args, "--decisions");
  const resolution = arg(args, "--resolution");
  const username = arg(args, "--as");
  if (path === undefined || resolution === undefined || username === undefined) {
    throw new Error("usage: --decisions <file.json> --resolution <ref> --as <username> [--apply]");
  }
  const file = decisionsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const items = adoptionItems(file);

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

      console.log(`adoption · release ${file.release} · ${String(items.length)} decisions from ${path}`);
      console.log(`  recorded as           mapped_by = ${person.id} (${username}, ${person.fullName})`);
      console.log(`                        adopted_under = "${resolution.trim()}"`);

      let report: AdoptionReport;
      try {
        report = await withTx(db, async (tx) => {
          const r = await adoptDecisions(tx, actor, resolution, items);
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

/* Guarded so a test can import the schema without the script running itself. */
if (require.main === module) main();
