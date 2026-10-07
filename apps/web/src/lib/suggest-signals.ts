import { useSyncExternalStore } from "react";
import { api } from "./api";

/*
 * ═══ THE CROSS, AND WHAT BECAME OF A CHIP (decision 0050, phase P0) ═══
 *
 * A suggestion chip can be TAKEN (the tap) or CROSSED OFF (the ×). Both are told to the server, with
 * the chips that were on screen, so learning has a denominator. Nothing here changes what is ranked:
 * a crossed chip leaves the screen for this visit and nothing else moves. A chip the doctor did not
 * tap is NOT a cross. A send that fails is dropped — the consult never waits for its own telemetry.
 */

export type SuggestKind = "diagnosis" | "test" | "medicine";
export type SuggestSurface = "consult_web" | "scribe";
export type HiddenItem = { kind: string; contextKey: string | null; itemKey: string };
export type SuggestionPrefs = { on: boolean; hospitalOn: boolean; hidden: HiddenItem[] };

type Signal = {
  kind: SuggestKind; source: "suggested"; outcome: "shown" | "accepted" | "dismissed"; surface: SuggestSurface;
  encounterId?: string; contextKey?: string; itemKey?: string; rankShown?: number; items?: string[]; batchId?: string;
};

export const SUGGESTION_PREFS_KEY = ["opd", "suggestion-prefs"] as const;
export const fetchSuggestionPrefs = (): Promise<SuggestionPrefs> => api<SuggestionPrefs>("GET", "/opd/consult/suggestions");
export const setSuggestionsOn = (suggestionsOn: boolean): Promise<{ on: boolean }> => api<{ on: boolean }>("PUT", "/opd/consult/suggestions", { suggestionsOn });

export function sendSignals(suggestions: Signal[]): void {
  if (suggestions.length === 0) return;
  void api("POST", "/opd/consult/signals", { misses: [], suggestions }).catch(() => undefined);
}

const norm = (k: string | null | undefined): string => (k ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** The server's hidden list (three crosses), read as a lookup. Keys are compared the way the server stores them. */
export function hiddenLookup(hidden: readonly HiddenItem[] | undefined): (kind: SuggestKind, contextKey: string | null, itemKey: string) => boolean {
  const set = new Set((hidden ?? []).map((h) => `${h.kind}|${norm(h.contextKey)}|${norm(h.itemKey)}`));
  return (kind, contextKey, itemKey) => set.has(`${kind}|${norm(contextKey)}|${norm(itemKey)}`);
}

/* What was crossed off in THIS sitting, per visit — it outlives the fold/unfold of the copilot column
   (the chips are one element mounted in two places) and is gone with the page. */
const crossed = new Map<string, Set<string>>();
const told = new Map<string, Set<string>>();
const batches = new Map<string, string>();
/* Every place that draws a chip redraws when one is crossed off — the same chip can be on screen twice. */
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (f: () => void): (() => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export function useCrossedVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function crossedHere(encounterId: string, kind: SuggestKind, itemKey: string): boolean {
  return crossed.get(encounterId)?.has(`${kind}|${norm(itemKey)}`) === true;
}

const batchOf = (encounterId: string, kind: SuggestKind, contextKey: string | null): string => {
  const k = `${encounterId}|${kind}|${norm(contextKey)}`;
  let id = batches.get(k);
  if (id === undefined) {
    id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    batches.set(k, id);
  }
  return id;
};

/**
 * Each chip is told as SHOWN once per visit and context: re-rendering it, or the list shrinking because
 * a neighbour was taken or crossed off, is not a second showing. Only chips not yet told are sent.
 */
export function tellShown(surface: SuggestSurface, encounterId: string, kind: SuggestKind, contextKey: string | null, items: string[]): void {
  const k = `${encounterId}|${kind}|${norm(contextKey)}`;
  const seen = told.get(k) ?? new Set<string>();
  const fresh = items.filter((i) => !seen.has(norm(i)));
  if (fresh.length === 0) return;
  for (const i of fresh) seen.add(norm(i));
  told.set(k, seen);
  sendSignals([{ kind, source: "suggested", outcome: "shown", surface, encounterId, ...(contextKey === null ? {} : { contextKey }), items: fresh, batchId: batchOf(encounterId, kind, contextKey) }]);
}

export function tellOutcome(surface: SuggestSurface, encounterId: string, kind: SuggestKind, contextKey: string | null, itemKey: string, rankShown: number, outcome: "accepted" | "dismissed"): void {
  if (outcome === "dismissed") {
    const set = crossed.get(encounterId) ?? new Set<string>();
    set.add(`${kind}|${norm(itemKey)}`);
    crossed.set(encounterId, set);
    version += 1;
    for (const f of listeners) f();
  }
  sendSignals([{ kind, source: "suggested", outcome, surface, encounterId, ...(contextKey === null ? {} : { contextKey }), itemKey, rankShown, batchId: batchOf(encounterId, kind, contextKey) }]);
}

/** Tests only. */
export function resetSuggestSignals(): void {
  crossed.clear(); told.clear(); batches.clear();
}
