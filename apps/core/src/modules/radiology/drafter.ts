import { findLockoutHits } from "../pcpndt";
import { templateFor, templateKeyFor } from "./templates";
import type { LockoutTier } from "../pcpndt";
import type { StudyType } from "./definitions";

/**
 * PLAN 18b T4 — **THE REPORT DRAFTER SEAM, AND ITS FIRST IMPLEMENTATION, WHICH IS NOT A MODEL.**
 *
 * ═══ D7 — MODULE-LOCAL, THE SHAPE `kernel/inference`'s `SpeechClient` USES ═══
 *
 * `ReportDrafter` is the interface a model-backed drafter binds to AFTER the owner rules on R4
 * (provider + DPIA addendum). Nothing in this phase calls a model, and nothing here needs the
 * kernel: the seam is a type and a registry in this module, the way `offlineSpeechClient` is the
 * speech seam's deterministic stand-in.
 *
 * ═══ THE OFFLINE DRAFTER NEVER INVENTS A FINDING ═══
 *
 * It fills `technique` from what the study RECORDED — modality, body part, contrast, dose — and
 * leaves `findings` and `impression` (and every other clinical section) EMPTY. A drafter that
 * wrote "No acute abnormality" into an impression would be a machine finding under a human
 * signature, which is what §6.8's provenance column exists to make visible and what the assertion
 * book's mutant is. The lockout runs over every proposal (`proposalLockoutHits`) so a drafter that
 * ever emitted a §5(2) term is REFUSED, not overridden — 18a's posture, extended to the machine.
 */

export type DrafterFacts = {
  studyId: string;
  accessionNo: string;
  studyType: Pick<StudyType, "code" | "name" | "modality" | "body_part" | "contrast_option" | "ionising">;
  laterality: string;
  /** Pass 2 B1 — the §5(2) tier THIS patient's report gets (F66), so the drafter can keep a label out of it. */
  lockoutTier: LockoutTier;
  contrastGiven: boolean;
  contrastAgent: string | null;
  contrastVolumeMl: string | null;
  dose: { ctdivol: string | null; dlp: string | null; dap: string | null; fluoroSeconds: number | null };
  /**
   * 18a-iii T4 / D5 — null for a study we performed. Non-null means the images came from another
   * centre, and the TECHNIQUE sentence has to say so: a signed report that reads like ours, about a
   * film that is not, is the exact confusion the register exists to prevent.
   */
  outside: { centreName: string; studyDate: string; arrival: string } | null;
};

export type DraftProposal = {
  templateKey: string;
  body: Record<string, string>;
  impression: string | null;
  laterality: string | null;
  /** §6.8 — a machine wrote this draft, and this says which one and from what. */
  provenance: {
    drafter: string;
    version: string;
    inputs: Record<string, unknown>;
    at: string;
  };
};

export type ReportDrafter = {
  readonly key: string;
  readonly version: string;
  draft(facts: DrafterFacts, now: Date): Promise<DraftProposal>;
};

const MODALITY_WORDS: Readonly<Record<string, string>> = {
  xray: "Plain radiograph", usg: "Ultrasound", ct: "CT", mri: "MRI", mammography: "Mammography",
};

/**
 * Close review B6 — `body_part` is a label ("obstetric", "lower limb"), so the sentence names the
 * study TYPE, which is a phrase the book wrote for humans: "Ultrasound: Obstetric anomaly scan".
 * Close review B3 — DAP is NOT rendered: `dose_dap` has no house unit anywhere in the tree and a
 * number under the wrong unit is a thousand-fold regulatory error under a signature. CTDIvol (mGy)
 * and DLP (mGy·cm) have one unit each; fluoroscopy is seconds. DAP's unit belongs to 18c's register.
 */
const ARRIVAL_WORDS: Readonly<Record<string, string>> = {
  film: "film", cd: "CD", link: "an external link", none: "no images",
};

function techniqueOf(f: DrafterFacts): string {
  const word = MODALITY_WORDS[f.studyType.modality] ?? f.studyType.modality;
  const parts = [f.studyType.name === "" ? word : `${word}: ${f.studyType.name}`];
  /**
   * ═══ 18a-iii T4 / D5 — THE LABEL COMES FIRST, BEFORE THE READER'S EYE REACHES THE FINDINGS ═══
   *
   * D5: *"the report surface labelling it so no reader mistakes it for ours."* The sentence names
   * the centre, their date and how the images arrived, because a radiologist reading a report six
   * months later needs all three to judge what the opinion was based on — and "reported from a CD"
   * is a materially different statement from "reported from film".
   *
   * Dose is deliberately NOT rendered for these: we did not irradiate this patient and there is no
   * dose of ours to state. That is the same fact `registerOutsideStudy` records by writing no
   * `radiation_dose_register` row at all.
   */
  if (f.outside !== null) {
    const how = ARRIVAL_WORDS[f.outside.arrival] ?? f.outside.arrival;
    parts.push(
      `— OUTSIDE STUDY, performed at ${f.outside.centreName} on ${f.outside.studyDate}, `
      + `reported here from ${how}.`,
    );
    return parts.join(" ");
  }
  if (f.laterality !== "na") parts.push(`(${f.laterality})`);
  if (f.contrastGiven) {
    /**
     * ═══ 18a-iii T1/T2 — THE NULL-VOLUME LEG NO LONGER CLAIMS A ROUTE ═══
     *
     * It used to read *"with intravenous {agent}."* whenever the volume was absent. 18a-iii makes
     * an ORAL-only study a first-class thing to record — and `summariseContrast` deliberately gives
     * such a study an agent and a NULL volume, because the study's volume column is the
     * INTRAVASCULAR volume and a litre of dilute barium is not a dose. So the old sentence would
     * have drafted *"Barium sulphate, intravenously"* into a signed report on a barium swallow.
     *
     * The non-null leg keeps the word, and it is now TRUE by construction rather than by luck: a
     * volume reaches this column only from an intravenous or intra-arterial administration.
     * (**Residue, named rather than fixed:** an intra-arterial study still drafts "intravenously".
     * DSA reporting has its own template and no seat drives it yet; when one does, the route belongs
     * on `DrafterFacts` and this branch goes away.)
     */
    const agent = f.contrastAgent ?? "contrast";
    parts.push(f.contrastVolumeMl === null ? `with ${agent}.` : `with ${f.contrastVolumeMl} ml ${agent} intravenously.`);
  } else if (f.studyType.contrast_option !== "none") {
    parts.push("without contrast.");
  } else {
    parts[parts.length - 1] += ".";
  }
  const dose: string[] = [];
  if (f.dose.ctdivol !== null) dose.push(`CTDIvol ${f.dose.ctdivol} mGy`);
  if (f.dose.dlp !== null) dose.push(`DLP ${f.dose.dlp} mGy·cm`);
  if (f.dose.fluoroSeconds !== null) dose.push(`fluoroscopy ${String(f.dose.fluoroSeconds)} s`);
  if (dose.length > 0) parts.push(`Dose: ${dose.join(", ")}.`);
  return parts.join(" ");
}

/** D7 — deterministic: the same facts produce the same proposal, and only `technique` is filled. */
export const offlineTemplateDrafter: ReportDrafter = {
  key: "offline_template",
  version: "1",
  async draft(facts, now) {
    const templateKey = templateKeyFor(facts.studyType.modality, facts.studyType.body_part);
    const body: Record<string, string> = {};
    for (const section of templateFor(templateKey).sections) body[section] = "";
    /**
     * Pass 2 B1 — the book's type LABEL may carry a demographic word ("USG pelvis (female)"), and
     * under F66 that word is refused for exactly the patients the type exists for. The drafter
     * never emits a lexicon term itself: if the label would, the sentence names the modality only
     * and the human writes the rest. Deterministic, and the refusal path stays for a drafter that
     * puts such a word in a FINDING.
     */
    const named = techniqueOf(facts);
    body.technique = findLockoutHits(named, facts.lockoutTier).length === 0
      ? named
      : techniqueOf({ ...facts, studyType: { ...facts.studyType, name: "" } });
    return {
      templateKey,
      body,
      impression: null,
      laterality: facts.laterality === "na" ? null : facts.laterality,
      provenance: {
        drafter: this.key, version: this.version, at: now.toISOString(),
        inputs: {
          studyTypeCode: facts.studyType.code, modality: facts.studyType.modality,
          contrastGiven: facts.contrastGiven, laterality: facts.laterality,
          dose: facts.dose,
        },
      },
    };
  },
};

let active: ReportDrafter = offlineTemplateDrafter;

/** The seam. A later phase binds a model-backed drafter here after R4; nothing else changes. */
export function activeDrafter(): ReportDrafter { return active; }
/**
 * Close review B11 — NOT exported from the module's `index.ts`: module-global mutable state that
 * only a test (or the phase that binds a model after R4, in this file) may touch. Nothing in
 * production calls it, and the row's `provenance.drafter` names whatever was bound.
 */
export function setActiveDrafter(drafter: ReportDrafter | null): void { active = drafter ?? offlineTemplateDrafter; }

/** Every proposal goes through the lockout. A drafter that emits a §5(2) term is refused, not overridden. */
export function proposalLockoutHits(p: DraftProposal, tier: LockoutTier): string[] {
  const text = `${Object.values(p.body).join(" ")} ${p.impression ?? ""}`;
  return findLockoutHits(text, tier).map((h) => h.term);
}
