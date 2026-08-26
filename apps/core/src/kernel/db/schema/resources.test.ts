import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { RESOURCE_KIND_VALUES, resourceStatusHistory, resources } from "./index";
import type { Db } from "../client";

/**
 * PLAN 13 T1 — the two registry tables, pinned by EXECUTION against the real migration.
 *
 * Every leg below reads `information_schema` / `pg_constraint` or exercises the constraint against
 * Postgres, rather than comparing the schema file to itself. That is §2.88's discipline and not
 * fussiness: an assertion built from the drizzle objects passes for ANY migration at all, including
 * one that was never generated and one that was generated and never applied. What is asserted here
 * is what POSTGRES HAS.
 *
 * ═══ WHAT THIS FILE DOES *NOT* PIN, AND WHERE IT LANDS INSTEAD ═══
 *
 * The plan's T1 acceptance names one leg it cannot own: **the CHECK constraint's kind list compared
 * to the `ResourceKind` UNION**. The union lives in `kernel/resources/kinds.ts`, which T2 creates —
 * T1 runs first, so that parity leg lands in `kinds.test.ts` and this file says so rather than
 * leaving the gap unremarked. What IS pinned here is the half that can be measured today: the ten
 * strings AS POSTGRES HOLDS THEM, read back out of `pg_get_constraintdef`. T2 then has a measured
 * list to compare its union against instead of a transcription of one.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

/** The tables this phase owns, and the columns each must have. A DROP in a later migration fails here. */
const CENSUS: Record<string, string[]> = {
  resources: [
    "attributes", "code", "created_at", "created_by", "id", "kind", "name",
    "occupant_ref", "occupant_type", "parent_id", "since", "site_id", "status",
    "updated_at", "updated_by",
  ],
  resource_status_history: [
    "actor_id", "at", "from_status", "id", "occupant_ref", "occupant_type",
    "reason", "resource_id", "seq", "to_status",
  ],
};

describe("the resource registry tables (Plan 13 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function columnsOf(table: string): Promise<string[]> {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  }

  /** A room, with everything the caller must supply and nothing it need not. */
  function room(id: string, code: string, over: Record<string, unknown> = {}) {
    return { id, kind: "room", code, name: `Room ${code}`, status: "available", ...AUDIT, ...over };
  }

  // ─────────────────────────────────── the census ───────────────────────────────────

  it("both tables exist with exactly the columns the plan names", async () => {
    for (const [table, expected] of Object.entries(CENSUS)) {
      expect({ table, columns: await columnsOf(table) }).toEqual({ table, columns: expected });
    }
  });

  /**
   * DD2 IS AN ABSENCE, AND AN ABSENCE NEEDS ITS OWN ASSERTION. The census leg above would still
   * pass if somebody "helpfully" added `active` and updated the list in the same commit; this leg
   * names the column and the reason, so the diff that adds it has to argue with a sentence rather
   * than with an array.
   */
  it("there is NO `active` boolean — one state column cannot disagree with itself (DD2)", async () => {
    expect(await columnsOf("resources")).not.toContain("active");
  });

  // ─────────────────────── the kind CHECK: ten strings, enforced ───────────────────────

  /**
   * The list AS POSTGRES HOLDS IT. `pg_get_constraintdef` renders the check back as SQL text; the
   * regex lifts the quoted literals out of it in the order they were declared. T2's `kinds.test.ts`
   * compares the `ResourceKind` union against this same measured list (DD5, §2.54's approved remedy
   * for two copies of one fact).
   */
  it("the kind CHECK holds exactly the ten roadmap kinds, read back out of Postgres", async () => {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(oid) as "def" from pg_constraint where conname = 'resources_kind_ck'
    `)).rows as { def: string }[];
    expect(rows).toHaveLength(1);
    const declared = [...rows[0]!.def.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(declared).toEqual([...RESOURCE_KIND_VALUES]);
    expect(declared).toEqual(["floor", "ward", "hall", "room", "bed", "theatre", "store", "bench", "analyzer", "device"]);
  });

  /**
   * The constraint refuses in the direction that matters. `kind` is what every downstream reader
   * branches on, and an out-of-set value reads as "not a bed" to the bed board and "not a room" to
   * the OPD picker — the safe-LOOKING direction, which is 16a's F3 in one sentence.
   */
  it("a kind outside the ten is unstorable, not merely undeclared", async () => {
    await expect(
      db.insert(resources).values(room("R1", "12", { kind: "helipad" })),
    ).rejects.toThrow(/resources_kind_ck/);
  });

  /**
   * `theatre` is IN the CHECK and no manifest declares it until Plan 15. That is deliberate and the
   * two halves are different instruments: the CHECK defends RAW SQL (T6's backfill writes rows the
   * application never sees), and the write path additionally refuses a kind no installed manifest
   * declares (T3, A4). This leg pins the weaker half so the stronger one is not mistaken for it.
   */
  it("a kind the CHECK allows is storable even before any manifest claims it — the two guards are not the same guard", async () => {
    await db.insert(resources).values(room("R1", "OT-1", { kind: "theatre", name: "Theatre 1" }));
    const rows = await db.select().from(resources);
    expect(rows.map((r) => r.kind)).toEqual(["theatre"]);
  });

  // ────────────────────── identity is (site, kind, code), case-free (DD13) ──────────────────────

  it("one code is one resource within a kind, case-free", async () => {
    await db.insert(resources).values(room("R1", "b-4"));
    await expect(
      db.insert(resources).values(room("R2", "B-4")),
    ).rejects.toThrow(/resources_site_kind_code_lower_ux/);
  });

  /**
   * THE WHOLE REASON THE INDEX IS SCOPED. `opd_rooms_code_ux` is unique on raw `code` GLOBALLY, so
   * on that table the first bed '12' would collide with the existing room '12'. Two rows here, same
   * code, different kind — and both must land.
   */
  it("a bed '12' and a room '12' are different things and both are storable", async () => {
    await db.insert(resources).values([
      room("R1", "12"),
      room("B1", "12", { kind: "bed", name: "Bed 12" }),
    ]);
    expect((await db.select().from(resources)).map((r) => `${r.kind}:${r.code}`).sort())
      .toEqual(["bed:12", "room:12"]);
  });

  it("the same code in a second site does not collide with this one (DD3's column, doing its job)", async () => {
    await db.insert(resources).values([
      room("R1", "12"),
      room("R2", "12", { siteId: "annexe" }),
    ]);
    expect((await db.select().from(resources)).map((r) => r.siteId).sort()).toEqual(["annexe", "main"]);
  });

  // ─────────────────────────────── defaults a reader can rely on ───────────────────────────────

  it("site_id defaults to 'main' and attributes to an empty object, so no reader handles null", async () => {
    await db.insert(resources).values(room("R1", "12"));
    const rows = await db.select().from(resources);
    expect({ siteId: rows[0]!.siteId, attributes: rows[0]!.attributes }).toEqual({ siteId: "main", attributes: {} });
  });

  it("the occupancy triad starts empty, all three together (DD6)", async () => {
    await db.insert(resources).values(room("R1", "12"));
    const rows = await db.select().from(resources);
    expect({ t: rows[0]!.occupantType, r: rows[0]!.occupantRef, s: rows[0]!.since })
      .toEqual({ t: null, r: null, s: null });
  });

  // ──────────────────────────────── the tree is a self-reference ────────────────────────────────

  it("a resource hangs under another, and a parent that does not exist is refused", async () => {
    await db.insert(resources).values(room("F1", "1", { kind: "floor", name: "First floor" }));
    await db.insert(resources).values(room("R1", "12", { parentId: "F1" }));
    const rows = await db.select().from(resources);
    expect(rows.map((r) => `${r.id}<-${r.parentId ?? "root"}`).sort()).toEqual(["F1<-root", "R1<-F1"]);
    await expect(
      db.insert(resources).values(room("R2", "13", { parentId: "NOSUCH" })),
    ).rejects.toThrow(/resources_parent_id_resources_id_fk/);
  });

  /**
   * Postgres cannot express "not my own ancestor", so a one-hop self-parent is STORABLE here. The
   * guard is on the write path (T3, A1) and the reader terminates independently of it (T4, A6).
   * Pinned rather than left implicit, because a reader who assumes the database refuses this would
   * conclude the write-path walk is belt-and-braces — and it is the only belt there is.
   */
  it("the database does NOT refuse a cycle — that guard lives on the write path, and this pins why it must", async () => {
    await db.insert(resources).values(room("R1", "12"));
    await db.execute(sql`update resources set parent_id = 'R1' where id = 'R1'`);
    const rows = await db.select().from(resources);
    expect(rows[0]!.parentId).toBe("R1");
  });

  // ──────────────────────────────── history is append-only, in seq ────────────────────────────────

  it("from_status is nullable, because the creation row has no previous status", async () => {
    await db.insert(resources).values(room("R1", "12"));
    await db.insert(resourceStatusHistory).values({
      id: "H1", resourceId: "R1", fromStatus: null, toStatus: "available", actorId: "t",
    });
    const rows = await db.select().from(resourceStatusHistory);
    expect({ from: rows[0]!.fromStatus, to: rows[0]!.toStatus, reason: rows[0]!.reason }).toEqual({
      from: null, to: "available", reason: null,
    });
  });

  /**
   * `seq` IS THE ORDERING KEY and `id` is not. The two rows below are inserted with ids whose
   * lexical order is the REVERSE of their insertion order — 'Z' before 'A' — so a reader that
   * sorted by id would read this resource's history backwards. Ids are ULIDs in production and this
   * fixture makes the same point with two characters.
   */
  it("seq orders history, and it is monotonic even when the ids are not", async () => {
    await db.insert(resources).values(room("R1", "12"));
    await db.insert(resourceStatusHistory).values({ id: "Z-first", resourceId: "R1", toStatus: "available", actorId: "t" });
    await db.insert(resourceStatusHistory).values({ id: "A-second", resourceId: "R1", fromStatus: "available", toStatus: "blocked", actorId: "t" });
    const bySeq = await db.select().from(resourceStatusHistory).orderBy(resourceStatusHistory.seq);
    expect(bySeq.map((r) => r.id)).toEqual(["Z-first", "A-second"]);
    expect(bySeq[0]!.seq).toBeLessThan(bySeq[1]!.seq);
  });

  it("a history row cannot name a resource the registry does not have", async () => {
    await expect(
      db.insert(resourceStatusHistory).values({ id: "H1", resourceId: "NOSUCH", toStatus: "available", actorId: "t" }),
    ).rejects.toThrow(/resource_status_history_resource_id_resources_id_fk/);
  });
});
