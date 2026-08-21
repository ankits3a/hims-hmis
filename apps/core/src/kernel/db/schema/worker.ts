import { bigint, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// NO FOREIGN KEY LIVES IN THIS FILE, and the absence is a recorded trade, not an omission
// (Plan 08.5 D4/T1): a delivery or dead-letter row referencing events.seq would weld these
// tables to Plan 11's partition recreate AND drag them into the events truncate group by
// constraint. Integrity is application-level — nothing at the DB layer stops a delivery row
// for a seq that never existed, because only the dispatcher writes these rows, and only from
// rows it has just read.

// One row per scheduled job, upserted every tick (an UPDATE every 1-2 s; no per-tick events).
// /health reads the FRESHEST last_started_at to report the worker ok | stale | not_running (D7).
// Shape is the §11.19-C fix-29 precedent Plan 12a's agent heartbeats reuse (`job` = agent name).
export const schedulerHeartbeats = pgTable("scheduler_heartbeats", {
  job: text("job").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }).notNull(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
});

// The dispatcher's per-(consumer, seq) delivery claim. The claim is written status='done'
// AFTER the handler succeeds — deliberately the OPPOSITE placement from billing's
// withIdempotency (D4/D5): billing's nightmare is doing the work twice, the dispatcher's is
// LOSING an event, so a claim taken before a handler that then dies would mark an undelivered
// event delivered. At-least-once + idempotent consumers is the contract.
export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    consumer: text("consumer").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    status: text("status").notNull(), // 'retrying' | 'done' | 'parked'
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.seq] })],
);

// Poison parked after maxAttempts, so one permanently failing event stops blocking its
// consumer forever (D4). Requeue and replay tooling are explicitly NOT built here (D12):
// this table is the record, and nothing reads it yet.
export const eventDeadLetters = pgTable(
  "event_dead_letters",
  {
    consumer: text("consumer").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    name: text("name").notNull(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull(),
    parkedAt: timestamp("parked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.seq] })],
);
