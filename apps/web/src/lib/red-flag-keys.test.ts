import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RED-FLAG SENTENCES — KEYS `i18n-keys.test.ts` CANNOT SEE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * That test scans every literal `t("ns.key")` in this source, because `lib/i18n.ts` sets no
 * `parseMissingKeyHandler` and a missing key RENDERS ITSELF on the screen. A red-flag reason is
 * never a literal here: the server returns `opdTriage.redFlag.<rule>` and the stage renders
 * `t(s.triage.redFlag.reasonKey)`, so the scanner sees a variable and checks nothing.
 *
 * Ship a rule whose sentence nobody wrote and a clerk facing a possible heart attack reads
 * `opdTriage.redFlag.chestPain` where a warning should be. That is the worst place in this
 * application for that defect to land, and it is invisible to every other test.
 *
 * So the rule keys are read from the server's own module, which is the single source. Adding a red
 * flag without its sentence now fails here rather than at a counter.
 */
const RULE_KEYS: string[] = [
  ...new Set(
    [
      ...readFileSync(join(__dirname, "../../../core/src/modules/opd/red-flags.ts"), "utf8")
        .matchAll(/^\s*key:\s*"([A-Za-z]+)"/gm),
    ].map((m) => m[1] ?? ""),
  ),
];

function lookup(bundle: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(
    (node, part) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

describe("every red flag has a sentence a clerk can read", () => {
  it("found the rules at all", () => {
    /* `it.each([])` runs nothing and reports success — the empty-set trap. */
    expect(RULE_KEYS.length).toBeGreaterThanOrEqual(8);
  });

  it.each(RULE_KEYS)("%s has English", (key) => {
    expect(typeof lookup(en, `opdTriage.redFlag.${key}`)).toBe("string");
  });

  it.each(RULE_KEYS)("%s has Hindi", (key) => {
    expect(typeof lookup(hi, `opdTriage.redFlag.${key}`)).toBe("string");
  });

  /**
   * The instruction is the half that actually changes what the clerk DOES, and it is one sentence
   * shared by every rule — so it is worth its own assertion rather than being assumed present.
   */
  it("tells the clerk what to do, in both languages", () => {
    expect(typeof lookup(en, "opdTriage.redFlag.action")).toBe("string");
    expect(typeof lookup(hi, "opdTriage.redFlag.action")).toBe("string");
  });

  it("says DO NOT BOOK in as many words, in English", () => {
    // The whole point of the brake. A sentence that merely described the danger would leave the
    // clerk holding the decision it exists to take away from them.
    expect(String(lookup(en, "opdTriage.redFlag.action")).toLowerCase()).toContain("do not book");
  });
});
