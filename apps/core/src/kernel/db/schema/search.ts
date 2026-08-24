import { bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PLAN 11h T5 / DD4 — THE SEARCH ACCESS LOG, AND WHY IT IS A TABLE RATHER THAN AN EVENT.
 *
 * A global search over patient data is the single most audited surface a hospital system has: it
 * is how staff look up celebrities, neighbours and ex-partners, and "who searched for whom" is a
 * question NABH and DPDP both expect an answer to. So every call is recorded — INCLUDING the ones
 * that returned nothing, because a person typing six surnames and opening none of them is the
 * exact pattern this log exists to make visible.
 *
 * IT IS DELIBERATELY NOT ON THE EVENT SPINE. The spine is append-only, replayed by the dispatcher,
 * partitioned by month and sized for ~330 SEMANTIC event types; a debounced palette would write to
 * it on the rhythm of a keyboard. `kernel/retention/events.ts` already records the same reasoning
 * for its own non-event ("a nightly job that found nothing appending a row saying so would add 365
 * rows a year to the very table this job exists to keep prunable"). Searching is telemetry with a
 * legal purpose and a retention window; it is not a fact about the hospital's state.
 *
 * TWO CONVENTIONS FROM `ops.ts`, TRANSCRIBED BECAUSE GETTING EITHER WRONG IS SILENT:
 *
 *   1. ORDERING RIDES `seq`, never `id` and never `at`. `newId()` is a plain ULID — two ids minted
 *      in the same millisecond sort by coin flip, and a desk's keystrokes arrive inside one tick.
 *
 *   2. `actor_id` IS PLAIN TEXT, NOT A FOREIGN KEY, and this is load-bearing rather than
 *      stylistic: Postgres refuses to TRUNCATE a table any FK POINTS AT — constraint existence,
 *      never row counts (§3.35) — so an FK into `users` would drag this table into the test
 *      helper's users-group truncate statement and couple an audit log to authentication's
 *      lifecycle. `events.actor_id` is the shipped precedent.
 */
export const searchAudit = pgTable(
  "search_audit",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    actorId: text("actor_id").notNull(), // plain text, see header
    /**
     * The query AS TYPED. It is personal data — a name is a name whether it is in a column or a
     * search box — which is exactly why this table carries a retention window and why the palette
     * never persists recents in the browser (DD8).
     */
    rawQuery: text("raw_query").notNull(),
    /** SHA-256 of the normalised query: lets "the same search, 40 times" be counted without reading it. */
    queryHash: text("query_hash").notNull(),
    /** `{ patient: 3, invoice: 1 }` — per-entity result counts, never the results themselves. */
    entityCounts: jsonb("entity_counts").notNull(),
    totalHits: integer("total_hits").notNull(),
    tookMs: integer("took_ms").notNull(),
    /** 'text' | 'voice' — T9 sets 'voice', so the owner can MEASURE how much dictated audio leaves. */
    source: text("source").notNull().default("text"),
    /** A hit carrying a RESTRICTED stub was rendered (DD3). Also appended to the spine — that one IS semantic. */
    restrictedSurfaced: boolean("restricted_surfaced").notNull().default(false),
    /**
     * Which result was actually opened, written by a second call. The searching is the haystack;
     * THE OPEN IS THE NEEDLE, and it is the moment a records-access enquiry actually asks about.
     */
    openedEntity: text("opened_entity"),
    openedId: text("opened_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "What did this person search for, and when" — the enquiry this table answers.
    index("search_audit_actor_at_idx").on(t.actorId, t.at),
    // The retention sweep's own predicate.
    index("search_audit_at_idx").on(t.at),
  ],
);
