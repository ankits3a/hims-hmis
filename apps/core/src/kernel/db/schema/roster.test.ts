import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { roles, rosterPositions } from "./index";
import type { Db } from "../client";

/**
 * PHASE R (R1) — `roster_positions`' structural guarantees, EXECUTED against the migrated database.
 *
 * ═══ THE LEG A REVIEWER SHOULD READ FIRST IS THE EXTENSION ═══
 *
 * `btree_gist` is created by 0108 and used by nobody until R2. drizzle-kit does not model
 * extensions, so it is absent from the snapshot and **no `generate` will ever notice it missing**:
 * a future migration that recreates the schema from the snapshot would produce a database on which
 * R2's exclusion constraints cannot be created, and nothing but this assertion would say so. It asks
 * `pg_extension`, not the migration file.
 *
 * ═══ THE OTHER LEGS ARE ABOUT THE THREE VOCABULARIES (S1) ═══
 *
 * A position is what somebody ANSWERS AS, and `eligible_role_key` is the only thread to what they
 * may DO. The FK leg is what stops that thread being tied to nothing — a position whose eligible
 * role does not exist would make every assignment to it unvalidatable, silently.
 */
describe("roster — 0108 structure", () => {
  const AUDIT = { createdBy: "t", updatedBy: "t" } as const;
  const CENSUS: Record<string, string[]> = {
    roster_positions: [
      "active", "cadre", "counts_toward_requirements", "created_at", "created_by", "default_mode",
      "eligible_role_key", "key", "label", "ladder_rank", "max_presence_hours", "updated_at",
      "updated_by",
    ],
  };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values({ key: "doctor", title: "Doctor" }).onConflictDoNothing();
  });

  const columnsOf = async (table: string): Promise<string[]> => {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  };

  const position = (over: Partial<typeof rosterPositions.$inferInsert> = {}) =>
    db.insert(rosterPositions).values({
      key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3,
      eligibleRoleKey: "doctor", maxPresenceHours: 24, ...AUDIT, ...over,
    });

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

  /* ═══════════════════ the extension R2 is built on ═══════════════════ */

  it("btree_gist EXISTS — nothing but this assertion knows 0108 created it", async () => {
    const found = await db.execute(sql`select extname from pg_extension where extname = 'btree_gist'`);
    expect(found.rows).toHaveLength(1);
  });

  /* ═══════════════════ the census ═══════════════════ */

  it("every censused table exists with exactly the columns named — ALL of them, in one run", async () => {
    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(CENSUS)) actual[table] = await columnsOf(table);
    expect(actual).toEqual(CENSUS);
  });

  it("no roster_ table exists that this census does not know about", async () => {
    // R2, R3, R4, R7 and R8 each add tables to this prefix. The leg is here from the first of them
    // so that a table added without a census entry is red in the task that adds it, not later.
    const rows = (await db.execute(sql`
      select table_name as "tableName" from information_schema.tables
      where table_schema = 'public' and table_name like 'roster\\_%' order by table_name asc
    `)).rows as { tableName: string }[];
    expect(rows.map((r) => r.tableName).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  /* ═══════════════════ the thread to RBAC, and the two ends of it ═══════════════════ */

  it("refuses a position whose eligible role does not exist", async () => {
    expect(await constraintOf(position({ eligibleRoleKey: "senior_resident" })))
      .toBe("roster_positions_eligible_role_key_roles_key_fk");
  });

  it("accepts a position with NO eligible role — an intern is not a registered practitioner", async () => {
    expect(await constraintOf(position({ key: "intern", label: "Intern", cadre: "intern", ladderRank: 1, eligibleRoleKey: null, maxPresenceHours: 24 })))
      .toBe("(accepted)");
  });

  it("refuses the same key twice, and the same LABEL under a different key", async () => {
    await position();
    expect(await constraintOf(position())).toBe("roster_positions_pkey");
    // Two positions reading identically on a screen is a rota nobody can check.
    expect(await constraintOf(position({ key: "unit_sr_2" }))).toBe("roster_positions_label_ux");
  });

  /* ═══════════════════ the vocabularies and the bounds ═══════════════════ */

  it.each([
    ["a cadre payroll does not have", { cadre: "registrar" }, "roster_positions_cadre_ck"],
    ["a mode that is neither present nor reachable", { defaultMode: "remote" }, "roster_positions_default_mode_ck"],
    ["a rung below the bedside", { ladderRank: 0 }, "roster_positions_ladder_rank_ck"],
    ["a position planned for no time at all", { maxPresenceHours: 0 }, "roster_positions_max_presence_ck"],
    ["a position planned for a day and a half on the floor", { maxPresenceHours: 37 }, "roster_positions_max_presence_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    expect(await constraintOf(position(over as Partial<typeof rosterPositions.$inferInsert>))).toBe(constraint);
  });

  it("accepts the 24-hour take at its boundary, and the 36-hour outer bound", async () => {
    expect(await constraintOf(position({ maxPresenceHours: 24 }))).toBe("(accepted)");
    expect(await constraintOf(position({ key: "k36", label: "L36", maxPresenceHours: 36 }))).toBe("(accepted)");
  });

  /* ═══════════════════ a table absent from truncateAll is never emptied ═══════════════════ */

  it("the table is emptied by truncateAll", async () => {
    await position();
    await truncateAll(db);
    expect(await db.select().from(rosterPositions)).toHaveLength(0);
  });
});
