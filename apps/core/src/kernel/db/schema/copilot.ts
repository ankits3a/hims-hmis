import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    /**
     * E0.5 — the chooser and model calls this ask made (0 on the phrasebook path), their ESTIMATED cost in
     * micro-rupees (₹1 = 1,000,000; a routing call costs fractions of a paisa, so paise would round to 0),
     * one `{provider, model, kind, inTok, outTok, microInr, ok, tokens}` entry per call, and whether the
     * daily cap had already been reached so this ask ran phrasebook-only (decision 0064).
     */
    modelCalls: integer("model_calls").notNull().default(0),
    costMicroInr: integer("cost_micro_inr").notNull().default(0),
    modelUsage: jsonb("model_usage"),
    capped: boolean("capped").notNull().default(false),
  },
  (t) => [
    index("copilot_asks_at_idx").on(t.at),
    /*
      E0.5 — THE CAP CHECK'S INDEX. Every ask sums today's spend; only rows that spent anything are in
      it, and the cost is the index's second column, so the sum is an index-only scan over the day's model calls.
    */
    index("copilot_asks_spend_idx").on(t.at, t.costMicroInr).where(sql`cost_micro_inr > 0`),
    check("copilot_asks_outcome_ck", inList(t.outcome, COPILOT_ASK_OUTCOMES)),
    check("copilot_asks_route_ck", inList(t.route, COPILOT_ROUTES)),
    check("copilot_asks_source_ck", sql`${t.source} is null or ${t.source} in ('chip', 'typed')`),
    check("copilot_asks_ms_ck", sql`${t.ms} >= 0`),
    check("copilot_asks_cost_ck", sql`${t.modelCalls} >= 0 and ${t.costMicroInr} >= 0`),
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
 * PHONE SETTINGS (owner 2026-10-11, spec SPEC-phone-settings-2026-10-11) — whether a person has turned the
 * copilot ON in the phone app. It follows the ACCOUNT (owner: "follows the account"), so it is a row here
 * rather than a value on one phone. No row = OFF, the owner's default for everyone. It governs the phone
 * app only; the web's ask box does not read it.
 */
export const copilotUserSettings = pgTable("copilot_user_settings", {
  userId: text("user_id").primaryKey(),
  phoneEnabled: boolean("phone_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * E0.3 — THE HALT SWITCH (plan E0.3, decision 0064). One row per HALTED scope; no row, not halted. Read
 * on every ask (one indexed round trip, no cache — the `getOperatingMode` rule: a halt must take effect
 * on the very next ask, on this box and on the failover site, which reads the same replicated table).
 * The history lives in `events` (`copilot.halt_set` / `copilot.halt_cleared`, each naming who).
 */
export const COPILOT_HALT_SCOPES = ["read", "act", "draft", "global"] as const;
export type CopilotHaltScope = (typeof COPILOT_HALT_SCOPES)[number];

export const copilotHalts = pgTable(
  "copilot_halts",
  {
    scope: text("scope").primaryKey(),
    haltedBy: text("halted_by").notNull(),
    haltedAt: timestamp("halted_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => [check("copilot_halts_scope_ck", inList(t.scope, COPILOT_HALT_SCOPES))],
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
