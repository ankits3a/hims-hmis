import { useSyncExternalStore } from "react";
import { istClock } from "../desk-one/model";

/**
 * WHAT HAPPENED AT THIS DESK — per tab, outside React's tree.
 *
 * `/pharmacy/desk` and `/pharmacy/desk/<id>` are two routes, so taking a ticket REMOUNTS the desk,
 * and a log held in component state was wiped at the exact moment it had something to say — found
 * by a browser walk, where every suite was green. A module store outlives the remount and still
 * dies with the tab, which is the lifetime the dock promises.
 */
export type DeskLog = { at: string; text: string; kind: "ok" | "warn" | "err" };

let entries: readonly DeskLog[] = [];
const listeners = new Set<() => void>();

export function say(text: string, kind: DeskLog["kind"] = "ok"): void {
  entries = [{ at: istClock(), text, kind }, ...entries].slice(0, 40);
  for (const l of listeners) l();
}

export function useDeskLog(): readonly DeskLog[] {
  return useSyncExternalStore(
    (onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    () => entries,
  );
}

/**
 * SAVE DRAFT'S CONFIRMATION, held here for the same reason as the log: the draft clears the desk, the
 * clear is a route change, and the route change remounts the desk — a sentence in component state
 * died at the moment it was due to be read (browser walk, 2026-09-23). It is shown until the next
 * ticket is in hand or the pharmacist dismisses it.
 */
let draftNotice: string | null = null;
export function noteDraftSaved(text: string | null): void {
  draftNotice = text;
  for (const l of listeners) l();
}
export function useDraftNotice(): string | null {
  return useSyncExternalStore(
    (onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    () => draftNotice,
  );
}

/** Tests only — a module store is shared across a suite's renders. */
export function resetDeskLog(): void {
  entries = [];
  draftNotice = null;
  for (const l of listeners) l();
}
