import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
