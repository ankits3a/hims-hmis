import { date, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PLAN 07c T8 / DD13 — ONE PERSON'S DAY, PRE-SUMMED, BECAUSE LIVE AGGREGATION IS NOT VIABLE.
 *
 * ═══ THE MEASUREMENT THAT FORCED THIS TABLE ═══
 *
 * Re-measured on the dev database at kickoff, and it is worse than the phase document recorded:
 * across the eight tables a brief touches there is **not one index on any actor column** —
 * `created_by`, `opened_by`, `recorded_by`, `booked_by`, `issued_by`, `received_by` — alone or
 * paired with a date. `receipt_tenders` carries **only its primary key**: not even an index on
 * `receipt_id`, its own foreign key, which is what `dayBook` joins on today. And `receipts` has no
 * index on `service_day` either, so the EXISTING day book is already a sequential scan.
 *
 * At the 2,000-visit/day target a six-month window is ~2.5–3M rows across those tables and the
 * spec asks for load tests at 3×. A brief that aggregated live would scan all of it, per person,
 * per page load. Migration 0041 adds the composite `(actor, date)` indexes — which is what makes
 * the NIGHTLY ROLL cheap — and this table is what the long windows are actually served from.
 *
 * ═══ WHY A JSONB BAG AND NOT COLUMNS ═══
 *
 * `facts` is `{ "<module>.<fact>": integer }`, contributed by `DeskProvider.facts` (see
 * `kernel/desk/types.ts` for the contract). A column per counter would make every new module a
 * migration and a schema review — pharmacy dispensing, lab collections, theatre cases — and would
 * put the kernel in the position of knowing what a "consult" is. The kernel adds numbers; the
 * modules name them.
 *
 * ═══ IT IS A CACHE, AND IT IS ALLOWED TO BE REBUILT ═══
 *
 * Nothing here is a source of truth: every row is derivable from the primary tables by re-running
 * the same providers over the same date. That is what makes A5 (a corrected day re-rolls) a plain
 * upsert rather than a compensation problem, and it is why `computed_at` is stored — an operator
 * asking "is this brief stale?" needs an answer that is not "look at the job logs".
 */
export const userDayFacts = pgTable(
  "user_day_facts",
  {
    userId: text("user_id").notNull(),
    /** The IST calendar day, the grain every desk figure is cut on. */
    day: date("day", { mode: "string" }).notNull(),
    facts: jsonb("facts").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * (user_id, day) IS THE IDENTITY, and the composite primary key is what makes A2 structural:
     * the roll is an upsert on conflict, so a second run of the same night cannot double a person's
     * day. An `id` column with a unique index would work identically and would also let a bug
     * insert a second row for the same day and have it look like data.
     */
    primaryKey({ columns: [t.userId, t.day] }),
    /*
     * AND NO SECOND INDEX. The first draft added `(user_id, day)` again as a plain index for "the
     * window scan every brief makes" — which the primary key ALREADY provides, byte for byte.
     * Caught by reading the generated SQL rather than by a test: a duplicate index is not an error,
     * it is a write cost and a page cache cost that nothing ever reports.
     */
  ],
);
