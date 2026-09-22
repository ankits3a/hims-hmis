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

/** The form's own vocabulary (`opd-consult.tsx`'s FREQUENCY_OPTIONS) — a value outside it cannot be selected. */
export type RxFrequency = "OD" | "BD" | "TDS" | "QID" | "HS" | "SOS" | "STAT" | "other";

export function frequencyOf(sig: string): RxFrequency {
  const s = sig.toLowerCase();
  /* The Indian slip's own notation first — "1-0-1" is read aloud as morning-noon-night and is what
     the bundle writes. Count the non-zero slots; that is the frequency, whatever words follow. */
  const slots = /(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?/.exec(s);
  if (slots !== null) {
    const taken = slots.slice(1).filter((x) => x !== undefined && x !== "0").length;
    if (taken === 1) return /0\s*-\s*0\s*-\s*[1-9]/.test(s) && /bed|night|hs/.test(s) ? "HS" : "OD";
    if (taken === 2) return "BD";
    if (taken === 3) return "TDS";
    if (taken === 4) return "QID";
  }
  if (/\bstat\b/.test(s)) return "STAT";
  if (/\bsos\b|as needed|when required/.test(s)) return "SOS";
  if (/every\s*4\s*-?\s*6\s*h|q4h/.test(s)) return "QID";
  if (/every\s*6\s*h|q6h|\bqid\b/.test(s)) return "QID";
  if (/every\s*8\s*h|q8h|\btds\b|\btid\b/.test(s)) return "TDS";
  if (/every\s*12\s*h|q12h|\bbd\b|\bbid\b|twice/.test(s)) return "BD";
  if (/bedtime|at night|\bhs\b/.test(s)) return "HS";
  if (/once daily|\bod\b|\bdaily\b/.test(s)) return "OD";
  return "other";
}

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
