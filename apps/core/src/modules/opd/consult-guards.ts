import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { LINE_SOURCES, newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { cdsDoctorPrefs, opdEncounters, opdLasaPairs, opdSuggestionEvents, opdTermMisses } from "../../kernel/db/schema";
import { medicinesByIds, saltsByIds, searchMedicinesForPrescribing } from "../formulary";
import type { PrescribingHit } from "../formulary";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PHONE CONSULT — THE GUARDS ROUND A SUGGESTION (decision 0049 and the independent review the
 * owner commissioned, 2026-10-07).
 *
 *   - Nothing is ever pre-selected: a suggestion is a row with a button. That is the screen's law;
 *     this file gives the row what it must SHOW — the strength, the form and the class — so the
 *     doctor is choosing a drug, not a word.
 *   - Look-alike / sound-alike names (`opd_lasa_pairs`) ride on the hit: the phone asks
 *     "Hydroxyzine — not Hydralazine?" and takes a second tap.
 *   - A word that matched nothing is logged — the TERM, its kind, where it was tried, who, when.
 *     No patient, no visit, no sentence. It feeds a later alias tool (a separate spec).
 *   - What became of a suggestion is counted: accepted / dismissed / written by hand.
 *
 * Matching itself is NOT changed here: exact, then the formulary's own trigram search. No alias
 * table, no embeddings (pgvector is not installed on any host).
 */

// ——— one script ———

const VOWELS: Record<string, string> = { "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e" };
const MATRAS: Record<string, string> = { "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e" };
const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
};
const NUKTA: Record<string, string> = { "क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f" };
const DIGITS = "०१२३४५६७८९";

/**
 * Devanagari → Roman, so there is ONE lexicon to match against and one script on the screen. The
 * speech model is asked for Roman already (`hintFor`); this is for the day it answers "बुखार"
 * anyway. Plain reading spelling, not a scholar's: बुखार → "bukhar", खांसी → "khansi". The
 * inherent "a" is dropped at the end of a word, which is how Hindi is said. Roman text, numbers
 * and punctuation pass through untouched; the doctor's own edit afterwards is kept as typed.
 */
export function romanise(text: string): string {
  if (!/[ऀ-ॿ]/.test(text)) return text;
  let out = "";
  const chars = [...text.normalize("NFC")];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const next = chars[i + 1];
    if (CONSONANTS[c] !== undefined) {
      let base = CONSONANTS[c];
      let j = i + 1;
      if (chars[j] === "़") { base = NUKTA[c] ?? base; j += 1; }
      const after = chars[j];
      if (after === "्") { out += base; i = j; continue; }
      if (after !== undefined && MATRAS[after] !== undefined) { out += base + MATRAS[after]; i = j; continue; }
      // The inherent vowel: said inside a word, silent at its end (except a word of one letter).
      const endOfWord = after === undefined || !/[ऀ-ॿ]/.test(after) || after === "।";
      const alone = out === "" || /[^a-z]$/i.test(out);
      out += endOfWord && !alone ? base : `${base}a`;
      i = j - 1;
      continue;
    }
    if (VOWELS[c] !== undefined) { out += VOWELS[c]; continue; }
    if (MATRAS[c] !== undefined) { out += MATRAS[c]; continue; }
    if (c === "ं" || c === "ँ") { out += next !== undefined && /[पफबभम]/.test(next) ? "m" : "n"; continue; }
    if (c === "ः") { out += "h"; continue; }
    if (c === "।") { out += "."; continue; }
    if (c === "्" || c === "़" || c === "ऽ") continue;
    const d = DIGITS.indexOf(c);
    if (d >= 0) { out += String(d); continue; }
    out += c;
  }
  // A sentence the model wrote in Devanagari starts with a capital here too.
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

// ——— look-alike / sound-alike ———

export type LasaPair = { a: string; b: string; reviewed: boolean };

export async function lasaPairs(db: Db): Promise<LasaPair[]> {
  const rows = await db.select().from(opdLasaPairs).where(eq(opdLasaPairs.active, true));
  return rows.map((r) => ({ a: r.nameA, b: r.nameB, reviewed: r.reviewedBy !== null }));
}

/** The name this one is confused with, or null. `names` are the medicine's own name and its moieties. */
export function lasaPartner(pairs: readonly LasaPair[], names: readonly string[]): string | null {
  const words = names.flatMap((n) => n.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 4);
  for (const p of pairs) {
    if (words.some((w) => w === p.a || w.startsWith(p.a))) return p.b;
    if (words.some((w) => w === p.b || w.startsWith(p.b))) return p.a;
  }
  return null;
}

// ——— what a suggestion row shows ———

const CLASS_LABEL: Record<string, string> = { ppi: "PPI", nsaid: "NSAID", arb: "ARB", ace_inhibitor: "ACE inhibitor", statin: "Statin" };
export function classLabel(drugClass: string | null): string | null {
  if (drugClass === null || drugClass.trim() === "") return null;
  return CLASS_LABEL[drugClass] ?? drugClass.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export type GuardedMedicineHit = PrescribingHit & {
  /** The moiety's class as the formulary records it ("PPI"), or null when none is recorded — never guessed. */
  drugClass: string | null;
  /** The look-alike name the phone must ask about before it takes this pick, or null. */
  lasa: string | null;
};

export async function guardHits(db: Db, hits: readonly PrescribingHit[]): Promise<GuardedMedicineHit[]> {
  if (hits.length === 0) return [];
  const meds = await medicinesByIds(db, hits.map((h) => h.id));
  const saltIds = [...new Set([...meds.values()].flatMap((m) => m.salts.map((s) => s.saltId)))];
  const salts = saltIds.length === 0 ? new Map<string, { drugClass: string | null }>() : await saltsByIds(db, saltIds.slice(0, 200));
  const pairs = await lasaPairs(db);
  return hits.map((h) => {
    const classes = [...new Set((meds.get(h.id)?.salts ?? []).map((s) => classLabel(salts.get(s.saltId)?.drugClass ?? null)).filter((c): c is string => c !== null))];
    return { ...h, drugClass: classes.length === 0 ? null : classes.join(" + "), lasa: lasaPartner(pairs, [h.name, ...h.salts]) };
  });
}

/** The phone's medicine search: the formulary's own search, each row carrying its class and its look-alike. */
export async function guardedMedicineSearch(db: Db, q: string, limit: number): Promise<GuardedMedicineHit[]> {
  /* The prescriber's search: the catalogue's answer, plus a learned nickname's medicine when the pipeline is on (`alias-store.ts`). */
  return guardHits(db, await searchMedicinesForPrescribing(db, q, limit));
}

// ——— the two logs ———

export const SIGNAL_KINDS = ["medicine", "test", "diagnosis", "complaint", "advice", "dose", "department", "alias"] as const;
/** What a "no match" can be about — the three the search boxes serve. */
export const MISS_KINDS = ["medicine", "test", "diagnosis"] as const;
export const SIGNAL_SOURCES = LINE_SOURCES;
/** `accepted` is a tap; `shown` is one row for the chips drawn together; `edited` is a tap the doctor then changed. */
export const SIGNAL_OUTCOMES = ["accepted", "dismissed", "manual", "shown", "edited"] as const;
export const SIGNAL_SURFACES = ["consult_web", "consult_phone", "scribe", "desk"] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];
export type Miss = { kind: typeof MISS_KINDS[number]; term: string; stage: "search" | "voice" };
/**
 * ONE SUGGESTION EVENT (decision 0050, P0). The first three fields are all the phone consult sent
 * (0048) and are still all a caller must send. The rest say WHICH suggestion, FOR what, on WHICH
 * visit — an encounter id, never a patient. `itemKey` and `contextKey` are keys (a medicine id, an
 * ICD code, a test code, `dx:J06`), kept short; they are not free text about a person.
 */
export type SuggestionSignal = {
  kind: SignalKind; source: typeof SIGNAL_SOURCES[number]; outcome: typeof SIGNAL_OUTCOMES[number];
  surface?: typeof SIGNAL_SURFACES[number] | undefined; encounterId?: string | undefined; contextKey?: string | undefined; itemKey?: string | undefined;
  rankShown?: number | undefined; items?: string[] | undefined; batchId?: string | undefined;
};

/** A term as it is logged: one line, trimmed, lower-case, at most 60 characters; null when there is nothing worth keeping. */
export function missTerm(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
  return t.length < 2 ? null : t;
}

export async function recordMisses(db: Db, userId: string, misses: readonly Miss[], now: Date = new Date()): Promise<number> {
  const rows = misses.slice(0, 20).map((m) => ({ ...m, term: missTerm(m.term) })).filter((m): m is Miss => m.term !== null)
    .map((m) => ({ id: newId(), kind: m.kind, term: m.term, stage: m.stage, userId, createdAt: now }));
  if (rows.length > 0) await db.insert(opdTermMisses).values(rows);
  return rows.length;
}

export async function recordSignals(
  db: Db, actor: Actor, input: { misses: readonly Miss[]; suggestions: readonly SuggestionSignal[] }, now: Date = new Date(),
): Promise<{ misses: number; suggestions: number }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a consultation's signals are a doctor's");
  const misses = await recordMisses(db, actor.id, input.misses, now);
  const list = input.suggestions.slice(0, 60);
  /* The doctor and department are READ from the visit, never taken from the caller. */
  const encIds = [...new Set(list.map((s) => s.encounterId).filter((x): x is string => x !== undefined))];
  const encs = encIds.length === 0 ? [] : await db.select({ id: opdEncounters.id, doctorId: opdEncounters.doctorId, departmentId: opdEncounters.departmentId })
    .from(opdEncounters).where(inArray(opdEncounters.id, encIds));
  const encById = new Map(encs.map((e) => [e.id, e]));
  const key = (k: string | undefined): string | null => (k === undefined ? null : k.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160) || null);
  const rows = list.map((s) => {
    const enc = s.encounterId === undefined ? undefined : encById.get(s.encounterId);
    return {
      id: newId(), userId: actor.id, kind: s.kind, source: s.source, outcome: s.outcome, createdAt: now,
      surface: s.surface ?? null, encounterId: enc?.id ?? null, doctorId: enc?.doctorId ?? null, departmentId: enc?.departmentId ?? null,
      contextKey: key(s.contextKey), itemKey: key(s.itemKey), rankShown: s.rankShown ?? null,
      items: s.items === undefined ? null : s.items.slice(0, 20).map((i) => key(i)).filter((i): i is string => i !== null),
      sourceLevel: null, batchId: s.batchId ?? null,
    };
  });
  /*
    A NICKNAME'S USE (decision 0051). A tap on a nickname's row is counted ONCE per visit — the same
    medicine picked twice for one prescription is one use — and only when it names a real visit. The
    rows are written first; what they MEAN for the nickname (trusted, demoted) is the caller's next
    step (`alias-use.ts` `applyAliasUse`, called by the route for each nickname the request named).
  */
  const aliasTaps = rows.filter((r) => r.kind === "alias" && r.outcome === "accepted");
  let keep = rows;
  if (aliasTaps.length > 0) {
    const had = await db.select({ itemKey: opdSuggestionEvents.itemKey, encounterId: opdSuggestionEvents.encounterId }).from(opdSuggestionEvents)
      .where(and(eq(opdSuggestionEvents.kind, "alias"), eq(opdSuggestionEvents.outcome, "accepted"),
        inArray(opdSuggestionEvents.itemKey, aliasTaps.map((r) => r.itemKey ?? "")), inArray(opdSuggestionEvents.encounterId, aliasTaps.map((r) => r.encounterId ?? ""))));
    const seen = new Set(had.map((h) => `${h.itemKey ?? ""}|${h.encounterId ?? ""}`));
    keep = rows.filter((r) => {
      if (r.kind !== "alias" || r.outcome !== "accepted") return true;
      const k = `${r.itemKey ?? ""}|${r.encounterId ?? ""}`;
      if (r.itemKey === null || r.encounterId === null || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (keep.length > 0) await db.insert(opdSuggestionEvents).values(keep);
  return { misses, suggestions: keep.length };
}

export type SignalsMeter = {
  /** The last 28 days. */
  suggestions: { source: string; accepted: number; dismissed: number; manual: number }[];
  misses: { kind: string; term: string; times: number; lastAt: string }[];
};

export async function signalsMeter(db: Db, now: Date = new Date()): Promise<SignalsMeter> {
  const since = new Date(now.getTime() - 28 * 24 * 3600 * 1000);
  const n = sql<number>`count(*)::int`;
  const ev = await db.select({ source: opdSuggestionEvents.source, outcome: opdSuggestionEvents.outcome, n }).from(opdSuggestionEvents)
    .where(gte(opdSuggestionEvents.createdAt, since)).groupBy(opdSuggestionEvents.source, opdSuggestionEvents.outcome);
  const by = new Map<string, { source: string; accepted: number; dismissed: number; manual: number }>();
  for (const r of ev) {
    const row = by.get(r.source) ?? { source: r.source, accepted: 0, dismissed: 0, manual: 0 };
    if (r.outcome === "accepted" || r.outcome === "dismissed" || r.outcome === "manual") row[r.outcome] += Number(r.n);
    by.set(r.source, row);
  }
  const last = sql<Date>`max(${opdTermMisses.createdAt})`;
  const ms = await db.select({ kind: opdTermMisses.kind, term: opdTermMisses.term, n, last }).from(opdTermMisses)
    .where(and(gte(opdTermMisses.createdAt, since))).groupBy(opdTermMisses.kind, opdTermMisses.term).orderBy(desc(n), opdTermMisses.term).limit(30);
  return {
    suggestions: [...by.values()].sort((a, b) => (a.source < b.source ? -1 : 1)),
    misses: ms.map((m) => ({ kind: m.kind, term: m.term, times: Number(m.n), lastAt: new Date(m.last).toISOString() })),
  };
}

// ——— the cross, counted (decision 0050, P0) ———

/**
 * "Hide after explicit × three times" (the plan's principle 5). DECIDED for P0: a cross counts for
 * ninety days — three of the plan's thirty-day half-lives — and three standing crosses hide the item.
 * The plan's graded form (score · max(0, 1 − d/3), d a decayed sum) is RANKING and arrives with P1;
 * it reads these same rows.
 */
export const HIDE_AFTER = 3;
export const DISMISS_COUNTS_FOR_DAYS = 90;

export type HiddenItem = { kind: string; contextKey: string | null; itemKey: string };

/**
 * WHAT THIS DOCTOR HAS CROSSED OFF ENOUGH TO STOP SEEING: for each (kind, context, item), the explicit
 * crosses in the last ninety days SINCE the doctor last took that item (a tap, or typing it by hand,
 * resets it); hidden at three. Not looking is not a cross: `shown` rows never count. Nothing is
 * deleted — a hidden item returns by itself when a cross ages out, and at once when the doctor types it.
 */
export async function hiddenSuggestions(db: Db, userId: string, now: Date = new Date()): Promise<HiddenItem[]> {
  const since = new Date(now.getTime() - DISMISS_COUNTS_FOR_DAYS * 24 * 3600 * 1000);
  const rows = await db.select({
    kind: opdSuggestionEvents.kind, contextKey: opdSuggestionEvents.contextKey, itemKey: opdSuggestionEvents.itemKey,
    outcome: opdSuggestionEvents.outcome,
  }).from(opdSuggestionEvents).where(and(
    eq(opdSuggestionEvents.userId, userId), gte(opdSuggestionEvents.createdAt, since), lte(opdSuggestionEvents.createdAt, now),
    inArray(opdSuggestionEvents.outcome, ["dismissed", "accepted", "manual", "edited"]),
  )).orderBy(opdSuggestionEvents.createdAt);
  const d = new Map<string, { item: HiddenItem; crosses: number }>();
  for (const r of rows) {
    if (r.itemKey === null) continue;
    const k = `${r.kind}|${r.contextKey ?? ""}|${r.itemKey}`;
    if (r.outcome !== "dismissed") { d.delete(k); continue; }
    const cur = d.get(k) ?? { item: { kind: r.kind, contextKey: r.contextKey, itemKey: r.itemKey }, crosses: 0 };
    cur.crosses += 1;
    d.set(k, cur);
  }
  return [...d.values()].filter((x) => x.crosses >= HIDE_AFTER).map((x) => x.item);
}

// ——— each doctor's own switch ———

export async function doctorSuggestionsOn(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ on: cdsDoctorPrefs.suggestionsOn }).from(cdsDoctorPrefs).where(eq(cdsDoctorPrefs.userId, userId));
  return row?.on ?? true;
}

export async function setDoctorSuggestions(db: Db, actor: Actor, on: boolean, now: Date = new Date()): Promise<void> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a doctor's own setting is a doctor's");
  await db.insert(cdsDoctorPrefs).values({ userId: actor.id, suggestionsOn: on, updatedAt: now })
    .onConflictDoUpdate({ target: cdsDoctorPrefs.userId, set: { suggestionsOn: on, updatedAt: now } });
}
