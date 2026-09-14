import { KNOWLEDGE } from "./knowledge";
import type { Syndrome } from "./knowledge";

/**
 * ═══ CHIEF COMPLAINT → SYNDROME, AND THE MODEL IS NOT IN THIS PATH ═══
 *
 * Owner, 2026-09-14: *"I wanted AI co-pilot to assist the doctor as much as it can with LOW help
 * from LLM."* This is the low-help half, and it is the DEFAULT path rather than the fallback: the
 * bundle ships keywords for all eight syndromes, a doctor's complaint line is three or four words,
 * and matching words to words needs no model, no network and no milliseconds anybody notices.
 *
 * `triage.ts` (department routing) is the shape for the other half when it is wanted: the model
 * receives OUR list and returns INDEXES into it, so it cannot name a syndrome we do not have. It is
 * a TIE-BREAKER over this function's output, never a source, and nothing here waits on it.
 *
 * ═══ WHY SCORING RATHER THAN FIRST-MATCH ═══
 *
 * "fever + sore throat + dry cough" hits URI on three keywords and Bronchitis on one. First-match
 * would return whichever syndrome happened to be earlier in the file. The doctor sees a RANKED list
 * and taps; the software never decides, which is also why a tie is left as a tie.
 */
export type SyndromeHit = { key: string; name: string; icd10: string | null; score: number; matched: string[] };

/** Fold to lowercase and strip punctuation so "Fever, sore-throat" and "fever sore throat" agree. */
function normalise(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * A keyword counts when it appears as a WHOLE WORD SEQUENCE, which is why both sides are padded
 * with spaces: "ear" must not match "fever", and "cough" must not match "coughing"'s absence —
 * substring matching on clinical words produces exactly the confident nonsense this design exists
 * to avoid. Longer keywords score higher: "sore throat" is worth more evidence than "fever",
 * which appears in half the syndromes in the book.
 */
export function rankSyndromes(complaint: string, limit = 4): SyndromeHit[] {
  const hay = normalise(complaint);
  if (hay.trim() === "") return [];
  const hits: SyndromeHit[] = [];
  for (const s of KNOWLEDGE.syndromes) {
    const matched: string[] = [];
    let score = 0;
    for (const kw of s.keywords) {
      const needle = normalise(kw);
      if (needle.trim() !== "" && hay.includes(needle)) {
        matched.push(kw);
        score += needle.trim().split(" ").length;
      }
    }
    if (score > 0) hits.push({ key: s.key, name: s.name, icd10: s.icd10, score, matched });
  }
  /* Ties break by the syndrome's own key so the order is STABLE across calls — a list that
     reshuffles between two keystrokes is a list a doctor cannot tap. */
  return hits.sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key)).slice(0, limit);
}

export function allSyndromes(): Syndrome[] {
  return KNOWLEDGE.syndromes;
}
