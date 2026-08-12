import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";

// Holds the global uniqueness of idempotency keys outside `events`, which will later be
// RANGE-partitioned for retention: Postgres forces every unique constraint on a partitioned
// table to include the partition key, which would make the guarantee per-partition only.
export const eventIdempotency = pgTable("event_idempotency", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  eventId: text("event_id").notNull(),
  // Nullable by design: the key is claimed before the event exists, and appendEvent always
  // fills seq in before the caller's transaction commits.
  seq: bigint("seq", { mode: "number" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});
