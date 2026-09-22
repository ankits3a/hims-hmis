import { sql } from "drizzle-orm";
import { check, index, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import type { SQL } from "drizzle-orm";

// In-app alerts — the one consumer's output (D6). The uniqueness unit is the
// (source_event_id, user_id) PAIR, not source_event_id alone: one escalation.triggered fans
// to every id in resolvedUserIds, so a per-row unique would cap one escalation at ONE
// recipient. Corrected deliberately from the roadmap's shorthand.
//
// NO PATIENT IDENTITY IN ANY COLUMN (Global Constraint 6): title/body are built from
// defKey · state · rung only, and the recipient reaches the patient through
// permission-checked routes. user_id is the only foreign key this plan adds anywhere, and it
// points OUTWARD, into users.
/**
 * The three answers a human can give an alert (O7's evidence kinds, narrowed to what a bell can
 * carry): *I have seen it* · *it is mine until HH:MM* · *it is now theirs*. Closed vocabulary, in
 * TypeScript and in a CHECK, and `schema/alerts.test.ts` asserts the two copies still agree.
 */
export const ALERT_ACK_KINDS = ["seen", "owned", "handed_over"] as const;
export type AlertAckKind = (typeof ALERT_ACK_KINDS)[number];

/**
 * Copied from `schema/ot.ts:153` deliberately, with its warning: drizzle-kit renders a BOUND
 * PARAMETER into DDL as `$1`, so `inArray(col, values)` generates `CHECK (... in ($1, $2, $3))` —
 * a constraint that constrains nothing. `sql.raw` of vetted snake_case literals is the only shape
 * that survives generation, and the generated file is read before it is applied.
 */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    sourceEventId: text("source_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),

    // ═══ PHASE O T3 — READ IS NOT ANSWERED, AND THE SPINE NEEDS THE DIFFERENCE ═══
    //
    // `read_at` says a browser rendered the row. It cannot say a human took the thing on, and the
    // obligation spine's respond clock (T1) may only be stopped by someone SAYING SO. These six
    // columns are that statement: which kind of answer was given, when, until when it is owned,
    // the note, who it was handed to, and how many times the owner has re-dated it (G5 — two
    // re-owns, then the role ladder climbs regardless of what the owner promises).
    //
    // STILL NO PATIENT IDENTITY (Global Constraint 6): `ack_note` is the acknowledger's own words
    // about the OBLIGATION, `handed_to_user_id` points outward into `users` exactly as `user_id`
    // does, and nothing here is fanned anywhere `alert.raised` does not already go.
    ackKind: text("ack_kind"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ownedUntil: timestamp("owned_until", { withTimezone: true }),
    ackNote: text("ack_note"),
    handedToUserId: text("handed_to_user_id").references(() => users.id),
    ackExtensions: smallint("ack_extensions").notNull().default(0),
  },
  (t) => [
    uniqueIndex("alerts_source_event_user_ux").on(t.sourceEventId, t.userId),
    index("alerts_user_read_idx").on(t.userId, t.readAt),

    // ═══ T3 — FOUR CONSTRAINTS, BECAUSE A HALF-WRITTEN ANSWER STOPS A REAL CLOCK ═══
    //
    // `acknowledgeAlert` is the only writer today. It will not be the only writer for long — a
    // backfill, a repair script and T12's channel legs all reach this table — and every one of
    // them can stop an obligation's respond timer by writing a row. These say what an answer has
    // to look like in the one place no caller can route around.
    check("alerts_ack_kind_ck", inList(t.ackKind, ALERT_ACK_KINDS)),
    /** The radiology precedent (`imaging_critical_findings_ack_ck`): half an acknowledgement is not one. */
    check("alerts_ack_ck", sql`(${t.ackKind} is null) = (${t.acknowledgedAt} is null)`),
    /** Owning is a promise WITH A DEADLINE; without one, "mine" never expires and never climbs. */
    check("alerts_ack_owned_ck", sql`${t.ackKind} <> 'owned' or ${t.ownedUntil} is not null`),
    /** A handover with nobody on the other end is an abandonment wearing an answer's clothes. */
    check("alerts_ack_handover_ck", sql`${t.ackKind} <> 'handed_over' or ${t.handedToUserId} is not null`),
  ],
);
