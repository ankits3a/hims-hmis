import { eq } from "drizzle-orm";
import { gstinState, isValidGstin } from "@hmis/contracts";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import { loadOpdConfig, updateOpdConfig } from "../src/modules/opd/config";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../src/kernel/db/client";
import type { Letterhead } from "../src/modules/opd/config";

/**
 * `node dist/scripts/set-establishment-gst.js --gstin <GSTIN> --legal-name "<legal name>" --as <username> [--apply]`
 *
 * ═══ THE REGISTERED PERSON BEHIND THE LETTERHEAD (2026-09-17) ═══
 *
 * A tax invoice names the supplier's legal name and GSTIN (CGST Rules r.46(a)). The owner gave them
 * on 2026-09-17: the hospital is run by a trust. This writes both onto the ONE letterhead, keeping
 * its name and address lines exactly as they are.
 *
 * - `--as` names the person making the change. The account must be active and hold
 *   `opd.config.manage`; the config row records them.
 * - The GSTIN is checked (shape, state code, check character) before anything is read.
 * - The dry run prints the letterhead before and after, then rolls back. `--apply` commits.
 */
export type TaxIdentity = { gstin: string; legalName: string };

export async function setLetterheadTaxIdentity(tx: Tx, actor: Actor, input: TaxIdentity): Promise<{ before: Letterhead; after: Letterhead }> {
  const gstin = input.gstin.trim().toUpperCase();
  const legalName = input.legalName.trim();
  if (!isValidGstin(gstin)) throw new Error(`"${input.gstin}" is not a valid GSTIN`);
  if (legalName === "") throw new Error("a legal name is required");
  const before = (await loadOpdConfig(tx)).letterhead;
  const after = (await updateOpdConfig(tx, actor, { letterhead: { ...before, legalName, gstin } })).letterhead;
  return { before, after };
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

class DryRun extends Error {
  constructor(readonly result: { before: Letterhead; after: Letterhead }) { super("dry run"); }
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const gstin = arg(args, "--gstin");
  const legalName = arg(args, "--legal-name");
  const username = arg(args, "--as");
  if (gstin === undefined || legalName === undefined || username === undefined) {
    throw new Error('usage: --gstin <GSTIN> --legal-name "<legal name>" --as <username> [--apply]');
  }
  const state = gstinState(gstin.trim().toUpperCase());
  if (state === null) throw new Error(`"${gstin}" is not a valid GSTIN`);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const [person] = await db.select({ id: users.id, fullName: users.fullName, active: users.active })
        .from(users).where(eq(users.username, username));
      if (person === undefined || !person.active) throw new Error(`no active account "${username}"`);
      if (!(await hasPermission(db, person.id, "opd.config.manage", "hospital"))) {
        throw new Error(`"${username}" does not hold opd.config.manage`);
      }
      console.log(`establishment GST · recorded as ${username} (${person.fullName}) · GSTIN state ${state.name} (${state.code})`);
      let result: { before: Letterhead; after: Letterhead };
      try {
        result = await withTx(db, async (tx) => {
          const r = await setLetterheadTaxIdentity(tx, { type: "user", id: person.id }, { gstin, legalName });
          if (!apply) throw new DryRun(r);
          return r;
        });
      } catch (e) {
        if (!(e instanceof DryRun)) throw e;
        console.log(`  before  ${JSON.stringify(e.result.before)}`);
        console.log(`  after   ${JSON.stringify(e.result.after)}`);
        console.log("\nDRY RUN — rolled back, nothing written. Re-run with --apply.");
        return;
      }
      console.log(`  before  ${JSON.stringify(result.before)}`);
      console.log(`  after   ${JSON.stringify(result.after)}`);
      console.log("\nAPPLIED. Every invoice printed from now on carries the legal name and GSTIN.");
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();
