import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

/**
 * PHASE 11i T4 — THE MIGRATION WATERMARK GUARD, in front of drizzle's migrator.
 *
 * ═══ THE SKIP RULE, MEASURED AGAINST THE INSTALLED 0.40.1 AND NOT THE DOCS ═══
 *
 * `drizzle-orm/node-postgres`'s migrator reads exactly ONE row —
 *
 *     select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
 *
 * — and then applies a journal entry only `if (!lastDbMigration || Number(lastDbMigration.created_at)
 * < migration.folderMillis)` (`pg-core/dialect.js:57,62` of drizzle-orm 0.40.1). Two consequences,
 * both load-bearing here:
 *
 *   1. The comparison is STRICTLY GREATER. An entry whose `when` EQUALS the newest applied
 *      `created_at` is skipped, silently. So the guard's own comparison must be `<=`, not `<`.
 *   2. `hash` is WRITTEN and never READ. Drizzle cannot notice that an applied migration's file
 *      changed, that a tag was renumbered, or that an entry appeared below the watermark. It has
 *      one number and it trusts it.
 *
 * ═══ WHAT GOES WRONG WITHOUT THIS, AND WHY IT IS SILENT ═══
 *
 * Eight lanes take migration serials at rebase time (CLAUDE.md). A lane that regenerates its
 * migration after a peer's has merged produces a folder whose `when` sits BELOW the deployed
 * database's watermark. On that database drizzle skips it — no error, exit 0, "migrations applied"
 * — and the table it was supposed to create simply does not exist, discovered later by a query
 * from a screen with a person in front of it. `drizzle-when-silently-skips` is that failure with
 * four recorded variants.
 *
 * ═══ IT REFUSES; IT NEVER REPAIRS (D6) ═══
 *
 * The guard names the tag, its `when`, the watermark, and stops. It does not re-stamp the
 * migrations table, does not reorder the journal and does not renumber a file: renumbering is a
 * human act performed at rebase, and a script that quietly re-stamped a watermark would be
 * inventing the very history the guard exists to defend. An empty table (or no table at all) is a
 * FRESH DATABASE and passes — that is every test database, every UAT reset and the first deploy.
 * An entry below the watermark that IS applied is also fine and says nothing: that is the normal
 * state of every migration but the last.
 */
export const MIGRATIONS_FOLDER = "./drizzle";
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

/** The `_journal.json` fields this guard uses. `idx` is deliberately NOT one of them: drizzle
 *  orders by `when`, so a guard that read `idx` would be measuring a different sequence. */
export type JournalEntry = { idx: number; when: number; tag: string };

export type WatermarkOffender = { tag: string; when: number };
export type WatermarkVerdict = {
  ok: boolean;
  /** The newest applied `created_at`, or `null` for a fresh database. */
  watermark: number | null;
  appliedCount: number;
  offenders: WatermarkOffender[];
};

export function readJournalEntries(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const raw = readFileSync(`${folder}/meta/_journal.json`, "utf8");
  const journal = JSON.parse(raw) as { entries?: JournalEntry[] };
  const entries = journal.entries;
  if (entries === undefined || entries.length === 0) {
    // §2.49: a parser that returns empty on a shape it did not understand is a guard that passes
    // everything. The journal of this repo has never been empty and cannot legitimately be.
    throw new Error(`${folder}/meta/_journal.json holds no entries — this parser is stale`);
  }
  return entries;
}

/** Byte-for-byte the hash drizzle stores: sha256 of the WHOLE .sql file, before any splitting on
 *  `--> statement-breakpoint` (`drizzle-orm/migrator.js`, `readMigrationFiles`). The test asserts
 *  this equality against the installed package rather than trusting this comment. */
export function migrationHash(folder: string, tag: string): string {
  return createHash("sha256").update(readFileSync(`${folder}/${tag}.sql`).toString()).digest("hex");
}

const FRESH_DATABASE_CODES = new Set(["42P01", "3F000"]); // undefined_table, invalid_schema_name

export async function checkMigrationWatermark(
  db: Db,
  opts: { folder?: string; schema?: string; table?: string } = {},
): Promise<WatermarkVerdict> {
  const folder = opts.folder ?? MIGRATIONS_FOLDER;
  const schema = opts.schema ?? MIGRATIONS_SCHEMA;
  const table = opts.table ?? MIGRATIONS_TABLE;

  let rows: { hash: string; created_at: string | number }[];
  try {
    const result = await db.execute<{ hash: string; created_at: string | number }>(
      sql`select hash, created_at from ${sql.identifier(schema)}.${sql.identifier(table)}`,
    );
    rows = result.rows;
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : "";
    if (FRESH_DATABASE_CODES.has(code)) return { ok: true, watermark: null, appliedCount: 0, offenders: [] };
    throw e;
  }

  if (rows.length === 0) return { ok: true, watermark: null, appliedCount: 0, offenders: [] };

  const watermark = Math.max(...rows.map((r) => Number(r.created_at)));
  const applied = new Set(rows.map((r) => r.hash));

  const offenders = readJournalEntries(folder)
    // `<=` and not `<`: drizzle applies only what is STRICTLY greater, so an entry sitting exactly
    // ON the watermark is skipped too. See the header.
    .filter((e) => e.when <= watermark && !applied.has(migrationHash(folder, e.tag)))
    .map((e) => ({ tag: e.tag, when: e.when }));

  return { ok: offenders.length === 0, watermark, appliedCount: rows.length, offenders };
}

export const RENUMBER_SENTENCE = "renumber at rebase; never edit an applied migration";

export function watermarkReport(verdict: WatermarkVerdict): string[] {
  return [
    ...verdict.offenders.map(
      (o) =>
        `ERROR migration_below_watermark: ${o.tag} (when=${o.when}) is at or below this database's ` +
        `watermark ${String(verdict.watermark)} and has never been applied — drizzle will SKIP it ` +
        `and report success. ${RENUMBER_SENTENCE}.`,
    ),
    `watermark: ${String(verdict.watermark)} applied=${verdict.appliedCount} offenders=${verdict.offenders.length}`,
  ];
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const verdict = await checkMigrationWatermark(db);
    for (const line of watermarkReport(verdict)) console.log(line);
    if (!verdict.ok) {
      // REFUSE. Never repair — D6. `exitCode` rather than `process.exit()` so the pool still closes
      // in `finally`; `deploy.sh` runs under `set -e` and stops at the line that named the tag.
      process.exitCode = 1;
      return;
    }
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

// Guarded so `test/migrate-watermark.test.ts` can import the check without the script migrating the
// test database on import — the `check-config-present.ts` / `seed-roles.ts` house convention.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
