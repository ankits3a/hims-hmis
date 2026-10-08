import { IdentifierLeak, assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import type { ChoiceAnswer, ChoiceClient, PredicateClient } from "../../kernel/inference/types";
import type { AliasCandidateRow } from "../formulary";
import { lasaPartner } from "./consult-guards";
import type { LasaPair } from "./consult-guards";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE AUTOMATIC MEDICINE-ALIAS PIPELINE (decision 0051; plan 2026-10-07 §7a; phase P2, first slice)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-10-07: "Aliases: currently no one adds and no one approves. No body has anytime to
 * do it and so I am looking this to be automated using advanced AI model." And on a person
 * reviewing them: "I would ask AI to get in this." So there is NO approval queue anywhere below.
 *
 * For one term nothing matched ("pan forty"), `proposeAlias`:
 *   a. asks the formulary for candidates — the rows named exactly so, then the nearest by trigram;
 *   b. hands a CHOOSER the term and that closed set plus "none of these";
 *   c. asks a second, different model (the REVIEWER) one closed question — does the term mean this
 *      product? — as a probability, and one closed reason code;
 *   d. runs the rules in code: never a Schedule H1 / X / NDPS medicine, a strength written in the
 *      term equals the target's, one target only, no look-alike conflict;
 *   e. says 'suggestion' ONLY when chooser and reviewer agree, each above its own line, and every
 *      rule passes. Anything else is 'proposed' with the first thing that refused — never shown.
 *
 * WHAT IS SENT TO A MODEL, AND IT IS ALL OF IT: the term, after it has been refused if it carries
 * anything identifier-shaped, and catalogue names. No patient, no visit, no doctor. What comes
 * BACK is a key we offered, a probability and one of seven codes — a model writes no text here.
 *
 * THIS SLICE HAS NO CALLER IN THE PRODUCT. Nothing reads `cds_aliases` in a search, on a screen or
 * in a job; `enabled` (the server setting `ALIAS_PIPELINE_ENABLED`) is false by default, and with it
 * false this function returns before it touches the catalogue or a model.
 * `scripts/eval-aliases.ts` is how it was measured before anything is switched on.
 */

export const ALIAS_REASON_CODES = ["name_match", "strength_match", "brand_nickname", "ambiguous_strength", "ambiguous_form", "lookalike_risk", "not_a_medicine"] as const;
export type AliasReasonCode = (typeof ALIAS_REASON_CODES)[number];
/** A reviewer that says "yes" and gives one of these has contradicted itself: read as "unsure". */
const REFUSING_REASONS: readonly AliasReasonCode[] = ["ambiguous_strength", "ambiguous_form", "lookalike_risk", "not_a_medicine"];

export const ALIAS_RULE_CODES = ["controlled_drug", "strength_mismatch", "form_mismatch", "strength_unstated", "lookalike_conflict", "multiple_targets", "same_model"] as const;
export type AliasRuleCode = (typeof ALIAS_RULE_CODES)[number];
export type AliasRuleResult = "pass" | "not_run" | AliasRuleCode;

export type AliasRefusal =
  | "identifier_in_term" | "no_candidates" | "chooser_unavailable" | "chooser_none" | "chooser_below_line"
  | "reviewer_unavailable" | "reviewer_no" | "reviewer_unsure" | AliasRuleCode;

export type ReviewerAnswer = "yes" | "no" | "unsure";

/** How many candidates a chooser is shown (plan §7a: "trigram top-N"). */
export const ALIAS_SHOWN = 5;
/** A second, different product holding more than this share of the chooser's belief is a second target. */
export const SECOND_TARGET_SHARE = 0.2;

// ─────────────────────────────────────────── reading a term ───────────────────────────────────────────

export type FormClass = "oral_solid" | "oral_solid_mr" | "oral_liquid" | "injection" | "topical" | "local_drops" | "inhaled" | "other";

/** The catalogue's open `form` text, folded into the classes a doctor's word can tell apart. */
export function formClassOf(form: string): FormClass {
  const f = form.toLowerCase();
  if (/inject|infusion/.test(f)) return "injection";
  if (/inhal|nebuli/.test(f)) return "inhaled";
  if (/\b(eye|ear|nasal)\b/.test(f)) return "local_drops";
  if (/cutaneous|cream|ointment|\bgel\b|lotion|shampoo|vaginal|rectal|suppositor|transdermal|patch/.test(f)) return "topical";
  /* A prolonged-release tablet is a different product from the plain one of the same strength; gastro-resistant is not. */
  if (/tablet|capsule|lozenge|granules|sachet/.test(f)) return /prolonged|sustained|extended|modified|controlled/.test(f) ? "oral_solid_mr" : "oral_solid";
  if (/syrup|suspension|solution|drops|elixir|liquid/.test(f)) return "oral_liquid";
  return "other";
}

const FORM_WORDS: Record<string, FormClass> = {
  tab: "oral_solid", tabs: "oral_solid", tablet: "oral_solid", tablets: "oral_solid", cap: "oral_solid", caps: "oral_solid", capsule: "oral_solid", capsules: "oral_solid", goli: "oral_solid",
  syp: "oral_liquid", syr: "oral_liquid", syrup: "oral_liquid", susp: "oral_liquid", suspension: "oral_liquid",
  inj: "injection", injection: "injection", iv: "injection", im: "injection", sui: "injection",
  cream: "topical", oint: "topical", ointment: "topical", gel: "topical", lotion: "topical",
};

/** "tab" names a tablet, and a prolonged-release tablet is still one. */
const formAgrees = (said: FormClass, target: FormClass): boolean => said === target || (said === "oral_solid" && target === "oral_solid_mr");

/** One strength: a mass in milligrams, or a count in another unit ("iu", "%"), or a bare number whose unit was not said. */
export type Strength = { value: number; unit: "mg" | "iu" | "%" | "bare" };

const UNIT_WORDS: Record<string, { unit: Strength["unit"]; times: number }> = {
  mg: { unit: "mg", times: 1 }, mgs: { unit: "mg", times: 1 }, milligram: { unit: "mg", times: 1 }, milligrams: { unit: "mg", times: 1 },
  g: { unit: "mg", times: 1000 }, gm: { unit: "mg", times: 1000 }, gms: { unit: "mg", times: 1000 }, gram: { unit: "mg", times: 1000 }, grams: { unit: "mg", times: 1000 },
  mcg: { unit: "mg", times: 0.001 }, microgram: { unit: "mg", times: 0.001 }, micrograms: { unit: "mg", times: 0.001 }, microg: { unit: "mg", times: 0.001 }, "µg": { unit: "mg", times: 0.001 },
  iu: { unit: "iu", times: 1 }, unit: { unit: "iu", times: 1 }, units: { unit: "iu", times: 1 },
  "%": { unit: "%", times: 1 },
};

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Romanised Hindi, the spellings a north-Indian counter actually produces.
  ek: 1, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, chhah: 6, cheh: 6, saat: 7, aath: 8, nau: 9, das: 10, dus: 10,
  bees: 20, bis: 20, pachees: 25, pachis: 25, tees: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90,
};
const BIG: Record<string, number> = { hundred: 100, sau: 100, thousand: 1000, hazar: 1000, hazaar: 1000 };
/** "dhai sau" is 250, "dedh" is 1.5, "sade chhe sau" is 650. */
const FRACTION: Record<string, number> = { dhai: 2.5, dhaai: 2.5, dedh: 1.5, sawa: 1.25, half: 0.5, aadha: 0.5 };
const HALF_MORE = new Set(["sade", "saade", "sadhe", "saadhe"]);
const isNumberWord = (t: string): boolean => Object.hasOwn(SMALL, t) || Object.hasOwn(BIG, t) || Object.hasOwn(FRACTION, t) || HALF_MORE.has(t) || t === "point";

/**
 * A run of spoken number words as one number. Two grammars, because a strength is SAID two ways:
 * "five hundred", "sade chhe sau" (arithmetic) and "six fifty", "six two five" (read out like a
 * label: 650, 625). `null` when the run is not a number after all.
 */
export function spokenNumber(run: readonly string[]): number | null {
  const point = run.indexOf("point");
  if (point !== -1) {
    const whole = point === 0 ? 0 : spokenNumber(run.slice(0, point));
    const digits = run.slice(point + 1).map((t) => SMALL[t]);
    if (whole === null || digits.length === 0 || digits.some((d) => d === undefined || d > 9)) return null;
    return Number(`${String(whole)}.${digits.map(String).join("")}`);
  }
  if (run.some((t) => Object.hasOwn(BIG, t))) {
    let total = 0; let cur = 0; let seen = false; let half = false;
    for (const t of run) {
      if (HALF_MORE.has(t)) { half = true; continue; }
      const big = BIG[t];
      if (big !== undefined) {
        const n = (seen ? cur : 1) + (half ? 0.5 : 0);
        half = false;
        if (big === 1000) { total += n * 1000; cur = 0; seen = false; } else { cur = n * 100; seen = true; }
        continue;
      }
      const n = FRACTION[t] ?? SMALL[t];
      if (n === undefined) return null;
      cur = seen ? cur + n : n; seen = true;
    }
    return total + cur;
  }
  if (run.some((t) => Object.hasOwn(FRACTION, t))) return run.length === 1 ? (FRACTION[run[0] as string] ?? null) : null;
  // Read out like a label: tens then a unit add ("twenty five"), everything else sits side by side ("six fifty").
  let text = ""; let prevTens = false; let half = false;
  for (const t of run) {
    if (HALF_MORE.has(t)) { half = true; continue; }
    const n = SMALL[t];
    if (n === undefined) return null;
    if (prevTens && n >= 1 && n <= 9) { text = `${text.slice(0, -1)}${String(n)}`; prevTens = false; continue; }
    text += String(n);
    prevTens = n >= 20 && n % 10 === 0;
  }
  if (text === "") return null;
  return Number(text) + (half ? 0.5 : 0);
}

export type TermReading = {
  /** The name part, lower-cased: "pan", "dolo", "amoxyclav". What the catalogue is searched for. */
  words: string;
  /** Every strength the term carried, in the order it was written. */
  numbers: Strength[];
  /** The form the term named ("tab", "inj", "syp"), or null. */
  form: FormClass | null;
  /** The term with its spoken numbers written as digits: "pan 40". What a model is also shown. */
  digits: string;
};

/** Lower-case, NFC, single-spaced — the key `cds_aliases.term` holds. */
export function normaliseTerm(raw: string): string {
  return raw.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

const trimNumber = (n: number): string => String(Number(n.toFixed(4)));

/** Split a normalised term into the name, the strengths and the form it names. Pure. */
export function readTerm(term: string): TermReading {
  const raw = normaliseTerm(term).replace(/(\d)\s*(mg|mcg|gm|g|ml|iu|k)\b/g, "$1 $2").replace(/[,;]/g, " ").split(" ").filter((t) => t !== "");
  const words: string[] = []; const numbers: Strength[] = []; const digits: string[] = [];
  let form: FormClass | null = null;
  let i = 0;
  /** Called with `i` just past a number: takes a following "k" (thousand) and a following unit with it. */
  const unitAfter = (said: number): Strength => {
    let value = said;
    if (raw[i] === "k") { value = said * 1000; i += 1; }
    digits.push(trimNumber(value));
    const word = raw[i];
    const u = word === undefined ? undefined : UNIT_WORDS[word];
    if (word === undefined || u === undefined) return { value, unit: "bare" };
    digits.push(word);
    i += 1;
    return { value: Number((value * u.times).toFixed(6)), unit: u.unit };
  };
  while (i < raw.length) {
    const t = raw[i] as string;
    if (/^\d+(?:\.\d+)?$/.test(t)) { i += 1; numbers.push(unitAfter(Number(t))); continue; }
    if (isNumberWord(t)) {
      let j = i;
      while (j < raw.length && isNumberWord(raw[j] as string)) j += 1;
      const n = spokenNumber(raw.slice(i, j));
      if (n !== null) { i = j; numbers.push(unitAfter(n)); continue; }
    }
    const f = FORM_WORDS[t];
    if (f !== undefined && (words.length > 0 || i < raw.length - 1)) { form = f; digits.push(t); i += 1; continue; }
    if (t === "ml" && numbers.length > 0) { digits.push(t); i += 1; continue; }
    words.push(t); digits.push(t); i += 1;
  }
  return { words: words.join(" "), numbers, form, digits: digits.join(" ") };
}

/**
 * The strengths a catalogue name prints: "… 500 mg + 125 mg oral tablet" → 500 mg, 125 mg. The
 * NAME is read, not `formulary_medicine_salts.strength`: measured on the catalogue 2026-10-08, a
 * combination's rows all repeat the first component's strength there. A denominator ("/5 mL",
 * "/1 vial") is not a strength and is not read.
 */
export function strengthsInName(name: string): Strength[] {
  const out: Strength[] = [];
  const re = /(^|[^\d./])(\d+(?:\.\d+)?)\s*(mg|g|mcg|microgram|micrograms|microg|µg|iu|units?|%)(?![a-z])/gi;
  for (const m of name.matchAll(re)) {
    const u = UNIT_WORDS[(m[3] as string).toLowerCase()];
    if (u === undefined) continue;
    out.push({ value: Number((Number(m[2]) * u.times).toFixed(6)), unit: u.unit });
  }
  return out;
}

const strengthKey = (s: readonly Strength[]): string => s.map((x) => `${trimNumber(x.value)}${x.unit}`).sort().join("+");

/** Same moieties, same strengths, same class of form: two rows that are one product to a prescriber. */
export function compositionKey(row: Pick<AliasCandidateRow, "name" | "form" | "salts">): string {
  return `${row.salts.join("+")}|${strengthKey(strengthsInName(row.name))}|${formClassOf(row.form)}`;
}

/** Does one number from the term name this strength? A bare "40" is 40 of whatever unit the label prints. */
function names(said: Strength, printed: Strength): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  if (said.unit !== "bare") return said.unit === printed.unit && near(said.value, printed.value);
  if (printed.unit !== "mg") return near(said.value, printed.value);
  return near(said.value, printed.value) || near(said.value, printed.value / 1000) || near(said.value, printed.value * 1000);
}

/**
 * Do the strengths written in the term equal the target's? Every number must name a component, or
 * — the Indian habit for a combination, "augmentin 625", "1.2 gram" — the one number is the SUM of
 * the components. A term with no number agrees with nothing and disagrees with nothing (`null`).
 */
export function strengthAgrees(said: readonly Strength[], targetName: string): boolean | null {
  if (said.length === 0) return null;
  const printed = strengthsInName(targetName);
  if (printed.length === 0) return false;
  if (said.every((s) => printed.some((p) => names(s, p)))) return true;
  const only = said[0];
  if (said.length === 1 && only !== undefined && printed.length > 1 && printed.every((p) => p.unit === "mg")) {
    return names(only, { value: printed.reduce((a, p) => a + p.value, 0), unit: "mg" });
  }
  return false;
}

// ─────────────────────────────────────────── the rules ───────────────────────────────────────────

/**
 * NEVER A CONTROLLED MEDICINE. The stored flags are asked first (Schedule H1 / X, an NDPS class on
 * a moiety) — and then the NAME, because the flags are not complete: measured on the staging
 * catalogue 2026-10-08, no moiety carries an NDPS class at all and "Morphine sulfate 10 mg oral
 * tablet" has no schedule flag. A name that looks controlled is refused; the stricter reading.
 */
const LOOKS_CONTROLLED = /(morphin|fentan|methadon|codon|codein|pethidin|meperidin|tramad|tapentad|buprenorph|pentazoc|nalbuph|butorphan|ketamin|azepam|azolam|clobazam|chlordiazepox|zolpid|zopiclon|zaleplon|barbit|methylphenid|amfetamin|amphetamin|modafin|diphenoxyl|propoxyphen|opium|cannab)/i;

export function isControlled(row: Pick<AliasCandidateRow, "name" | "scheduleFlag" | "salts" | "ndps">): boolean {
  return row.scheduleFlag === "H1" || row.scheduleFlag === "X" || row.ndps || LOOKS_CONTROLLED.test(row.name) || row.salts.some((s) => LOOKS_CONTROLLED.test(s));
}

/** Levenshtein distance, capped: anything past `cap` reads as `cap + 1`. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return Math.min(prev[b.length] as number, cap + 1);
}

/**
 * The interim look-alike line (plan §8 P2: "LASA second tap from the interim edit-distance rule"):
 * two edits for a name of seven letters or more, one for four to six, none below four — DECIDED,
 * because at two edits every three-letter brand is a look-alike of every other.
 */
export const lookalikeDistance = (name: string): number => (name.length >= 7 ? 2 : name.length >= 4 ? 1 : 0);

/** The name a row is CALLED: the brand before its bracket, or a generic's words before its strength. */
export function headOf(name: string): string {
  const lower = name.toLowerCase();
  const bracket = lower.indexOf(" (");
  const digit = lower.search(/\s\d/);
  const cut = [bracket, digit].filter((x) => x > 0);
  return (cut.length === 0 ? lower : lower.slice(0, Math.min(...cut))).trim();
}

const callNames = (row: Pick<AliasCandidateRow, "name" | "salts">): string[] => [headOf(row.name), ...row.salts];

export type RuleInput = {
  reading: TermReading;
  target: AliasCandidateRow;
  /** The wide candidate pool: the target's other strengths and the names around it. */
  pool: readonly AliasCandidateRow[];
  lasa: readonly LasaPair[];
  /** The chooser's belief in each OTHER shown product that is a different composition, 0..1. */
  rivalShares: readonly number[];
  chooserModel: string | null;
  reviewerModel: string | null;
};

/**
 * The checks no model is asked about. `result` is 'pass' or the FIRST rule that refused, in the
 * order they matter. `lasaGuard` is the second-tap flag: the term names its target exactly but the
 * target has a look-alike, so a screen that ever offers this alias must ask before using it.
 */
export function ruleCheck(input: RuleInput): { result: "pass" | AliasRuleCode; lasaGuard: boolean } {
  const { reading, target, pool } = input;
  if (isControlled(target)) return { result: "controlled_drug", lasaGuard: false };
  if (strengthAgrees(reading.numbers, target.name) === false) return { result: "strength_mismatch", lasaGuard: false };
  const targetForm = formClassOf(target.form);
  if (reading.form !== null && !formAgrees(reading.form, targetForm)) return { result: "form_mismatch", lasaGuard: false };

  const sameSalts = (r: AliasCandidateRow): boolean => r.salts.join("+") === target.salts.join("+");
  if (reading.numbers.length === 0) {
    /* No strength was said: an alias to ONE strength is a guess whenever the catalogue holds another. */
    const mine = strengthKey(strengthsInName(target.name));
    if (pool.some((r) => sameSalts(r) && formClassOf(r.form) === targetForm && strengthKey(strengthsInName(r.name)) !== mine)) return { result: "strength_unstated", lasaGuard: false };
  }

  const words = reading.words;
  const exact = callNames(target).some((n) => n === words || n.startsWith(`${words} `));
  const mine = exact ? 0 : Math.min(...callNames(target).map((n) => editDistance(words, n)));
  const others = pool.filter((r) => !sameSalts(r));
  const line = lookalikeDistance(words);
  if (!exact) {
    /* A misspelt or shortened name that sits as near another medicine as its target is not an alias of either. */
    if (others.some((r) => callNames(r).some((n) => { const d = editDistance(words, n); return d <= line && d <= mine; }))) return { result: "lookalike_conflict", lasaGuard: false };
    if (lasaPartner(input.lasa, callNames(target)) !== null) return { result: "lookalike_conflict", lasaGuard: false };
  }
  if (input.rivalShares.some((s) => s > SECOND_TARGET_SHARE)) return { result: "multiple_targets", lasaGuard: false };
  /* Two models agreeing means two DIFFERENT models (decision 0051: "two independent models"). */
  if (input.chooserModel !== null && input.chooserModel === input.reviewerModel) return { result: "same_model", lasaGuard: false };

  const head = headOf(target.name);
  const lasaGuard = lasaPartner(input.lasa, callNames(target)) !== null
    || others.some((r) => { const h = headOf(r.name); return h !== head && editDistance(head, h) <= lookalikeDistance(head); });
  return { result: "pass", lasaGuard };
}

// ─────────────────────────────────────────── trust by use ───────────────────────────────────────────

export type AliasUse = {
  distinctDoctors: number;
  /** Taps per target medicine for this term — more than one key means doctors used it for different things. */
  tapsByTarget: Readonly<Record<string, number>>;
  /** Taps after which the doctor changed the line to a DIFFERENT moiety set. */
  editedToAnotherMoiety: number;
  /** The target is Schedule H1 / X or NDPS today (a flag can arrive after the alias did). */
  controlled: boolean;
};
export type TrustVerdict = { trusted: boolean; why: "earned" | "controlled_drug" | "few_doctors" | "few_taps" | "composition_disagreement" | "second_target" };

export const TRUST_MIN_DOCTORS = 3;
export const TRUST_MIN_TAPS = 10;

/**
 * Decision 0050: an alias is TRUSTED (ranked first) only by composition-agreeing use by several
 * doctors — at least 3 different doctors and 10 taps, no tap later edited to a different moiety
 * set, never when a second target holds more than 20% of its taps, never a controlled medicine.
 * Pure, and NOTHING CALLS IT YET: this slice counts no taps.
 */
export function trustByUse(use: AliasUse): TrustVerdict {
  if (use.controlled) return { trusted: false, why: "controlled_drug" };
  const taps = Object.values(use.tapsByTarget).filter((n) => n > 0).sort((a, b) => b - a);
  const total = taps.reduce((a, n) => a + n, 0);
  const second = taps[1] ?? 0;
  if (total > 0 && second / total > SECOND_TARGET_SHARE) return { trusted: false, why: "second_target" };
  if (use.editedToAnotherMoiety > 0) return { trusted: false, why: "composition_disagreement" };
  if (use.distinctDoctors < TRUST_MIN_DOCTORS) return { trusted: false, why: "few_doctors" };
  if (total < TRUST_MIN_TAPS) return { trusted: false, why: "few_taps" };
  return { trusted: true, why: "earned" };
}

// ─────────────────────────────────────────── the pipeline ───────────────────────────────────────────

export type AliasDeps = {
  /** The kill switch (`ALIAS_PIPELINE_ENABLED`). False: nothing below runs. */
  enabled: boolean;
  /** `formulary.aliasCandidatePool`, bound to a database by the caller. */
  candidates: (words: string, numbers: string[]) => Promise<AliasCandidateRow[]>;
  lasa: () => Promise<readonly LasaPair[]>;
  chooser: ChoiceClient | null;
  reviewer: (ChoiceClient & PredicateClient) | null;
  /** `ALIAS_CHOOSER_MIN_CONFIDENCE`, default 0.6. */
  chooserLine: number;
  /** `ALIAS_REVIEWER_MIN_PROBABILITY`, default 0.9: yes at or above it, no at or below 1 − it, else unsure. */
  reviewerLine: number;
};

export type AliasProposal =
  | { outcome: "off" }
  | {
    outcome: "ran";
    term: string;
    state: "proposed" | "suggestion";
    /** The chooser's pick, kept on a refused row too — it is what a later retry is compared with. */
    medicineId: string | null;
    refusal: AliasRefusal | null;
    ruleResult: AliasRuleResult;
    lasaGuard: boolean;
    chooser: { model: string; confidence: number } | null;
    reviewer: { model: string; answer: ReviewerAnswer; probability: number; reasonCode: AliasReasonCode } | null;
    /** What the chooser was shown, in order — catalogue rows, for the log and the evaluation. */
    shown: AliasCandidateRow[];
  };

/** The few a chooser sees: a strength that agrees first, then exact names, a form that agrees, nearness; one row per product. */
export function shownCandidates(reading: TermReading, pool: readonly AliasCandidateRow[], limit = ALIAS_SHOWN): AliasCandidateRow[] {
  const score = (r: AliasCandidateRow): number[] => [
    strengthAgrees(reading.numbers, r.name) === true ? 1 : 0,
    r.tier,
    reading.form !== null && formAgrees(reading.form, formClassOf(r.form)) ? 1 : 0,
    r.similarity,
    -r.salts.length, // "amlodipine 5" is the plain medicine before any of its combinations
    r.generic ? 1 : 0,
  ];
  const ranked = [...pool].map((r, i) => ({ r, s: score(r), i })).sort((a, b) => {
    for (let k = 0; k < a.s.length; k += 1) { const d = (b.s[k] as number) - (a.s[k] as number); if (d !== 0) return d; }
    return a.i - b.i;
  });
  const seen = new Set<string>();
  const out: AliasCandidateRow[] = [];
  for (const { r } of ranked) {
    const key = compositionKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

const describe = (r: AliasCandidateRow): string => `${r.salts.join(" + ")} · ${strengthsInName(r.name).map((s) => `${trimNumber(s.value)} ${s.unit}`).join(" + ")} · ${r.form.toLowerCase()}`;

const CHOOSER_INSTRUCTIONS = "`term` is how a doctor in India typed or said the name of a medicine: a brand nickname, an abbreviation, a strength spoken aloud, or a misspelling. `read_as` is the same term with spoken numbers written as digits. Choose the ONE catalogue product the term means. Choose `none` when it is not a medicine, when none of the products is what it means, or when it could mean more than one of them because it does not say which strength or form.";
const REVIEWER_INSTRUCTIONS = "`term` is how a doctor in India typed or said the name of a medicine (`read_as` is the same with spoken numbers as digits). True only if the term means exactly `product` — that medicine, that strength and that form — and not any of `other_candidates`. False if it means something else, is not a medicine, or leaves the strength or the form open.";
const REASON_INSTRUCTIONS = "A doctor's `term` was matched to `product`. Which ONE of these best describes that match?";
const REASONS: Record<AliasReasonCode, string> = {
  name_match: "the term is the product's own generic or brand name, perhaps misspelt",
  strength_match: "the name and the strength written in the term are both the product's",
  brand_nickname: "the term is a common short name or nickname doctors use for this brand",
  ambiguous_strength: "the term does not say which strength, and the medicine comes in several",
  ambiguous_form: "the term does not say which form (tablet, syrup, injection), and it matters",
  lookalike_risk: "the term is as close to a different medicine's name as to this one",
  not_a_medicine: "the term is not the name of a medicine at all",
};

/**
 * One term, start to finish. Never throws for a model that is down or unsure: that is a 'proposed'
 * row with the reason, retried when a later run asks again.
 */
export async function proposeAlias(deps: AliasDeps, rawTerm: string): Promise<AliasProposal> {
  if (!deps.enabled) return { outcome: "off" };
  const term = normaliseTerm(rawTerm);
  const refused = (refusal: AliasRefusal, over: Partial<Extract<AliasProposal, { outcome: "ran" }>> = {}): AliasProposal => ({
    outcome: "ran", term, state: "proposed", medicineId: null, refusal, ruleResult: "not_run", lasaGuard: false, chooser: null, reviewer: null, shown: [], ...over,
  });

  /*
    THE TERM IS REFUSED, NOT MASKED, WHEN IT CARRIES AN IDENTIFIER. A medicine's name has no phone
    number, UHID or visit number in it; a term that does is somebody's sentence, and a placeholder
    in its place would still be an alias row keyed on a patient's text.
  */
  if (maskQuestion(term).masked !== term) return refused("identifier_in_term");
  try { assertNoIdentifiers(term); } catch (e) { if (e instanceof IdentifierLeak) return refused("identifier_in_term"); throw e; }

  const reading = readTerm(term);
  const pool = reading.words.length < 2 ? [] : await deps.candidates(reading.words, reading.numbers.map((n) => trimNumber(n.value)));
  const shown = shownCandidates(reading, pool);
  if (shown.length === 0) return refused("no_candidates");
  if (deps.chooser === null) return refused("chooser_unavailable", { shown });

  const state: Record<string, string> = { term, read_as: reading.digits };
  const keyOf = (i: number): string => `c${String(i + 1)}`;
  const options: Record<string, unknown> = Object.fromEntries(shown.map((r, i) => [keyOf(i), r.name]));
  options.none = "none of these, not a medicine, or more than one of these";

  let picked: ChoiceAnswer;
  let chooserModel: string;
  try {
    const out = await deps.chooser.choose({ state, questions: { product: { instructions: CHOOSER_INSTRUCTIONS, options } } });
    const a = out.answers.product;
    if (a === undefined || !Object.hasOwn(options, a.choice)) return refused("chooser_unavailable", { shown });
    picked = a; chooserModel = out.model;
  } catch {
    return refused("chooser_unavailable", { shown });
  }
  const chooser = { model: chooserModel, confidence: picked.confidence };
  const index = shown.findIndex((_, i) => keyOf(i) === picked.choice);
  const target = shown[index];
  if (target === undefined) return refused("chooser_none", { shown, chooser });

  const rivals = shown.filter((r, i) => i !== index && compositionKey(r) !== compositionKey(target));
  const rivalShares = shown.map((r, i) => (i !== index && compositionKey(r) !== compositionKey(target) ? (picked.probabilities[keyOf(i)] ?? 0) : 0));
  const base = { shown, chooser, medicineId: target.id };

  if (deps.reviewer === null) return refused("reviewer_unavailable", base);
  let reviewer: { model: string; answer: ReviewerAnswer; probability: number; reasonCode: AliasReasonCode };
  try {
    const reviewState = { ...state, product: `${target.name} (${describe(target)})`, other_candidates: rivals.length === 0 ? "none" : rivals.map((r) => r.name).join("; ") };
    const verdict = await deps.reviewer.predicate({ state: reviewState, instructions: REVIEWER_INSTRUCTIONS });
    const why = await deps.reviewer.choose({ state: reviewState, questions: { reason: { instructions: REASON_INSTRUCTIONS, options: REASONS } } });
    const code = why.answers.reason?.choice as AliasReasonCode | undefined;
    if (code === undefined || !ALIAS_REASON_CODES.includes(code)) return refused("reviewer_unavailable", base);
    const p = verdict.probability;
    let answer: ReviewerAnswer = p >= deps.reviewerLine ? "yes" : p <= 1 - deps.reviewerLine ? "no" : "unsure";
    if (answer === "yes" && REFUSING_REASONS.includes(code)) answer = "unsure";
    reviewer = { model: verdict.model, answer, probability: p, reasonCode: code };
  } catch {
    return refused("reviewer_unavailable", base);
  }

  const rules = ruleCheck({ reading, target, pool, lasa: await deps.lasa(), rivalShares, chooserModel: chooser.model, reviewerModel: reviewer.model });
  const refusal: AliasRefusal | null =
    chooser.confidence < deps.chooserLine ? "chooser_below_line"
      : reviewer.answer === "no" ? "reviewer_no"
        : reviewer.answer === "unsure" ? "reviewer_unsure"
          : rules.result !== "pass" ? rules.result
            : null;
  return {
    outcome: "ran", term, state: refusal === null ? "suggestion" : "proposed", medicineId: target.id, refusal,
    ruleResult: rules.result, lasaGuard: rules.result === "pass" && rules.lasaGuard, chooser, reviewer, shown,
  };
}
