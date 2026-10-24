/**
 * ═══ LOAD DDINTER 2.0 MAJOR INTERACTIONS AS THE REFERENCE LAYER (#617, decision 0052) ═══
 *
 *   DATABASE_URL=… tsx scripts/import-ddinter.ts --file <ddinter_downloads_code_A.csv> [--file …]
 *       --retrieved <YYYY-MM-DD> --as <username> [--apply]
 *
 * `--file` is a DDInter export the owner supplies (columns `DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level`), as
 * downloaded; give every file. Only Major pairs are kept; Moderate, Minor and Unknown are counted and skipped. Names map
 * to formulary moieties exactly (name or alias; a pharmacist adds a missing alias); the dry run lists the names it could not
 * map, most frequent first. `--retrieved` is the date the files were downloaded and is stored on every row. Dry run
 * unless `--apply`. A second run with the same files changes nothing; a newer file retires pairs it no longer holds.
 *
 * Loading changes NOTHING a doctor sees: the prescription check reads these pairs only when
 * `DDINTER_REFERENCE_ENABLED=true`, and that waits for `scripts/replay-ddinter.ts` and the owner (decision 0052).
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { importDdinterInteractions } from "../src/modules/formulary";

const arg = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  const v = i < 0 ? undefined : args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
};
const all = (args: readonly string[], name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));

function main(): void {
  const args = process.argv.slice(2);
  const files = all(args, "--file");
  const retrievedOn = arg(args, "--retrieved");
  const username = arg(args, "--as");
  const apply = args.includes("--apply");
  if (files.length === 0 || retrievedOn === undefined || username === undefined) {
    throw new Error("usage: --file <ddinter.csv> [--file <ddinter.csv> …] --retrieved <YYYY-MM-DD> --as <username> [--apply]");
  }
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const person = (await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.username, username)))[0];
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      if (!(await hasPermission(db, person.id, "formulary.manage", "hospital"))) throw new Error(`"${username}" does not hold formulary.manage`);
      const r = await importDdinterInteractions(db, { type: "user", id: person.id }, { files: texts, retrievedOn, apply });
      console.log(`read    major ${String(r.major)} · skipped moderate ${String(r.skipped.moderate)} · minor ${String(r.skipped.minor)} · unknown ${String(r.skipped.unknown)} · malformed ${String(r.malformed)}`);
      console.log(`mapped  ${String(r.mapped)} moiety pairs · unmapped pairs ${String(r.unmappedPairs)} · same moiety ${String(r.sameMoiety)} · already curated ${String(r.curatedOverlap)}`);
      console.log(`table   added ${String(r.added)} · retired ${String(r.retired)} · unchanged ${String(r.unchanged)}`);
      if (r.unmappedNames.length > 0) {
        console.log(`unmapped names (${String(r.unmappedNames.length)}), most frequent first:`);
        for (const n of r.unmappedNames.slice(0, 50)) console.log(`  ${String(n.count).padStart(5)}  ${n.name}`);
      }
      console.log(apply ? `APPLIED (batch ${r.batch}).` : "DRY RUN — nothing written. Re-run with --apply.");
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
