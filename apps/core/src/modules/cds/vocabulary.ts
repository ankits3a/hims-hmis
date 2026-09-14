import { KNOWLEDGE } from "./knowledge";

/**
 * ═══ WHAT THE DOCTOR IS OFFERED WHILE TYPING A COMPLAINT ═══
 *
 * Owner, 2026-09-14: *"if doctor start writing 'fev' … auto suggestion will appear as 'fever' … If
 * doctor types 'fever' and presses enter, 'fever' will be added a tag exactly as the doctor wrote."*
 *
 * Two halves, and the second is the one that keeps this honest: the vocabulary SUGGESTS, and the
 * doctor's own words WIN. Nothing here rewrites, corrects or normalises what was typed — a
 * suggestion the doctor ignores is a suggestion that was wrong.
 *
 * The vocabulary is the hospital's own: every keyword the eight syndromes match on, plus every
 * symptom the bundle maps to a first-line molecule. No model, no network, no index to rebuild —
 * about seventy terms, searched in microseconds, which is what lets this run on a keystroke.
 */
export type ComplaintTerm = { term: string; from: "syndrome" | "symptom" };

const VOCABULARY: ComplaintTerm[] = (() => {
  const seen = new Map<string, ComplaintTerm>();
  for (const s of KNOWLEDGE.syndromes) {
    for (const k of s.keywords) {
      const t = k.trim().toLowerCase();
      if (t !== "" && !seen.has(t)) seen.set(t, { term: t, from: "syndrome" });
    }
  }
  for (const r of KNOWLEDGE.rules) {
    if (r.domain !== "symptom_mappings") continue;
    const t = String(r.subject ?? "").trim().toLowerCase();
    if (t !== "" && !seen.has(t)) seen.set(t, { term: t, from: "symptom" });
  }
  return [...seen.values()].sort((a, b) => a.term.localeCompare(b.term));
})();

/**
 * PREFIX FIRST, THEN ANYWHERE — because a doctor typing `fev` means a word that STARTS `fev`, and
 * an inline ghost completion can only be offered for a prefix match. The word-start pass sits
 * between them so `sore` reaches `sore throat` without `throat` jumping the queue.
 */
export function completeComplaint(q: string, limit = 8): ComplaintTerm[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const starts: ComplaintTerm[] = [];
  const wordStarts: ComplaintTerm[] = [];
  const anywhere: ComplaintTerm[] = [];
  for (const v of VOCABULARY) {
    if (v.term.startsWith(needle)) starts.push(v);
    else if (v.term.split(" ").some((w) => w.startsWith(needle))) wordStarts.push(v);
    else if (v.term.includes(needle)) anywhere.push(v);
  }
  return [...starts, ...wordStarts, ...anywhere].slice(0, limit);
}

/**
 * The inline completion for `→`: the remainder of the single best PREFIX match, or null. Only a
 * prefix can be ghosted — completing `fev` to `high grade fever` by pushing letters in front of the
 * cursor is a keystroke the doctor did not make.
 */
export function ghostFor(q: string): string | null {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return null;
  const hit = VOCABULARY.find((v) => v.term.startsWith(needle) && v.term !== needle);
  return hit === undefined ? null : hit.term.slice(needle.length);
}

export function complaintVocabulary(): ComplaintTerm[] {
  return VOCABULARY;
}
