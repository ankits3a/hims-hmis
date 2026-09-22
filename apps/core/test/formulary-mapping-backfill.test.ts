import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE `derived_from` BACKFILL, RUN AGAINST REAL ROWS ═══
 *
 * The mapping-loop migration carries a hand-written UPDATE that `drizzle-kit generate` did not
 * produce. A migration runs once, against a database that holds no catalogue (every test and CI
 * database), so a green suite says nothing about it unless something runs it on rows shaped like a
 * loaded catalogue. This does, and it reads the statement OUT OF THE MIGRATION FILE: the
 * provenance suite for 0094 proved that a hand-copied statement lets the migration be broken while
 * the copy stays green.
 *
 * The file is found by its tag suffix, not its serial, because the serial is taken at rebase and
 * moves. Exactly one match is required.
 *
 * Three rows, one per case the predicate must separate:
 *   - a DERIVED row on a RELEASE IMAGE      → gets the image's `source_ref`;
 *   - a DERIVED row on a CURATED moiety     → stays null (nothing records its substance; E10);
 *   - a CURATED row on a RELEASE IMAGE      → stays null. A pharmacist composed it by hand, and the
 *     table's check constraint forbids a curated row carrying a derivation, so a backfill that
 *     dropped `source = 'derived'` would not merely mislabel it: it would abort the migration.
 */
const DRIZZLE = resolve(__dirname, "../drizzle");

function backfillFromMigration(): string {
  const files = readdirSync(DRIZZLE).filter((f) => /^\d{4}_formulary_mapping_loop\.sql$/.test(f));
  if (files.length !== 1) throw new Error(`expected one *_formulary_mapping_loop.sql, found: ${files.join(", ") || "none"}`);
  const statements = readFileSync(resolve(DRIZZLE, files[0] as string), "utf8").split("--> statement-breakpoint");
  const updates = statements
    .map((st) => st.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim())
    .filter((st) => /^update\b/i.test(st));
  if (updates.length !== 1) throw new Error(`expected exactly one UPDATE in ${files[0] as string}, found ${String(updates.length)}`);
  return (updates[0] as string).replace(/;\s*$/, "");
}

describe("migration *_formulary_mapping_loop — the derived_from backfill", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, source_ref, created_by, updated_by) values
        ('S-IMG-AMOX', 'Amoxicillin trihydrate', '[]'::jsonb, '96068000', 'cds-import', 'cds-import'),
        ('S-ASPIRIN',  'aspirin',                '[]'::jsonb, null,       'seed:formulary-interactions', 'seed:formulary-interactions')
    `);
    await db.execute(sql`
      insert into formulary_medicines (id, brand_name, name_normalized, form, route_class, created_by, updated_by) values
        ('M-MOX',     'Mox 250',     'mox 250',     'tablet',  'systemic', 'cds-import', 'cds-import'),
        ('M-ECOSPRIN','Ecosprin 75', 'ecosprin 75', 'tablet',  'systemic', 'cds-import', 'cds-import'),
        ('M-NOVAMOX', 'Novamox 500', 'novamox 500', 'capsule', 'systemic', '01HPHARMACIST0000000000001', '01HPHARMACIST0000000000001')
    `);
    // As the importer wrote them BEFORE this migration: no `derived_from` anywhere.
    await db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength, source) values
        ('M-MOX',      'S-IMG-AMOX', '250 mg', 'derived'),
        ('M-ECOSPRIN', 'S-ASPIRIN',  '75 mg',  'derived'),
        ('M-NOVAMOX',  'S-IMG-AMOX', '500 mg', 'curated')
    `);
  }

  async function derivedFrom(): Promise<Record<string, string | null>> {
    const r = await db.execute<{ medicine_id: string; derived_from: string | null }>(sql`
      select medicine_id, derived_from from formulary_medicine_salts order by medicine_id
    `);
    return Object.fromEntries(r.rows.map((x) => [x.medicine_id, x.derived_from]));
  }

  it("fills a derived row on a release image from the image, and nothing else", async () => {
    await seed();

    await db.execute(sql.raw(backfillFromMigration()));

    expect(await derivedFrom()).toEqual({
      "M-ECOSPRIN": null,
      "M-MOX": "96068000",
      "M-NOVAMOX": null,
    });
  });

  it("is idempotent", async () => {
    await seed();
    await db.execute(sql.raw(backfillFromMigration()));
    await db.execute(sql.raw(backfillFromMigration()));

    expect((await derivedFrom())["M-MOX"]).toBe("96068000");
  });

  it("the table refuses a curated row that claims a derivation", async () => {
    await seed();
    await expect(db.execute(sql`
      update formulary_medicine_salts set derived_from = '96068000' where medicine_id = 'M-NOVAMOX'
    `)).rejects.toThrow(/formulary_medicine_salts_curated_underived_ck/);
  });
});
