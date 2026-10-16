import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkUser } from "../../../../test/helpers/opd";
import { doctorDeskActs, doctorDeskNudges, doctorDeskRatings } from "./index";
import type { Db } from "../client";

/**
 * DOCTOR DESK DD-0 (#626) — the module's four tables, EXECUTED against the migrated database.
 * The census is transcribed from `doctor-desk.ts`, not read back, so a column added without a
 * decision fails here; the prefix leg makes a fifth table without a census entry red too.
 */
describe("doctor-desk — schema", () => {
  const CENSUS: Record<string, string[]> = {
    // DD-1 (spec SPEC-doctor-desk-dd1-2026-10-16) — moves, acts, ratings.
    doctor_desk_acts: ["acted_at", "actor_id", "choice", "holder_id", "id", "note", "opened_at", "row_key", "team_id"],
    doctor_desk_moves: ["alert_id", "created_at", "from_user_id", "id", "moved_by", "row_key", "team_id", "to_user_id"],
    doctor_desk_ratings: ["created_at", "department_id", "id", "rated_user_id", "rater_id", "rating", "reason", "team_id", "work_date", "work_id", "work_kind"],
    doctor_desk_agent_runs: ["agent", "id", "outcome", "params", "ran_at", "summary_key", "team_id", "user_id"],
    doctor_desk_briefs: ["created_at", "facts", "id", "kind", "seen_at", "shown_at", "user_id", "window_from", "window_to"],
    doctor_desk_nudges: ["alert_id", "created_at", "holder_id", "id", "row_key", "sender_id", "team_id"],
    doctor_desk_reads: ["last_read_at", "user_id"],
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

  it("every censused table exists with exactly the columns named", async () => {
    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(CENSUS)) actual[table] = await columnsOf(table);
    expect(actual).toEqual(CENSUS);
  });

  it("no doctor_desk_ table exists that this census does not know about", async () => {
    const rows = (await db.execute(sql`
      select table_name as "tableName" from information_schema.tables
      where table_schema = 'public' and table_name like 'doctor\\_desk\\_%' order by table_name asc
    `)).rows as { tableName: string }[];
    expect(rows.map((r) => r.tableName).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  it("a nudge is once per row per sender, and never to oneself", async () => {
    const a = (await mkUser(db, "dd_a", [])).id;
    const b = (await mkUser(db, "dd_b", [])).id;
    const row = { rowKey: "alert:1", teamId: "t1", senderId: a, holderId: b };
    await db.insert(doctorDeskNudges).values({ id: newId(), ...row });
    await expect(db.insert(doctorDeskNudges).values({ id: newId(), ...row })).rejects.toThrow();
    await expect(db.insert(doctorDeskNudges).values({ id: newId(), ...row, rowKey: "alert:2", holderId: a })).rejects.toThrow();
  });

  it("DD-1: an act is once per row and Other needs words; a rating is once per rater, never oneself, and Needs rework says why", async () => {
    const a = (await mkUser(db, "dd1_a", [])).id;
    const b = (await mkUser(db, "dd1_b", [])).id;
    const opened = new Date("2026-10-06T04:00:00Z");
    const act = { rowKey: "lab_critical:c1", holderId: a, actorId: b, openedAt: opened, actedAt: new Date("2026-10-06T04:10:00Z") };
    await expect(db.insert(doctorDeskActs).values({ id: newId(), ...act, choice: "other", note: " " })).rejects.toThrow();
    await expect(db.insert(doctorDeskActs).values({ id: newId(), ...act, choice: "ecg_ordered", actedAt: new Date("2026-10-06T03:00:00Z") })).rejects.toThrow();
    await db.insert(doctorDeskActs).values({ id: newId(), ...act, choice: "ecg_ordered" });
    await expect(db.insert(doctorDeskActs).values({ id: newId(), ...act, choice: "treatment_started" })).rejects.toThrow();
    const rating = { workKind: "opd_visit", workId: "e1", workDate: "2026-10-06", ratedUserId: a, raterId: b, teamId: "t", departmentId: "d" };
    await expect(db.insert(doctorDeskRatings).values({ id: newId(), ...rating, rating: "needs_rework", reason: null })).rejects.toThrow();
    await expect(db.insert(doctorDeskRatings).values({ id: newId(), ...rating, raterId: a, rating: "good" })).rejects.toThrow();
    await db.insert(doctorDeskRatings).values({ id: newId(), ...rating, rating: "good" });
    await expect(db.insert(doctorDeskRatings).values({ id: newId(), ...rating, rating: "fine" })).rejects.toThrow();
  });
});
