import { TRIAGE_BOOK } from "./triage-book";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * RANKING A COMPLAINT AGAINST THE HARVESTED BOOK — 82 syndromes, 782 phrasings
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The hand-written table in `triage.ts` is the floor: fourteen rows, every department, all three
 * scripts, and every key chosen so a clerk can be told why. It answers the common complaint
 * instantly and it is the only thing that reads Devanagari — the harvested book is romanised
 * (five Devanagari characters in 782 variants, measured).
 *
 * This is the other half: breadth. It is what lets *"thehuna me dard ba"* and *"jaad lag ke bukhar
 * aawat ba"* reach a department, which no list I could write by hand was going to cover.
 *
 * ═══ WHY TOKENS WITH INVERSE DOCUMENT FREQUENCY, AND NOT THE BUNDLE'S VECTOR ═══
 *
 * The engine this content arrived with scored character-trigram overlap and called it an embedding.
 * Measured, it could not read Devanagari at all and returned **EMERGENCY (RED), Pediatrics** for
 * *"mera mobile kho gaya"* — no confidence floor, so a wrong answer looked exactly like a right one.
 *
 * The signal that actually distinguishes these complaints is not spelling, it is WHICH WORDS ARE
 * RARE. `dard` appears in dozens of variants and says almost nothing; `thehuna`, `motiyabind` and
 * `bawaseer` each appear in one syndrome and say almost everything. So a token is worth `1/df`
 * across the whole book, computed once at module load, and a query scores by the rare words it
 * shares with an entry. That is cheap, explainable — the seat can name the word that decided it —
 * and it degrades in the right direction: a query of nothing but common words scores nothing and
 * the ranker says so.
 */

/** Function words that carry no clinical signal in any of the three scripts the desk types. */
const STOPWORDS = new Set([
  "me", "mein", "mai", "ka", "ki", "ke", "hai", "hain", "ho", "hua", "raha", "rahi", "rahe",
  "ba", "ba.", "gail", "gaya", "gayi", "gaye", "se", "ko", "par", "aur", "nahi", "na", "kar",
  "karna", "karwana", "karana", "lag", "laga", "lagi", "jaisa", "bahut", "thoda", "sa", "si",
  "ek", "do", "wala", "wali", "mera", "meri", "uska", "uski", "is", "in", "the", "a", "an",
  "of", "for", "and", "with", "to", "my", "has", "have", "had", "it", "on", "at", "from",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * token → the entry keys that use it, built ONCE. `salt_rank`'s lesson, and the ICD-10 one before
 * it: deriving a ranking signal per keystroke is what cost the drug field two seconds.
 */
const INDEX: Map<string, Set<string>> = new Map();
const ENTRY_TOKENS: Map<string, Set<string>> = new Map();

for (const entry of TRIAGE_BOOK) {
  const own = new Set<string>();
  for (const variant of entry.variants) for (const t of tokens(variant)) own.add(t);
  ENTRY_TOKENS.set(entry.key, own);
  for (const t of own) {
    const bucket = INDEX.get(t) ?? new Set<string>();
    bucket.add(entry.key);
    INDEX.set(t, bucket);
  }
}

/**
 * ═══ LIGHT PREFIX MATCHING, BECAUSE TRANSLITERATED HINDI AGGLUTINATES ═══
 *
 * Found by a failing test on `garbh theharana`. The book spells it `garbhadhan` and `garbhwati`;
 * an exact-token match sees neither, so a plainly pregnancy-related complaint reached nothing.
 * The same shape recurs all through this vocabulary — `dhadkan`/`dhadkane`, `sujan`/`sujankar` —
 * and no stopword list or synonym table fixes it, because it is morphology rather than vocabulary.
 *
 * So a query token also matches an index token when one is a PREFIX of the other, and only when
 * the shorter is at least five characters — below that, prefixes collide freely and the evidence
 * is not worth the noise. A prefix hit is discounted: it is real evidence and weaker than the word
 * itself, and saying so in the score is cheaper than pretending otherwise.
 */
const PREFIX_MIN = 5;
const PREFIX_DISCOUNT = 0.8;
const INDEX_TOKENS: string[] = [...INDEX.keys()];

function lookup(token: string): { indexToken: string; factor: number }[] {
  if (INDEX.has(token)) return [{ indexToken: token, factor: 1 }];
  if (token.length < PREFIX_MIN) return [];
  const out: { indexToken: string; factor: number }[] = [];
  for (const candidate of INDEX_TOKENS) {
    const shorter = candidate.length < token.length ? candidate : token;
    if (shorter.length < PREFIX_MIN) continue;
    if (candidate.startsWith(token) || token.startsWith(candidate)) {
      out.push({ indexToken: candidate, factor: PREFIX_DISCOUNT });
    }
  }
  return out;
}

/** A token shared by many syndromes is weak evidence; one used by a single syndrome is strong. */
function weightOf(token: string): number {
  const df = INDEX.get(token)?.size ?? 0;
  return df === 0 ? 0 : 1 / df;
}

export type BookMatch = {
  key: string;
  label: string;
  urgency: "emergency" | "urgent" | "routine";
  departments: { department: string; weight: number }[];
  score: number;
  /** The rare words that decided it — so the seat can say WHY, not merely what. */
  because: string[];
};

/**
 * The floor a match must clear, and the margin it must beat the runner-up by.
 *
 * Both exist for the same reason the copilot's phrasebook has them and the bundle's engine did not:
 * at a desk staffed by non-clinicians, a confident wrong answer costs more than an honest "I do not
 * know". `"mera mobile kho gaya"` must score nothing, and it does — none of its words is in the
 * book at all.
 */
const MIN_SCORE = 0.34;
const MIN_MARGIN = 1.15;

/** Rank the book for one complaint, or return null and let the caller fall back. */
export function rankBook(complaint: string): BookMatch | null {
  const qs = [...new Set(tokens(complaint))];
  if (qs.length === 0) return null;

  const scores = new Map<string, { score: number; because: string[] }>();
  let matchedTokens = 0;
  for (const token of qs) {
    const hits = lookup(token);
    if (hits.length === 0) continue;
    matchedTokens += 1;
    for (const { indexToken, factor } of hits) {
      const w = weightOf(indexToken) * factor;
      for (const key of INDEX.get(indexToken) ?? []) {
        const acc = scores.get(key) ?? { score: 0, because: [] };
        /* One query word contributes its BEST claim on an entry, never several times over. */
        acc.score = Math.max(acc.score, w);
        /* Only a genuinely distinctive word is worth showing a clerk as the reason. */
        if (w >= 0.2) acc.because.push(token);
        scores.set(key, acc);
      }
    }
  }
  if (scores.size === 0) return null;

  /*
    ═══ COVERAGE — ONE RARE WORD IN A LONG SENTENCE IS A COINCIDENCE, NOT A COMPLAINT ═══

    Found by a test: *"bijli ka bill jama karna hai"* (I have an electricity bill to pay) matched
    CC_BURNS_SCALDS, because `bijli` genuinely IS a burns word — electrical burns. One rare token
    out of three content words is a collision, and scoring alone cannot tell it from a real match.

    So a query of three or more content words must land at least TWO of them. A one- or two-word
    query is exempt, because "motiyabind" on its own IS the complaint and demanding a second word
    would break the shortest and clearest inputs there are.
  */
  if (qs.length >= 3 && matchedTokens < 2) return null;

  /*
    ═══ THE MARGIN IS APPLIED TO THE DEPARTMENT, NOT THE SYNDROME ═══

    Also found by a test, and it was a real defect. `garbh` matches infertility AND antenatal care;
    `kaan` matches ENT disorders AND deafness. Scored as syndromes those tie and the ranker refused
    — but BOTH PAIRS AGREE ON THE DEPARTMENT, and the department is the only thing the appointment
    book needs. Refusing there was answering a question nobody asked.

    So syndrome scores are folded onto departments first, weighted by the entry's own priority, and
    the floor and margin are judged on what the desk actually acts on.
  */
  const byDepartment = new Map<string, number>();
  for (const [key, v] of scores) {
    const entry = TRIAGE_BOOK.find((e) => e.key === key);
    if (entry === undefined) continue;
    for (const d of entry.departments) {
      /*
        ═══ MAX, NOT SUM — AND SUMMING WAS A REAL DEFECT ═══

        Summing let a COMMON word out-vote a rare one. `dard` appears in dozens of syndromes; most
        of them fold onto General Medicine, so its many tiny contributions added up and beat
        `thehuna`'s single strong claim on Orthopaedics. "thehuna me dard ba" — a Bhojpuri knee
        complaint, and the exact phrase this harvest exists to catch — routed to Medicine.

        A department is supported by its BEST-matching syndrome, not by how many weakly-related
        ones mention it. That is also the honest reading of the evidence: one syndrome matching
        well is not the same claim as six matching badly.
      */
      const claim = v.score * (d.weight / 100);
      byDepartment.set(d.department, Math.max(byDepartment.get(d.department) ?? 0, claim));
    }
  }
  const deptRanked = [...byDepartment.entries()].sort((a, b) => b[1] - a[1]);
  const topDept = deptRanked[0];
  if (topDept === undefined || topDept[1] < MIN_SCORE) return null;
  const nextDept = deptRanked[1];
  /*
    A RATIO, not a difference: these are sums of reciprocals with no fixed scale, so a flat
    difference would be meaningless at one end and unreachable at the other.
  */
  if (nextDept !== undefined && nextDept[1] > 0 && topDept[1] / nextDept[1] < MIN_MARGIN) return null;

  /* The best syndrome that actually claims the winning department — that is the one to name. */
  const best = [...scores.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .filter((c) => TRIAGE_BOOK.find((e) => e.key === c.key)?.departments.some((d) => d.department === topDept[0]) === true)
    .sort((a, b) => b.score - a.score)[0];
  if (best === undefined) return null;

  const entry = TRIAGE_BOOK.find((e) => e.key === best.key);
  if (entry === undefined) return null;
  return {
    key: entry.key,
    label: entry.label,
    urgency: entry.urgency,
    /* Led by the department the SCORES chose, which is not always the entry's own first. */
    departments: [
      { department: topDept[0], weight: entry.departments.find((d) => d.department === topDept[0])?.weight ?? 100 },
      ...entry.departments.filter((d) => d.department !== topDept[0]),
    ],
    score: Number(topDept[1].toFixed(4)),
    because: [...new Set(best.because)],
  };
}

/** Every department the book can name. Used by the census test to prove none is unreachable. */
export function bookDepartments(): string[] {
  return [...new Set(TRIAGE_BOOK.flatMap((e) => e.departments.map((d) => d.department)))].sort();
}
