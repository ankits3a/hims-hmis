import { and, gte, inArray, notInArray } from "drizzle-orm";
import { istDayString, istDayWindow } from "../approvals/cumulative";
import { opdAppointments, opdEncounters } from "../db/schema/opd";
import { patients } from "../db/schema/patients";
import { normalizeForSearch } from "../search/normalize";
import { IdentifierLeak, maskQuestion } from "./mask";
import { cueWords } from "./phrasebook";
import type { Db } from "../db/client";
import type { MaskedQuestion } from "./mask";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.6 — NAME-AWARE MASKING: THE NAMES THE SERVER KNOWS, MASKED BEFORE ANY MODEL SEES A QUESTION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `mask.ts` finds identifier SHAPES, and a name has none. On the web the screen supplies the names it
 * displays (`terms`); the phone has no such screen, so "Ramesh ka bill" would have reached the
 * chooser as typed. Spec: /opt/hmis-context/SPEC-copilot-name-mask-2026-10-11.md (owner yes 2026-10-11).
 *
 * THE LIST IS HOSPITAL-WIDE, not "patients this user can see": over-masking costs a little routing,
 * under-masking costs a patient, and a confidential patient's REAL name must be masked even for a
 * clerk who only ever sees the alias. Per patient: name, alias, father/husband name (kin identifies).
 *
 * READ FRESH ON EVERY ASK — no cross-request cache, so a patient registered ten seconds ago is
 * covered. Three indexed reads (migration: service_date and created_at indexes), a 300 ms ceiling
 * and a 20,000-name cap; any failure means NO index, and no index means phrasebook-only.
 *
 * THE SEAM (for the eval harness and tests): `CopilotNameSource` + `COPILOT_NAME_SOURCE`. The
 * controller takes an optional provider under that token and falls back to `loadDayNames`; a pure
 * caller uses `maskForAsk(question, terms, buildNameIndex(names))`, with `[]` for no names.
 */

export type NameIndex = {
  /** Folded whole names ("ramesh kumar"), any length. */
  full: Set<string>;
  /** Folded name parts of three letters or more. */
  parts: Set<string>;
  /** Parts by length, for the one-edit near-match. */
  partsByLen: Map<number, string[]>;
  /** The longest name in words (capped), so the finder knows how far to look ahead. */
  maxWords: number;
};

export type NameDays = { visits: string[]; appointments: string[]; registeredSince: Date };
export type CopilotNameSource = (db: Db, days: NameDays) => Promise<string[]>;
export const COPILOT_NAME_SOURCE = Symbol("COPILOT_NAME_SOURCE");
export const NAME_LOAD_TIMEOUT_MS = 300;
export const NAME_CAP = 20_000;

const MIN_PART = 3;
const MIN_NEAR = 5;
const MAX_WORDS = 6;
const WORD_RE = /[\p{L}\p{M}]+/gu;

/**
 * Words that are never a name on their own: every word the phrasebook's cues are built from, and
 * the connective tissue of a Hinglish counter question. Inside a full name they still mask
 * ("Kal Singh"); alone they are the question ("kal aana").
 */
const FUNCTION_WORDS = [
  "aaj", "kal", "abhi", "kab", "kya", "kaun", "kitna", "kitni", "kitne", "hai", "hain", "nahi", "nahin", "haan",
  "aur", "wala", "wali", "wale", "mein", "par", "tak", "bhi", "liya", "diya", "gaya", "gaye", "gayi", "aaya", "aaye",
  "aayi", "dekha", "dekhi", "dekhe", "dekho", "kaha", "kahan", "kyun", "kaise", "kitna", "paisa", "paise", "baaki",
  "bill", "line", "number", "token", "doctor", "patient", "wait", "time", "bhai", "behen", "mata", "pita", "beta",
  "beti", "baba", "amma", "papa", "mummy", "sir", "madam", "mam", "the", "and", "has", "been", "seen", "was", "who",
  "how", "what", "when", "where", "which", "today", "yesterday", "tomorrow", "please", "aana", "jana", "karo", "karna",
  "baitho", "andar", "bahar", "ward", "room", "bed", "test", "report", "dawa", "dawai", "medicine",
];

/** Fold a name or a word: script, case, diacritics, then doubled vowels (Aasha = Asha = आशा). */
export function foldName(s: string): string {
  return normalizeForSearch(s.normalize("NFC")).replace(/a{2,}/g, "a").replace(/e{2,}|i{2,}/g, "i").replace(/o{2,}|u{2,}/g, "u");
}

let stopCache: { words: Set<string>; prefixes: string[] } | null = null;
function stopWords(): { words: Set<string>; prefixes: string[] } {
  if (stopCache === null) {
    const words = new Set([...cueWords(), ...FUNCTION_WORDS].map(foldName).filter((w) => w !== ""));
    stopCache = { words, prefixes: [...words].filter((w) => w.length >= 4) };
  }
  return stopCache;
}

export function buildNameIndex(names: readonly string[]): NameIndex {
  const full = new Set<string>();
  const parts = new Set<string>();
  let maxWords = 1;
  for (const raw of names) {
    const words = foldedWords(raw);
    if (words.length === 0) continue;
    full.add(words.join(" "));
    maxWords = Math.max(maxWords, Math.min(words.length, MAX_WORDS));
    for (const w of words) if ([...w].length >= MIN_PART) parts.add(w);
  }
  const partsByLen = new Map<number, string[]>();
  for (const p of parts) {
    const list = partsByLen.get(p.length) ?? [];
    list.push(p);
    partsByLen.set(p.length, list);
  }
  return { full, parts, partsByLen, maxWords };
}

function foldedWords(s: string): string[] {
  return [...s.matchAll(WORD_RE)].map((m) => foldName(m[0])).filter((w) => w !== "");
}

type Token = { text: string; start: number; end: number; fold: string };
function tokens(s: string): Token[] {
  return [...s.matchAll(WORD_RE)].map((m) => ({
    text: m[0], start: m.index, end: m.index + m[0].length, fold: foldName(m[0]),
  }));
}

/** "Rameshji" / "रमेशजी" is Ramesh: the honorific written onto the name. */
function withoutJi(fold: string): string | null {
  return fold.length > MIN_PART + 2 && fold.endsWith("ji") ? fold.slice(0, -2) : null;
}

function isNamePart(fold: string, index: NameIndex, stop: Set<string>): boolean {
  if (stop.has(fold)) return false;
  return index.parts.has(fold) || ([...fold].length >= 2 && index.full.has(fold));
}

/** Levenshtein distance ≤ 1, without building a matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function isNearName(fold: string, index: NameIndex): boolean {
  if (fold.length < MIN_NEAR) return false;
  const stop = stopWords();
  if (stop.words.has(fold)) return false;
  /*
    A near-spelling of an ordinary word is that word: "dekha" is one edit from "Rekha", and it starts
    with the cue "dekh". Neither may cost the question its route.
  */
  if (stop.prefixes.some((p) => fold.startsWith(p))) return false;
  for (const w of stop.words) if (withinOneEdit(fold, w)) return false;
  for (const len of [fold.length - 1, fold.length, fold.length + 1]) {
    for (const p of index.partsByLen.get(len) ?? []) if (withinOneEdit(fold, p)) return true;
  }
  return false;
}

/**
 * The spans of `question` that are names of today's patients, as typed. `near` is true when a word
 * was one edit from a name part without being one: that word is a span too, and the ask must not
 * reach a model (spec item 4).
 */
export function findNameSpans(question: string, index: NameIndex): { spans: string[]; near: boolean } {
  const stop = stopWords().words;
  const toks = tokens(question);
  const spans: string[] = [];
  let near = false;
  let i = 0;
  outer: while (i < toks.length) {
    for (let w = Math.min(index.maxWords, toks.length - i); w >= 2; w -= 1) {
      const key = toks.slice(i, i + w).map((t) => t.fold).join(" ");
      if (index.full.has(key)) {
        spans.push(question.slice(toks[i]!.start, toks[i + w - 1]!.end));
        i += w;
        continue outer;
      }
    }
    const t = toks[i]!;
    const bare = withoutJi(t.fold);
    if (isNamePart(t.fold, index, stop) || (bare !== null && isNamePart(bare, index, stop))) {
      spans.push(t.text);
    } else if (isNearName(t.fold, index)) {
      spans.push(t.text);
      near = true;
    }
    i += 1;
  }
  return { spans, near };
}

/**
 * THE SECOND WITNESS, beside `assertNoIdentifiers` and for the same reason: a masker cannot be its
 * own witness. Its own loop over the exact string about to go on the wire; throws `IdentifierLeak`
 * (length only, never the text) if a name of today's patients is still standing.
 */
export function assertNoNames(text: string, index: NameIndex): void {
  const stop = stopWords().words;
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    const bare = withoutJi(t.fold);
    if (isNamePart(t.fold, index, stop) || (bare !== null && isNamePart(bare, index, stop))) {
      throw new IdentifierLeak(t.text);
    }
    let key = t.fold;
    for (let j = i + 1; j < Math.min(toks.length, i + index.maxWords); j += 1) {
      key += ` ${toks[j]!.fold}`;
      if (index.full.has(key)) throw new IdentifierLeak(key);
    }
  }
}

/**
 * The days whose patients are "in the hospital today": visits today and yesterday (a night queue
 * spills past midnight) and on the date the screen asked about; appointments today and on that
 * date; and everyone registered since IST midnight. Explicit `now`, never the clock inside.
 */
export function nameDays(now: Date, serviceDate: string): NameDays {
  const today = istDayString(now);
  const yesterday = istDayString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return {
    visits: [...new Set([today, yesterday, serviceDate])],
    appointments: [...new Set([today, serviceDate])],
    registeredSince: istDayWindow(now).start,
  };
}

const NAME_COLUMNS = { name: patients.name, alias: patients.alias, kin: patients.fatherHusbandName };

/** The three reads behind `loadDayNames`, exported so a test can EXPLAIN exactly these. */
export function dayNameQueries(db: Db, days: NameDays) {
  return {
    visits: db.select(NAME_COLUMNS).from(patients).where(inArray(
      patients.id,
      db.select({ id: opdEncounters.patientId }).from(opdEncounters).where(inArray(opdEncounters.serviceDate, days.visits)),
    )),
    appointments: db.select(NAME_COLUMNS).from(patients).where(inArray(
      patients.id,
      db.select({ id: opdAppointments.patientId }).from(opdAppointments).where(and(
        inArray(opdAppointments.serviceDate, days.appointments),
        notInArray(opdAppointments.status, ["cancelled", "rescheduled"]),
      )),
    )),
    registered: db.select(NAME_COLUMNS).from(patients).where(gte(patients.createdAt, days.registeredSince)),
  };
}

/** The default `CopilotNameSource`: every name, alias and kin name of the day's patients. */
export async function loadDayNames(db: Db, days: NameDays): Promise<string[]> {
  const q = dayNameQueries(db, days);
  const rows = (await Promise.all([q.visits, q.appointments, q.registered])).flat();
  const out = new Set<string>();
  for (const r of rows) for (const n of [r.name, r.alias, r.kin]) if (n !== null && n.trim() !== "") out.add(n.trim());
  return [...out];
}

/**
 * The day's index, or null — and null is the fail-closed answer: an error, a read slower than the
 * ceiling, or more names than the cap all mean this ask runs phrasebook-only.
 */
export async function nameIndexFor(
  source: CopilotNameSource,
  db: Db,
  days: NameDays,
  opts: { timeoutMs?: number; cap?: number } = {},
): Promise<NameIndex | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const names = await Promise.race([
      source(db, days),
      new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, opts.timeoutMs ?? NAME_LOAD_TIMEOUT_MS); }),
    ]);
    if (names === null || names.length > (opts.cap ?? NAME_CAP)) return null;
    return buildNameIndex(names);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type AskMask = MaskedQuestion & {
  /** Placeholders minted from SERVER names: never rehydrated into a tool subject (spec item 7). */
  nameSlots: string[];
  /** No index, or a near-spelling of a name: the floor may answer, no model is asked. */
  phrasebookOnly: boolean;
  names: NameIndex | null;
};

/**
 * One ask's mask: the screen's `terms` first, exactly as `maskQuestion` always did them, then the
 * server's names (whole-word), then identifier shapes — one placeholder numbering.
 */
export function maskForAsk(question: string, terms: readonly string[], names: NameIndex | null): AskMask {
  const found = names === null ? { spans: [], near: false } : findNameSpans(question, names);
  const { masked, slots } = maskQuestion(question, terms, { nameTerms: found.spans });
  const termKeys = new Set(terms.map((t) => t.trim().toLowerCase()));
  const spanKeys = new Set(found.spans.map((s) => s.trim().toLowerCase()));
  const nameSlots = Object.entries(slots)
    .filter(([, v]) => spanKeys.has(v.toLowerCase()) && !termKeys.has(v.toLowerCase()))
    .map(([k]) => k);
  return { masked, slots, nameSlots, phrasebookOnly: names === null || found.near, names };
}
