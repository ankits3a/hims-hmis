import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { importHolderBook } from "../src/modules/membership";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 09 T5 — read one partner drop into the holder book.
 *
 * ═══ IT IS AN OPERATOR COMMAND AND IT IS DELIBERATELY NOT IN `docker/prod/deploy.sh` ═══
 *
 * Every `seed:*` script in this package runs on EVERY deploy, because a seed is configuration the
 * deployment owns and re-running it changes nothing. A drop is not configuration: it is one file a
 * partner sent on one day, and a deploy that imported it would be importing data nobody asked it
 * for — the same reasoning that keeps `seed:admin` out of the deploy path (§6.0 S14).
 *
 * ═══ IT NAMES NO TABLE, AND THAT IS ENFORCED ═══
 *
 * `modules/membership/catalogs-empty.test.ts` scans every `.ts` file in this directory for the name
 * of any catalog table, in either spelling, and requires the list to be empty — DD3's structural
 * guard, and the reason it can exist without committing the values it forbids. So everything below
 * goes through the module's declared interface and the schema is never mentioned here at all.
 *
 * Usage:
 *   pnpm --filter @hmis/core import:holder-book -- \
 *     --partner <counterpartyId> --file ./drop.csv [--map holder-book-v1] [--actor <name>]
 *
 * The partner is named by ID rather than by code on purpose: a code is DATA that arrives at
 * commissioning, and an operator pasting the id from the admin surface cannot mistype it into a
 * different partner's book without the foreign key refusing.
 */

type Args = { partner: string; file: string; map?: string; actor: string };

function parseArgs(argv: string[]): Args {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const partner = read("--partner");
  const file = read("--file");
  if (partner === undefined || partner === "" || file === undefined || file === "") {
    throw new Error("usage: import:holder-book -- --partner <id> --file <path> [--map <version>] [--actor <name>]");
  }
  return { partner, file, map: read("--map"), actor: read("--actor") ?? "import-holder-book" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Plain text, DD17 — `imported_by` is a NAME on a provenance record, never a foreign key, so an
  // operator can be identified without this script having to authenticate one.
  const actor: Actor = { type: "user", id: args.actor };
  const csv = readFileSync(args.file, "utf8");

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const result = await importHolderBook(db, actor, {
      counterpartyId: args.partner,
      fileName: basename(args.file),
      csv,
      columnMapVersion: args.map,
    });
    if (result.alreadyImported) {
      console.log(`already imported as ${result.importId} — nothing was read a second time`);
      return;
    }
    console.log(
      `import ${result.importId} (${result.columnMapVersion}): ` +
        `${result.rowsTotal} rows, ${result.rowsAccepted} accepted, ` +
        `${result.rowsAlreadyApplied} already held, ${result.rowsQuarantined} quarantined`,
    );
    for (const q of result.quarantined) console.log(`  quarantined line ${q.rowNo}: ${q.reason}`);
    for (const q of result.queued) console.log(`  reconcile line ${q.rowNo}: ${q.reason}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}); // the shipped seed-admin.ts convention: a failed import exits non-zero, loudly
