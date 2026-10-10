import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.1 — THE COPILOT LEDGER (decision 0064, spec /opt/hmis-context/SPEC-copilot-ledger-2026-10-10.md)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three tables, and like `phi_access_log` and `search_audit` they reference NOTHING: `actor_id` is
 * plain text so a log outlives the row it names and never joins its truncate group.
 *
 * WHY ASKS ARE NOT `events` ROWS (spec D1, owner-approved 2026-10-10). The plan first said "asks as
 * `events` rows". `events` is append-only by trigger (migration 0139) and kept TEN YEARS by monthly
 * partition drop; an ask is kept 180 days. One table cannot carry both windows, so asks get their
 * own table with their own window — the `search_audit` precedent, made append-only like
 * `phi_access_log` (the retention prune is its one delete door).
 */

/** Every way an ask can end. `halted` is reserved for the E0.3 halt switch and written by nothing yet. */
export const COPILOT_ASK_OUTCOMES = [
  "answered", "notUnderstood", "noTool", "notPermitted", "needSubject", "failed",
  "identifierLeak", "refusedActor", "badRequest", "error", "halted",
] as const;
export type CopilotAskOutcome = (typeof COPILOT_ASK_OUTCOMES)[number];

/** Which route answered. `chooser` and `model` are separate on purpose: G4 reads timings per route. */
export const COPILOT_ROUTES = ["phrasebook", "chooser", "model", "none"] as const;
export type CopilotRoute = (typeof COPILOT_ROUTES)[number];

const inList = (col: unknown, list: readonly string[]) =>
  sql`${col} in (${sql.raw(list.map((v) => `'${v}'`).join(", "))})`;

export const copilotAsks = pgTable(
  "copilot_asks",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    outcome: text("outcome").notNull(),
    route: text("route").notNull(),
    intent: text("intent"),
    answerKey: text("answer_key"),
    ms: integer("ms").notNull(),
    /** The MASKED question only. Null when the scrubber fired (it held an identifier) or the body was invalid. */
    maskedQuestion: text("masked_question"),
    /** The screen that asked, as the web names it. Null from callers that send none. */
    screen: text("screen"),
    /** chip | typed — sent by the phone (E1.3); null from the web, which sends none. */
    source: text("source"),
  },
  (t) => [
    index("copilot_asks_at_idx").on(t.at),
    check("copilot_asks_outcome_ck", inList(t.outcome, COPILOT_ASK_OUTCOMES)),
    check("copilot_asks_route_ck", inList(t.route, COPILOT_ROUTES)),
    check("copilot_asks_source_ck", sql`${t.source} is null or ${t.source} in ('chip', 'typed')`),
    check("copilot_asks_ms_ck", sql`${t.ms} >= 0`),
  ],
);

/**
 * One row per act the copilot carried out after a human tapped confirm (E0.2 writes it; E0.1 only
 * creates it). Kept as long as the record it changed: UPDATE and DELETE are refused by trigger.
 * `confirm_id` NOT NULL + UNIQUE is G6(b) at the database: an act without a confirm cannot exist,
 * and one confirm cannot be spent twice.
 */
export const copilotActs = pgTable(
  "copilot_acts",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id").notNull(),
    tool: text("tool").notNull(),
    subjectPatientId: text("subject_patient_id"),
    argsHash: text("args_hash").notNull(),
    proposalId: text("proposal_id").notNull(),
    confirmId: text("confirm_id").notNull(),
    resultModule: text("result_module"),
    resultRowId: text("result_row_id"),
  },
  (t) => [
    uniqueIndex("copilot_acts_confirm_ux").on(t.confirmId),
    index("copilot_acts_at_idx").on(t.at),
    check("copilot_acts_confirm_ck", sql`length(${t.confirmId}) > 0`),
  ],
);

/**
 * The staff notice (owner ruling 2026-10-10: notice first). One row per user per notice version,
 * written when the user dismisses it. No existing per-user acknowledgement table fitted: `alerts`
 * acknowledgements are per alert, `users` carries no flags.
 */
export const copilotNoticeAcks = pgTable(
  "copilot_notice_acks",
  {
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "copilot_notice_acks_pkey", columns: [t.userId, t.version] })],
);

/**
 * E1.3 — the one-tap "Wrong" on an answer card (goal G3b: wrong taps ÷ answers). One row per ask,
 * written only by the person who asked it (`POST /copilot/feedback`). Like the asks it references
 * nothing; it is deleted with them after 180 days by the copilot's own prune (decision 0065).
 */
export const COPILOT_FEEDBACK_VERDICTS = ["wrong"] as const;

export const copilotAskFeedback = pgTable(
  "copilot_ask_feedback",
  {
    askId: text("ask_id").primaryKey(),
    userId: text("user_id").notNull(),
    verdict: text("verdict").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("copilot_ask_feedback_at_idx").on(t.at),
    check("copilot_ask_feedback_verdict_ck", inList(t.verdict, COPILOT_FEEDBACK_VERDICTS)),
  ],
);
