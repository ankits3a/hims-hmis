import { createHash } from "node:crypto";
import type { TriageDepartment, TriageResult } from "./triage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — THE SAME COMPLAINT SHOULD NOT BE PAID FOR TWICE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner asked whether a repeated sentence could reuse its answer instead of spending another
 * request. It can, and this is the only kind of saving worth having: the answer is IDENTICAL by
 * construction, so there is nothing to trade off. A cache hit is the same string the model returned
 * for the same question about the same departments.
 *
 * ═══ WHY THE OBVIOUS OPTIMISATION IS NOT HERE ═══
 *
 * The cheaper idea — skip the model whenever `keywordRank` already has an answer — was MEASURED
 * over 22 realistic complaints against the hospital's real 12 departments and it is wrong:
 *
 *     identical answers          6 / 22
 *     keyword table empty       12 / 22   (no ear, tooth, skin, eye, abdomen, headache, fracture…)
 *     "seene mein dard nahi hai, sirf gas lagti hai"
 *         keywords -> [Cardiology, General Medicine]   ← matched the substring "seene"
 *         model    -> [General Medicine]
 *
 * A table that cannot read a negation must never be allowed to skip the model. So the saving comes
 * from not asking the SAME question twice, and from nowhere else.
 *
 * ═══ WHAT IS IN THE KEY, AND WHAT IS DELIBERATELY NOT ═══
 *
 * The key is the normalised complaint text plus a fingerprint of the department list. The
 * department fingerprint is load-bearing: a hospital that adds Neurology must not keep being told
 * the old ranking for "sar dard", and including the list means a department added, removed or
 * renamed invalidates every entry on its own rather than waiting for a TTL.
 *
 * Normalisation is deliberately TIMID — case, Unicode form, and runs of whitespace, and nothing
 * else. No punctuation stripping and above all no stop-word removal: "dard nahi hai" and "dard hai"
 * are opposite complaints and any normalisation that collapses them would turn this cache into a
 * source of wrong routing rather than a saving.
 *
 * ═══ PRIVACY: THE KEY CARRIES NO PATIENT ═══
 *
 * The key is built from the MASKED complaint (`suggestDepartments`, `triage.ts`): identifier shapes
 * and the names the desk supplied are placeholders before the key exists. Until 2026-09-19 this
 * paragraph said the prompt carried no name while nothing made that so — a clerk's "Ramesh ji ko
 * bukhar" went into the key and to the provider verbatim. What is left is a symptom phrase and a
 * department list, linked to nobody, and it is kept IN MEMORY only: it dies with the process, is
 * never written to disk or to the database, and is never logged. A persisted version would be a different decision about
 * storing health text and is not one to take incidentally for a performance win.
 */
export interface TriageCache {
  get(key: string): TriageResult | undefined;
  set(key: string, value: TriageResult): void;
  /**
   * Calls already on the wire, keyed identically. Two clerks typing "bukhar" in the same second are
   * one upstream request, not two — the second awaits the first. This is a saving the cache alone
   * cannot make, because nothing is cached until the first call has ANSWERED.
   */
  readonly inflight: Map<string, Promise<TriageResult>>;
  readonly stats: { hits: number; misses: number; coalesced: number; stored: number };
  size(): number;
  clear(): void;
}

/** Case, Unicode form and whitespace. Nothing that could change what the sentence means. */
export function normaliseComplaint(text: string): string {
  return text.normalize("NFC").trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * The list as the model will be SHOWN it, in order, because the prompt numbers them by position.
 * Hashed rather than joined so a 12-department hospital does not carry 330 characters of ULID in
 * every key.
 */
export function departmentFingerprint(departments: TriageDepartment[]): string {
  return createHash("sha1").update(departments.map((d) => `${d.id}:${d.name}`).join("\u0000")).digest("hex").slice(0, 16);
}

export function triageCacheKey(text: string, departments: TriageDepartment[]): string {
  return `${departmentFingerprint(departments)}|${normaliseComplaint(text)}`;
}

/**
 * A bounded LRU with a TTL. `Map` iterates in insertion order, so re-inserting on read is the whole
 * of the LRU. `now` is injected because a cache whose expiry can only be tested by sleeping is a
 * cache whose expiry is not tested.
 *
 * The defaults suit a counter rather than a benchmark: a front desk's complaint vocabulary is small
 * and extremely repetitive — five one-click chips plus a few dozen typed phrases — so 500 entries
 * holds a whole hospital's working set, and a day is longer than any shift.
 */
export function createTriageCache(opts: { max?: number; ttlMs?: number; now?: () => number } = {}): TriageCache {
  const max = opts.max ?? 500;
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { at: number; value: TriageResult }>();
  const stats = { hits: 0, misses: 0, coalesced: 0, stored: 0 };

  return {
    inflight: new Map<string, Promise<TriageResult>>(),
    stats,
    size: () => entries.size,
    clear: () => { entries.clear(); },
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) { stats.misses += 1; return undefined; }
      if (now() - hit.at > ttlMs) { entries.delete(key); stats.misses += 1; return undefined; }
      entries.delete(key); // re-insert to move it to the young end
      entries.set(key, hit);
      stats.hits += 1;
      return hit.value;
    },
    set(key, value) {
      /*
       * A KEYWORD ANSWER IS NEVER STORED, and this is the subtle half of the whole design. The
       * advisor falls back to the keyword table on any failure — a 429, a timeout, malformed JSON —
       * and caching that would let one transient rate-limit pin the DEGRADED answer in front of
       * every clerk for the rest of the TTL. A cache is only allowed to remember a success.
       */
      if (value.source !== "model") return;
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { at: now(), value });
      stats.stored += 1;
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/** The process-wide cache the controller uses. Tests build their own so nothing leaks between them. */
export const defaultTriageCache = createTriageCache();
