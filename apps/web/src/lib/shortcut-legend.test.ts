import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — A KEYCAP THAT LIES IS WORSE THAN NONE, AND SO IS A LEGEND ENTRY NOBODY RENDERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The signed-off keyboard artboard states the rule this file enforces: "Every keycap ON the screen
 * shows what is actually bound. A keycap that lies is worse than none." The `shortcuts` namespace is
 * where that rule is easiest to break, because the legend is written in one file and the bindings in
 * another, and nothing has ever compared them.
 *
 * The FD-25 build spec found ONE instance — `shortcuts.opdConsult` ("Alt+C Consult"), advertising a
 * chord FD-5 parked — and told this task to delete it or bind it. Grepping for the sibling shape
 * found SIX MORE: `approvals`, `billing`, `merge`, `opdAppointments`, `opdDesk`, `opdVitals` and
 * `title`. Seven translated strings, in two languages, describing keys that do nothing.
 *
 * That is the asymmetry this lane keeps paying for: a fix aimed at the instance closes the instance.
 * The instance was deleted; this is what closes the class. A legend entry can now only exist while
 * `ShortcutLegend` renders it, and the next one that stops being rendered fails here by name.
 *
 * ═══ WHY IT READS THE SOURCE RATHER THAN LISTING THE FIVE ═══
 *
 * A hand-written list here would be the second copy that drifts — the exact failure one level up.
 * `keyboard.tsx` is the authority on what the legend shows, so the legend's own source is what this
 * reads, and it throws rather than returning empty if the parse ever stops matching (§2.49).
 */
const KEYBOARD_TSX = join(__dirname, "keyboard.tsx");

function renderedLegendKeys(): string[] {
  const source = readFileSync(KEYBOARD_TSX, "utf8");
  const keys = [...source.matchAll(/\bt\(\s*"shortcuts\.([a-zA-Z]+)"/g)].map((m) => m[1]!);
  if (keys.length === 0) {
    throw new Error(`no t("shortcuts.*") calls found in ${KEYBOARD_TSX} — the parser, not the legend, is out of date`);
  }
  return [...new Set(keys)].sort();
}

describe("the shortcut legend advertises exactly the keys it renders", () => {
  const rendered = renderedLegendKeys();

  it("found the legend's own calls", () => {
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered).toContain("search");
  });

  /**
   * THE ASSERTION. An entry here that `ShortcutLegend` does not render is a promise of a key that
   * does nothing — and a doctor or clerk who presses it and gets nothing stops trusting the row.
   */
  it("has no string for a key the legend never shows", () => {
    const orphans = Object.keys(en.shortcuts).filter((k) => !rendered.includes(k));
    expect(orphans, `these shortcut strings advertise keys nothing binds:\n${orphans.join("\n")}\n`).toEqual([]);
  });

  /** And the other direction: a rendered key with no string prints its own path in the footer. */
  it("has a string for every key the legend does show", () => {
    const missing = rendered.filter((k) => typeof (en.shortcuts as Record<string, string>)[k] !== "string");
    expect(missing, `the legend renders these with no locale string:\n${missing.join("\n")}\n`).toEqual([]);
  });
});
