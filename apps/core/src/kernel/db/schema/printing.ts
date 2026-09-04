import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { patients } from "./patients";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T1 — THE PRINT OUTBOX
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04 (R1): printing is SERVER-SIDE. Not `window.print()`.
 *
 * WHY AN OUTBOX AND NOT A DIRECT SUBMIT. Production is a Hetzner box in Helsinki; the printers are
 * on a LAN in Hajipur. **The server cannot reach a printer.** So the server does not print — it
 * RECORDS an intention to print, and a relay inside the hospital claims the row, submits to the
 * local CUPS queue and reports back. The relay holds an outbound connection, so the hospital needs
 * no inbound firewall hole, and one relay serves the whole site rather than one agent per counter.
 *
 * THIS IS `notifications` WITH A DIFFERENT SINK, and it is deliberately shaped like it: a
 * `dedupeKey` unique index so an at-least-once producer (or a double-clicking clerk) inserts one
 * row, `status` + `nextAttemptAt` as the claim predicate, `attempts` + `lastError` as the retry
 * record, and a `(status, updatedAt)` index for the retention prune that is NOT the claim index —
 * one index cannot serve both leading-column orders. Nothing here is invented; the reasoning for
 * each of those lives in `notifications.ts` and still applies.
 *
 * ═══ WHAT `params` MAY AND MAY NOT CARRY ═══
 *
 * IDENTIFIERS, NOT PHI. `params` holds the encounter/invoice/patient ids the renderer needs to find
 * the record, and the renderer resolves names, ages and amounts AT RENDER TIME — the same rule
 * `notifications.params` follows ("rendering happens at send"). Two reasons, and the second is the
 * one that matters: a queue row is not a second copy of the patient record to keep in step, and a
 * reprint after a name correction should hand over the CORRECTED name rather than faithfully
 * reproducing a typo (`overlays.tsx` versions amendments precisely so this is answerable).
 *
 * A print job still POINTS AT a patient, so `patientId` is a real column rather than a key buried in
 * jsonb: it is what makes "what did this hospital print about this person" answerable, and what lets
 * the retention sweep and any future erasure find these rows at all.
 */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: text("id").primaryKey(), // ULID via newId()
    /**
     * WHAT to print. One of the document kinds the renderer knows: `opd_token_slip`,
     * `opd_payment_receipt`, `opd_prescription`, `vitals_slip`. Text rather than an enum for the
     * reason every other status column here is text — a new document is a code change plus a
     * template, never a migration.
     */
    document: text("document").notNull(),
    /**
     * WHERE to print, as a LOGICAL destination — `front_desk_thermal`, `front_desk_a4`,
     * `vitals_thermal` — never a CUPS queue name.
     *
     * The server has never seen the hospital's printers and must not pretend to. The relay owns the
     * mapping from a logical destination to whatever the queue is actually called, which is what
     * lets a printer be replaced, renamed or moved to another desk without a deploy or a migration.
     */
    destination: text("destination").notNull(),
    /** Identifiers the renderer resolves from. NOT patient data — see the header. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    /** The at-least-once guard: a redelivered event, or a clerk hitting the button twice, inserts nothing. */
    dedupeKey: text("dedupe_key").notNull(),
    patientId: text("patient_id").references(() => patients.id), // nullable: a job need not be about a person
    encounterId: text("encounter_id"), // plain text, like `opd_queue_entries.encounter_id`'s sibling columns
    /** Who asked for it. A reprint is a new row with a new requester, which is the audit answer to "who printed this again". */
    requestedBy: text("requested_by").references(() => users.id),
    /**
     * 'queued' | 'claimed' | 'printed' | 'failed' | 'cancelled'.
     *
     * `failed` is TERMINAL and, by owner ruling R7, ADVISORY: nothing in the money or queue path
     * waits on it. The screen says the slip did not come out and offers a reprint; the patient can
     * be sent to the doctor on a spoken token. A hospital that stops taking money because a printer
     * jammed is worse than one that prints late.
     */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** The claim predicate's other half; null = due now. Set on a retry to hold the row back. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /**
     * THE VISIBILITY TIMEOUT. A relay that dies mid-job would otherwise strand the row in `claimed`
     * for ever, and the slip nobody is printing is the one nobody notices. A claim carries a lease;
     * once it lapses the row is claimable again, so the failure mode is a duplicate slip rather than
     * a missing one — which is the right way round for a queue token.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"), // the relay's id, not a user
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("print_jobs_dedupe_key_ux").on(t.dedupeKey),
    // the claim: queued rows that are due, and claimed rows whose lease has lapsed
    index("print_jobs_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("print_jobs_lease_idx").on(t.status, t.leaseExpiresAt),
    // the prune, deliberately NOT the claim index (see the header)
    index("print_jobs_status_updated_at_idx").on(t.status, t.updatedAt),
    index("print_jobs_patient_idx").on(t.patientId),
  ],
);
