/**
 * The urgency a syndrome carries in the harvested book.
 *
 * Its own file so `triage-book.ts` — which is GENERATED and must never be hand-edited — imports a
 * type rather than declaring one. A generated file that also owns a type is a generated file
 * somebody eventually edits by hand to change the type.
 *
 * `emergency` rows are present in the book for completeness and are NOT routed by it: an emergency
 * belongs to `red-flags.ts`, which refuses to book at all, and none of these has been merged there
 * yet — see `docs/superpowers/2026-09-17-triage-emergency-signoff.md`.
 */
export type TriageUrgency = "emergency" | "urgent" | "routine";
