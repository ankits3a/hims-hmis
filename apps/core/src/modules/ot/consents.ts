import { eq } from "drizzle-orm";
import { otCases } from "../../kernel/db/schema";
import { consentSchema } from "../../kernel/consent";
import { guardiansWithAuthority } from "../patients";
import { OtError } from "./errors";
import type { ConsentEvidence } from "../../kernel/consent";
import type { Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T4 / DD5 — **CONSENT: what a signature has to carry to be one.**
 *
 * The SHAPE — `consentSchema`, its `ConsentEvidence` type and the `consentEvidence` blob a satisfied
 * gate carries — lives in `kernel/consent/consent.ts` (#1086), with the reason for every field; imaging
 * takes consent by the same shape. `index.ts` re-exports those objects under the same names. What stays
 * here is theatre's: which gate kinds are consents, and the check of a consent against an OT case.
 *
 * ═══ CONSENT IS RECORDED, THEN A GATE IS SATISFIED — TWO ACTS, NOT ONE ═══
 *
 * `recordConsent` writes the evidence; `satisfyGate("consent_procedure", { consentId })` uses it.
 * They are separate because a consent is taken at the desk or the bedside, minutes or hours before
 * anybody looks at a gate, and because ONE consent may satisfy the procedure gate while the
 * anaesthesia consent is still outstanding.
 */

export const CONSENT_KINDS = ["consent_procedure", "consent_anaesthesia"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * Validates a consent against the case it is for, and against the signer's authority.
 *
 * Returns the parsed evidence rather than writing it: `satisfyGate` is the one writer of a gate's
 * evidence, so this stays a pure-ish check with one authority read. That keeps the "who may sign"
 * rule in ONE place instead of one per gate kind.
 */
export async function validateConsent(
  tx: Tx, caseId: string, raw: unknown, at: Date = new Date(),
): Promise<ConsentEvidence> {
  const parsed = consentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OtError(
      "consent_authority_missing",
      `consent is incomplete: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const consent = parsed.data;

  const rows = await tx.select().from(otCases).where(eq(otCases.id, caseId));
  const kase = rows[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${caseId}`);

  // H6 — the consent must be for THIS procedure. A consent for a different one is not consent.
  if (consent.procedureCode !== kase.procedureCode) {
    throw new OtError(
      "consent_authority_missing",
      `this consent is for "${consent.procedureCode}" and the case is "${kase.procedureCode}" (H6)`,
    );
  }
  // A7's third operand has to AGREE with the case, or the triple equality is comparing noise.
  if (consent.laterality !== kase.laterality) {
    throw new OtError(
      "consent_authority_missing",
      `the consent's laterality (${String(consent.laterality)}) is not the case's (${String(kase.laterality)}) — A3/A7`,
    );
  }

  /**
   * ═══ A11 — A MINOR'S CONSENT IS THE GUARDIAN'S, AND ONLY WITH `consents` AUTHORITY ═══
   *
   * `guardiansWithAuthority` computes at `at`, so a guardian whose authority ENDED — the patient
   * turned eighteen, a court order expired, the link was ended — is powerless here whether or not
   * the nightly sweep has run. The mutant skips the SCOPE and accepts any live guardian, which is
   * the natural shortcut: `messages` authority is the default a registration desk grants, and it is
   * the one authority that must not carry a signature on an operation.
   */
  if (consent.signer === "guardian") {
    const guardians = await guardiansWithAuthority(tx, kase.patientId, at);
    const guardian = guardians.find((g) => g.guardianId === consent.guardianId);
    if (!guardian) {
      throw new OtError(
        "consent_authority_missing",
        `guardian ${String(consent.guardianId)} is not a live guardian of this patient (E15)`,
      );
    }
    if (!guardian.authority.consents) {
      throw new OtError(
        "consent_authority_missing",
        `guardian ${guardian.guardianId} (${guardian.relationship}) does not hold CONSENT authority for this patient (E15/A11)`,
        { guardianId: guardian.guardianId, authority: guardian.authority },
      );
    }
  }
  return consent;
}
