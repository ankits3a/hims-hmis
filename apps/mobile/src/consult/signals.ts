/**
 * THE CROSS ON THE PHONE (decision 0050, phase P0 — owner 2026-10-07).
 *
 * A suggestion the doctor does not want is crossed off with one tap. The cross is told to the server
 * with the visit and the suggestion's key (never a patient, never a typed word); it takes that one
 * row off this visit's screen and nothing else moves. A row the doctor merely did not tap is NOT a
 * cross. What the doctor has crossed three times comes back from the server as `hidden` and is not
 * offered again until they type it themselves.
 */
export type SuggestKind = "medicine" | "test" | "diagnosis";
export type HiddenItem = { kind: string; contextKey: string | null; itemKey: string };
export type SuggestState = { on: boolean; hidden: readonly HiddenItem[] };
export const SUGGEST_DEFAULT: SuggestState = { on: true, hidden: [] };

const norm = (k: string | null | undefined): string => (k ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/* Crossed in this sitting, per visit: a drawer closes and opens again, and the row stays gone. */
const crossed = new Map<string, Set<string>>();

export function crossOff(encounterId: string, kind: SuggestKind, itemKey: string): void {
  const set = crossed.get(encounterId) ?? new Set<string>();
  set.add(`${kind}|${norm(itemKey)}`);
  crossed.set(encounterId, set);
}

/** Not offered: crossed on this visit, or on the server's three-crosses list for this doctor. */
export function notOffered(state: SuggestState, encounterId: string, kind: SuggestKind, contextKey: string | null, itemKey: string): boolean {
  if (crossed.get(encounterId)?.has(`${kind}|${norm(itemKey)}`) === true) return true;
  return state.hidden.some((h) => h.kind === kind && norm(h.contextKey) === norm(contextKey) && norm(h.itemKey) === norm(itemKey));
}

/** Tests only. */
export function resetCrossed(): void { crossed.clear(); }
