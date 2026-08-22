import { pgTable, text, integer, timestamp, jsonb, bigserial, index, primaryKey, unique } from "drizzle-orm/pg-core";

// RANGE-PARTITIONED BY MONTH ON `recorded_at` since migration 0016 (Plan 11a D5). The key shape
// below is what partitioning FORCES, not what it prefers: Postgres requires every PRIMARY KEY and
// UNIQUE constraint on a partitioned table to CONTAIN the partition key, so `seq` alone cannot be
// the PK and `event_id` alone cannot be unique. Both gained `recorded_at`, and neither guarantee
// actually weakened:
//   · PK (seq, recorded_at) — `seq` is still allocated by the one global `events_seq_seq`, so it
//     is still monotone and still the dispatcher's ordering key. Nothing reads the PK as a
//     uniqueness claim on `seq`; the sequence is what makes it unique.
//   · UNIQUE (event_id, recorded_at) — `event_id` is a ULID, unique by construction.
// SEMANTIC dedup never lived in this table: it lives in the non-partitioned `event_idempotency`,
// which is exactly why the idempotency index below has always been plain rather than unique.
//
// DRIZZLE CANNOT EXPRESS `PARTITION BY RANGE` (no partitioning API exists in pg-core), so this
// declaration describes the table drizzle CAN see and migration 0016 hand-writes the rest. The
// PARTITIONS are not schema and are deliberately absent from here: `worker/partitions.ts`'s
// `createEventPartitions` job creates each IST month ahead of time, and a DEFAULT partition
// catches any month nobody pre-created. Partition month boundaries are IST (+05:30) — the
// retention unit is an IST concept (dailyIst jobs, Indian statute), not a UTC one.
export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    patientId: text("patient_id"),
    encounterId: text("encounter_id"),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    module: text("module").notNull(),
    payload: jsonb("payload").notNull(),
    siteId: text("site_id").notNull().default("main"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    // Both constraints keep their PRE-partitioning names, because 0016 RENAMES the old indexes
    // out of the way and recreates these on the new parent under the names everything already
    // knows. A generated name here would describe a constraint the database does not have.
    primaryKey({ name: "events_pkey", columns: [t.seq, t.recordedAt] }),
    unique("events_event_id_unique").on(t.eventId, t.recordedAt),
    // Plain, not unique: uniqueness lives in event_idempotency so it survives partitioning.
    index("events_idempotency_key_idx").on(t.idempotencyKey),
    index("events_name_idx").on(t.name),
    index("events_patient_idx").on(t.patientId),
    index("events_correlation_idx").on(t.correlationId),
  ],
);
