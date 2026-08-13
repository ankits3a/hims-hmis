import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientAllergies, patients } from "../../kernel/db/schema";
import { allergyRecorded, correctionEnteredInError } from "./events";
import { PatientError } from "./uhid";
import type { Db, Tx } from "../../kernel/db/client";

export type AllergyRow = typeof patientAllergies.$inferSelect;

export async function addAllergy(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: {
    substance: string;
    reaction?: string;
    severity?: "mild" | "moderate" | "severe";
    source: "registration" | "vitals" | "consult";
  },
): Promise<{ allergyId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "record allergies on the canonical patient");

  const allergyId = newId();
  await tx.insert(patientAllergies).values({
    id: allergyId,
    patientId,
    substance: input.substance,
    reaction: input.reaction ?? null,
    severity: input.severity ?? null,
    source: input.source,
    recordedBy: actor.id,
  });
  await appendEvent(
    tx,
    allergyRecorded.make({
      actor,
      patientId,
      payload: {
        patientId,
        allergyId,
        substance: input.substance,
        severity: input.severity ?? null,
        source: input.source,
      },
    }),
  );
  return { allergyId };
}

/** All statuses, newest first — corrected entries render struck-through, never vanish (E-8). */
export async function listAllergies(db: Db, patientId: string): Promise<AllergyRow[]> {
  return db
    .select()
    .from(patientAllergies)
    .where(eq(patientAllergies.patientId, patientId))
    .orderBy(desc(patientAllergies.recordedAt));
}

export async function markAllergyEnteredInError(
  tx: Tx,
  actor: Actor,
  allergyId: string,
  reason: string,
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed === "") throw new PatientError("reason_required", "a correction needs a reason (E-8)");

  const rows = await tx.select().from(patientAllergies).where(eq(patientAllergies.id, allergyId));
  const row = rows[0];
  if (!row) throw new PatientError("allergy_not_found", `unknown allergy ${allergyId}`);

  const updated = await tx
    .update(patientAllergies)
    .set({ status: "entered_in_error", correctedBy: actor.id, correctedAt: new Date(), correctionReason: trimmed })
    .where(and(eq(patientAllergies.id, allergyId), eq(patientAllergies.status, "active")))
    .returning({ id: patientAllergies.id });
  if (updated.length === 0) {
    throw new PatientError("allergy_not_active", "already corrected");
  }
  await appendEvent(
    tx,
    correctionEnteredInError.make({
      actor,
      patientId: row.patientId,
      payload: { entity: "allergy", entityId: allergyId, patientId: row.patientId, reason: trimmed },
    }),
  );
}
