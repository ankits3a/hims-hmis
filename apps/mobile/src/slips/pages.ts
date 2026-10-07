/**
 * SEVERAL PAGES OF ONE SLIP (owner 2026-10-07) — the small rules of the page strip, kept apart from
 * the screen so they can be tested without a camera.
 */

/** A slip is a sheet or two; a discharge summary a handful. Past this it is a different job. */
export const MAX_PAGES = 6;

/** What the server said, beside the document id, about marking the visit consulted (ruling 2026-10-06). */
export type PaperSaid = { outcome?: string; failed?: boolean };

const CONSULTED = ["marked", "already_marked", "doctor_completed"];

/**
 * One line for the whole slip. The FIRST prescription page closes the visit ("marked"); the pages
 * after it answer "already_marked". The slip says the first, not the last — and when no page closed
 * the visit, the first reason any page gave.
 */
export function paperOf(said: readonly (string | null)[]): string | null {
  const heard = said.filter((x): x is string => x !== null);
  return heard.find((x) => CONSULTED.includes(x)) ?? heard[0] ?? null;
}

/**
 * A send whose answer never came back may still have landed. The server numbers a visit's pages by
 * counting them, and takes no idempotency key on this route, so the desk asks what the visit holds:
 * `before` pages were on file when it was taken in hand, `confirmed` of this slip's have been
 * answered for — one more than that means the unheard page is there, and it is not sent again.
 */
export function landedUnheard(before: number, confirmed: number, onFileNow: number): boolean {
  return onFileNow >= before + confirmed + 1;
}

/** Move one page a place earlier (-1) or later (+1) in the strip; out of range changes nothing. */
export function moveById<P extends { id: number }>(pages: readonly P[], id: number, by: -1 | 1): P[] {
  const from = pages.findIndex((p) => p.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= pages.length) return [...pages];
  const out = [...pages];
  [out[from], out[to]] = [out[to]!, out[from]!];
  return out;
}
