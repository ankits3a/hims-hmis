import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabStrip } from "./desk-fields";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 BACKLOG ITEM 8 — THE CARET, NOT THE PAINT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `TabStrip` moved the SELECTION on an arrow key and left the caret where it was. That is not one
 * of the two shapes the WAI-ARIA tabs pattern allows: automatic activation moves focus and lets
 * selection follow it, manual activation moves focus and does NOT change selection. "Selection
 * moves, focus stays" is a third thing, and it strands the caret on a button that now reports
 * `aria-selected="false"` and `tabIndex="-1"`.
 *
 * WHY 500-ODD GREEN WEB TESTS SAID NOTHING. Every tab test in this repository drives its tabs with
 * `user.click` (`opd-consult.test.tsx` ×9, `opd-admin.test.tsx` ×2, `billing-office.test.tsx` ×1),
 * and a click focuses the button it activates as a browser side effect. The click path therefore
 * masks the keyboard path completely, and `grep -rn "ArrowRight" apps/web/src` had exactly two
 * hits before this file existed — both of them lines of the component itself.
 *
 * SO `document.activeElement` IS THE ASSERTION THAT MATTERS HERE. Every `aria-selected` line below
 * passes against the UNFIXED component; they are here to prove the selection did not regress, not
 * to catch the defect. A test that asserted only `aria-selected` would have been worthless, and
 * writing one would have been the easiest mistake in this file.
 *
 * WHAT RESETS THE DOM BETWEEN THESE TESTS, since seven tests assert on one global. `test-setup.ts`
 * is the single line `import "@testing-library/jest-dom/vitest";` and registers no cleanup itself.
 * The unmount between tests comes from RTL's own auto-registration against the `afterEach` global
 * that `globals: true` (`vite.config.ts`) provides — the same mechanism the 18 sibling component
 * suites in this directory already rely on. After an unmount `document.activeElement` is
 * `document.body`, so no test inherits the previous one's caret.
 *
 * AND WHAT THIS FILE CANNOT PROVE. The costliest consequence of the defect is the screen-reader
 * one: a reader announces the FOCUSED element, so the panel changed and the doctor was told
 * nothing. jsdom has no accessibility tree and no announcement channel, so there is no assertion
 * for that and there is not going to be one. `document.activeElement` is a proxy for it. The one
 * test below that reproduces something a sighted keyboard user can feel directly is "Tab after an
 * arrow lands IN THE PANEL" — which is why it is worth keeping even though it overlaps the
 * ArrowRight test's revert pair.
 */

type Tab = "note" | "rx" | "history";
const OPTIONS = [["note", "Note"], ["rx", "Prescription"], ["history", "History"]] as const;

/**
 * The harness mirrors both real callers rather than inventing a shape: ONE panel mounted at a time
 * (`opd-admin.tsx:593`, `opd-consult.tsx:1082/1135/1248`), holding a focusable control, rendered
 * AFTER the strip. That document order is what makes the Tab-order assertion mean anything — the
 * stranded tab sits BEFORE the newly selected one, which is why the defect costs a doctor two Tabs
 * after an ArrowRight and only one after an ArrowLeft. The keyboard contract was not merely wrong,
 * it was direction-dependent.
 */
function Harness(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("note");
  return (
    <div>
      <button type="button" data-testid="before">before the strip</button>
      <TabStrip<Tab> label="Consult" value={tab} onChange={setTab} options={OPTIONS} testId="strip" />
      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <button type="button" data-testid="in-panel">first control in the {tab} panel</button>
      </div>
      {/* a parent changing the tab WITHOUT a key press — the negative control for the last test */}
      <button type="button" data-testid="jump" onClick={() => { setTab("history"); }}>jump to history</button>
    </div>
  );
}

const tabButton = (name: string): HTMLElement => screen.getByRole("tab", { name });

describe("TabStrip — the ARIA tabs pattern, focus included", () => {
  it("is ONE tab stop, entered on the selected tab — the roving tabindex, which already worked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(tabButton("Note")).toHaveAttribute("tabindex", "0");
    expect(tabButton("Prescription")).toHaveAttribute("tabindex", "-1");
    expect(tabButton("History")).toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("before"));
    await user.tab();
    expect(document.activeElement).toBe(tabButton("Note"));
  });

  it("ArrowRight moves the CARET as well as the selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tabButton("Note").focus();

    await user.keyboard("{ArrowRight}");

    expect(tabButton("Prescription")).toHaveAttribute("aria-selected", "true");
    expect(tabButton("Note")).toHaveAttribute("aria-selected", "false");
    expect(document.activeElement).toBe(tabButton("Prescription"));
    expect(tabButton("Prescription")).toHaveAttribute("tabindex", "0");
    expect(tabButton("Note")).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowLeft wraps to the last tab and takes the caret with it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tabButton("Note").focus();

    await user.keyboard("{ArrowLeft}");

    expect(tabButton("History")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabButton("History"));
  });

  it("the caret never lands on a tab that is not selected — three arrows, three times", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tabButton("Note").focus();

    for (const expected of ["Prescription", "History", "Note"]) {
      await user.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(screen.getByRole("tab", { selected: true }));
      expect(document.activeElement).toBe(tabButton(expected));
    }
  });

  /**
   * The header comment on the component promises "Tab itself moves OUT of the strip and into the
   * panel — that is the point of the roving tabindex". Unfixed, that promise held only until the
   * doctor pressed an arrow: user-event's tab walk keeps every non-negative-tabindex element PLUS
   * the currently active one, in document order, so the stranded `tabindex="-1"` Note stayed in
   * the ring and the next Tab landed on the Prescription TAB rather than in the panel.
   */
  it("Tab after an arrow lands IN THE PANEL, not on another tab — the promise the header makes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tabButton("Note").focus();

    await user.keyboard("{ArrowRight}");
    await user.tab();

    expect(document.activeElement).toBe(screen.getByTestId("in-panel"));
  });

  it("Home and End reach the first and last tab, caret included", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tabButton("Note").focus();

    await user.keyboard("{End}");
    expect(tabButton("History")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabButton("History"));

    await user.keyboard("{Home}");
    expect(tabButton("Note")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabButton("Note"));
  });

  /**
   * THE NEGATIVE CONTROL, and the reason the fix must not be a `useEffect` on `value`. A parent
   * changing the tab by itself — `/opd/consult` does exactly this from its Escape handler
   * (`opd-consult.tsx:847`, `setTab("note")` on the second press) — must repaint the strip and
   * leave the caret wherever the user put it. An effect-based fix passes all six tests above and
   * fails this one, which is the whole job it has.
   *
   * It has NO revert pair, and saying so is the useful half: it is GREEN against the unfixed
   * component and GREEN against the fixed one. Reverting the fix does not turn it red, because it
   * is a fence around the SHAPE of the fix rather than proof of its effect. The instrument that
   * proves it is doing work is a MUTANT that ADDS the forbidden thing — paste
   * `useEffect(() => { tabs.current.get(value)?.focus(); }, [value])` into the component and this
   * test goes red while the other six stay green. That was run once and deleted.
   */
  it("a tab changed by the PARENT repaints the strip and does not steal the caret", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("jump"));

    expect(tabButton("History")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByTestId("jump"));
  });
});
