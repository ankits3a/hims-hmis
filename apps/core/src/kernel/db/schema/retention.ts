import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { patients } from "./patients";

// A LEGAL HOLD IS A ROW, NOT A CONFIG FLAG (Plan 11a D6). Retention drops whole `events`
// partitions — a month at a time, irreversibly — so the thing that stops a drop has to be
// STRUCTURAL and inspectable, not a boolean somebody set in an environment file. The sweep
// (Plan 11a T5) refuses to drop any month that intersects an ACTIVE hold and events the refusal;
// this table is what it reads.
//
// `patient_id` NULL MEANS A GLOBAL HOLD — every month is held, for everyone. That is the shape
// litigation actually takes ("preserve everything from this period"), and encoding it as a null
// rather than a second table keeps the sweep's check one query.
//
// A hold is RELEASED, never deleted: `released_at` is the only way a hold stops applying, so the
// record that a hold once existed survives the release. Nothing in this schema deletes rows here.
export const retentionLegalHolds = pgTable("retention_legal_holds", {
  id: text("id").primaryKey(), // ULID via newId() — entity ids share the event-id grammar
  // FK into patients ON PURPOSE, and it is a safety property rather than tidiness: a hold whose
  // patient id is a typo would be a hold that silently protects nobody, and `null` here already
  // means something quite different (a GLOBAL hold). The FK makes the two states distinguishable.
  patientId: text("patient_id").references(() => patients.id),
  reason: text("reason").notNull(), // free text: the matter, the order, the counsel who asked
  releasedAt: timestamp("released_at", { withTimezone: true }), // null = ACTIVE
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(), // actor id, plain text — the approvals.ts precedent
});
