import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientPhotos, patients } from "../../kernel/db/schema";
import { patientUpdated } from "./events";
import { getPatient } from "./registration";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

/** Server-side cap; the web client downscales to ~640px JPEG (~50–200 KB) before upload. */
export const PHOTO_MAX_BYTES = 512_000;

export async function storePatientPhoto(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: { mimeType: string; bytes: Buffer },
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  if (input.mimeType !== "image/jpeg") {
    throw new PatientError("unsupported_photo_type", "photos are image/jpeg only in v1");
  }
  if (input.bytes.length > PHOTO_MAX_BYTES) {
    throw new PatientError("photo_too_large", `photo exceeds ${PHOTO_MAX_BYTES} bytes — the client must downscale`);
  }
  const rows = await tx.select({ id: patients.id, status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "store the photo on the canonical patient");

  await tx
    .insert(patientPhotos)
    .values({ patientId, mimeType: input.mimeType, bytes: input.bytes, updatedBy: actor.id })
    .onConflictDoUpdate({
      target: patientPhotos.patientId,
      set: { mimeType: input.mimeType, bytes: input.bytes, updatedBy: actor.id, updatedAt: new Date() },
    });
  await appendEvent(
    tx,
    patientUpdated.make({
      actor,
      patientId,
      payload: { patientId, changes: [{ field: "photo", from: null, to: null }] },
    }),
  );
}

/**
 * Reads THROUGH getPatient: merge chain resolved, §14 confidential gate identical — a photo
 * is exactly as visible as its patient. C-18's attach prompt calls this.
 */
export async function getPatientPhoto(
  db: Db,
  actor: Actor,
  patientId: string,
): Promise<{ mimeType: string; bytes: Buffer } | null> {
  const resolved = await getPatient(db, actor, patientId);
  if (!resolved) return null;
  const rows = await db
    .select({ mimeType: patientPhotos.mimeType, bytes: patientPhotos.bytes })
    .from(patientPhotos)
    .where(eq(patientPhotos.patientId, resolved.patient.id));
  return rows[0] ?? null;
}
