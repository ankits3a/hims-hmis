import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { roles, rosterAssignments, rosterPeriods, users } from "./index";
import type { Db } from "../client";

/**
 * PLAN 20 T1 — the roster's structural guarantees, EXECUTED against the migrated database.
 *
 * The one a reviewer should read first is **`roster_assignments_no_double_presence_excl`**. It is
 * hand-written SQL appended to 0108 because drizzle-kit does not model `EXCLUDE`, so it is absent
 * from the snapshot and no `generate` will ever notice it missing. THIS FILE IS THE ONLY THING THAT
 * KNOWS IT EXISTS. `publishPeriod` checks for clashes in application code first, in order to refuse
 * in a sentence — which means its own tests would stay green with the constraint dropped. These
 * write rows DIRECTLY, underneath that code, and watch the database say no.
 */
describe("roster — 0108 structure", () => {
  const U1 = "01USER0000000000000000001";
  const U2 = "01USER0000000000000000002";
  const P1 = "01PERIOD00000000000000001";
  const P2 = "01PERIOD00000000000000002";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values({ key: "junior_resident", title: "JR" }).onConflictDoNothing();
    for (const [id, username] of [[U1, "kavita.rao"], [U2, "sandeep.yadav"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
  });

  const period = (id: string, over: Partial<typeof rosterPeriods.$inferInsert> = {}) =>
    db.insert(rosterPeriods).values({
      id, scopeType: "unit", scopeId: "ORTHO-U2", title: "October", version: 1,
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00"), createdBy: "t", updatedBy: "t", ...over,
    });
  const slot = (id: string, startsAt: string, endsAt: string, over: Partial<typeof rosterAssignments.$inferInsert> = {}) =>
    db.insert(rosterAssignments).values({
      id, periodId: P1, userId: U1, roleKey: "junior_resident", startsAt: at(startsAt), endsAt: at(endsAt),
      createdBy: "t", updatedBy: "t", ...over,
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

  /* ═══════════════════ one body, two rooms ═══════════════════ */

  it("the exclusion constraint EXISTS, is gist, and is partial on live presence rows", async () => {
    const found = await db.execute(sql`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'roster_assignments' and c.conname = 'roster_assignments_no_double_presence_excl'`);
    expect(found.rows).toHaveLength(1);
    const def = String((found.rows[0] as { def: string }).def);
    expect(def).toContain("EXCLUDE USING gist");
    expect(def).toContain("user_id WITH =");
    expect(def).toContain("WITH &&");
    expect(def).toMatch(/WHERE \(\(?effective AND/);
    expect(def).toContain("'presence'");
  });

  it("refuses two LIVE presence windows of one person that overlap", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true });
    expect(await constraintOf(slot("A2", "2026-10-13T07:30", "2026-10-13T14:00", { effective: true })))
      .toBe("roster_assignments_no_double_presence_excl");
  });

  it("accepts what is NOT one body in two rooms", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true });
    // back-to-back: the range is half-open, 08:00 belongs to the second duty only
    expect(await constraintOf(slot("A2", "2026-10-13T08:00", "2026-10-13T14:00", { effective: true }))).toBe("(accepted)");
    // on call across a duty
    expect(await constraintOf(slot("A3", "2026-10-12T08:00", "2026-10-13T08:00", { effective: true, mode: "call" }))).toBe("(accepted)");
    // a draft's copy of the same slot
    expect(await constraintOf(slot("A4", "2026-10-12T20:00", "2026-10-13T08:00", { effective: false }))).toBe("(accepted)");
    // somebody else, same window
    expect(await constraintOf(slot("A5", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true, userId: U2 }))).toBe("(accepted)");
  });

  it("refuses the UPDATE that would bring a clashing draft row into effect — the path publish takes", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true });
    await slot("A2", "2026-10-12T22:00", "2026-10-13T06:00", { effective: false });
    expect(await constraintOf(db.execute(sql`update roster_assignments set effective = true where id = 'A2'`)))
      .toBe("roster_assignments_no_double_presence_excl");
  });

  /* ═══════════════════ the publication gate, as the database sees it ═══════════════════ */

  it("allows ONE published version per scope and start, and any number of drafts", async () => {
    const pub = { status: "published", publishedAt: new Date(), publishedBy: "t" };
    await period(P1, pub);
    await period(P2, { version: 2 }); // a draft beside it: fine
    expect(await constraintOf(db.execute(sql`update roster_periods set status = 'published', published_at = now(), published_by = 't' where id = ${P2}`)))
      .toBe("roster_periods_one_published_ux");
    // a different unit's October is a different roster
    expect(await constraintOf(period("01PERIOD00000000000000003", { ...pub, scopeId: "ORTHO-U3" }))).toBe("(accepted)");
  });

  it("refuses the same version twice, and treats a hospital scope's NULL id as equal to itself", async () => {
    await period(P1, { scopeType: "hospital", scopeId: null });
    expect(await constraintOf(period(P2, { scopeType: "hospital", scopeId: null })))
      .toBe("roster_periods_scope_start_version_ux");
  });

  it.each([
    // carries the publication pair, so the ONLY thing wrong with the row is the word
    ["a status outside the vocabulary", { status: "cancelled", publishedAt: new Date(), publishedBy: "t" }, "roster_periods_status_ck"],
    ["a hospital roster that names a scope", { scopeType: "hospital", scopeId: "x" }, "roster_periods_scope_id_ck"],
    ["a unit roster that names none", { scopeId: null }, "roster_periods_scope_id_ck"],
    ["a window that ends before it starts", { endsAt: at("2026-09-01T00:00") }, "roster_periods_window_ck"],
    ["version zero", { version: 0 }, "roster_periods_version_ck"],
    ["published with nobody's name on it", { status: "published", publishedAt: new Date(), publishedBy: null }, "roster_periods_published_ck"],
    ["a draft that claims a publication time", { publishedAt: new Date(), publishedBy: "t" }, "roster_periods_published_ck"],
    ["superseded with no time", { status: "superseded", publishedAt: new Date(), publishedBy: "t" }, "roster_periods_superseded_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    expect(await constraintOf(period(P1, over as Partial<typeof rosterPeriods.$inferInsert>))).toBe(constraint);
  });

  it.each([
    ["a duty that ends when it starts", { endsAt: at("2026-10-12T20:00") }, "roster_assignments_window_ck"],
    ["a mode outside the vocabulary", { mode: "remote" }, "roster_assignments_mode_ck"],
    ["a kind outside the vocabulary", { kind: "holiday" }, "roster_assignments_kind_ck"],
    ["a source outside the vocabulary", { source: "whatsapp" }, "roster_assignments_source_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    await period(P1);
    expect(await constraintOf(slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", over as Partial<typeof rosterAssignments.$inferInsert>)))
      .toBe(constraint);
  });

  /* ═══════════════════ a table absent from truncateAll is never emptied ═══════════════════ */

  it("both tables are emptied by truncateAll", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00");
    await truncateAll(db);
    expect(await db.select().from(rosterPeriods)).toHaveLength(0);
    expect(await db.select().from(rosterAssignments)).toHaveLength(0);
  });
});
