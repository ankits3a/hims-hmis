import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { newId } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import { patientIdentityVersions, patients } from "../../kernel/db/schema";
import { PatientError } from "./uhid";

/**
 * PLAN 22c-A T3 — FIELD CLASSES, THE ASSURANCE LADDER, AND VERSION MINTING.
 *
 * The three ideas here are one idea: a patient record answers several different questions, and
 * they correct through different doors. Conflating them is how a hospital ends up either
 * obstructing a legal right or letting a clinical value be rewritten as an identity correction.
 */

/**
 * DD2 — the ladder, ORDERED, and compared by `assuranceRank` rather than by string order. Alphabetical
 * comparison would put 'abha_verified' < 'id_verified' < 'self_declared' < 'staff_verified', which is
 * very nearly the reverse of the truth. Stored as TEXT (this table's own precedent: `sex`,
 * `abha_verification_status`) because a fifth level will arrive and an enum would make that a
 * migration with a lock on the patient master.
 */
export const IDENTITY_ASSURANCE = ["self_declared", "staff_verified", "id_verified", "abha_verified"] as const;
export type IdentityAssurance = (typeof IDENTITY_ASSURANCE)[number];

export function assuranceRank(level: string): number {
  const i = IDENTITY_ASSURANCE.indexOf(level as IdentityAssurance);
  if (i < 0) throw new PatientError("invalid_assurance", `unknown identity assurance "${level}"`);
  return i;
}

export function isIdentityAssurance(v: string): v is IdentityAssurance {
  return (IDENTITY_ASSURANCE as readonly string[]).includes(v);
}

/**
 * DD3/DD4 — THE FIELD CLASSES.
 *
 *   CLASS I   identity-bearing. Answers "who was this person". Versioned, amendment-gated, and
 *             a change drops assurance when it is not evidenced (DD5).
 *   CLASS II  contact and administrivia. A phone number is not part of who someone is; minting a
 *             version for it would make the table unbounded and the resolver ambiguous.
 *   CLASS III clinical observation. Corrects through the `entered_in_error` grammar allergies
 *             already use, never through the identity-amendment path.
 *
 * `administrative_gender` is CLASS I and `sex` is CLASS III, and that assignment is DD4's ruling
 * rather than an implementation detail: administrative gender is the legal marker that prints on
 * documents and that a patient has a NALSA right to change; clinical sex drives reference ranges
 * and dosing once a lab exists. Swapping them obstructs the right in one direction and corrupts
 * the clinical record in the other.
 */
export type FieldClass = "I" | "II" | "III";

/**
 * THE AMENDMENT REASON CLASS — an enum, never free text (series R-018, and the shipped precedent
 * is `refunds.ts`'s `reasonClass`). Free text on an amendment produces "correction", "corrected",
 * "as per document" and a thousand other spellings of four actual reasons, and nothing can ever
 * be counted or audited from it.
 */
export const AMENDMENT_REASONS = [
  "clerical_error",      // typed wrong at the counter
  "legal_change",        // NALSA gender change, marriage, gazette notification
  "document_correction", // brought into agreement with an identity document
  "patient_request",     // the patient says the record is wrong about them
  "merge_reconciliation", // settled while resolving a duplicate
] as const;
export type AmendmentReason = (typeof AMENDMENT_REASONS)[number];

export function isAmendmentReason(v: string): v is AmendmentReason {
  return (AMENDMENT_REASONS as readonly string[]).includes(v);
}

const CLASS_I = ["name", "dob", "dobEstimated", "administrativeGender", "abhaNumber"] as const;
const CLASS_III = ["sex", "bloodGroup"] as const;

export function resolveFieldClass(field: string): FieldClass {
  if ((CLASS_I as readonly string[]).includes(field)) return "I";
  if ((CLASS_III as readonly string[]).includes(field)) return "III";
  return "II";
}

/** True when any field in the changed set is identity-bearing. */
export function touchesIdentity(fields: readonly string[]): boolean {
  return fields.some((f) => resolveFieldClass(f) === "I");
}

export type ClassIFields = {
  name: string;
  dob: Date | null;
  dobEstimated: boolean;
  administrativeGender: string;
  abhaNumber: string | null;
};

/**
 * Mints the next version for a patient, INSIDE THE CALLER'S TRANSACTION. That is A6's whole
 * point: an amendment that rolls back must not leave a version behind claiming a state the
 * patient was never in. The version number is allocated by reading the current max under the
 * caller's transaction, and the `(patient_id, version)` unique index is the backstop — two
 * concurrent amendments cannot both write version N, and the loser fails loudly rather than
 * silently overwriting.
 */
export async function mintIdentityVersion(
  tx: Tx,
  input: {
    patientId: string;
    fields: ClassIFields;
    identityAssurance: string;
    validFrom: Date;
    reasonClass: string | null;
    evidenceRef: string | null;
    createdBy: string;
  },
): Promise<{ versionId: string; version: number }> {
  const [maxRow] = await tx
    .select({ max: sql<number | null>`max(${patientIdentityVersions.version})` })
    .from(patientIdentityVersions)
    .where(eq(patientIdentityVersions.patientId, input.patientId));
  const version = (maxRow?.max ?? 0) + 1;
  const versionId = newId();
  await tx.insert(patientIdentityVersions).values({
    id: versionId,
    patientId: input.patientId,
    version,
    name: input.fields.name,
    dob: input.fields.dob,
    dobEstimated: input.fields.dobEstimated,
    administrativeGender: input.fields.administrativeGender,
    abhaNumber: input.fields.abhaNumber,
    identityAssurance: input.identityAssurance,
    validFrom: input.validFrom,
    reasonClass: input.reasonClass,
    evidenceRef: input.evidenceRef,
    createdBy: input.createdBy,
  });
  return { versionId, version };
}

/**
 * DD5 (S1-R3, locked) — AN UNEVIDENCED CLASS I AMENDMENT DROPS ASSURANCE RATHER THAN BEING REFUSED.
 *
 * Refusing would push clerks into re-registering the patient, and duplicate records are the exact
 * disease this whole programme exists to cure — a rule that makes the honest path harder than the
 * dishonest one produces the dishonest path. So the amendment succeeds and the STAMP tells the
 * truth instead: a record that was `id_verified` on a name nobody re-checked is no longer
 * `id_verified`, it is `staff_verified`.
 *
 * The floor is `staff_verified`, never `self_declared`: a clerk did perform this amendment, and
 * that is worth exactly one rung. The drop is skipped when the amendment carries evidence at or
 * above the record's current level.
 */
export function assuranceAfterAmendment(current: string, evidencedAt: string | null): string {
  const currentRank = assuranceRank(current);
  if (currentRank <= assuranceRank("staff_verified")) return current;
  if (evidencedAt !== null && assuranceRank(evidencedAt) >= currentRank) return current;
  return "staff_verified";
}

/**
 * The upgrade path. STAFF ACTORS ONLY (A9) — a patient actor raising its own assurance is
 * self-asserted identity verification, which is the one thing an assurance ladder must never
 * permit. The guard is `!== "user"` rather than `=== "patient"` so that a future fifth member
 * arrives denied, the same lesson `workflow/instances.ts` taught this phase (T2/S2).
 */
export async function upgradeAssurance(
  tx: Tx,
  actor: Actor,
  patientId: string,
  toLevel: string,
  evidenceRef: string | null,
): Promise<{ from: string; to: string }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only a staff user may change identity assurance");
  }
  if (!isIdentityAssurance(toLevel)) {
    throw new PatientError("invalid_assurance", `unknown identity assurance "${toLevel}"`);
  }
  const rows = await tx.select().from(patients).where(eq(patients.id, patientId));
  const current = rows[0];
  if (!current) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (current.status !== "active") {
    throw new PatientError("patient_not_active", "a merged record is frozen — edit the canonical patient");
  }
  if (assuranceRank(toLevel) <= assuranceRank(current.identityAssurance)) {
    // A9: assurance never DECREASES through this door. The only descent is DD5's drop, which is a
    // consequence of an amendment rather than an act of its own — routing it here would let a
    // clerk quietly downgrade a verified record with no amendment to justify it.
    throw new PatientError(
      "assurance_not_increasing",
      `cannot move assurance from ${current.identityAssurance} to ${toLevel} — upgrades only`,
    );
  }
  if (assuranceRank(toLevel) >= assuranceRank("id_verified") && (evidenceRef ?? "").trim() === "") {
    throw new PatientError("evidence_required", `${toLevel} needs an evidence reference`);
  }
  await tx
    .update(patients)
    .set({ identityAssurance: toLevel, updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")));
  return { from: current.identityAssurance, to: toLevel };
}

/**
 * PLAN 22c-A T6 (DD6) — THE RESOLVER. Returns the Class I field set in force at `at`.
 *
 * A21: the comparison is `<=`, not `<`. A version minted at exactly `at` IS in force at `at` —
 * the amendment happened, or it would not be in the table, and an amendment and an issue landing
 * in the same second must resolve to the same side every time rather than by clock luck.
 *
 * A20: when no version is at or before `at` — a document dated before this patient's earliest
 * version — the EARLIEST version is returned rather than null. 0043 backfilled version 1 at each
 * patient's `created_at`, so this covers the pre-migration document whose issue date precedes any
 * amendment. Returning null instead would make every such document fail to render, which is a
 * worse answer than "the oldest thing we know".
 */
export async function resolveIdentityAt(
  db: Db | Tx,
  patientId: string,
  at: Date,
): Promise<(ClassIFields & { version: number; identityAssurance: string; validFrom: Date }) | null> {
  const inForce = await db
    .select()
    .from(patientIdentityVersions)
    .where(and(eq(patientIdentityVersions.patientId, patientId), lte(patientIdentityVersions.validFrom, at)))
    .orderBy(desc(patientIdentityVersions.validFrom), desc(patientIdentityVersions.version))
    .limit(1);
  const row =
    inForce[0] ??
    (
      await db
        .select()
        .from(patientIdentityVersions)
        .where(eq(patientIdentityVersions.patientId, patientId))
        .orderBy(patientIdentityVersions.version)
        .limit(1)
    )[0];
  if (!row) return null;
  return {
    name: row.name,
    dob: row.dob,
    dobEstimated: row.dobEstimated,
    administrativeGender: row.administrativeGender,
    abhaNumber: row.abhaNumber,
    version: row.version,
    identityAssurance: row.identityAssurance,
    validFrom: row.validFrom,
  };
}
