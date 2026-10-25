import { istDayStart } from "../../kernel/report/metrics";
import { ageInDaysIst } from "./ranges";
import type { SlipHeader } from "./slip-reader";

/**
 * ═══ SPEC #934 — WHICH REPORT A SLIP BELONGS TO: AN EXACT ID, OR A PERSON ═══
 *
 * "Never attach by guess" (rule 5, ingest D4). Our sample number or UHID typed on the analyser is the
 * primary path; name, age and gender only SUGGEST, as chips — never a percentage, the patient search's
 * design ruling — and staff confirm. These are the pure halves: reading the printed ID, age, gender
 * and name, and comparing them with a patient. `slips.ts` runs the queries.
 */
export type SlipIdKind = "sample_no" | "uhid" | "counter" | "none" | "unknown_id";
export type NameChip = "same" | "close" | "differs" | "unread";
export type AgeChip = "same" | "pm1" | "differs" | "unread";
export type GenderChip = "same" | "differs" | "unread";
export type TimeChip = "before_print" | "after_print" | null;
export type SlipChips = { name: NameChip; age: AgeChip; gender: GenderChip; time: TimeChip };
export type SlipDifference = "id" | "name" | "gender" | "age";

/** Upper case; spaces, `-` and `/` removed — `HMS 00000101 7` and `HMS-00000101-7` are one UHID. */
export function normaliseSlipId(s: string): string {
  return s.toUpperCase().replace(/[\s\-/]+/g, "");
}

/**
 * The ID the slip names: the Patient ID field, else the Sample ID field. A digits-only value is the
 * analyser's own counter and is never compared with a UHID or a sample number, so `0023` cannot match
 * the end of anything.
 */
export function slipIdOf(header: SlipHeader): { id: string; counter: boolean } | null {
  for (const raw of [header.patientId, header.sampleId]) {
    if (raw === null || raw.trim() === "") continue;
    const id = normaliseSlipId(raw);
    if (id === "") continue;
    return { id, counter: /^\d+$/.test(id) };
  }
  return null;
}

/** "34Y", "34 Yrs", "8 M", "20 D", "34" → a number and its unit; null when it does not read. */
export function parseSlipAge(s: string | null): { n: number; unit: "Y" | "M" | "D" } | null {
  if (s === null) return null;
  const m = /^\s*(\d{1,3})\s*(y|yr|yrs|year|years|m|mo|mon|mons|month|months|d|day|days)?\.?\s*$/i.exec(s);
  if (m === null) return null;
  const u = (m[2] ?? "y").toLowerCase();
  return { n: Number(m[1]), unit: u.startsWith("d") ? "D" : u.startsWith("m") ? "M" : "Y" };
}

export function parseSlipGender(s: string | null): "male" | "female" | null {
  const t = (s ?? "").trim().toLowerCase();
  if (t === "m" || t === "male") return "male";
  if (t === "f" || t === "female") return "female";
  return null;
}

/** Age on the slip against the patient's age at collection: years, or months / days for an infant. */
export function ageChip(printed: string | null, dob: string | null, collectedAt: Date): AgeChip {
  const age = parseSlipAge(printed);
  if (age === null || dob === null) return "unread";
  const days = ageInDaysIst(dob, collectedAt);
  const actual = age.unit === "Y" ? Math.floor(days / 365.25) : age.unit === "M" ? Math.floor(days / 30.4375) : days;
  const d = Math.abs(actual - age.n);
  return d === 0 ? "same" : d === 1 ? "pm1" : "differs";
}

export function genderChip(printed: string | null, administrativeGender: string): GenderChip {
  const g = parseSlipGender(printed);
  if (g === null) return "unread";
  return g === administrativeGender ? "same" : "differs";
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "smt", "shri", "sri", "kumari", "master", "baby", "bo", "so", "do", "wo", "dr"]);

/** Lower case; honorifics (mr, smt, b/o, s/o …), punctuation and digits removed. */
export function nameTokens(name: string): string[] {
  return name.toLowerCase()
    .replace(/\b([bsdw])\s*\/\s*o\b/g, "$1o")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "" && !HONORIFICS.has(t));
}

/** pg_trgm's `similarity()`, computed the way the extension computes it (padded word trigrams, Jaccard). */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x !== "")) {
      const p = `  ${w} `;
      for (let i = 0; i + 3 <= p.length; i += 1) out.add(p.slice(i, i + 3));
    }
    return out;
  };
  const x = grams(a), y = grams(b);
  if (x.size === 0 && y.size === 0) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both += 1;
  return both / (x.size + y.size - both);
}

/** Every slip token is an in-order prefix (or initial) of the patient's tokens: thermal printers cut names at 12–16 characters. */
function prefixOrInitials(slip: readonly string[], patient: readonly string[]): boolean {
  let j = 0;
  for (const t of slip) {
    while (j < patient.length && !patient[j]!.startsWith(t)) j += 1;
    if (j >= patient.length) return false;
    j += 1;
  }
  return slip.length > 0;
}

export function nameChip(printed: string | null, patientName: string): NameChip {
  if (printed === null || printed.trim() === "") return "unread";
  const s = nameTokens(printed), p = nameTokens(patientName);
  if (s.length === 0) return "unread";
  const same = s.length === p.length && [...new Set(s)].every((t) => p.includes(t)) && [...new Set(p)].every((t) => s.includes(t));
  if (same) return "same";
  if (trigramSimilarity(s.join(" "), p.join(" ")) >= 0.6 || prefixOrInitials(s, p)) return "close";
  return "differs";
}

/**
 * "collected before the slip printed", when the printed time reads. Accepts the common analyser
 * layouts (2026-10-21 11:20, 21/10/2026 11:20, 21-10-2026 11:20:05), read as IST.
 */
export function printedAtOf(s: string | null): Date | null {
  if (s === null) return null;
  const t = s.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m !== null) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
    if (m === null) return null;
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const day = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const ms = istDayStart(day).getTime() + ((Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0)) * 60 + Number(m[6] ?? 0)) * 1000;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export type SlipPatient = { name: string; administrativeGender: string; dob: string | null };

export function chipsFor(header: SlipHeader, p: SlipPatient, collectedAt: Date): SlipChips {
  const printed = printedAtOf(header.printedAt);
  return {
    name: nameChip(header.name, p.name),
    age: ageChip(header.age, p.dob, collectedAt),
    gender: genderChip(header.gender, p.administrativeGender),
    time: printed === null ? null : collectedAt.getTime() <= printed.getTime() ? "before_print" : "after_print",
  };
}

/** What the slip says that disagrees with this patient: a name neither same nor close, a gender, an age beyond ±1. */
export function differencesOf(c: SlipChips): SlipDifference[] {
  const out: SlipDifference[] = [];
  if (c.name === "differs") out.push("name");
  if (c.gender === "differs") out.push("gender");
  if (c.age === "differs") out.push("age");
  return out;
}

const SCORE = {
  name: { same: 3, close: 2, unread: 0, differs: -1 },
  age: { same: 2, pm1: 1, unread: 0, differs: -1 },
  gender: { same: 1, unread: 0, differs: -1 },
} as const;
export function chipStrength(c: SlipChips): number {
  return SCORE.name[c.name] + SCORE.age[c.age] + SCORE.gender[c.gender] + (c.time === "before_print" ? 0.5 : 0);
}

const nameOk = (c: SlipChips) => c.name === "same" || c.name === "close";
const twoOfThree = (c: SlipChips) => [nameOk(c), c.age === "same", c.gender === "same"].filter(Boolean).length >= 2;

/**
 * One candidate is pre-selected only when it ALONE has name same-or-close, the same age and the same
 * gender, and no other candidate has two of the three. Staff still tap Confirm.
 */
export function preselectIndex(chips: readonly SlipChips[]): number | null {
  const full = chips.map((c, i) => (nameOk(c) && c.age === "same" && c.gender === "same" ? i : -1)).filter((i) => i >= 0);
  if (full.length !== 1) return null;
  const only = full[0]!;
  return chips.some((c, i) => i !== only && twoOfThree(c)) ? null : only;
}
