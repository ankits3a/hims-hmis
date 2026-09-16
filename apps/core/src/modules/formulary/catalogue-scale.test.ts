import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { listMedicines } from "./masters";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CATALOGUE-SCALE PIN: A READ'S BIND PARAMETERS MUST NOT COUNT THE CATALOGUE ═══
 *
 * WHY THIS SUITE EXISTS. `listMedicines` reads every row of `formulary_medicines`, then asks for
 * the composition with `inArray(medicineId, <every id>)`. drizzle emits ONE BIND PARAMETER PER
 * VALUE, and the Postgres wire Bind message counts its parameters in an **Int16**. Past 65,535 the
 * count wraps and the server rejects the message outright. So this is not a slow read that wants
 * an index — it is a read that STOPS WORKING, with a protocol error, at a row count the national
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
 * And the fix, measured the same way on the same rows: `= any($1::text[])` carries the whole list
 * in ONE parameter — 103,383 ids, 1 bind parameter, 153 ms, no error.
 *
 * WHY IT MATTERS BEYOND THIS FUNCTION. `listMedicines` has nine callers and five of them are on
 * the pharmacy counter — `queue.ts` inside `getDispense`, which is the return value of EVERY
 * pharmacy mutation, plus label printing, claims, handover and the dispensing gate. The catalogue
 * being empty is the only reason any of them work today: production's `formulary_medicines` is 0
 * rows and `deploy.sh` runs no importer. The first deployment to load the drug catalogue — which
 * is exactly what the doctor's typeahead needs — takes the whole pharmacy module down with it.
 *
 * WHAT THIS SUITE PINS, AND WHERE. The decision under test is "ask for the ids you need, bounded,
 * rather than for the catalogue". It is made inside the formulary's read helpers, so that is where
 * this asserts. The per-call-site pins — that `queue.ts` asks for a dispense's medicines and not
 * for all of them — live beside those call sites, because a suite that only proved the helper
 * works would stay green while a caller went on handing it the catalogue.
 *
 * COST. The seed is a single `generate_series` insert, not 70,000 round trips. Measured on this
 * box it costs a few seconds once, in `beforeAll`, and no other suite pays for it.
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
   * A1 — THE DEFECT ITSELF. Against `6c9e39d5` this throws
   *   `08P01 bind message has 4464 parameter formats but 0 parameters`  (70,000 mod 65,536)
   * and that failure is this suite's reason to exist. Every pharmacy read below fails the same way
   * and for the same reason; they are listed separately because each one is a separate promise to
   * a separate screen, and a fix that closed only the first would leave the rest throwing.
   */
  it("reads every medicine without scaling its bind parameters with the catalogue", async () => {
    const all = await listMedicines(db);
    expect(all.length).toBe(SCALE);
  });

  it("reads the ACTIVE medicines the same way", async () => {
    const all = await listMedicines(db, { activeOnly: true });
    expect(all.length).toBe(SCALE);
  });
});
