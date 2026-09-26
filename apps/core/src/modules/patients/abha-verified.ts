import { and, eq, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { patients } from "../../kernel/db/schema";
import { normaliseAbhaNumber } from "./abdm";
import { patientUpdated, identityVersionMinted } from "./events";
import { mintIdentityVersion } from "./identity";
import { PatientError } from "./uhid";
import type { Actor } from "@hmis/contracts";
import type { PatientRow } from "./registration";
import type { Tx } from "../../kernel/db/client";

/**
 * ═══ ABDM S0 — THE ONE WRITER OF `abha_verification_status = 'verified'` ═══
 *
 * `verified` is a claim about the national ABHA registry, and the only thing entitled to make it is
 * that registry answering. So the counter's register and amend paths REFUSE it
 * (`abha_verified_only_by_abdm`, `registration.ts`), and this function — which no route reaches —
 * is where it is set. The abdm module's S1 handlers call it, through `patients/index.ts`, after ABDM
 * has verified the number by OTP or shared a verified profile.
 *
 * WHAT IT WRITES, and why each part is the same as a counter amendment rather than a shortcut round it:
 *   · the row, under the row lock, and only while the patient is `active` (a merged record is frozen);
 *   · `patient.updated` with the field diff, under the ABDM SYSTEM actor — the audit says who
 *     changed the record, and it was not a clerk;
 *   · a new identity VERSION when the number changed, because `abha_number` is Class I and every
 *     Class I change mints one (22c-A A6). Its evidence is ABDM itself, so the record's identity
 *     assurance is left where it was rather than dropped as an unevidenced amendment would be.
 *     Whether an ABDM verification should RAISE identity assurance is S1's decision, not S0's.
 */
export const ABDM_ACTOR: Actor = { type: "system", id: "abdm" };

const ABHA_NUMBER_SHAPE = /^\d{2}-\d{4}-\d{4}-\d{4}$/;

function auditString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export async function recordAbhaVerifiedByAbdm(
  tx: Tx,
  patientId: string,
  input: { abhaNumber: string; abhaAddress?: string | null; via: string },
): Promise<{ patient: PatientRow; changed: string[] }> {
  const abhaNumber = normaliseAbhaNumber(input.abhaNumber);
  if (!ABHA_NUMBER_SHAPE.test(abhaNumber)) {
    throw new PatientError("abha_number_invalid", "ABDM's answer did not carry a fourteen-digit ABHA number");
  }
  const rows = await tx.select().from(patients).where(eq(patients.id, patientId)).for("update");
  const current = rows[0];
  if (!current) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (current.status !== "active") {
    throw new PatientError("patient_not_active", "a merged record is frozen — verify the canonical patient");
  }

  const address = input.abhaAddress === undefined ? current.abhaAddress : (input.abhaAddress ?? "").trim();
  const next: { abhaNumber: string; abhaAddress: string | null; abhaVerificationStatus: "verified" } = {
    abhaNumber,
    abhaAddress: address === "" ? null : address,
    abhaVerificationStatus: "verified",
  };
  const changes = Object.entries(next)
    .map(([field, to]) => ({ field, from: auditString((current as Record<string, unknown>)[field]), to }))
    .filter((c) => c.from !== c.to);
  if (changes.length === 0) return { patient: current, changed: [] };

  const updated = await tx
    .update(patients)
    .set({ ...next, updatedBy: ABDM_ACTOR.id, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
    .returning();
  if (updated.length === 0) throw new PatientError("patient_not_active", "patient was frozen concurrently");
  const row = updated[0]!;
  await appendEvent(tx, patientUpdated.make({ actor: ABDM_ACTOR, patientId, payload: { patientId, changes } }));

  if (changes.some((c) => c.field === "abhaNumber")) {
    const evidenceRef = `ABDM ${input.via}`;
    const { version } = await mintIdentityVersion(tx, {
      patientId,
      fields: {
        name: row.name, dob: row.dob, dobEstimated: row.dobEstimated,
        administrativeGender: row.administrativeGender, abhaNumber: row.abhaNumber,
      },
      identityAssurance: row.identityAssurance,
      validFrom: row.updatedAt,
      reasonClass: "document_correction",
      evidenceRef,
      createdBy: ABDM_ACTOR.id,
    });
    await appendEvent(tx, identityVersionMinted.make({
      actor: ABDM_ACTOR, patientId,
      payload: { patientId, version, fields: ["abhaNumber"], reasonClass: "document_correction", evidenceRef },
    }));
  }
  return { patient: row, changed: changes.map((c) => c.field) };
}
