import { pgTable, text, integer, timestamp, jsonb, bigserial, uniqueIndex, index } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    eventId: text("event_id").notNull().unique(),
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
    uniqueIndex("events_idempotency_key_ux").on(t.idempotencyKey),
    index("events_name_idx").on(t.name),
    index("events_patient_idx").on(t.patientId),
    index("events_correlation_idx").on(t.correlationId),
  ],
);
