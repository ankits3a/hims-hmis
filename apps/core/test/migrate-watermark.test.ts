import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { setupTestDb } from "./helpers/db";
import {
  MIGRATIONS_FOLDER, RENUMBER_SENTENCE, checkMigrationWatermark, migrationHash, readJournalEntries,
  watermarkReport,
} from "../scripts/migrate";
import type { Db } from "../src/kernel/db/client";

/**
 * PHASE 11i T4 — the watermark guard.
 *
 * THE FAILURE IT EXISTS FOR IS SILENT. drizzle-orm 0.40.1 reads ONE row from the migrations table
 * and applies a journal entry only when `Number(created_at) < folderMillis`
 * (`pg-core/dialect.js:57,62`). `hash` is written and never read. So a migration whose `when` sits
 * at or below the deployed watermark is SKIPPED, the migrator exits 0, prints "migrations applied",
 * and the table it should have created does not exist — found later by a screen with a person in
 * front of it. Eight lanes take serials at rebase time, which is exactly how a folder gets a `when`
 * below a watermark.
 *
 * Two claims below are measured against the INSTALLED package rather than its documentation: that
 * this file's hash is byte-for-byte drizzle's, and that an entry sitting exactly ON the watermark
 * is skipped by drizzle's own migrator. The second is why the guard compares `<=` and not `<`.
 */
const SCHEMA = "wm_probe";
const TABLE = "wm_migrations";

/** A migrations folder in the shape drizzle reads: `<tag>.sql` files plus `meta/_journal.json`. */
function synthFolder(entries: { tag: string; when: number; sql: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql);
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })),
    }),
  );
  return dir;
}

/** Adds one entry to an existing synthetic folder — the shape of a deploy that brings a new
 *  migration to a database that already has a watermark. */
function appendEntry(dir: string, entry: { tag: string; when: number; sql: string }): void {
  writeFileSync(join(dir, `${entry.tag}.sql`), entry.sql);
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries.push({ idx: journal.entries.length, version: "7", when: entry.when, tag: entry.tag, breakpoints: true } as never);
  writeFileSync(journalPath, JSON.stringify(journal));
}

describe("the migration watermark guard (11i T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const probe = { folder: "", schema: SCHEMA, table: TABLE };

  const tableExists = async (name: string): Promise<boolean> => {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.tables where table_name = ${name}`);
    return Number(r.rows[0]?.n ?? 0) > 0;
  };
  const appliedCount = async (): Promise<number> => {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`);
    return Number(r.rows[0]?.n ?? 0);
  };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(SCHEMA)} cascade`);
    for (const t of ["wm_alpha", "wm_beta", "wm_gamma"]) await db.execute(sql`drop table if exists ${sql.identifier(t)}`);
    await teardown();
  });
  beforeEach(async () => {
    await db.execute(sql`drop schema if exists ${sql.identifier(SCHEMA)} cascade`);
    for (const t of ["wm_alpha", "wm_beta", "wm_gamma"]) await db.execute(sql`drop table if exists ${sql.identifier(t)}`);
  });

  it("hashes a migration file byte-for-byte the way the INSTALLED drizzle does", () => {
    // If this ever diverges, every offender check silently becomes "not applied" for every entry.
    const drizzleHashes = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map((m) => m.hash);
    const ours = readJournalEntries(MIGRATIONS_FOLDER).map((e) => migrationHash(MIGRATIONS_FOLDER, e.tag));
    expect(ours).toEqual(drizzleHashes);
    expect(ours.length).toBeGreaterThan(70); // non-vacuous: this repo's journal, not an empty read
  });

  it("passes a FRESH database — no migrations schema at all, and an empty table", async () => {
    // Every test database, every UAT reset and the first deploy of a new environment.
    const folder = synthFolder([{ tag: "0000_alpha", when: 1000, sql: "create table wm_alpha (id text);" }]);
    expect(await checkMigrationWatermark(db, { ...probe, folder })).toEqual({
      ok: true, watermark: null, appliedCount: 0, offenders: [],
    });

    await db.execute(sql`create schema ${sql.identifier(SCHEMA)}`);
    await db.execute(sql`create table ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (id serial primary key, hash text not null, created_at bigint)`);
    expect(await checkMigrationWatermark(db, { ...probe, folder })).toEqual({
      ok: true, watermark: null, appliedCount: 0, offenders: [],
    });
  });

  it("passes THIS repository's real journal against its own fully-migrated database", async () => {
    const entries = readJournalEntries(MIGRATIONS_FOLDER);
    const verdict = await checkMigrationWatermark(db); // the production defaults: drizzle.__drizzle_migrations
    expect(verdict.offenders).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.appliedCount).toBe(entries.length);
    expect(verdict.watermark).toBe(Math.max(...entries.map((e) => e.when)));
  });

  it("MEASURES drizzle 0.40.1's skip rule: an entry sitting exactly ON the watermark is not applied", async () => {
    // The claim the guard's `<=` rests on, proved against the installed package rather than read.
    //
    // MEASURED, and it corrected the first draft of this test: drizzle reads the last applied row
    // ONCE, BEFORE the loop, and never re-reads it. So on a FRESH database `lastDbMigration` is
    // undefined and every entry applies, equal millis included — the skip only happens against a
    // watermark that already existed when the migrator started. That is the production sequence
    // and so it is the sequence here: migrate, then bring a new folder to the same database.
    const folder = synthFolder([
      { tag: "0000_alpha", when: 1000, sql: "create table wm_alpha (id text);" },
      { tag: "0001_beta", when: 2000, sql: "create table wm_beta (id text);" },
    ]);
    await migrate(db, { migrationsFolder: folder, migrationsSchema: SCHEMA, migrationsTable: TABLE });
    expect(await appliedCount()).toBe(2); // watermark is now 2000

    appendEntry(folder, { tag: "0002_gamma", when: 2000, sql: "create table wm_gamma (id text);" });
    await migrate(db, { migrationsFolder: folder, migrationsSchema: SCHEMA, migrationsTable: TABLE });

    expect(await tableExists("wm_alpha")).toBe(true);
    expect(await tableExists("wm_beta")).toBe(true);
    expect(await tableExists("wm_gamma")).toBe(false); // skipped, silently, exit 0
    expect(await appliedCount()).toBe(2);

    const verdict = await checkMigrationWatermark(db, { ...probe, folder });
    expect(verdict).toEqual({
      ok: false, watermark: 2000, appliedCount: 2, offenders: [{ tag: "0002_gamma", when: 2000 }],
    });
    const report = watermarkReport(verdict).join("\n");
    expect(report).toContain("0002_gamma");
    expect(report).toContain("when=2000");
    expect(report).toContain("watermark 2000");
    expect(report).toContain(RENUMBER_SENTENCE);
  });

  it("REFUSES a regenerated migration below the watermark — the rebase hazard, by HASH not by tag", async () => {
    const alpha = { tag: "0000_alpha", when: 1000, sql: "create table wm_alpha (id text);" };
    const beta = { tag: "0001_beta", when: 2000, sql: "create table wm_beta (id text);" };
    const folder = synthFolder([alpha, beta]);
    await migrate(db, { migrationsFolder: folder, migrationsSchema: SCHEMA, migrationsTable: TABLE });
    expect(await checkMigrationWatermark(db, { ...probe, folder })).toMatchObject({ ok: true, offenders: [] });

    // A lane regenerates 0000 after a peer's migration has merged: same tag, different bytes. The
    // applied hash no longer matches the file, and drizzle will never look at either.
    writeFileSync(join(folder, "0000_alpha.sql"), "create table wm_alpha (id text, added text);");

    const verdict = await checkMigrationWatermark(db, { ...probe, folder });
    expect(verdict.ok).toBe(false);
    expect(verdict.offenders).toEqual([{ tag: "0000_alpha", when: 1000 }]);
    expect(verdict.watermark).toBe(2000);
  });

  it("says NOTHING about an applied entry below the watermark, nor about a pending one above it", async () => {
    // The normal state of every migration but the last, and the normal forward deploy. This is the
    // leg that a guard reading `idx` instead of `when` fails: every idx is below any millis value,
    // so a legitimately pending migration would be reported as an offender.
    const folder = synthFolder([
      { tag: "0000_alpha", when: 1000, sql: "create table wm_alpha (id text);" },
      { tag: "0001_beta", when: 2000, sql: "create table wm_beta (id text);" },
      { tag: "0002_gamma", when: 3000, sql: "create table wm_gamma (id text);" },
    ]);
    await db.execute(sql`create schema ${sql.identifier(SCHEMA)}`);
    await db.execute(sql`create table ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (id serial primary key, hash text not null, created_at bigint)`);
    await db.execute(sql`insert into ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at) values (${migrationHash(folder, "0000_alpha")}, 1000)`);

    const verdict = await checkMigrationWatermark(db, { ...probe, folder });
    expect(verdict).toEqual({ ok: true, watermark: 1000, appliedCount: 1, offenders: [] });
  });

  it("REFUSES and NEVER REPAIRS — a red verdict writes no row and stays red (D6)", async () => {
    const folder = synthFolder([
      { tag: "0000_alpha", when: 1000, sql: "create table wm_alpha (id text);" },
      { tag: "0001_beta", when: 2000, sql: "create table wm_beta (id text);" },
    ]);
    await db.execute(sql`create schema ${sql.identifier(SCHEMA)}`);
    await db.execute(sql`create table ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (id serial primary key, hash text not null, created_at bigint)`);
    await db.execute(sql`insert into ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at) values (${migrationHash(folder, "0001_beta")}, 2000)`);

    const first = await checkMigrationWatermark(db, { ...probe, folder });
    expect(first.ok).toBe(false);
    expect(first.offenders).toEqual([{ tag: "0000_alpha", when: 1000 }]);
    expect(await appliedCount()).toBe(1);

    // A guard that re-stamped the watermark would invent the history it exists to defend.
    const second = await checkMigrationWatermark(db, { ...probe, folder });
    expect(second).toEqual(first);
    expect(await appliedCount()).toBe(1);
    expect(await tableExists("wm_alpha")).toBe(false);
  });

  it("refuses a journal it did not understand rather than passing everything (§2.49)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-empty-"));
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", entries: [] }));
    expect(() => readJournalEntries(dir)).toThrow(/no entries/);
  });
});
