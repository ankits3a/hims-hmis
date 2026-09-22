import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import * as schema from "../../kernel/db/schema";
import { catalogueCensus, medicinesByIds, pageMedicines } from "./reads";
import { normalizeDrugName, resolveDrugTexts, resolveMedicines } from "./resolve";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CATALOGUE-SCALE PIN: NO READ MAY COST WHAT THE CATALOGUE COSTS ═══
 *
 * WHY THIS SUITE EXISTS. `listMedicines` read every row of `formulary_medicines`, then asked for
 * the composition with `inArray(medicineId, <every id>)`. drizzle emits ONE BIND PARAMETER PER
 * VALUE, and the Postgres wire Bind message counts its parameters in an **Int16**. Past 65,535 the
 * count wraps and the server rejects the message outright. So it was not a slow read that wanted an
 * index — it was a read that STOPPED WORKING, with a protocol error, at a row count the national
 * drug catalogue passes on its first day.
 *
 * MEASURED read-only against `hmis_cds_dev` (103,383 medicines, 142,759 composition rows), by
 * issuing the exact statement shape drizzle emits:
 *
 *     n =  65,535  ->  OK
 *     n =  65,536  ->  08P01  bind message supplies 0 parameters, but prepared statement ""
 *                            requires 65536
 *     n = 103,383  ->  08P01  bind message has 37847 parameter formats but 0 parameters
 *                            (103,383 mod 65,536 = 37,847 — the wrap, arithmetically)
 *
 * And at this suite's own 70,000: `bind message has 4464 parameter formats but 0 parameters`
 * (70,000 mod 65,536 = 4,464). That is the failure every case below produced before the fix.
 *
 * ═══ WHAT IT PINS NOW, AFTER `listMedicines` WAS DELETED RATHER THAN CAPPED ═══
 *
 * The first version of this file asserted `listMedicines(db).length === 70,000` — that the whole
 * catalogue could be read without throwing. That was the right assertion against a function whose
 * job was to return everything, and it is the WRONG one now: the fix was to stop asking. So the
 * assertions moved with the design, and what they pin is sharper — that the three questions the
 * module now offers each cost what THEY cost and not what the table costs:
 *
 *   - a PAGE costs a page (`pageMedicines`),
 *   - a COUNT costs no rows at all (`catalogueCensus`),
 *   - a HANDFUL costs a handful (`medicinesByIds`).
 *
 * The census case is the load-bearing one: it answers 70,000 while the page answers 50, over the
 * same table in the same suite. That pair is what says the count and the page are different
 * questions — and it is exactly the conflation that used to make a screen fetch 103,383 rows to
 * print a number.
 *
 * COST. The seed is a single `generate_series` insert, not 70,000 round trips: a few seconds once,
 * in `beforeAll`, and no other suite pays for it.
 */
const SCALE = 70_000;

/**
 * One short of 65,536 is not a margin, it IS the boundary: 65,535 passes and 65,536 throws, so a
 * suite seeded at 60,000 would be green over the defect. 70,000 is the smallest round number that
 * is unambiguously past it and still cheap to seed.
 */
const BIND_CEILING = 65_535;

async function seedCatalogueAtScale(db: Db, n: number): Promise<void> {
  await db.execute(sql`
    insert into formulary_medicines (id, brand_name, name_normalized, form, route_class, salt_rank, active, created_by, updated_by)
    select 'SCALE' || lpad(g::text, 12, '0'), 'Scale Brand ' || lpad(g::text, 12, '0'),
           'scale brand ' || lpad(g::text, 12, '0'),
           'tablet', 'systemic', 0, true, 'catalogue-scale-test', 'catalogue-scale-test'
      from generate_series(1, ${n}) g
  `);
  /* A moiety table at the same scale, because the read this suite now pins is over THAT table. */
  await db.execute(sql`
    insert into formulary_salts (id, name, aliases, product_count, active, created_by, updated_by)
    select 'SALT' || lpad(g::text, 12, '0'), 'scale moiety ' || lpad(g::text, 12, '0'),
           '[]'::jsonb, 0, true, 'catalogue-scale-test', 'catalogue-scale-test'
      from generate_series(1, ${n}) g
  `);
  /* One real composition row, so the medicine under test resolves to something rather than nothing. */
  await db.execute(sql`
    insert into formulary_medicine_salts (medicine_id, salt_id, strength, source)
    values ('SCALE000000000001', 'SALT000000000001', '500 mg', 'derived')
  `);
}

describe("the catalogue at national scale", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
    await truncateAll(db);
    await seedCatalogueAtScale(db, SCALE);
  });
  afterAll(async () => teardown());

  it("seeds past the Int16 bind ceiling, so this suite can see the defect at all", async () => {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from formulary_medicines`);
    const seeded = Number(r.rows[0]?.n ?? 0);
    expect(seeded).toBe(SCALE);
    expect(seeded).toBeGreaterThan(BIND_CEILING);
  });

  /**
   * A PAGE COSTS A PAGE. The old reader fetched every medicine row and then asked for the
   * composition of all of them; `pageMedicines` fetches `limit + 1` rows first and asks for the
   * composition of exactly those, which is the reordering that closes the defect.
   */
  it("answers a page over a catalogue far past the ceiling", async () => {
    const page = await pageMedicines(db, { limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]?.brandName).toBe("Scale Brand 000000000001");
    // The composition is joined for the PAGE: the one seeded row carries its moiety...
    expect(page.items[0]?.salts).toEqual([{ saltId: "SALT000000000001", strength: "500 mg" }]);
    // ...and a medicine with no composition is present with an EMPTY list rather than absent.
    expect(page.items[1]?.salts).toEqual([]);
  });

  it("advances: the next page starts after the last row of the previous one", async () => {
    const first = await pageMedicines(db, { limit: 50 });
    const second = await pageMedicines(db, { limit: 50, cursor: first.nextCursor });
    expect(second.items).toHaveLength(50);
    const lastOfFirst = first.items[first.items.length - 1]?.brandName ?? "";
    const firstOfSecond = second.items[0]?.brandName ?? "";
    expect(firstOfSecond.toLowerCase() > lastOfFirst.toLowerCase()).toBe(true);
    expect(second.items.map((m) => m.id)).not.toEqual(first.items.map((m) => m.id));
  });

  /**
   * THE PAIR THAT MATTERS. The census says 70,000 and the page says 50, over the same table in the
   * same test. A screen that wants the total asks for the total; it does not fetch the table and
   * measure it, which is how the admin screen used to print that number.
   */
  it("counts the whole catalogue without reading it, while a page still reads a page", async () => {
    const census = await catalogueCensus(db);
    expect(census.medicines).toBe(SCALE);
    expect(census.activeMedicines).toBe(SCALE);
    /*
      ONE of the seeded medicines has a composition and the rest do not, so this figure is asserted
      as SCALE - 1 rather than SCALE. That off-by-one is the assertion: a census that counted rows
      instead of composition-less rows would read 70,000 here, and the number exists precisely to
      separate the products a safety check can reason about from the ones it cannot.
    */
    expect(census.uncomposedActiveMedicines).toBe(SCALE - 1);
    expect(census.compositionRows).toBe(1);

    const page = await pageMedicines(db, { limit: 50 });
    expect(page.items).toHaveLength(50);
  });

  /**
   * ═══ RESOLVING ONE MEDICINE MUST NOT READ THE MOIETY TABLE ═══
   *
   * `resolveMedicines` used to call `activeSalts(db)` — `select … from formulary_salts where active`,
   * unbounded — purely to build a fallback map for a branch that could not fire. It sits on the
   * doctor's live prescription-check path and on the dispensing gate, where `verify.ts` resolves
   * exactly TWO medicines and paid for every moiety in the catalogue to do it.
   *
   * The assertion is on the SQL ISSUED, not on the answer, and that is the whole point: the answer
   * was always correct, which is why nothing caught the read. The filter excludes `= any(` because
   * the bounded reads legitimately query `formulary_salts` by a list of ids — what must never appear
   * again is a statement over that table with no id list at all.
   */
  it("resolves a medicine by id without reading the moiety table", async () => {
    const issued: string[] = [];
    const spied = drizzle(pool, {
      schema, logger: { logQuery: (q: string) => { issued.push(q); } },
    }) as unknown as Db;

    const out = await resolveMedicines(spied, ["SCALE000000000001"]);
    expect(out.get("SCALE000000000001")?.salts).toHaveLength(1);

    const unbounded = issued.filter((q) => /from "formulary_salts"/.test(q) && !/= any\(/.test(q));
    expect(unbounded).toEqual([]);
  });

  /**
   * ═══ RESOLVING FREE TEXT MUST NOT READ THE CATALOGUE EITHER ═══
   *
   * `resolveDrugTexts` used to `select ... from formulary_medicines where active` with no id filter
   * at all, then normalize every brand in JavaScript to build its lookup map — on every prescription
   * issue and every claim. It never threw (it takes no id list, so no bind-parameter ceiling), which
   * is exactly why it outlived the reads that did.
   *
   * THE ASSERTION IS THE SQL ISSUED. A statement over `formulary_medicines` with no `= any(` is the
   * unbounded read, by construction — the bounded form asks for the normalized names the caller
   * wanted. `formulary_salts` is excluded from the filter because `resolveDrugTexts` legitimately
   * reads all of it to build `byMoiety`/`byAlias`; that read is earned and is not what this pins.
   */
  it("resolves free text without reading the catalogue", async () => {
    const issued: string[] = [];
    const spied = drizzle(pool, {
      schema, logger: { logQuery: (q: string) => { issued.push(q); } },
    }) as unknown as Db;

    const out = await resolveDrugTexts(spied, ["Scale Brand 000000000001", "not a drug at all"]);
    expect(out.get("Scale Brand 000000000001")?.brandName).toBe("Scale Brand 000000000001");
    expect(out.get("not a drug at all")).toBeNull();

    const unbounded = issued.filter((q) => /from "formulary_medicines"/.test(q) && !/= any\(/.test(q));
    expect(unbounded).toEqual([]);
  });

  /**
   * ═══ THE SQL BACKFILL AND THE TYPESCRIPT NORMALIZER ARE ONE ANSWER ═══
   *
   * Migration 0095 fills `name_normalized` for rows that existed before the column, and it is the
   * ONE place the normalizer is written in SQL. `resolve.ts`'s header names the hazard precisely:
   * "two copies of one fact drift by construction ... the half that stops resolving is the SAFETY
   * half."
   *
   * A test that writes through `addMedicine` cannot see this — those rows are filled by the
   * TypeScript function, so the SQL copy is never exercised. A mutant proved that: changing the
   * migration's character class to keep hyphens left every other case green. So the EXPRESSION is
   * read out of the migration file and evaluated by Postgres against a corpus, and compared with
   * what `normalizeDrugName` returns for the same strings.
   */
  it("the migration's backfill expression agrees with normalizeDrugName", async () => {
    const file = readFileSync(
      resolve(__dirname, "../../../drizzle/0095_formulary_medicine_name_normalized.sql"), "utf8",
    );
    const m = /SET "name_normalized" =([\s\S]*?)\n\s*WHERE/.exec(file);
    if (m === null) throw new Error("could not find the backfill's SET expression in migration 0095");
    const expr = (m[1] ?? "").trim().replace(/"brand_name"/g, "$1");

    const corpus = [
      "Augmentin-625", "Co.Amoxiclav (625)", "Amox  /  Clav", "  Crocin , 500  ",
      "PARACETAMOL", "A-Ret 0.025%", "NS (sodium chloride) 9 mg/1 ml",
    ];
    // One round trip, all rows: the expression applied to the corpus as a VALUES list.
    const rows = await db.execute<{ raw: string; sqlv: string }>(sql`
      select v as raw, ${sql.raw(expr.replace(/\$1/g, "v"))} as sqlv
        from (select unnest(${sql.param(corpus)}::text[]) as v) t
    `);
    expect(rows.rows).toHaveLength(corpus.length);
    for (const row of rows.rows) expect(row.sqlv).toBe(normalizeDrugName(row.raw));
  });

  /** A HANDFUL COSTS A HANDFUL — the shape every pharmacy call site now uses. */
  it("reads a named handful out of a catalogue past the ceiling", async () => {
    const ids = ["SCALE000000000001", "SCALE000000069999", "SCALE000000070000"];
    const found = await medicinesByIds(db, ids);
    expect([...found.keys()].sort()).toEqual([...ids].sort());
    expect(found.get("SCALE000000070000")?.brandName).toBe("Scale Brand 000000070000");
  });
});
