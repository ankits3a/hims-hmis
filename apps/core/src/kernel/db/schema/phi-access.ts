import { bigserial, boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * PLAN 07a T2 — THE PHI ACCESS LOG: who READ a patient's record, and how they were connected to
 * that patient's care at the time.
 *
 * The hospital already records what HAPPENED to a patient — 39 named business events across OPD
 * and billing, every one actor-stamped. It recorded almost nothing about who LOOKED. Before this
 * table the only access ever written was a click-through from the command palette
 * (`search_audit.opened_*`, one call site in the whole web app); a record reached from the OPD
 * queue, an appointment list, the consult screen or a pasted URL left no trace at all. Reads are
 * the thing that leaks, and reads were the thing nobody logged.
 *
 * ═══ WHY A TABLE AND NOT AN EVENT — the `search_audit` reasoning, applied again ═══
 *
 * The event spine is append-only, dispatcher-replayed, month-partitioned and sized for semantic
 * facts about the hospital's state. "Someone opened a chart" is telemetry with a legal purpose and
 * a retention window, not a fact about the hospital, and at 2,000 visits a day it arrives on the
 * rhythm of a mouse. `kernel/db/schema/search.ts` made this call first and states the reasoning in
 * full; this table follows it rather than re-deciding it.
 *
 * ═══ THE CONVENTIONS THAT ARE LOAD-BEARING, TRANSCRIBED FROM `search_audit` ═══
 *
 *   1. ORDERING RIDES `seq`, never `id` and never `at`. `newId()` is a plain ULID and two rows
 *      minted in the same millisecond sort by coin flip — a clinician opening a chart writes
 *      several rows inside one tick.
 *
 *   2. `actor_id` AND `patient_id` ARE PLAIN TEXT, NOT FOREIGN KEYS. Postgres refuses to TRUNCATE
 *      a table an FK POINTS AT — constraint existence, never row counts — so an FK into `users` or
 *      `patients` would drag this log into the test helper's truncate groups and couple an audit
 *      record to the lifecycle of the thing it audits. `events.actor_id` is the shipped precedent,
 *      and here it carries a second meaning: **the log must outlive the record it describes.**
 *
 * ═══ `context` IS COMPUTED AT WRITE TIME, AND THAT IS THE WHOLE POINT ═══
 *
 * Whether this actor had a care relationship with this patient is only knowable AT THE MOMENT OF
 * THE READ — the encounter closes, the doctor changes, the queue empties. Deriving it later from
 * the row's timestamp is guesswork dressed as evidence, so it is stamped here, once, by the code
 * that already resolved both sides.
 */
export const phiAccessLog = pgTable(
  "phi_access_log",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    /** Plain text, see header. The actor who performed the read. */
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' | 'agent' | 'system'
    /** Plain text, see header. The CANONICAL patient id — the merge chain is resolved before writing. */
    patientId: text("patient_id").notNull(),
    /**
     * WHICH SURFACE was read: `patient.detail` | `patient.allergies` | `opd.timeline` |
     * `opd.vitals` | `opd.prescriptions` | `opd.visit`. A free string rather than an enum because
     * every later module adds its own, and a CHECK constraint would make a read log the reason for
     * a migration.
     */
    surface: text("surface").notNull(),
    /** The encounter the read was scoped to, where it was scoped to one at all. */
    encounterId: text("encounter_id"),
    /**
     * HOW THE READ WAS CONNECTED TO CARE, at the moment of the read (see header):
     *
     *   `treating` — the actor is the assigned clinician on this patient's live encounter.
     *   `serving`  — the patient has an open encounter today and this actor's desk is part of it
     *                (front office, vitals, cashier). Legitimate, and NOT a clinician relationship.
     *   `none`     — no live connection at all. This is the row a review worklist exists for.
     *
     * A BOOLEAN `treating` WAS THE FIRST DESIGN AND IT WAS WRONG: it would have marked every
     * registration clerk and cashier read as out-of-context and drowned the worklist in exactly
     * the rows nobody needs to review, which is how an audit surface becomes ignored. Three values
     * keep `none` rare enough to mean something.
     */
    context: text("context").notNull(),
    /** The patient carried the confidential flag; the read therefore required the sealed-class grant. */
    sealed: boolean("sealed").notNull().default(false),
    /** Stated reason, where the surface required one (a sealed read, or an out-of-context read). */
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Who read this patient's record, and when" — the records-access enquiry this table exists for.
    index("phi_access_log_patient_at_idx").on(t.patientId, t.at),
    // "What did this person read" — the other half of the same enquiry, and the staff-conduct one.
    index("phi_access_log_actor_at_idx").on(t.actorId, t.at),
    // The out-of-context review worklist reads this, and the retention sweep reads `at`.
    index("phi_access_log_context_at_idx").on(t.context, t.at),
  ],
);
