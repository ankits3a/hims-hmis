/**
 * HOME-SCREEN WIDGETS (owner 2026-10-10, decision 0064 E1.1 and E1.7) — the ONE "return to" in the app.
 * The scan widget opens `hmis://scan`; the Ask widget opens `hmis://copilot?keyboard=1` (or `?mic=1`).
 * When the phone is not yet signed in (locked behind the fingerprint, signed out, or owing a new
 * password) the route hands the person to "/" — the one gate — and leaves this mark; the gate, once
 * signed in, opens that route instead of staying on home.
 * Deliberately not a general redirect system: the widgets' links only, one mark, held only in memory.
 */
export type WidgetRoute = "/scan" | "/copilot?keyboard=1" | "/copilot?mic=1";
let owed: WidgetRoute | null = null;

/** A widget's route was reached before sign-in: open it once sign-in is done. */
export function holdReturn(to: WidgetRoute): void {
  owed = to;
}

/** Whether a mark is waiting (a read; nothing is cleared). */
export function returnIsOwed(): boolean {
  return owed !== null;
}

/** The route once, then cleared: the gate opens it at most once per mark. */
export function takeReturn(): WidgetRoute | null {
  const to = owed;
  owed = null;
  return to;
}
