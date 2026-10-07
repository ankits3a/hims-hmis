/**
 * THE PRESCRIPTION LINE, MADE COUNTABLE (decision 0050, phase P0 — owner 2026-10-07: "start the
 * groundwork (P0) now").
 *
 * A doctor's own pattern can only be counted when "1 tab", "1 Tab" and "one tablet" are one thing and
 * "1-0-1", "bd" and "twice daily" are one thing. This file is the ONE definition every writer of a
 * prescription line reads — the web consult, the desk scribe, the phone, sets and repeat-last — and
 * the one the server uses to write the countable copy of an issued line (`cds_rx_lines`).
 *
 * PURE: no imports, no I/O. The phone reads it by path (metro.config.js), the web and the server
 * through `@hmis/contracts`. It decides nothing clinical: no dose is ever produced here, only read.
 */

/** The closed set a line's "how often" is one of. `other` keeps whatever was typed beside it. */
export const RX_FREQUENCIES = ["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT"] as const;
export type RxFrequency = typeof RX_FREQUENCIES[number] | "other";

/** `1-0-1` is how a prescription is said aloud in an Indian OPD; `BD` is what this system stores. */
export const RX_FREQUENCY_NOTATION: Record<typeof RX_FREQUENCIES[number], string | null> = {
  OD: "1-0-0", BD: "1-0-1", TDS: "1-1-1", QID: "1-1-1-1", HS: "0-0-1", SOS: null, STAT: null,
};

/**
 * What was written, read as one of the closed set. An unrecognised text is `other` — never a guess.
 * (Moved here from the server's `cds/rx.ts`, which re-exports it; the body is unchanged.)
 */
export function frequencyOf(sig: string): RxFrequency {
  const s = sig.toLowerCase();
  /* The Indian slip's own notation first — "1-0-1" is read aloud as morning-noon-night. Count the
     non-zero slots; that is the frequency, whatever words follow. */
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

/**
 * What a typing desk should keep in the field: the closed code when the text is plainly one of them
 * ("1-0-1", "bd", "twice daily" → "BD"), and the text exactly as typed otherwise. "0-0-1" alone is
 * read as HS — the one notation `frequencyOf` leaves at OD because a slip may mean a morning dose.
 */
export function snapFrequency(typed: string): string {
  const raw = typed.trim();
  if (raw === "") return "";
  if (/^0\s*-\s*0\s*-\s*1$/.test(raw)) return "HS";
  /* Only a text that is NOTHING BUT a frequency snaps; "BD for 3 days then OD" is the doctor's own. */
  const bare = /^(\d\s*-\s*\d\s*-\s*\d(\s*-\s*\d)?|od|bd|bid|tds|tid|qid|hs|sos|stat|once daily|twice daily|thrice daily|at night|bedtime|as needed)$/i;
  if (!bare.test(raw)) return raw;
  if (/^thrice daily$/i.test(raw)) return "TDS";
  const f = frequencyOf(raw);
  return f === "other" ? raw : f;
}

// ——— the dose, read into an amount and a unit ———

export const DOSE_UNITS = ["tab", "cap", "ml", "mg", "g", "mcg", "iu", "unit", "drop", "puff", "sachet", "amp", "vial", "respule", "tsp"] as const;
export type DoseUnit = typeof DOSE_UNITS[number];
export type ParsedDose = { amount: number; unit: DoseUnit };

const UNIT_WORDS: [RegExp, DoseUnit][] = [
  [/^(tab|tabs|tablet|tablets|tb)$/, "tab"],
  [/^(cap|caps|capsule|capsules)$/, "cap"],
  [/^(ml|mls|millilitre|millilitres|milliliter|milliliters)$/, "ml"],
  [/^(mg|mgs|milligram|milligrams)$/, "mg"],
  [/^(g|gm|gms|gram|grams)$/, "g"],
  [/^(mcg|µg|microgram|micrograms)$/, "mcg"],
  [/^(iu)$/, "iu"],
  [/^(u|unit|units)$/, "unit"],
  [/^(drop|drops|gtt|gtts)$/, "drop"],
  [/^(puff|puffs)$/, "puff"],
  [/^(sachet|sachets)$/, "sachet"],
  [/^(amp|amps|ampoule|ampoules)$/, "amp"],
  [/^(vial|vials)$/, "vial"],
  [/^(respule|respules)$/, "respule"],
  [/^(tsp|teaspoon|teaspoons|teaspoonful)$/, "tsp"],
];
const WORD_NUMBERS: Record<string, number> = { half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };

function amountOf(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "½") return 0.5;
  if (t === "¼") return 0.25;
  if (t === "¾") return 0.75;
  const withHalf = /^(\d+)\s*½$/.exec(t);
  if (withHalf !== null) return Number(withHalf[1]) + 0.5;
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (frac !== null) {
    const d = Number(frac[2]);
    return d === 0 ? null : Number(frac[1]) / d;
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return WORD_NUMBERS[t] ?? null;
}

/**
 * "1 tab", "1 Tab", "one tablet", "½ tab", "5ml", "2 puffs" → an amount and a unit. Anything else is
 * NOT PARSED and returns null: a range ("1-2 tab"), a compound ("5 ml (250 mg)"), a bare number, an
 * instruction ("apply thin layer"), a refusal the regimen book wrote into the field. The raw string
 * is always kept beside it by the caller; null means "counted as written", never "no dose".
 */
export function parseDose(raw: string): ParsedDose | null {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (s === "" || s.length > 24) return null;
  const m = /^(½|¼|¾|\d+\s*½|\d+\s*\/\s*\d+|\d+(?:\.\d+)?|[a-z]+)\s*([a-zµ]+)$/.exec(s);
  if (m === null) return null;
  const amount = amountOf(m[1]!);
  if (amount === null || !(amount > 0) || amount > 100000) return null;
  const word = m[2]!;
  const unit = UNIT_WORDS.find(([re]) => re.test(word))?.[1];
  return unit === undefined ? null : { amount, unit };
}

/** One spelling for the same dose, for counting: "1 tab", "0.5 tab", "5 ml". Null when it was not parsed. */
export function doseKey(raw: string): string | null {
  const p = parseDose(raw);
  return p === null ? null : `${String(p.amount)} ${p.unit}`;
}

// ——— where a line (or a diagnosis) came from ———

/**
 * `typed` by hand · picked from `search` · `suggested` by the system and tapped · offered after a
 * `voice` note · from a `set` · `repeat`ed from the last prescription · typed by the desk from the
 * doctor's `paper`. Audit and learning only — no check reads it and no print shows it.
 */
export const LINE_SOURCES = ["typed", "search", "suggested", "voice", "set", "repeat", "paper"] as const;
export type RxLineSource = typeof LINE_SOURCES[number];
/** A committed diagnosis has the same origins, less the two that are a prescription's alone. */
export const DX_SOURCES = ["typed", "search", "suggested", "voice", "paper"] as const;
export type DxSource = typeof DX_SOURCES[number];
/** Evidence that the system put in front of the doctor, as against what the doctor went and found. */
export function fromSuggestion(source: string | null | undefined): boolean {
  return source === "suggested" || source === "voice" || source === "set" || source === "repeat";
}

// ——— the keys the counting reads ———

/** A diagnosis as a counting key: the ICD-10 three-character category when coded, else the words lower-cased. */
export function dxKeyOf(icd10Code: string | null | undefined, text: string | null | undefined): string | null {
  const code = (icd10Code ?? "").trim().toUpperCase();
  if (/^[A-Z]\d{2}/.test(code)) return `dx:${code.slice(0, 3)}`;
  const words = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return words === "" ? null : `tx:${words.slice(0, 120)}`;
}

// ——— children: no dose is suggested (decision 0009; owner 2026-10-07) ———

export type Band = "adult" | "pediatric";
/** The server's `bandFor`, restated for the screens: under 40 kg, or under 12 years when no weight is charted. */
export function bandOf(p: { ageYears: number | null; weightKg: number | null }): Band {
  if (p.weightKg !== null) return p.weightKg < 40 ? "pediatric" : "adult";
  if (p.ageYears !== null && p.ageYears < 12) return "pediatric";
  return "adult";
}

/**
 * A line the SYSTEM is putting in front of the doctor for a child — from a set, from the last
 * prescription, from a suggestion — arrives with the medicine and NO dose, frequency or days: a dose
 * a doctor gave one child is not evidence for another (owner 2026-10-07: "yes on 'no children's doses
 * in the first version'"). What the doctor then types is the doctor's own.
 */
export function withoutDoseForChild<L extends { dose: string; frequency: string; durationDays: number | null }>(lines: readonly L[], band: Band): L[] {
  if (band !== "pediatric") return [...lines];
  return lines.map((l) => ({ ...l, dose: "", frequency: "", durationDays: null }));
}
