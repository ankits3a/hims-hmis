import { z } from "zod";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otCases } from "../../kernel/db/schema";
import { guardiansWithAuthority } from "../patients";
import { OtError } from "./errors";
import type { Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T4 / DD5 — **CONSENT: what a signature has to carry to be one.**
 *
 * ═══ THE SHAPE IS THE POINT (H6, E7, K2, K4, G2) ═══
 *
 * A consent gate satisfied by a boolean is a consent gate that proves nothing. Every field below is
 * a real refusal somewhere:
 *
 *   · `procedureCode` + `templateVersion` — H6. A consent signed against last year's template for a
 *     different operation is not consent to this one, and without both fields nobody can ever tell.
 *   · `language` + `interpreter` — E7. A Hindi-only patient signing an English form needs an
 *     interpreter named on the record; the alternative is a signature nobody can defend.
 *   · `thumbImpression` + `witness` — K4. A patient who cannot write signs with a thumb, and a thumb
 *     impression without a witness is the commonest way an Indian consent form fails in court.
 *   · `laterality` — A3/A7. THE SITE-MARKING TRIPLE EQUALITY'S THIRD OPERAND. The marking is
 *     compared to the case AND to this, which is why laterality lives on the consent at all.
 *   · `conversionCovered` — G2/N11. "If we get in and it has to become an open procedure, may we?"
 *     `procedure.converted` records whether it was covered; a conversion without it is a finding,
 *     not a block, because the surgeon is already inside the patient.
 *   · `signer` + `guardianId` — E15/A11. A minor's consent is the guardian's, and only a guardian
 *     with `consents` authority AT THIS MOMENT.
 *
 * ═══ CONSENT IS RECORDED, THEN A GATE IS SATISFIED — TWO ACTS, NOT ONE ═══
 *
 * `recordConsent` writes the evidence; `satisfyGate("consent_procedure", { consentId })` uses it.
 * They are separate because a consent is taken at the desk or the bedside, minutes or hours before
 * anybody looks at a gate, and because ONE consent may satisfy the procedure gate while the
 * anaesthesia consent is still outstanding.
 *
 * **The consent lives on the GATE's `evidence` jsonb, not in a table of its own.** DD5 makes a gate
 * a child workflow instance carrying evidence, and a consent that is not attached to a gate is a
 * document nothing reads. `documentId` points at the scanned paper when there is one.
 */

export const CONSENT_KINDS = ["consent_procedure", "consent_anaesthesia"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const consentSchema = z.object({
  procedureCode: z.string().min(1),
  templateVersion: z.string().min(1),
  language: z.string().min(1),
  signer: z.enum(["patient", "guardian"]),
  guardianId: z.string().min(1).optional(),
  interpreter: z.string().min(1).optional(),
  witness: z.string().min(1).optional(),
  thumbImpression: z.boolean().default(false),
  /** A3/A7's third operand. Null for a non-lateral procedure. */
  laterality: z.enum(["left", "right", "bilateral"]).nullable().default(null),
  conversionCovered: z.boolean(),
  documentId: z.string().min(1).optional(),
  signedAt: z.string().min(1),
}).superRefine((consent, ctx) => {
  // K4 — a thumb impression with no witness is the commonest way an Indian consent fails in court.
  if (consent.thumbImpression && consent.witness === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a thumb-impression consent requires a named witness (K4)" });
  }
  // E15 — a guardian-signed consent must name WHICH guardian; `satisfyGate` then checks authority.
  if (consent.signer === "guardian" && consent.guardianId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a guardian-signed consent must name the guardian (E15)" });
  }
  if (consent.signer === "patient" && consent.guardianId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a patient-signed consent must not name a guardian" });
  }
});

export type ConsentEvidence = z.infer<typeof consentSchema>;

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

/** The `evidence` blob a satisfied consent gate carries, plus who attached it. */
export function consentEvidence(consent: ConsentEvidence, actor: Actor): Record<string, unknown> {
  return { kind: "consent", consent, recordedBy: actor.id, recordedAt: new Date().toISOString(), evidenceId: newId() };
}
