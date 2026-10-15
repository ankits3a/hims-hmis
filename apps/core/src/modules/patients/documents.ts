import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { patientDocuments, patients } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { PatientError } from "./uhid";
import { getPatient } from "./registration";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SLIP THE DESK PHOTOGRAPHS — CAPTURE, READ-BACK, AND THE DOCTOR'S HISTORY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: the desk outside the consultation room takes the paper prescription from the
 * patient, scans the slip's QR, photographs it — and the doctor can then see that photograph in the
 * patient's history.
 *
 * ═══ THE SIZE RULE IS THE PHOTO'S, AND THE NUMBER IS NOT ═══
 *
 * `storePatientPhoto` refuses rather than compresses — *"the client must downscale"* — and that is
 * exactly right: a server that silently re-encodes a clinical image is a server that decides how
 * legible a prescription is. Same rule here.
 *
 * The CAP is three times the photo's, and the reasoning is the owner's ruling: a raw phone photo is
 * 2-4 MB, a downscaled A5 slip that a human can still read is ~300 KB, and 1.5 MB sits above the
 * second and well below the first. So a client that forgets to downscale is refused loudly instead
 * of quietly filling a disk at 145 GB a year.
 */
export const DOCUMENT_MAX_BYTES = 1_500_000;
const ALLOWED_MIME = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["application/pdf", "pdf"]]);
export const DOCUMENT_KINDS = ["outside_prescription", "consult_prescription", "outside_report"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type CapturedDocument = {
  id: string;
  encounterId: string | null;
  kind: string;
  mimeType: string;
  byteSize: number;
  note: string | null;
  capturedBy: string;
  capturedAt: Date;
};

/**
 * Photograph one slip against one patient.
 *
 * ═══ THE ROW IS WRITTEN FIRST, AND THE FIRST DRAFT HAD THIS BACKWARDS ═══
 *
 * The property that matters is that a row never claims bytes that are not there — a document the
 * history offers and cannot open teaches a doctor nothing and does not even say whether the slip
 * was taken. **The TRANSACTION is what guarantees that, not the ordering:** a `put` that throws
 * takes the whole `withTx` down with it, so the row is gone either way. A mutation that reversed
 * these two lines left every test green, which is how the first draft's stated reasoning was caught
 * being wrong.
 *
 * What the ordering actually decides is ORPHANS, and there row-first wins: a store failure after
 * the insert rolls back the row AND no file was ever written, so nothing is left behind. Bytes
 * first would have left the file and rolled back the row. `G2b` is the row that discriminates.
 */
/**
 * ═══ WHAT ELSE A FILED DOCUMENT MEANS — OWNER RULING 2026-10-06 ═══
 *
 * A photographed prescription slip is also the evidence that the doctor has seen the patient, and
 * the OPD closes the visit on it. This module must not know that: it is imported by nearly every
 * other module and imports none of them. So the OPD hands in a function, exactly as billing hands
 * the OPD its consult-door verdict (`registerConsultStartGuard`), and this file calls whatever is
 * registered and passes the answers back beside the document id.
 *
 * KEYED, so a second module init in one jest worker replaces rather than double-registers.
 *
 * A HOOK NEVER COSTS THE DOCUMENT. Each runs inside its own SAVEPOINT: a hook that throws rolls
 * back only what the hook wrote, the page stays filed, and the caller is told the hook failed
 * (`{ failed: true }`) instead of being told the capture did.
 */
export type DocumentCapturedHook = (
  tx: Tx, actor: Actor,
  doc: { documentId: string; patientId: string; encounterId: string | null; kind: DocumentKind },
  now: Date,
) => Promise<unknown>;

const documentCapturedHooks = new Map<string, DocumentCapturedHook>();

/** Registers (or replaces) the hook under `key` and returns the unregister function. */
export function registerDocumentCapturedHook(key: string, hook: DocumentCapturedHook): () => void {
  documentCapturedHooks.set(key, hook);
  return () => {
    documentCapturedHooks.delete(key);
  };
}

export async function captureDocument(
  tx: Tx,
  store: DocumentStore,
  actor: Actor,
  patientId: string,
  input: {
    encounterId?: string | null;
    kind: DocumentKind;
    mimeType: string;
    bytes: Buffer;
    note?: string | null;
  },
  now: Date = new Date(),
): Promise<{ documentId: string; effects: Record<string, unknown> }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");

  const ext = ALLOWED_MIME.get(input.mimeType);
  if (ext === undefined) {
    throw new PatientError("unsupported_document_type", `documents are JPEG, PNG or PDF — not ${input.mimeType}`);
  }
  if (input.bytes.length === 0) throw new PatientError("document_empty", "an empty capture is not a document");
  if (input.bytes.length > DOCUMENT_MAX_BYTES) {
    throw new PatientError(
      "document_too_large",
      `document exceeds ${String(DOCUMENT_MAX_BYTES)} bytes — the client must downscale`,
    );
  }
  if (!DOCUMENT_KINDS.includes(input.kind)) {
    throw new PatientError("unsupported_document_type", `unknown document kind ${input.kind}`);
  }

  const rows = await tx.select({ status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  /* The canonical patient, as the photo and the allergy list both require: filing a slip against a
     merged-away record hides it from every reader of the surviving one. */
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "file the document on the canonical patient");

  const id = newId();
  /*
    THE KEY IS MINTED HERE AND NEVER COMES FROM A CALLER. It is derived from the row's own id and
    the capture month, which is what makes it unguessable, collision-free and laid out for an
    operator — and `assertStorageKey` refuses anything that is not that shape.
  */
  const key = `${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  await tx.insert(patientDocuments).values({
    id,
    patientId,
    encounterId: input.encounterId ?? null,
    kind: input.kind,
    mimeType: input.mimeType,
    byteSize: input.bytes.length,
    storageKey: key,
    sha256,
    note: (input.note ?? "").trim() === "" ? null : (input.note ?? "").trim(),
    capturedBy: actor.id,
    capturedAt: now,
  });
  await store.put(key, input.bytes);

  const effects: Record<string, unknown> = {};
  for (const [hookKey, hook] of documentCapturedHooks) {
    try {
      const answer = await tx.transaction((sp) => hook(
        sp, actor, { documentId: id, patientId, encounterId: input.encounterId ?? null, kind: input.kind }, now,
      ));
      if (answer !== null && answer !== undefined) effects[hookKey] = answer;
    } catch (e) {
      effects[hookKey] = { failed: true, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { documentId: id, effects };
}

/**
 * What is filed against this patient, newest first — and it is a PHI read.
 *
 * An outside prescription is clinical data about a person, so this goes through `getPatient` (which
 * answers null for a sealed patient this actor may not see, indistinguishably from one that does
 * not exist) and writes an access-log row, exactly as the allergy list does.
 */
export async function listDocuments(db: Db, actor: Actor, patientId: string): Promise<CapturedDocument[]> {
  const visible = await getPatient(db, actor, patientId);
  if (visible === null) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  await recordPhiAccess(db, {
    actor, patientId: visible.patient.id, surface: "patient.documents",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });
  const rows = await db
    .select()
    .from(patientDocuments)
    .where(and(eq(patientDocuments.patientId, visible.patient.id), eq(patientDocuments.status, "active")))
    .orderBy(desc(patientDocuments.capturedAt));
  return rows.map((r) => ({
    id: r.id, encounterId: r.encounterId, kind: r.kind, mimeType: r.mimeType,
    byteSize: r.byteSize, note: r.note, capturedBy: r.capturedBy, capturedAt: r.capturedAt,
  }));
}

/**
 * The bytes, for one document. A SECOND PHI read and a second log row, because opening the image is
 * a different act from seeing that it exists — and the access log is what answers "who looked at
 * this patient's prescription", which is the question it is kept for.
 *
 * The integrity check is not decoration: a store that silently truncates or loses a file would
 * otherwise reach the doctor as a blank image, which reads as a bad photograph rather than as a
 * broken record.
 */
export async function readDocument(
  db: Db, store: DocumentStore, actor: Actor, documentId: string,
): Promise<{ mimeType: string; bytes: Buffer }> {
  const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
  if (!row || row.status !== "active") throw new PatientError("document_not_found", `unknown document ${documentId}`);

  const visible = await getPatient(db, actor, row.patientId);
  /* Same answer for "not yours to see" as for "does not exist": a document id must not be a way to
     learn that a sealed patient exists. */
  if (visible === null) throw new PatientError("document_not_found", `unknown document ${documentId}`);
  await recordPhiAccess(db, {
    actor, patientId: row.patientId, surface: "patient.document.image",
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });

  const bytes = await store.get(row.storageKey);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== row.sha256) {
    throw new PatientError("document_corrupt", `the stored bytes for ${documentId} do not match the hash recorded at capture`);
  }
  return { mimeType: row.mimeType, bytes };
}

/**
 * E-8, because a slip filed against the wrong patient is a clinical-record error. The bytes are
 * deliberately NOT removed: the row explains why a doctor saw what they saw last Tuesday, and the
 * retention sweep is what eventually reclaims the disk.
 */
export async function markDocumentEnteredInError(
  tx: Tx, actor: Actor, documentId: string, reason: string, now: Date = new Date(),
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const trimmed = reason.trim();
  if (trimmed === "") throw new PatientError("reason_required", "a correction needs a reason (E-8)");

  const updated = await tx
    .update(patientDocuments)
    .set({ status: "entered_in_error", correctedBy: actor.id, correctedAt: now, correctionReason: trimmed })
    .where(and(eq(patientDocuments.id, documentId), eq(patientDocuments.status, "active")))
    .returning({ id: patientDocuments.id });
  if (updated.length === 0) throw new PatientError("document_not_found", `no active document ${documentId}`);
}

/**
 * UX-AUDIT 2026-09-28 · BOARD — WHAT IS ON FILE FOR A SET OF VISITS, FOR THE SLIP DESK'S DAY.
 *
 * Metadata only — kind, time, the retake request — and never the image or the note, which is why
 * this is not a PHI read the way `listDocuments` is: it says THAT a page was filed against a visit
 * the caller can already list, not what the page says. The caller (the OPD slip day) resolves the
 * patients through `getPatientSummaries`, which is where a sealed record is withheld.
 *
 * Oldest first, so "page 2" is the second row of an encounter.
 */
export type EncounterDocument = {
  id: string; encounterId: string; kind: string; capturedAt: Date; capturedBy: string;
  retakeRequestedAt: Date | null; retakeRequestedBy: string | null; retakeReason: string | null;
};

export async function documentsForEncounters(db: Db | Tx, encounterIds: readonly string[]): Promise<EncounterDocument[]> {
  const ids = [...new Set(encounterIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(patientDocuments)
    .where(and(inArray(patientDocuments.encounterId, ids), eq(patientDocuments.status, "active")))
    .orderBy(asc(patientDocuments.capturedAt));
  return rows.map((r) => ({
    id: r.id, encounterId: r.encounterId!, kind: r.kind, capturedAt: r.capturedAt, capturedBy: r.capturedBy,
    retakeRequestedAt: r.retakeRequestedAt, retakeRequestedBy: r.retakeRequestedBy, retakeReason: r.retakeReason,
  }));
}

/**
 * UX-AUDIT 2026-09-28 · BOARD — THE DOCTOR ASKS THE DESK FOR A CLEARER PHOTOGRAPH OF ONE PAGE.
 *
 * The page is NOT hidden or corrected: it is what was filed, and it may be half-readable, which is
 * better than nothing. The request only puts the visit back on the desk's list as "retake" until a
 * newer page is filed. First writer wins — a second request on the same page changes nothing and
 * says so — and a page that has been entered in error cannot be asked about.
 */
export async function requestDocumentRetake(
  tx: Tx, actor: Actor, documentId: string, reason: string | null, now: Date = new Date(),
): Promise<{ documentId: string; encounterId: string | null; alreadyRequested: boolean }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const [row] = await tx.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
  if (!row || row.status !== "active") throw new PatientError("document_not_found", `no active document ${documentId}`);
  if (row.retakeRequestedAt !== null) return { documentId, encounterId: row.encounterId, alreadyRequested: true };
  const trimmed = (reason ?? "").trim();
  await tx
    .update(patientDocuments)
    .set({ retakeRequestedBy: actor.id, retakeRequestedAt: now, retakeReason: trimmed === "" ? null : trimmed })
    .where(eq(patientDocuments.id, documentId));
  return { documentId, encounterId: row.encounterId, alreadyRequested: false };
}
