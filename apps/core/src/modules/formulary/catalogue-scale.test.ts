import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { catalogueCensus, medicinesByIds, pageMedicines } from "./reads";
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
    insert into formulary_medicines (id, brand_name, form, route_class, salt_rank, active, created_by, updated_by)
    select 'SCALE' || lpad(g::text, 12, '0'), 'Scale Brand ' || lpad(g::text, 12, '0'),
           'tablet', 'systemic', 0, true, 'catalogue-scale-test', 'catalogue-scale-test'
      from generate_series(1, ${n}) g
  `);
}

describe("the catalogue at national scale", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
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
    // The composition is joined for the PAGE, so it is present and empty rather than absent.
    expect(page.items[0]?.salts).toEqual([]);
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
    // Every seeded row is composition-less, which is precisely what this figure is for.
    expect(census.uncomposedActiveMedicines).toBe(SCALE);
    expect(census.compositionRows).toBe(0);

    const page = await pageMedicines(db, { limit: 50 });
    expect(page.items).toHaveLength(50);
  });

  /** A HANDFUL COSTS A HANDFUL — the shape every pharmacy call site now uses. */
  it("reads a named handful out of a catalogue past the ceiling", async () => {
    const ids = ["SCALE000000000001", "SCALE000000069999", "SCALE000000070000"];
    const found = await medicinesByIds(db, ids);
    expect([...found.keys()].sort()).toEqual([...ids].sort());
    expect(found.get("SCALE000000070000")?.brandName).toBe("Scale Brand 000000070000");
  });
});
