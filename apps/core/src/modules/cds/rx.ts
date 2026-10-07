import type { BuiltLine } from "./regimen";

/**
 * ═══ THE REGIMEN LINE AS A PRESCRIPTION LINE — BUILT HERE, NOT IN THE BROWSER ═══
 *
 * The owner's "1-tap accept full regimen" means the doctor's prescription form arrives already
 * filled. Something must turn *"1-0-1 After Food"* and *"5 Days"* into the form's `frequency` and
 * `durationDays`, and that something is prose parsing — which belongs where it can be tested and
 * where one implementation serves every client, not in a screen where it is invisible until a
 * doctor notices a wrong duration on a printed slip.
 *
 * ═══ WHAT IT REFUSES TO GUESS ═══
 *
 * An unrecognised frequency is `other` and an unrecognised duration is `null`, with the bundle's
 * own sig carried verbatim in `instructions` either way. The form is a DRAFT the doctor reads
 * before issuing — every one of these lines still passes `runRxChecks` at issue time — so the right
 * failure is an empty field beside the original text, never a plausible number nobody chose.
 */
export type RxDraftLine = {
  drug: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  instructions: string;
  noSubstitution: boolean;
};

/**
 * The closed frequency set and its reader live in `@hmis/contracts` (`rx-line.ts`) since decision
 * 0050's phase P0: the web, the scribe desk, the phone and this module all read the one definition.
 */
export { frequencyOf } from "@hmis/contracts";
export type { RxFrequency } from "@hmis/contracts";
import { frequencyOf } from "@hmis/contracts";

export function durationDaysOf(duration: string | null, sig: string): number | null {
  for (const text of [duration ?? "", sig]) {
    const m = /(\d+)\s*(?:day|days|d\b)/i.exec(text);
    if (m !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && n <= 365) return n;
    }
  }
  return null;
}

function routeOf(label: string): string {
  const s = label.toLowerCase();
  if (/inhaler|puff|nebuli|rotacap/.test(s)) return "inhaled";
  if (/\bgel\b|ointment|cream|topical|compress|patch/.test(s)) return "topical";
  if (/injection|\biv\b|infusion|vial/.test(s)) return "iv";
  return "oral";
}

/**
 * THE DOSE FIELD IS THE COMPUTED ONE WHEN THERE IS A COMPUTED ONE, and the bundle's own text when
 * there is not. A line the module refused to compute (an unreviewed rate, a missing weight, a
 * substitute, a blocked drug) arrives with the reason IN THE DOSE FIELD, so a doctor who taps
 * "fill" without reading the cards still cannot print a number nobody stands behind.
 */
export function toRxDraft(line: BuiltLine): RxDraftLine {
  const d = line.dose;
  const dose = d.state === "computed"
    ? (d.ml === null ? `${d.mg} mg` : `${d.ml} mL (${d.mg} mg)`)
    : d.state === "blocked" ? "— removed: allergy on file"
      : d.state === "needs_review" ? "— dose needs review"
        : d.state === "no_weight" ? "— record weight"
          : line.sig;
  const parts = [line.sig, line.purpose ?? "", d.state === "computed" ? d.basis : d.basis].filter((x) => x !== "");
  return {
    drug: line.drugLabel,
    dose,
    route: routeOf(line.drugLabel),
    frequency: frequencyOf(line.sig),
    durationDays: durationDaysOf(line.duration, line.sig),
    instructions: parts.join(" · "),
    noSubstitution: false,
  };
}
