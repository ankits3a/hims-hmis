import { describe, expect, it } from "vitest";
import { expandSnippet } from "./snippets";
import type { SnippetContext, SnippetStop } from "./snippets";

/**
 * The stop-shifting arithmetic, exercised without React so the failure is arithmetic rather than
 * a render-timing story. This is the loop `useSnippets.onChangeValue` runs, character by character,
 * exactly as userEvent drives it.
 */
const CTX: SnippetContext = {
  patient: null, vitals: null, note: { complaint: "", diagnosis: "" },
  doctor: { name: null }, now: new Date("2026-09-14T06:00:00.000Z"),
};

/** The same shift rule the hook applies, isolated. */
function shift(stops: SnippetStop[], prev: string, next: string, caret: number): SnippetStop[] {
  const delta = next.length - prev.length;
  if (delta === 0) return stops;
  const editedAt = caret - Math.max(delta, 0);
  return stops.map((s) => (s.start >= editedAt ? { ...s, start: s.start + delta, end: s.end + delta } : s));
}

describe("stop shifting", () => {
  it("D1: typing over the first blank leaves the second one on its own space", () => {
    const { text, stops } = expandSnippet("Take {?one tablet} {?} after food.", CTX);
    expect(text).toBe("Take one tablet  after food.");
    expect(stops.map((s) => [s.start, s.end])).toEqual([[5, 15], [16, 16]]);

    // Replace the selected default, then type the rest — one keystroke at a time.
    let value = text;
    let cur = stops;
    let caret = 5;
    const typed = "2 tablets";
    for (let i = 0; i < typed.length; i += 1) {
      const from = i === 0 ? 5 : caret;
      const to = i === 0 ? 15 : caret;
      const next = value.slice(0, from) + typed[i] + value.slice(to);
      caret = from + 1;
      cur = shift(cur, value, next, caret);
      value = next;
    }
    expect(value).toBe("Take 2 tablets  after food.");
    /* The second blank must still sit BETWEEN the two spaces — at 15, not 14. One off and the
       sentence reads "2 tabletstwice daily". */
    expect(cur[1]!.start).toBe(15);
    expect(value.slice(0, cur[1]!.start)).toBe("Take 2 tablets ");
  });
});
