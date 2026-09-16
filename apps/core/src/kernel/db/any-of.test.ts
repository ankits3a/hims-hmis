import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { anyOfText } from "./any-of";
import { formularyMedicineSalts } from "./schema";

/**
 * `.toSQL()` renders the statement without issuing it, so this suite needs no database and no test
 * lock. It also means the assertion is about the thing that actually breaks — THE NUMBER OF BIND
 * PARAMETERS — rather than about a query that happened to succeed at a size nobody chose.
 */
const db = drizzle(new Pool({ connectionString: "postgres://never:connected@127.0.0.1:1/none" }));

/** Past 65,535, the Int16 parameter count wraps. See `any-of.ts` for the measured reproduction. */
const PAST_THE_CEILING = 70_000;

const ids = Array.from({ length: PAST_THE_CEILING }, (_, i) => `M${String(i).padStart(12, "0")}`);

describe("anyOfText", () => {
  it("carries any number of values in ONE bind parameter", () => {
    const { sql, params } = db.select().from(formularyMedicineSalts)
      .where(anyOfText(formularyMedicineSalts.medicineId, ids)).toSQL();

    expect(params).toHaveLength(1);
    expect(params[0]).toEqual(ids);
    expect(sql).toContain("= any($1::text[])");
  });

  /**
   * THE COMPARISON IS THE POINT. Without it the assertion above is just a fact about a helper;
   * with it, the suite states the defect the helper exists to close. `inArray` over the same list
   * renders 70,000 parameters, which is the shape that throws `08P01` on the wire.
   */
  it("is the fix for inArray, which emits one bind parameter per value", () => {
    const { params } = db.select().from(formularyMedicineSalts)
      .where(inArray(formularyMedicineSalts.medicineId, ids)).toSQL();

    expect(params).toHaveLength(PAST_THE_CEILING);
    expect(params.length).toBeGreaterThan(65_535);
  });

  it("matches nothing on an empty list, rather than everything", () => {
    const { params, sql } = db.select().from(formularyMedicineSalts)
      .where(anyOfText(formularyMedicineSalts.medicineId, [])).toSQL();

    expect(params).toEqual([[]]);
    expect(sql).toContain("= any($1::text[])");
  });
});
