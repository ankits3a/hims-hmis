import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

/**
 * THE KEYS ARE READ FROM THE CONTRACT'S SOURCE, not imported from it.
 *
 * `@hmis/contracts` resolves its runtime entry to `dist/`, which the web never builds — every web
 * import of it in the tree is an `import type`, erased before vite sees it, and a value import
 * fails to resolve. `i18n-keys.test.ts` has the same problem with the web's own source and solves
 * it the same way: `readFileSync` and a regular expression. Reading the declaration keeps ONE list
 * of these keys; a copy in this file would be the second, and two copies of one fact drift by
 * construction (§2.54).
 */
const COPILOT_ANSWER_KEYS: string[] = [
  ...new Set(
    [
      ...readFileSync(join(__dirname, "../../../../packages/contracts/src/copilot.ts"), "utf8")
        .matchAll(/"(copilot\.answer\.[A-Za-z]+)"/g),
    ].map((m) => m[1] ?? ""),
  ),
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE KEYS `i18n-keys.test.ts` CANNOT SEE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * That test scans every literal `t("ns.key")` in the web source against `en.json`, and its header
 * explains what it is defending: `lib/i18n.ts` sets no `parseMissingKeyHandler`, so a missing key
 * RENDERS ITSELF and a clerk reads `registrationSeat.form.newPatient` where a heading belongs —
 * green suite, wrong screen, found by a person looking at it. FD-11, FD-2 and FD-24 each paid for
 * that class.
 *
 * A COPILOT ANSWER KEY IS NEVER A LITERAL IN THIS SOURCE. It arrives in a response body and the
 * dock renders `t(answer.key)`, so the scanner sees a variable and can check nothing. Ship a tool
 * whose key nobody added and the defect arrives through the one door that test cannot watch.
 *
 * `COPILOT_ANSWER_KEYS` is the server's own closed set, in the package both sides share. This walks
 * it. Adding a key to a tool without adding the sentence now fails here instead of on a counter.
 */
function lookup(bundle: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(
    (node, part) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

describe("every copilot answer key has a sentence in both languages", () => {
  it("found the contract's key list at all", () => {
    /*
      THE EMPTY-SET TRAP. `it.each([])` runs NOTHING and reports success, so a moved file or a
      changed quoting style would turn this whole suite green while checking not one key — the
      empty-grep defect, where the result is evidence about the search rather than the thing.
    */
    expect(COPILOT_ANSWER_KEYS.length).toBeGreaterThan(15);
  });

  it.each(COPILOT_ANSWER_KEYS)("%s is in en.json", (key) => {
    expect(typeof lookup(en, key)).toBe("string");
  });

  it.each(COPILOT_ANSWER_KEYS)("%s is in hi.json", (key) => {
    expect(typeof lookup(hi, key)).toBe("string");
  });

  /**
   * ═══ AND THE INTERPOLATIONS MUST MATCH, WHICH IS THE HALF THAT ACTUALLY BREAKS ═══
   *
   * A key present in both files still renders wrongly if the Hindi forgot a `{{token}}`: i18next
   * silently drops an interpolation it is not asked for, so the sentence reads "अभी नहीं — पर लाइन
   * में हैं" and the clerk never learns the token. Nothing else in this repository checks that, and
   * it is invisible to anybody who only reads the English.
   */
  it.each(COPILOT_ANSWER_KEYS)("%s uses the same placeholders in both languages", (key) => {
    const placeholders = (s: unknown): string[] =>
      typeof s === "string" ? [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "").sort() : [];
    expect(placeholders(lookup(hi, key))).toEqual(placeholders(lookup(en, key)));
  });
});
