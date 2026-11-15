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
  outside: { id?: string; centreName: string; studyDate: string; arrival: string } | null;
  /**
   * #1081 — the latest SIGNED prior of the same modality and body part (`proposeDraft` finds it), for
   * the comparison line. `studyDate` is the prior's IST day; null or absent means there is none.
   */
  prior?: { reportId: string; studyId: string; accessionNo: string; studyDate: string; studyTypeName: string } | null;
  /** #1081 — the contrast register's rows behind `contrastAgent`/`contrastVolumeMl`, named on the chip. */
  contrastAdministrationIds?: readonly string[];
};

/**
 * #1081 — **ONE SOURCE PER ROW A DRAFTED SECTION WAS BUILT FROM.** `ref` is the row (a study type's
 * code, the study whose dose and contrast columns were read, the outside register's row, the prior
 * report's id); `values` are the facts read from it, exactly as the sentence uses them, so the numbers
 * check can compare a sentence with its sources without reading anything again. Ids never go in
 * `values` (a ULID is full of digits and would make every number look sourced).
 */
export const DRAFT_SOURCE_KINDS = ["study_type", "dose_record", "contrast_register", "outside_register", "prior_report"] as const;
export type DraftSourceKind = (typeof DRAFT_SOURCE_KINDS)[number];
export type DraftSource = {
  kind: DraftSourceKind;
  ref: string;
  values: Record<string, string | number | null>;
  /** The register rows behind a summary (the contrast administrations), when there are any. */
  rows?: string[];
};
export type DraftSection = { sources: DraftSource[] };

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
    /** #1081 — per drafted section, the rows it came from: the screen's chip. Absent on a section nobody drafted. */
    sections?: Record<string, DraftSection>;
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

/**
 * #1081 — the rows `techniqueOf` read for THESE facts, in the order the sentence uses them. Kept beside
 * it so a clause added there is a source added here; the numbers check refuses the proposal otherwise.
 */
function techniqueSources(f: DrafterFacts, named: boolean): DraftSource[] {
  const out: DraftSource[] = [{
    kind: "study_type", ref: f.studyType.code,
    values: { code: f.studyType.code, name: named ? f.studyType.name : null, modality: f.studyType.modality },
  }];
  if (f.outside !== null) {
    out.push({
      kind: "outside_register", ref: f.outside.id ?? f.studyId,
      values: { centreName: f.outside.centreName, studyDate: f.outside.studyDate, arrival: f.outside.arrival },
    });
    return out;
  }
  if (f.contrastGiven) {
    out.push({
      kind: "contrast_register", ref: f.studyId,
      values: { agent: f.contrastAgent, volumeMl: f.contrastVolumeMl },
      ...(f.contrastAdministrationIds !== undefined && f.contrastAdministrationIds.length > 0 ? { rows: [...f.contrastAdministrationIds] } : {}),
    });
  }
  if (f.dose.ctdivol !== null || f.dose.dlp !== null || f.dose.fluoroSeconds !== null) {
    out.push({
      kind: "dose_record", ref: f.studyId,
      values: { ctdivol: f.dose.ctdivol, dlp: f.dose.dlp, fluoroSeconds: f.dose.fluoroSeconds },
    });
  }
  return out;
}

/**
 * #1081 — **THE COMPARISON LINE**: the latest signed prior of the same modality and body part, by its
 * study type, its IST day and its accession — the three things a reader needs to pull it up. Never a
 * word of the prior's findings: a comparison of FINDINGS is the radiologist's to write.
 */
function comparisonOf(prior: NonNullable<DrafterFacts["prior"]>): { text: string; source: DraftSource } {
  return {
    text: `Compared with ${prior.studyTypeName} of ${prior.studyDate}, accession ${prior.accessionNo}.`,
    source: {
      kind: "prior_report", ref: prior.reportId,
      values: { studyTypeName: prior.studyTypeName, studyDate: prior.studyDate, accessionNo: prior.accessionNo },
    },
  };
}

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
    const nameKept = findLockoutHits(named, facts.lockoutTier).length === 0;
    body.technique = nameKept ? named : techniqueOf({ ...facts, studyType: { ...facts.studyType, name: "" } });
    const sections: Record<string, DraftSection> = { technique: { sources: techniqueSources(facts, nameKept) } };
    /** #1081 — the comparison line only when there is a prior; with none the section is not drafted at all. */
    if (facts.prior !== undefined && facts.prior !== null) {
      const c = comparisonOf(facts.prior);
      body.comparison = c.text;
      sections.comparison = { sources: [c.source] };
    }
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
        sections,
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

/** A number as a sentence writes one: digits, with one decimal part. "2026-02-14" is three numbers. */
const NUMBER_RE = /\d+(?:\.\d+)?/g;
function numbersIn(text: string): string[] { return text.match(NUMBER_RE) ?? []; }

/**
 * #1081 — **"AI NEVER WRITES NUMBERS": EVERY NUMBER IN A DRAFTED SECTION APPEARS IN A ROW ITS CHIP NAMES.**
 *
 * Deterministic and textual: each number in each non-empty section (and the impression) must appear,
 * character for character, among the numbers of that section's own source values. A section with no
 * sources has none to cite, so any number in it fails. The offline drafter passes by construction (it
 * prints the columns it names); a drafter that rounds a dose, invents a size or mistypes a date is
 * refused, as the lockout refuses a §5(2) term — and, like the lockout, nobody may override it.
 */
export function proposalNumberHits(p: DraftProposal): { section: string; number: string }[] {
  const hits: { section: string; number: string }[] = [];
  const texts: [string, string][] = [...Object.entries(p.body), ["impression", p.impression ?? ""]];
  for (const [section, text] of texts) {
    if (typeof text !== "string" || text.trim() === "") continue;
    const known = new Set((p.provenance.sections?.[section]?.sources ?? [])
      .flatMap((s) => Object.values(s.values).flatMap((v) => (v === null ? [] : numbersIn(String(v))))));
    for (const n of numbersIn(text)) if (!known.has(n)) hits.push({ section, number: n });
  }
  return hits;
}
