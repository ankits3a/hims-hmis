import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { opdEncounters } from "./opd";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A DOCUMENT PHOTOGRAPHED AT A DESK — THE METADATA HERE, THE BYTES BEHIND THE STORE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: the desk outside the consultation room scans the slip's QR, photographs the
 * paper prescription, and the doctor can then see that photograph in the patient's history.
 *
 * ═══ THERE IS NO `bytea` COLUMN, AND THAT IS THE OWNER'S RULING ═══
 *
 * *"downscale the image and save it to disk for now, I will then add Cloudflare R2 or AWS S3
 * later."* So the row holds a `storage_key` and `kernel/documents` holds the bytes — a disk adapter
 * today, an object store when the owner adds one, and no caller changes either way.
 *
 * `patient_photos` does keep its bytes in the row, and was right to: one 512 KB face photo per
 * patient. Measured before the ruling: raw phone photos of slips at 200 patients a day are ~145 GB
 * a year, inside every `pg_dump`, every restore and every replica. The same choice does not survive
 * the change of scale.
 *
 * ═══ MANY ROWS PER ENCOUNTER, WHICH IS THE OTHER THING THE PHOTO TABLE CANNOT DO ═══
 *
 * A prescription runs to two pages; a patient arrives holding an outside report as well. So the key
 * is a document id and the encounter is an indexed column, not the primary key.
 *
 * `encounter_id` is NULLABLE on purpose: a slip can be photographed for a patient whose visit this
 * hospital never opened — the outside prescription somebody brings to a first consultation. Forcing
 * an encounter would make the commonest reason to photograph paper the one case that cannot be
 * recorded.
 */
export const patientDocuments = pgTable(
  "patient_documents",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The visit it belongs to. Null for paper that arrived from outside this hospital. */
    encounterId: text("encounter_id").references(() => opdEncounters.id),
    /**
     * What the paper IS. `outside_prescription` is the one the owner asked for; the column exists
     * so the next kind does not need a migration, and the CHECK lives in code rather than here for
     * the same reason `patient_allergies.source` grew a fourth value without one.
     */
    kind: text("kind").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Recorded so a list can be rendered, and a total billed against a quota, without a store read. */
    byteSize: integer("byte_size").notNull(),
    /**
     * WHERE THE BYTES ARE — `YYYY/MM/<id>.<ext>`, and the store validates the shape both on the way
     * in and after resolving it. Never a caller-supplied path: it is minted from the row's own id.
     */
    storageKey: text("storage_key").notNull(),
    /**
     * SHA-256 of the bytes as stored. Two jobs: a re-capture of the identical photograph is
     * detectable, and a byte store that silently loses or truncates a file can be caught by
     * something other than a human noticing a blank image on a screen.
     */
    sha256: text("sha256").notNull(),
    /** The doctor's own note, or the desk's. Free text; the patient never sees it. */
    note: text("note"),
    capturedBy: text("captured_by").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * E-8 again, because this is a clinical record: a slip filed against the wrong patient is
     * corrected, never deleted. `entered_in_error` hides it from every reader and keeps the trail.
     */
    status: text("status").notNull().default("active"),
    correctedBy: text("corrected_by"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctionReason: text("correction_reason"),
  },
  (t) => [
    /** The doctor's history panel reads by patient, newest first. */
    index("patient_documents_patient_idx").on(t.patientId, t.capturedAt.desc()),
    /** The desk's read-back — "what is already filed against this visit" — reads by encounter. */
    index("patient_documents_encounter_idx").on(t.encounterId),
  ],
);
