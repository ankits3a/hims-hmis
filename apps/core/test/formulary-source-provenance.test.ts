import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE BACKFILL IN MIGRATION 0094, RUN AGAINST REAL ROWS ═══
 *
 * `0094_formulary_composition_provenance.sql` carries a hand-written UPDATE that `drizzle-kit
 * generate` did not produce and could not: the generator reproduces a schema diff, and this is a
 * data statement. A hand-written data statement with no test is a statement nobody has ever seen
 * run — so this runs the file's own UPDATE against a medicine written by the importer and a
 * medicine written by a pharmacist, and asserts it moves exactly one of them.
 *
 * It matters because the discriminator is a STRING COMPARISON on `created_by`. Get it wrong in the
 * safe-looking direction — drop the predicate, widen it — and every row a pharmacist ever typed is
 * relabelled as release data, which is precisely the confusion `source` exists to end.
 *
 * ═══ THE STATEMENT IS READ OUT OF THE MIGRATION FILE, NOT RETYPED HERE ═══
 *
 * The first version of this suite held a hand-copied `const BACKFILL = sql\`UPDATE …\``, and a
 * mutant proved the copy worthless: deleting the `created_by` predicate FROM THE MIGRATION left
 * every case green, because the suite was exercising its own copy. "Verbatim" meant somebody had
 * typed the same characters once, which is exactly the two-copies-of-one-fact drift this repo keeps
 * finding. It now parses the file the deploy actually applies, so an edit to the migration is an
 * edit to what this suite runs.
 *
 * The migration has already run against this database by the time the suite starts; re-running the
 * statement against fixtures of the suite's own making is safe by construction, because it is
 * idempotent (setting 'derived' twice is setting it once) and scoped by a predicate rather than by
 * position.
 */
const MIGRATION = resolve(__dirname, "../drizzle/0094_formulary_composition_provenance.sql");

/** The migration's first statement, with its `--` prose stripped: the backfill, as shipped. */
function backfillFromMigration(): string {
  const file = readFileSync(MIGRATION, "utf8");
  const [first] = file.split("--> statement-breakpoint");
  const body = (first ?? "").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim();
  if (!/^update\b/i.test(body)) {
    throw new Error(`the first statement of ${MIGRATION} is not the backfill UPDATE — it is: ${body.slice(0, 80)}`);
  }
  return body;
}

describe("migration 0094 — composition provenance", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, product_count, active, created_by, updated_by)
      values ('S-AMOX', 'amoxicillin', '[]'::jsonb, 0, true, 'cds-import', 'cds-import')
    `);
    // One medicine from the release, one a pharmacist typed. The actor id shape is the real one.
    await db.execute(sql`
      insert into formulary_medicines (id, brand_name, form, route_class, salt_rank, active, created_by, updated_by)
      values ('M-REL', 'Novamox 500', 'capsule', 'systemic', 0, true, 'cds-import', 'cds-import'),
             ('M-HUM', 'Mox 250',     'capsule', 'systemic', 0, true, '01HPHARMACIST0000000000001', '01HPHARMACIST0000000000001')
    `);
    await db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength, source)
      values ('M-REL', 'S-AMOX', '500 mg', 'curated'),
             ('M-HUM', 'S-AMOX', '250 mg', 'curated')
    `);
  }

  const sourceOf = async (medicineId: string): Promise<string> => {
    const r = await db.execute<{ source: string }>(
      sql`select source from formulary_medicine_salts where medicine_id = ${medicineId}`,
    );
    return r.rows[0]?.source ?? "<absent>";
  };

  it("relabels the importer's rows and leaves the pharmacist's alone", async () => {
    await seed();
    // Both start as the old default said they were, which is the state this migration inherits.
    expect(await sourceOf("M-REL")).toBe("curated");
    expect(await sourceOf("M-HUM")).toBe("curated");

    await db.execute(sql.raw(backfillFromMigration()));

    expect(await sourceOf("M-REL")).toBe("derived");
    expect(await sourceOf("M-HUM")).toBe("curated");
  });

  it("is idempotent — a re-run moves nothing further", async () => {
    await seed();
    await db.execute(sql.raw(backfillFromMigration()));
    await db.execute(sql.raw(backfillFromMigration()));
    expect(await sourceOf("M-REL")).toBe("derived");
    expect(await sourceOf("M-HUM")).toBe("curated");
  });

  /**
   * THE DEFAULT IS GONE, AND THAT IS WHAT MAKES EVERY WRITER'S `source` LOAD-BEARING. While a
   * default existed, `addMedicine`'s `source: "curated"` literal could be deleted and no test could
   * tell — the column would supply the same value. This is the assertion that gives that literal
   * teeth: an insert that names no `source` must now fail at the database.
   */
  it("refuses an insert that does not say where the row came from", async () => {
    await seed();
    await expect(db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength)
      values ('M-HUM', 'S-NONE-SUCH', '1 mg')
    `)).rejects.toThrow();

    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, product_count, active, created_by, updated_by)
      values ('S-CLAV', 'clavulanic acid', '[]'::jsonb, 0, true, 'x', 'x')
    `);
    await expect(db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength)
      values ('M-HUM', 'S-CLAV', '125 mg')
    `)).rejects.toThrow(/source/);
  });

  /** The CHECK still holds: provenance is one of two words, not free text. */
  it("refuses a provenance that is neither curated nor derived", async () => {
    await seed();
    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, product_count, active, created_by, updated_by)
      values ('S-CLAV', 'clavulanic acid', '[]'::jsonb, 0, true, 'x', 'x')
    `);
    await expect(db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength, source)
      values ('M-HUM', 'S-CLAV', '125 mg', 'guessed')
    `)).rejects.toThrow();
  });
});
