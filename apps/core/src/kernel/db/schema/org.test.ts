import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { opdDepartments, orgDepartments } from "./index";
import type { Db } from "../client";

/**
 * PHASE R (R1) — `org_departments`' structural guarantees, EXECUTED against the migrated database.
 *
 * The two a reviewer should read first are the two that cannot be recovered from later:
 *
 *   · **`org_departments_opd_department_ux`** — one clinic has at most one organisational owner.
 *     Without it, two departments can both claim `MED`'s OPD, and "whose clinic is this?" stops
 *     having an answer at the moment somebody needs it (a rota, a fee anchor, an NMC return).
 *   · **the FK to `opd_departments`** — the link is the ONLY thing that ties the roster's list to
 *     the counter's, and the plan freezes `opd_departments` (§5), so this is the only side it can
 *     be written on.
 *
 * The last `it` is the one the method makes executable: **a table absent from `truncateAll` is
 * never emptied**, so every later suite in the file that uses it inherits another suite's rows.
 */
describe("org — 0108 structure", () => {
  const AUDIT = { createdBy: "t", updatedBy: "t" } as const;
  const CENSUS: Record<string, string[]> = {
    org_departments: [
      "active", "admitting", "code", "created_at", "created_by", "id", "kind", "name",
      "opd_department_id", "site_id", "updated_at", "updated_by", "valid_from", "valid_to",
    ],
  };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const columnsOf = async (table: string): Promise<string[]> => {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  };

  const dept = (over: Partial<typeof orgDepartments.$inferInsert> = {}) =>
    db.insert(orgDepartments).values({
      id: "D1", code: "MED", name: "General Medicine", kind: "clinical", ...AUDIT, ...over,
    });

  /** The constraint a write tripped, dug out of whichever `cause` drizzle wrapped it in. */
  const constraintOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    const e = await p.then(() => null, (err: unknown) => err);
    let cur: unknown = e;
    for (let i = 0; i < 4 && cur != null && typeof cur === "object"; i += 1) {
      const c = cur as { constraint?: unknown; cause?: unknown };
      if (typeof c.constraint === "string") return c.constraint;
      cur = c.cause;
    }
    return e === null ? "(accepted)" : undefined;
  };

  /* ═══════════════════ the census ═══════════════════ */

  it("every censused table exists with exactly the columns named — ALL of them, in one run", async () => {
    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(CENSUS)) actual[table] = await columnsOf(table);
    expect(actual).toEqual(CENSUS);
  });

  it("no org_ table exists that this census does not know about", async () => {
    const rows = (await db.execute(sql`
      select table_name as "tableName" from information_schema.tables
      where table_schema = 'public' and table_name like 'org\\_%' order by table_name asc
    `)).rows as { tableName: string }[];
    expect(rows.map((r) => r.tableName).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  /* ═══════════════════ one code, one department; one clinic, one owner ═══════════════════ */

  it("refuses a second department with the same code at the same site, and allows it at another", async () => {
    await dept();
    expect(await constraintOf(dept({ id: "D2" }))).toBe("org_departments_code_ux");
    expect(await constraintOf(dept({ id: "D3", siteId: "annexe" }))).toBe("(accepted)");
  });

  it("refuses two departments claiming ONE clinic, and allows any number claiming none", async () => {
    await db.insert(opdDepartments).values({ id: "OPD-MED", code: "MED", name: "General Medicine", ...AUDIT });
    await dept({ opdDepartmentId: "OPD-MED" });
    expect(await constraintOf(dept({ id: "D2", code: "SUR", opdDepartmentId: "OPD-MED" })))
      .toBe("org_departments_opd_department_ux");
    // NULL is not equal to NULL in a unique index: the eleven that never run a clinic all coexist.
    expect(await constraintOf(dept({ id: "D3", code: "PATH" }))).toBe("(accepted)");
    expect(await constraintOf(dept({ id: "D4", code: "NURS" }))).toBe("(accepted)");
  });

  it("refuses a link to a clinic that does not exist — the list cannot point at nothing", async () => {
    expect(await constraintOf(dept({ opdDepartmentId: "OPD-GHOST" })))
      .toBe("org_departments_opd_department_id_opd_departments_id_fk");
  });

  /* ═══════════════════ the vocabularies and the dates ═══════════════════ */

  it.each([
    ["a kind outside NMC's own division", { kind: "outpatient" }, "org_departments_kind_ck"],
    ["a closure before the opening", { validFrom: new Date("2026-04-01"), validTo: new Date("2026-03-01") }, "org_departments_validity_ck"],
    ["a closure at the instant of opening", { validFrom: new Date("2026-04-01"), validTo: new Date("2026-04-01") }, "org_departments_validity_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    expect(await constraintOf(dept(over as Partial<typeof orgDepartments.$inferInsert>))).toBe(constraint);
  });

  it("accepts a department that is OPEN and already has a closing date — a planned merger is not a contradiction", async () => {
    expect(await constraintOf(dept({
      active: true, validFrom: new Date("2026-04-01"), validTo: new Date("2027-04-01"),
    }))).toBe("(accepted)");
  });

  /* ═══════════════════ a table absent from truncateAll is never emptied ═══════════════════ */

  it("the table is emptied by truncateAll", async () => {
    await dept();
    await truncateAll(db);
    expect(await db.select().from(orgDepartments)).toHaveLength(0);
  });
});
