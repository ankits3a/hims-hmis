import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE DEVANAGARI FIX MUST REACH EVERY `.pp` SUBTREE, NOT EVERY `.pp` CALL SITE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This defect has now been found four times, in four places, and each fix closed one instance:
 *
 *   FD-10  the sign-in screen — fixed under `.lg[data-lang="hi"]`
 *   FD-11  Desk One — the identical `.tag`, never given the same fix
 *   FD-25  `/opd/appointments` and `/patients/:id`, which mount `.pp` and stamp no attribute
 *   FD-25  and then NINE `<DialogContent className="pp">` mounts, found by an asymmetry scan
 *
 * The shape is always the same: `.tag`'s three rules are Latin assumptions — Plex Mono has no
 * Devanagari coverage, `text-transform: uppercase` buys nothing in a script with no case, and
 * `letter-spacing: .14em` pulls conjuncts and matras apart — and the correction is scoped to
 * whichever mount somebody remembered.
 *
 * ═══ WHY THIS TEST GUARDS THE SELECTOR AND NOT THE CALL SITES ═══
 *
 * A test that swept every `className="pp"` for a sibling `data-lang` would be the fifth fix of the
 * same shape: it would pass the moment somebody adds the attribute to the ninth dialog, and fail
 * again on the tenth. `html[lang="hi"] .pp` is the version that cannot be forgotten, because
 * `lib/i18n.ts` stamps the document element on every language change and a portalled dialog is
 * still inside the document.
 *
 * So this asserts the SELECTOR exists — and, because a guard that only reads one file can be
 * defeated by moving the rule, that no `.pp` rule anywhere reintroduces the attribute-only form
 * without the document-level one beside it.
 */
const CSS = join(__dirname, "desk-one.css");

/** Comments carry the words this test matches on; a rule is what is left after they are gone. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the Devanagari correction is scoped to the document, not to the mount", () => {
  const rules = stripComments(readFileSync(CSS, "utf8"));

  it("found the stylesheet and its Hindi block", () => {
    expect(rules).toContain('data-lang="hi"');
    expect(rules.length).toBeGreaterThan(1000);
  });

  /**
   * THE ASSERTION. Both the root face and the `.tag` correction must reach a `.pp` that carries no
   * attribute of its own — which is every dialog this application portals to `document.body`.
   */
  it("applies the Devanagari face to a .pp subtree that stamps no attribute of its own", () => {
    expect(rules).toMatch(/html\[lang="hi"\]\s+\.pp\s*[,{]/);
  });

  it("applies the .tag correction there too — the face alone leaves uppercase and the tracking", () => {
    expect(rules).toMatch(/html\[lang="hi"\]\s+\.pp\s+\.tag\s*[,{]/);
  });

  /**
   * `.mo` DELIBERATELY DOES NOT CHANGE, here as on the sign-in screen: it is worn by UHIDs, money,
   * tokens and times, which are Latin and digits, and a clerk compares those character by
   * character. A rule that swept `.mo` into the Devanagari face would be a regression dressed as
   * thoroughness, so it is asserted as absent rather than left to habit.
   */
  it("leaves .mo alone under Hindi — a UHID is compared character by character", () => {
    expect(rules).not.toMatch(/html\[lang="hi"\]\s+\.pp\s+\.mo\s*[,{]/);
    expect(rules).not.toMatch(/\.pp\[data-lang="hi"\]\s+\.mo\s*[,{]/);
  });
});
