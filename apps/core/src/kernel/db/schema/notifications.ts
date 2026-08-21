import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { users } from "./auth";

// The notification OUTBOX (Plan 10, D2/D4/D5). Every would-be message becomes a row here FIRST
// and no human flow ever blocks on it (Global Constraint 1): modules and consumers only INSERT;
// sending happens on the worker's clock, in the pump.
//
// WHAT THIS TABLE DELIBERATELY DOES NOT STORE (D4): phone, language, deceased state and merge
// state are contact TRUTH, resolved by the pump at SEND time, never snapshotted at enqueue. A
// number corrected at the desk after enqueue is the one that gets used; a phone added while a
// message waits un-strands the patient; a patient marked deceased after enqueue is still
// suppressed. So this table stores WHO (patient_id or user_id), WHICH template + params, WHEN
// the message dies (expires_at), and the claim/ladder state. Nothing else.
//
// THE CLAIM PRECEDES THE ADAPTER CALL (D2) — deliberately the OPPOSITE of the dispatcher's
// placement in schema/worker.ts. A WhatsApp message cannot be un-sent, so this surface's
// nightmare is sending TWICE, not losing a row; the dispatcher's is the mirror image and both
// reasonings stay written down. `status` + `next_attempt_at` is what the pump's
// `FOR UPDATE SKIP LOCKED` claim reads, hence the composite index below.
//
// AUDIENCE / RECIPIENT COHERENCE IS APP-ENFORCED, NOT A CHECK CONSTRAINT. An
// `audience='patient'` row is expected to carry `patient_id` and no `user_id`, and a
// `staff`/`owner` row the reverse — but that invariant lives in `enqueueNotification`, which is
// the only writer, and in the pump that reads it. No CHECK constraint beyond the NOT NULLs
// states it: a CHECK here would have to be re-migrated the first time an audience is added, and
// the enqueue API is a narrower gate than the table.
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(), // ULID via newId() — entity ids share the event-id grammar
    audience: text("audience").notNull(), // 'patient' | 'staff' | 'owner' (D8; app-enforced against the columns below)
    patientId: text("patient_id").references(() => patients.id), // nullable: set iff audience='patient'
    userId: text("user_id").references(() => users.id), // nullable: set iff audience is 'staff' | 'owner'
    templateKey: text("template_key").notNull(), // key into the code registry (D8); rendering happens at send
    params: jsonb("params").$type<Record<string, unknown>>().notNull(), // ONLY event-payload fields (D8/N10) — no name lookups
    dedupeKey: text("dedupe_key").notNull(), // UNIQUE below — at-least-once redelivery inserts nothing (GC15)
    sourceEventId: text("source_event_id"), // nullable: producers that are not dispatcher consumers have none
    refType: text("ref_type"), // nullable; with ref_id, the expire-by-ref handle (D13) and E-22's future seam
    refId: text("ref_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), // the EVENT's time, never the wall clock (D5/D13)
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // computed at enqueue by the template (D5)
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }), // nullable: null = due immediately (reminders set it)
    status: text("status").notNull().default("queued"), // 'queued'|'sending'|'sent'|'suppressed'|'expired'|'undeliverable'
    rung: integer("rung").notNull().default(0), // ladder position (D6): 0 = first channel; audience decides the ladder
    attempts: integer("attempts").notNull().default(0), // attempts AT THE CURRENT RUNG; quiet-hours deferral counts none (D4)
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }), // nullable; the claim predicate's other half
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentChannel: text("sent_channel"), // 'whatsapp' | 'sms' — which adapter accepted it (D11)
    sentTemplateVersion: integer("sent_template_version"), // the template version that actually rendered (D8)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_key_ux").on(t.dedupeKey),
    index("notifications_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("notifications_ref_idx").on(t.refType, t.refId),
  ],
);
