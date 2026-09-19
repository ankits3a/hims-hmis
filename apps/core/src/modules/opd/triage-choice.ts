import type { TriageDepartment, TriageSuggestion } from "./triage";
import type { ChoiceClient } from "../../kernel/inference/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * TRIAGE'S FIRST MODEL — A CLASSIFIER HANDED THE HOSPITAL'S OWN DEPARTMENTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-19: *"keep typesafe as priority and the groq as fallback"*. TypeSafe is given the
 * masked complaint and the hospital's active departments as a closed set, and returns one of them —
 * or "none of these" — with a probability for every option. Like the chat model it only CHOOSES
 * from ours; unlike it, it cannot write anything, so the reason a clerk could read is ours too.
 *
 * ═══ MEASURED BEFORE IT WAS WIRED — 2026-09-19, `triage-eval.test.ts`'s own 46 complaints ═══
 *
 *     TypeSafe alone (with the descriptions below)   40/46 top-1   p50 274 ms
 *     gpt-oss-120b alone (triage.ts's prompt)        44/46 top-1   p50 698 ms
 *     TypeSafe at confidence >= 0.6                  38 answered, 38 right
 *
 * The chat model knows more Hindi symptom vocabulary — "gala kharab", "naak band" and "kaan bahta"
 * are ENT to it and General Medicine to TypeSafe. But every one of TypeSafe's misses scored under
 * the line, so the cascade hands exactly those to the chat model: simulated 45/46, better than
 * either alone, with 38 of 46 complaints answered in ~280 ms instead of ~700. The labels are the
 * eval's author's, not a clinician's; the gain is measured, the ground truth is not signed.
 */

/**
 * What each department SEES, for the names a hospital commonly seeds. The model reads the option
 * name AND its description, and names alone left it guessing ("Physiotherapy" vs "Orthopaedics"
 * for a stiff shoulder). A department this map does not know is offered by name alone — never
 * refused, never renamed. These are fixed strings, which is also what makes them safe to hand a
 * clerk as the suggestion's reason.
 */
const DESCRIPTIONS: Record<string, string> = {
  "general medicine": "fever, cough, infections, diabetes, blood pressure, thyroid, jaundice, general illness in adults",
  "general surgery": "lumps, hernia, piles, stones, wounds, abscesses, anything needing an operation",
  paediatrics: "any illness or vaccination in a child",
  pediatrics: "any illness or vaccination in a child",
  "obstetrics & gynaecology": "pregnancy, periods, women's reproductive health",
  "obstetrics and gynaecology": "pregnancy, periods, women's reproductive health",
  orthopaedics: "bones, joints, back, fractures, sprains",
  orthopedics: "bones, joints, back, fractures, sprains",
  ent: "ear, nose, throat, hearing, sinus, tonsils",
  ophthalmology: "eyes, vision, glasses, cataract",
  dermatology: "skin, rash, itching, hair loss, nails",
  psychiatry: "sleep, mood, anxiety, stress, addiction, mental health",
  cardiology: "heart, palpitations, chest discomfort that may be the heart",
  dental: "teeth and gums",
  physiotherapy: "exercise therapy and rehabilitation, stiffness, recovery after stroke or injury",
};

const NONE = "none of these";
const NONE_DESCRIPTION = "none of these departments, or not a health complaint";

/** A secondary department is offered only if the model gives it at least this chance. */
const SECONDARY_FLOOR = 0.1;
const MAX_SUGGESTIONS = 3;

const INSTRUCTIONS =
  "`complaint` is what a walk-in patient told the front desk of an Indian hospital, typed by a clerk in Hindi, " +
  "English, Hinglish or Bhojpuri. Patient identifiers are masked as <<P1>>. Which OUT-PATIENT department should see them?";

/** The departments as options: a key per department (duplicates disambiguated) and the way back to its id. */
export function departmentOptions(departments: TriageDepartment[]): { options: Record<string, string | null>; idOf: Map<string, TriageDepartment> } {
  const options: Record<string, string | null> = {};
  const idOf = new Map<string, TriageDepartment>();
  for (const d of departments) {
    let key = d.name;
    // Two departments with one name are still two departments; "ENT", "ENT #2".
    for (let n = 2; Object.hasOwn(options, key) || key === NONE; n += 1) key = `${d.name} #${String(n)}`;
    options[key] = DESCRIPTIONS[d.name.trim().toLowerCase()] ?? null;
    idOf.set(key, d);
  }
  options[NONE] = NONE_DESCRIPTION;
  return { options, idOf };
}

/** Ranked suggestions when sure; `none` when sure it is none of them; `unsure` hands over to the fallback. */
export type TriageChoiceOutcome = TriageSuggestion[] | "none" | "unsure";

export async function chooseDepartments(
  masked: string,
  departments: TriageDepartment[],
  chooser: ChoiceClient,
  minConfidence: number,
): Promise<TriageChoiceOutcome> {
  const { options, idOf } = departmentOptions(departments);

  let answer;
  try {
    const out = await chooser.choose({
      state: { complaint: masked },
      questions: { department: { instructions: INSTRUCTIONS, options } },
    });
    answer = out.answers.department;
  } catch {
    // Unreachable, slow, malformed — every one of them is "ask the fallback", never a guess.
    return "unsure";
  }
  if (answer === undefined || answer.confidence < minConfidence) return "unsure";
  if (answer.choice === NONE) return "none";

  /*
    RANKED BY THE MODEL'S OWN DISTRIBUTION, its choice first. A second or third department is offered
    only at a real chance of being right — the clerk sees at most three and picks.
  */
  const ranked = Object.entries(answer.probabilities)
    .filter(([key, p]) => key !== NONE && idOf.has(key) && (key === answer.choice || p >= SECONDARY_FLOOR))
    .sort(([a, pa], [b, pb]) => (a === answer.choice ? -1 : b === answer.choice ? 1 : pb - pa))
    .slice(0, MAX_SUGGESTIONS);

  const suggestions: TriageSuggestion[] = [];
  for (const [key] of ranked) {
    const dept = idOf.get(key);
    if (dept !== undefined) suggestions.push({ departmentId: dept.id, reason: options[key] ?? dept.name });
  }
  return suggestions.length > 0 ? suggestions : "unsure";
}
