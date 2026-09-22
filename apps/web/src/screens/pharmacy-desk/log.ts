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

/** Tests only — a module store is shared across a suite's renders. */
export function resetDeskLog(): void {
  entries = [];
  for (const l of listeners) l();
}
