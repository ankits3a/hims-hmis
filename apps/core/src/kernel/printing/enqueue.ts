import { newId } from "@hmis/contracts";
import { printJobs } from "../db/schema";
import type { Tx } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T1 — THE PRINT OUTBOX'S ONLY WRITER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything that would ever put paper in a patient's hand comes through here — the counter's token
 * slip, the cashier's receipt, the prescription sheet, the vitals bay's slip. One writer, because
 * the three refusals below would otherwise have to be right in four call sites.
 *
 * IT TAKES A `Tx`, NOT A `Db`, DELIBERATELY, and this is the whole reason the counter can trust it:
 * the enqueue rides the caller's transaction. A visit that rolls back leaves no slip queued, and a
 * slip that is queued is queued against a visit that exists. The alternative — printing from a
 * callback after the commit — is how you hand a patient a token for a visit that was never opened.
 *
 * AND IT IS ONE INSERT. Owner ruling R7 makes a print failure advisory, but that ruling is about
 * what happens LATER, at the printer. This function is on the counter's critical path, inside the
 * clerk's transaction, so it does no I/O beyond the insert, resolves nothing, and renders nothing.
 * Rendering happens when the relay claims the row.
 */

/** The documents the renderer knows. A new one is a code change plus a template — never a migration. */
export type PrintDocument =
  | "opd_token_slip"
  | "opd_payment_receipt"
  | "opd_prescription"
  | "vitals_slip";

/**
 * LOGICAL destinations, never CUPS queue names.
 *
 * The server has never seen this hospital's printers and must not pretend to. The relay owns the
 * mapping to whatever the queue is actually called, which is what lets a printer be replaced,
 * renamed or moved between desks without a deploy, a migration or a code change here.
 */
export type PrintDestination =
  | "front_desk_thermal"
  | "front_desk_a4"
  | "vitals_thermal";

/**
 * WHERE EACH DOCUMENT GOES, from the owner's rulings and `PrinterChoice.dc.html`.
 *
 * It is a table rather than a caller argument because the pairing is a property of the DOCUMENT,
 * not of the screen asking. A caller that could choose would eventually send an A4 prescription to
 * a 72 mm roll, and the failure would be a jammed printer at a counter with a queue behind it.
 *
 * R2 put the prescription on the FRONT DESK's A4 laser rather than the vitals desk's — the patient
 * carries it into the consultation room, which is what `Main.dc.html` means by "1 slip · 1 × A4".
 */
export const DESTINATION_OF: Record<PrintDocument, PrintDestination> = {
  opd_token_slip: "front_desk_thermal",
  opd_payment_receipt: "front_desk_thermal",
  opd_prescription: "front_desk_a4",
  vitals_slip: "vitals_thermal",
};

export type EnqueuePrintInput = {
  document: PrintDocument;
  /**
   * IDENTIFIERS ONLY — the renderer resolves names, ages and amounts at render time. A queue row is
   * not a second copy of the patient record to keep in step, and a reprint after a name correction
   * should hand over the CORRECTED name rather than faithfully reproducing a typo.
   */
  params: Record<string, unknown>;
  /**
   * The at-least-once guard. A clerk hitting the button twice, or a producer redelivering, inserts
   * ONE row. Build it from what makes the document unique — `token:<encounterId>`, not a timestamp
   * or a ULID, or it dedupes nothing.
   */
  dedupeKey: string;
  patientId?: string | null;
  encounterId?: string | null;
  requestedBy?: string | null;
};

/**
 * Enqueues one print job, or nothing.
 *
 * Returns the row's id, or `null` when the dedupe key was already present — which is a SUCCESS and
 * not an error: it means the paper is already coming. Callers that treat `null` as a failure will
 * tell a clerk the slip did not print when it did.
 */
export async function enqueuePrintJob(tx: Tx, input: EnqueuePrintInput): Promise<string | null> {
  if (input.dedupeKey.trim() === "") {
    // A blank key would be UNIQUE against itself exactly once and then swallow every later job in
    // the hospital. Louder to refuse than to discover on a quiet afternoon that nothing prints.
    throw new Error("enqueuePrintJob: dedupeKey must not be blank");
  }
  const destination = DESTINATION_OF[input.document];
  if (destination === undefined) {
    throw new Error(`enqueuePrintJob: no destination for document ${input.document}`);
  }
  const id = newId();
  const inserted = await tx
    .insert(printJobs)
    .values({
      id,
      document: input.document,
      destination,
      params: input.params,
      dedupeKey: input.dedupeKey,
      patientId: input.patientId ?? null,
      encounterId: input.encounterId ?? null,
      requestedBy: input.requestedBy ?? null,
    })
    .onConflictDoNothing({ target: printJobs.dedupeKey })
    .returning({ id: printJobs.id });
  return inserted[0]?.id ?? null;
}
