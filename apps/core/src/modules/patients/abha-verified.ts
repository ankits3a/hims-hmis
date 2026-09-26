import { and, eq, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { patients } from "../../kernel/db/schema";
import { normaliseAbhaNumber } from "./abdm";
import { patientUpdated, identityVersionMinted } from "./events";
import { mintIdentityVersion } from "./identity";
import { PatientError } from "./uhid";
import { abhaRaceError, assertAbhaFree, isAbhaUniqueViolation } from "./abha-holders";
import { ABDM_DEMOGRAPHICS_KEY, updatePatient } from "./registration";
import type { Actor } from "@hmis/contracts";
import type { PatientPatch, PatientRow } from "./registration";
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
  input: {
    abhaNumber: string; abhaAddress?: string | null; via: string;
    /**
     * ABDM S1 — the hospital user whose act this is (the clerk who linked). Used ONLY to decide
     * whether an `abha_already_linked` refusal may name the other record's UHID; the write itself
     * stays the ABDM system actor's.
     */
    requestedBy?: Actor | null;
  },
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
  // ABDM S1 — ONE ABHA, ONE PATIENT: ABDM verifying a number does not let it sit on two records.
  await assertAbhaFree(tx, input.requestedBy ?? null, { abhaNumber: next.abhaNumber, abhaAddress: next.abhaAddress }, patientId);
  const changes = Object.entries(next)
    .map(([field, to]) => ({ field, from: auditString((current as Record<string, unknown>)[field]), to }))
    .filter((c) => c.from !== c.to);
  if (changes.length === 0) return { patient: current, changed: [] };

  const updated = await tx
    .update(patients)
    .set({ ...next, updatedBy: ABDM_ACTOR.id, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
    .returning()
    .catch((e: unknown) => {
      if (isAbhaUniqueViolation(e)) throw abhaRaceError();
      throw e;
    });
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

/**
 * ═══ ABDM S1 — TAKING ABDM'S NAME, DATE OF BIRTH AND GENDER ONTO THE RECORD (DECIDED) ═══
 *
 * NHA's M1 workbook expects ABDM-verified demographics to be authoritative: after verification
 * "the fields for name, date of birth and gender are set as non-editable". So linking a verified ABHA
 * takes ABDM's values — after the clerk has SEEN the differences and accepted them (the abdm module
 * refuses a link with differences until they have) — and then the lock in `updatePatient` holds them
 * while the ABHA stays `verified`.
 *
 * THROUGH THE AMENDMENT PATH, NOT ROUND IT. This is `updatePatient` with the ONE key to the lock,
 * so everything an amendment owes still happens: the row lock, the `patient.updated` diff under the
 * CLERK's actor (they accepted it), a new Class I identity VERSION with `reasonClass:
 * document_correction` and `evidenceRef: abdm_verified (…)`, and DD5's assurance rule — evidenced at
 * `abha_verified` with a named reference, so the stamp is held, not raised and not dropped.
 * Call it BEFORE `recordAbhaVerifiedByAbdm`, in the same transaction.
 */
export const ABDM_EVIDENCE_REF = "abdm_verified";

export async function acceptAbdmDemographics(
  tx: Tx,
  actor: Actor,
  patientId: string,
  fields: Pick<PatientPatch, "name" | "dob" | "dobEstimated" | "administrativeGender">,
  via: string,
): Promise<{ patient: PatientRow; changed: string[] }> {
  const patch: PatientPatch = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.dob !== undefined) patch.dob = fields.dob;
  if (fields.dobEstimated !== undefined) patch.dobEstimated = fields.dobEstimated;
  if (fields.administrativeGender !== undefined) patch.administrativeGender = fields.administrativeGender;
  return updatePatient(tx, actor, patientId, patch, {
    reasonClass: "document_correction",
    evidenceRef: `${ABDM_EVIDENCE_REF} (${via})`,
    evidencedAt: "abha_verified",
    [ABDM_DEMOGRAPHICS_KEY]: true,
  });
}
