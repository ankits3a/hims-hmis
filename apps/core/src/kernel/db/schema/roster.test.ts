import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  orgDepartments, roles, rosterAmendments, rosterAssignments, rosterPeriods, rosterPositions, users,
} from "./index";
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
    // PHASE R (R2) — transcribed from `roster.ts`, not read back out of the database, so a column
    // added without a decision fails here rather than being certified by its own existence.
    roster_periods: [
      "based_on_period_id", "content_hash", "covers_positions", "created_at", "created_by",
      "department_id", "drafted_by_actor_type", "ends_at", "human_touched_at", "id", "origin",
      "published_at", "published_by", "scope_id", "scope_type", "site_id", "starts_at", "status",
      "superseded_at", "superseded_by_period_id", "team_id", "title", "updated_at", "updated_by",
      "version",
    ],
    roster_amendments: [
      "added_count", "after_the_fact", "applied_at", "approved_at", "approved_by", "created_at",
      "created_by", "id", "kind", "period_id", "reason", "requested_by", "superseded_count",
      "updated_at", "updated_by",
    ],
    roster_assignments: [
      "amendment_id", "batch_ref", "call_tier", "confirmed_at", "confirmed_by_user_id",
      "cover_scope", "created_at", "created_by", "department_id", "effective", "ends_at", "id",
      "kind", "lineage_id", "live_from", "live_to", "location_resource_id", "mode", "note",
      "off_kind", "period_id", "position_key", "proposal_run_id", "proposed_by_actor_id",
      "proposed_by_actor_type", "shift_def_id", "source", "starts_at", "supernumerary",
      "swap_of_id", "team_id", "topic", "updated_at", "updated_by", "user_id",
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

/**
 * PHASE R (R2) — the period, slot and amendment structure, EXECUTED, and written **underneath the
 * domain code**.
 *
 * ═══ WHY THESE ROWS ARE INSERTED DIRECTLY ═══
 *
 * `publishPeriod` refuses a double-booking in a sentence, before the constraint ever sees it. That
 * is right for a human — and it means **the domain suite would stay entirely green with the
 * exclusion constraint dropped.** The constraint is the thing that holds when a path nobody
 * anticipated writes a row: a future importer, a repair script, an amendment written by a phase
 * that has not been designed yet. So this file writes rows the way those would, and watches
 * Postgres say no.
 *
 * The three objects a `generate` cannot see — two EXCLUDEs and a gist index — are asked for by
 * name from `pg_constraint` and `pg_indexes`. Nothing else in the tree knows they exist.
 */
describe("roster — 0109 structure", () => {
  const AUDIT = { createdBy: "t", updatedBy: "t" } as const;
  const U1 = "01USER0000000000000000001";
  const U2 = "01USER0000000000000000002";
  const P1 = "01PERIOD00000000000000001";
  const P2 = "01PERIOD00000000000000002";
  const DEPT = "01ORGDEPT00000000000MED1";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values({ key: "doctor", title: "Doctor" }).onConflictDoNothing();
    await db.insert(orgDepartments).values({
      id: DEPT, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, ...AUDIT,
    });
    await db.insert(rosterPositions).values({
      key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3,
      eligibleRoleKey: "doctor", maxPresenceHours: 24, ...AUDIT,
    });
    for (const [id, username] of [[U1, "kavita.rao"], [U2, "sandeep.yadav"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
  });

  const period = (id: string, over: Partial<typeof rosterPeriods.$inferInsert> = {}) =>
    db.insert(rosterPeriods).values({
      id, scopeType: "team", scopeId: "MED-U2", title: "October", version: 1,
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00"),
      coversPositions: ["unit_sr"], departmentId: DEPT, ...AUDIT, ...over,
    });

  const slot = (id: string, startsAt: string, endsAt: string, over: Partial<typeof rosterAssignments.$inferInsert> = {}) =>
    db.insert(rosterAssignments).values({
      id, periodId: P1, userId: U1, positionKey: "unit_sr", departmentId: DEPT,
      startsAt: at(startsAt), endsAt: at(endsAt), lineageId: id, proposedByActorId: "t", ...AUDIT, ...over,
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

  /* ═══════════════════ the three objects no `generate` can see ═══════════════════ */

  it("the presence EXCLUDE exists, is gist, and is partial on live, present, NAMED rows", async () => {
    const found = await db.execute(sql`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'roster_assignments' and c.conname = 'roster_assignments_no_double_presence_excl'`);
    expect(found.rows).toHaveLength(1);
    const def = String((found.rows[0] as { def: string }).def);
    expect(def).toContain("EXCLUDE USING gist");
    expect(def).toContain("user_id WITH =");
    expect(def).toContain("WITH &&");
    expect(def).toContain("'presence'");
    expect(def).toContain("user_id IS NOT NULL");
  });

  it("the one-published-per-scope EXCLUDE exists and is over the RANGE, not the start", async () => {
    const found = await db.execute(sql`
      select pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'roster_periods' and c.conname = 'roster_periods_one_published_excl'`);
    expect(found.rows).toHaveLength(1);
    const def = String((found.rows[0] as { def: string }).def);
    expect(def).toContain("EXCLUDE USING gist");
    expect(def).toContain("tstzrange");
    expect(def).toContain("&&");
    expect(def).toContain("'published'");
  });

  it("the resolver's gist index exists and is partial on effective", async () => {
    const found = await db.execute(sql`
      select indexdef from pg_indexes
       where tablename = 'roster_assignments' and indexname = 'roster_assignments_position_window_idx'`);
    expect(found.rows).toHaveLength(1);
    const def = String((found.rows[0] as { indexdef: string }).indexdef);
    expect(def).toContain("USING gist");
    expect(def).toContain("position_key");
    expect(def).toContain("WHERE effective");
  });

  /* ═══════════════════ V1 — one body, two rooms ═══════════════════ */

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
    // on call across a duty — that is what on-call MEANS
    expect(await constraintOf(slot("A3", "2026-10-12T08:00", "2026-10-13T08:00", { effective: true, mode: "call" }))).toBe("(accepted)");
    // a draft's copy of the same slot
    expect(await constraintOf(slot("A4", "2026-10-12T20:00", "2026-10-13T08:00", { effective: false }))).toBe("(accepted)");
    // somebody else, same window
    expect(await constraintOf(slot("A5", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true, userId: U2 }))).toBe("(accepted)");
    // a SUPERSEDED row that was live for the same window — the knowledge axis, not the duty axis
    expect(await constraintOf(slot("A6", "2026-10-12T20:00", "2026-10-13T08:00", {
      effective: false, liveTo: at("2026-10-12T21:00"),
    }))).toBe("(accepted)");
  });

  it("two VACANT slots in one window are two holes, not one person in two rooms", async () => {
    // The leg that would fail if the EXCLUDE's `user_id IS NOT NULL` were dropped: an unfilled
    // night in Medicine and an unfilled night in Surgery are the commonest pair on any roster.
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true, userId: null });
    expect(await constraintOf(slot("A2", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true, userId: null })))
      .toBe("(accepted)");
  });

  it("refuses the UPDATE that would bring a clashing draft row into effect — the path publish takes", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", { effective: true });
    await slot("A2", "2026-10-12T22:00", "2026-10-13T06:00", { effective: false });
    expect(await constraintOf(db.execute(sql`update roster_assignments set effective = true where id = 'A2'`)))
      .toBe("roster_assignments_no_double_presence_excl");
  });

  /* ═══════════════════ V2 — one published roster per scope per instant ═══════════════════ */

  it("refuses a second published roster whose window OVERLAPS, and allows one that abuts", async () => {
    const pub = { status: "published", publishedAt: new Date(), publishedBy: "t", contentHash: "h" };
    await period(P1, pub);
    // September running into October: the overlap T1's unique index could not see.
    expect(await constraintOf(period(P2, {
      ...pub, startsAt: at("2026-09-01T00:00"), endsAt: at("2026-10-06T00:00"),
    }))).toBe("roster_periods_one_published_excl");
    // November, abutting exactly — half-open, so no overlap
    expect(await constraintOf(period("01PERIOD00000000000000003", {
      ...pub, startsAt: at("2026-11-01T00:00"), endsAt: at("2026-12-01T00:00"),
    }))).toBe("(accepted)");
    // another team's October is a different roster
    expect(await constraintOf(period("01PERIOD00000000000000004", { ...pub, scopeId: "MED-U3" }))).toBe("(accepted)");
    // and any number of DRAFTS may overlap
    expect(await constraintOf(period("01PERIOD00000000000000005", { version: 2 }))).toBe("(accepted)");
  });

  it("refuses the same version twice, and treats a hospital scope's NULL id as equal to itself", async () => {
    await period(P1, { scopeType: "hospital", scopeId: null });
    expect(await constraintOf(period(P2, { scopeType: "hospital", scopeId: null })))
      .toBe("roster_periods_scope_start_version_ux");
  });

  /* ═══════════════════ V6 — the publication stamps ═══════════════════ */

  it.each([
    ["a status outside the vocabulary", { status: "cancelled", publishedAt: new Date(), publishedBy: "t", contentHash: "h" }, "roster_periods_status_ck"],
    ["a hospital roster that names a scope", { scopeType: "hospital", scopeId: "x" }, "roster_periods_scope_id_ck"],
    ["a team roster that names none", { scopeId: null }, "roster_periods_scope_id_ck"],
    ["a window that ends before it starts", { endsAt: at("2026-09-01T00:00") }, "roster_periods_window_ck"],
    ["version zero", { version: 0 }, "roster_periods_version_ck"],
    ["published with nobody's name on it", { status: "published", publishedAt: new Date(), publishedBy: null, contentHash: "h" }, "roster_periods_published_ck"],
    ["a draft that claims a publication time", { publishedAt: new Date(), publishedBy: "t" }, "roster_periods_published_ck"],
    ["a roster that answers for no position at all", { coversPositions: [] }, "roster_periods_covers_ck"],
    ["an origin that is neither a person nor a machine", { origin: "imported" }, "roster_periods_origin_ck"],
    ["a draft carrying a content hash", { contentHash: "h" }, "roster_periods_hash_ck"],
    ["a published roster carrying none", { status: "published", publishedAt: new Date(), publishedBy: "t" }, "roster_periods_hash_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    expect(await constraintOf(period(P1, over as Partial<typeof rosterPeriods.$inferInsert>))).toBe(constraint);
  });

  it("refuses a version that stopped answering BEFORE it started answering", async () => {
    const publishedAt = at("2026-10-01T09:00");
    expect(await constraintOf(period(P1, {
      status: "superseded", publishedAt, publishedBy: "t", contentHash: "h",
      supersededAt: at("2026-10-01T08:00"), supersededByPeriodId: null,
    }))).toBe("roster_periods_supersede_order_ck");
    // the same instant is allowed, and it is what a cross-unit swap in one transaction produces
    expect(await constraintOf(period(P2, {
      status: "superseded", publishedAt, publishedBy: "t", contentHash: "h",
      supersededAt: publishedAt, version: 2,
    }))).toBe("(accepted)");
  });

  /* ═══════════════════ the slot's own vocabulary and bounds ═══════════════════ */

  it.each([
    ["a duty that ends when it starts", { endsAt: at("2026-10-12T20:00") }, "roster_assignments_window_ck"],
    ["a mode outside the vocabulary", { mode: "remote" }, "roster_assignments_mode_ck"],
    ["a kind outside the vocabulary", { kind: "holiday" }, "roster_assignments_kind_ck"],
    ["a source outside the vocabulary", { source: "whatsapp" }, "roster_assignments_source_ck"],
    ["a cover scope outside the vocabulary", { coverScope: "floor" }, "roster_assignments_cover_scope_ck"],
    ["an off-kind outside the vocabulary", { kind: "off", mode: null, offKind: "XX" }, "roster_assignments_off_kind_ck"],
    ["a call tier below the first rung", { callTier: 0 }, "roster_assignments_call_tier_ck"],
    ["a row that is effective and already superseded", { effective: true, liveTo: at("2026-10-13T00:00") }, "roster_assignments_effective_ck"],
    ["a knowledge window that closes before it opens", { liveFrom: at("2026-10-13T00:00"), liveTo: at("2026-10-12T00:00") }, "roster_assignments_live_ck"],
    ["a confirmation with no time on it", { confirmedByUserId: U2 }, "roster_assignments_confirmed_ck"],
  ] as const)("refuses %s", async (_what, over, constraint) => {
    await period(P1);
    expect(await constraintOf(slot("A1", "2026-10-12T20:00", "2026-10-13T08:00", over as Partial<typeof rosterAssignments.$inferInsert>)))
      .toBe(constraint);
  });

  it("refuses a day off that is vacant, has a mode, or has no off-kind — and accepts a real one", async () => {
    await period(P1);
    expect(await constraintOf(slot("A1", "2026-10-12T00:00", "2026-10-13T00:00", { kind: "off", mode: null, offKind: "WO", userId: null })))
      .toBe("roster_assignments_off_ck");
    expect(await constraintOf(slot("A2", "2026-10-12T00:00", "2026-10-13T00:00", { kind: "off", mode: "presence", offKind: "WO" })))
      .toBe("roster_assignments_off_ck");
    expect(await constraintOf(slot("A3", "2026-10-12T00:00", "2026-10-13T00:00", { kind: "off", mode: null, offKind: null })))
      .toBe("roster_assignments_off_ck");
    // and a DUTY may not carry an off-kind
    expect(await constraintOf(slot("A4", "2026-10-12T00:00", "2026-10-13T00:00", { offKind: "WO" })))
      .toBe("roster_assignments_off_ck");
    expect(await constraintOf(slot("A5", "2026-10-12T00:00", "2026-10-13T00:00", { kind: "off", mode: null, offKind: "WO" })))
      .toBe("(accepted)");
  });

  it("refuses a presence window over 36 hours, and lets an ON-CALL one run longer", async () => {
    await period(P1);
    expect(await constraintOf(slot("A1", "2026-10-12T08:00", "2026-10-13T21:00")))
      .toBe("roster_assignments_presence_hours_ck"); // 37 hours
    expect(await constraintOf(slot("A2", "2026-10-12T08:00", "2026-10-13T20:00"))).toBe("(accepted)"); // 36
    expect(await constraintOf(slot("A3", "2026-10-12T08:00", "2026-10-19T08:00", { mode: "call" }))).toBe("(accepted)");
  });

  it("refuses ANY window longer than five weeks, on call included", async () => {
    await period(P1);
    expect(await constraintOf(slot("A1", "2026-10-01T00:00", "2026-11-06T00:00", { mode: "call" })))
      .toBe("roster_assignments_window_cap_ck"); // 36 days
  });

  /* ═══════════════════ the amendment register ═══════════════════ */

  it("refuses an amendment with no reason, a 501-character one, or a kind nobody knows", async () => {
    await period(P1, { status: "published", publishedAt: new Date(), publishedBy: "t", contentHash: "h" });
    const amendment = (id: string, over: Partial<typeof rosterAmendments.$inferInsert> = {}) =>
      db.insert(rosterAmendments).values({
        id, periodId: P1, kind: "swap", reason: "Dr Rao is on leave", requestedBy: U1,
        approvedBy: U2, approvedAt: new Date(), ...AUDIT, ...over,
      });
    expect(await constraintOf(amendment("M1", { reason: "   " }))).toBe("roster_amendments_reason_ck");
    expect(await constraintOf(amendment("M2", { reason: "x".repeat(501) }))).toBe("roster_amendments_reason_ck");
    expect(await constraintOf(amendment("M3", { kind: "reshuffle" }))).toBe("roster_amendments_kind_ck");
    expect(await constraintOf(amendment("M4", { supersededCount: -1 }))).toBe("roster_amendments_counts_ck");
    expect(await constraintOf(amendment("M5"))).toBe("(accepted)");
  });

  /* ═══════════════════ a table absent from truncateAll is never emptied ═══════════════════ */

  it("all three tables are emptied by truncateAll", async () => {
    await period(P1);
    await slot("A1", "2026-10-12T20:00", "2026-10-13T08:00");
    await db.insert(rosterAmendments).values({
      id: "M1", periodId: P1, kind: "swap", reason: "r", requestedBy: U1, approvedBy: U2,
      approvedAt: new Date(), ...AUDIT,
    });
    await truncateAll(db);
    expect(await db.select().from(rosterPeriods)).toHaveLength(0);
    expect(await db.select().from(rosterAssignments)).toHaveLength(0);
    expect(await db.select().from(rosterAmendments)).toHaveLength(0);
  });
});
