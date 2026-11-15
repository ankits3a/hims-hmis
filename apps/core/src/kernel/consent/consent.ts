import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 15 T4 / DD5 — **CONSENT: what a signature has to carry to be one.** Moved here from
 * `modules/ot/consents.ts` (#1086): theatre and imaging both read it, and imaging does not depend on
 * theatre for consent. `ot` re-exports these objects under the same names, so nothing that imports `ot`
 * changes. Checking a consent AGAINST something (a case, a study, a guardian's authority) stays with the
 * module that owns that something — `ot`'s `validateConsent`, radiology's `contrast_consent` gate.
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
 * **The consent lives on the GATE's `evidence` jsonb, not in a table of its own.** DD5 makes a gate
 * a child workflow instance carrying evidence, and a consent that is not attached to a gate is a
 * document nothing reads. `documentId` points at the scanned paper when there is one.
 */
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

/** The `evidence` blob a satisfied consent gate carries, plus who attached it. */
export function consentEvidence(consent: ConsentEvidence, actor: Actor): Record<string, unknown> {
  return { kind: "consent", consent, recordedBy: actor.id, recordedAt: new Date().toISOString(), evidenceId: newId() };
}

/** The adult age: below it a consent is the guardian's (E15/A11), and a day-care escort must be at least it. */
export const ADULT_AGE_YEARS = 18;
