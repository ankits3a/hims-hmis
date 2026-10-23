import { sql } from "drizzle-orm";
import { check, date, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * DOCTOR DESK DD-0 (issue #626; plan `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md` §3.1, D-A).
 *
 * The four tables the `doctor-desk` module OWNS. None of them is a clinical row: a brief is a list of
 * pointers to records other modules own, a nudge is one colleague asking another, a run is the
 * desk's own log of what its jobs did, and a read is when a doctor last looked. No patient column,
 * deliberately — a brief line carries the patient only inside its `facts` (shown to the one doctor it
 * was built for), and nothing here is ever sent off the app.
 */

/**
 * A brief built for one doctor. `facts` is `BriefFact[]` (`modules/doctor-desk/briefs.ts`): each
 * line a template key, its params and the record it came from. The lifecycle (R9) is read from
 * `shown_at` and `seen_at`: highlighted for 5 minutes after it was first shown (or until Got it), on
 * the Tower for an hour, then only on the AI Briefs page. Nothing is deleted.
 */
export const doctorDeskBriefs = pgTable(
  "doctor_desk_briefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    facts: jsonb("facts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (t) => [
    index("doctor_desk_briefs_user_idx").on(t.userId, t.createdAt),
    check("doctor_desk_briefs_kind_ck", sql`${t.kind} in ('login', 'morning', 'round')`),
    check("doctor_desk_briefs_window_ck", sql`${t.windowTo} >= ${t.windowFrom}`),
  ],
);

/**
 * One nudge: a unit member asking the holder of an owed row to act (DD-0.6, D7). Once per row per
 * sender — the unique index is the refusal `already_nudged`. `row_key` names the owed row
 * (`alert:<id>`, `lab_critical:<id>`, `visit:<id>`); `alert_id` is the bell row it raised.
 */
export const doctorDeskNudges = pgTable(
  "doctor_desk_nudges",
  {
    id: text("id").primaryKey(),
    rowKey: text("row_key").notNull(),
    teamId: text("team_id").notNull(),
    senderId: text("sender_id").notNull().references(() => users.id),
    holderId: text("holder_id").notNull().references(() => users.id),
    alertId: text("alert_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("doctor_desk_nudges_once_ux").on(t.rowKey, t.senderId),
    index("doctor_desk_nudges_team_idx").on(t.teamId, t.createdAt),
    check("doctor_desk_nudges_not_self_ck", sql`${t.senderId} <> ${t.holderId}`),
  ],
);

/**
 * The desk's agent-run log (DD-0.9), append-only: what a deterministic job did, for whom, and
 * whether it failed. `summary_key` + `params` render the line; `team_id` / `user_id` scope it.
 */
export const doctorDeskAgentRuns = pgTable(
  "doctor_desk_agent_runs",
  {
    id: text("id").primaryKey(),
    agent: text("agent").notNull(),
    teamId: text("team_id"),
    userId: text("user_id"),
    outcome: text("outcome").notNull(),
    summaryKey: text("summary_key").notNull(),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("doctor_desk_agent_runs_team_idx").on(t.teamId, t.ranAt),
    index("doctor_desk_agent_runs_user_idx").on(t.userId, t.ranAt),
    check("doctor_desk_agent_runs_outcome_ck", sql`${t.outcome} in ('ok', 'failed')`),
  ],
);

/** When each doctor last read the Tower — the "since you left" instant of the next login brief. */
export const doctorDeskReads = pgTable("doctor_desk_reads", {
  userId: text("user_id").primaryKey().references(() => users.id),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
});

/* ═══ DD-1 (spec /opt/hmis-context/SPEC-doctor-desk-dd1-2026-10-16.md) — moves, acts, ratings ═══ */

/**
 * One MOVE (DD-1.2): the unit's head or a senior resident telling the unit who is now expected to act
 * on an owed row. The source row (a bell row, a critical call, a visit) is NEVER edited — the Desk
 * records the expectation, the newest move of a row wins, and `doctor_desk.row_moved` is appended in
 * the same transaction (the audit). `alert_id` is the bell row the new holder got.
 */
export const doctorDeskMoves = pgTable(
  "doctor_desk_moves",
  {
    id: text("id").primaryKey(),
    rowKey: text("row_key").notNull(),
    teamId: text("team_id").notNull(),
    fromUserId: text("from_user_id").notNull().references(() => users.id),
    toUserId: text("to_user_id").notNull().references(() => users.id),
    movedBy: text("moved_by").notNull().references(() => users.id),
    alertId: text("alert_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("doctor_desk_moves_row_idx").on(t.rowKey, t.createdAt),
    index("doctor_desk_moves_team_idx").on(t.teamId, t.createdAt),
    check("doctor_desk_moves_not_same_ck", sql`${t.fromUserId} <> ${t.toUserId}`),
  ],
);

/**
 * WHAT THE DOCTOR DID (DD-1.3, D3: the act, not the acknowledgement, closes the loop) — one per owed
 * row (`lab_critical:<call id>` in DD-1). `opened_at` is the obligation's own start (the call's opening),
 * copied so critical→act time is one subtraction that never needs the other module again.
 */
export const DOCTOR_DESK_ACT_CHOICES = ["seen_at_bedside", "ecg_ordered", "repeat_sample_sent", "treatment_started", "other"] as const;
export const doctorDeskActs = pgTable(
  "doctor_desk_acts",
  {
    id: text("id").primaryKey(),
    rowKey: text("row_key").notNull(),
    teamId: text("team_id"),
    holderId: text("holder_id").notNull().references(() => users.id),
    actorId: text("actor_id").notNull().references(() => users.id),
    choice: text("choice").notNull(),
    note: text("note"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    actedAt: timestamp("acted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("doctor_desk_acts_once_ux").on(t.rowKey),
    index("doctor_desk_acts_team_idx").on(t.teamId, t.actedAt),
    index("doctor_desk_acts_actor_idx").on(t.actorId, t.actedAt),
    check("doctor_desk_acts_choice_ck", sql`${t.choice} in ('seen_at_bedside', 'ecg_ordered', 'repeat_sample_sent', 'treatment_started', 'other')`),
    check("doctor_desk_acts_other_ck", sql`${t.choice} <> 'other' or length(btrim(coalesce(${t.note}, ''))) between 3 and 200`),
    check("doctor_desk_acts_order_ck", sql`${t.actedAt} >= ${t.openedAt}`),
  ],
);

/**
 * A SENIOR'S WORD ON A RESIDENT'S WORK (DD-1.7, D5) — for her PG logbook, never a league table.
 * `work_kind` + `work_id` name the item (`opd_visit` + encounter id in DD-1; the IPD discharge summary
 * joins in DD-IPD.5). Once per item per rater; never oneself; Needs rework carries its reason.
 * `department_id` is the rated resident's department on `work_date`, kept for the anonymous averages.
 */
export const DOCTOR_DESK_RATINGS = ["good", "fine", "needs_rework"] as const;
export const doctorDeskRatings = pgTable(
  "doctor_desk_ratings",
  {
    id: text("id").primaryKey(),
    workKind: text("work_kind").notNull(),
    workId: text("work_id").notNull(),
    workDate: date("work_date", { mode: "string" }).notNull(),
    ratedUserId: text("rated_user_id").notNull().references(() => users.id),
    raterId: text("rater_id").notNull().references(() => users.id),
    teamId: text("team_id").notNull(),
    departmentId: text("department_id").notNull(),
    rating: text("rating").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("doctor_desk_ratings_once_ux").on(t.workKind, t.workId, t.raterId),
    index("doctor_desk_ratings_rated_idx").on(t.ratedUserId, t.workDate),
    index("doctor_desk_ratings_department_idx").on(t.departmentId, t.workDate),
    check("doctor_desk_ratings_kind_ck", sql`${t.workKind} in ('opd_visit')`),
    check("doctor_desk_ratings_rating_ck", sql`${t.rating} in ('good', 'fine', 'needs_rework')`),
    check("doctor_desk_ratings_not_self_ck", sql`${t.raterId} <> ${t.ratedUserId}`),
    check("doctor_desk_ratings_reason_ck", sql`${t.rating} <> 'needs_rework' or length(btrim(coalesce(${t.reason}, ''))) between 3 and 200`),
    check("doctor_desk_ratings_reason_len_ck", sql`${t.reason} is null or length(${t.reason}) <= 200`),
  ],
);
