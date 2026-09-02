import { findLockoutHits } from "../pcpndt";
import { templateFor, templateKeyFor } from "./templates";
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
  contrastGiven: boolean;
  contrastAgent: string | null;
  contrastVolumeMl: string | null;
  dose: { ctdivol: string | null; dlp: string | null; dap: string | null; fluoroSeconds: number | null };
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

function techniqueOf(f: DrafterFacts): string {
  const parts = [`${MODALITY_WORDS[f.studyType.modality] ?? f.studyType.modality} of the ${f.studyType.body_part}`];
  if (f.laterality !== "na") parts.push(`(${f.laterality})`);
  if (f.contrastGiven) {
    const agent = f.contrastAgent ?? "contrast";
    parts.push(f.contrastVolumeMl === null ? `with intravenous ${agent}.` : `with ${f.contrastVolumeMl} ml ${agent} intravenously.`);
  } else if (f.studyType.contrast_option !== "none") {
    parts.push("without contrast.");
  } else {
    parts[parts.length - 1] += ".";
  }
  const dose: string[] = [];
  if (f.dose.ctdivol !== null) dose.push(`CTDIvol ${f.dose.ctdivol} mGy`);
  if (f.dose.dlp !== null) dose.push(`DLP ${f.dose.dlp} mGy·cm`);
  if (f.dose.dap !== null) dose.push(`DAP ${f.dose.dap} Gy·cm²`);
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
    body.technique = techniqueOf(facts);
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
export function setActiveDrafter(drafter: ReportDrafter | null): void { active = drafter ?? offlineTemplateDrafter; }

/** Every proposal goes through the lockout. A drafter that emits a §5(2) term is refused, not overridden. */
export function proposalLockoutHits(p: DraftProposal): string[] {
  const text = `${Object.values(p.body).join(" ")} ${p.impression ?? ""}`;
  return findLockoutHits(text, "full").map((h) => h.term);
}
