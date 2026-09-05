import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import "../styles/paper-pine.css";
import "../screens/desk-one/desk-one.css";

/**
 * ═══ FD-25 T0 — THE `.pp` SCREEN, AS ONE COMPONENT INSTEAD OF A CLASSNAME EVERYBODY RETYPES ═══
 *
 * There are two ways to wear paper-and-pine. `.d1` OWNS THE VIEWPORT: `position: fixed; inset: 0`
 * over an opaque ground, the route carries `staticData.fullViewport`, and the shell renders none of
 * its own chrome. Desk One is the only screen that does that, and it earns it — a one-person desk
 * with its own header, its own command key and its own dock does not want a second set of doors
 * above it.
 *
 * `.pp` IS THE OTHER WAY: the same language, INSIDE the app shell, under the nav and the patient
 * strip. It is what a screen wears when it is one seat among several and a clerk still needs to
 * reach the rest of the application from it.
 *
 * ═══ WHY A COMPONENT AND NOT `className="pp"` ═══
 *
 * Because `className="pp"` was already how it was done, twice, and BOTH mounts shipped with three
 * defects that no test in this repository can see. `/opd/appointments` and `/patients/:id` have
 * carried all three since FD-23:
 *
 *   1. NO PALETTE. `styles/paper-pine.css` scoped the tokens to `.d1, .lg, .dash, .shell` and `.pp`
 *      was not in the list, so every `var(--green)` in a `.pp` subtree resolved to nothing. `.shell`
 *      sits on the <header> element, not on an ancestor of the outlet, so it never cascaded down.
 *      Fixed in that file; this component's import is what guarantees the file is in the bundle.
 *
 *   2. NO PRIMITIVES UNDER CODE-SPLITTING. `desk-one.css` carries the `.pp` half of every primitive
 *      (`.d1 .box, .pp .box` and thirty more) and was imported from exactly one place —
 *      `desk-one.tsx`. A screen that never mounts Desk One in its route tree is not guaranteed that
 *      chunk. The import belongs to whoever USES the primitives, which is this component.
 *
 *   3. NO `data-lang`. `desk-one.css` scopes `.pp[data-lang="hi"]` — Devanagari has no case and no
 *      letter-spacing, so `.tag`'s `text-transform: uppercase` and `.14em` tracking are wrong for it
 *      — and neither `.pp` mount ever stamped the attribute. `.d1` does. This lane has already paid
 *      for that exact defect twice (FD-10 on login, FD-11 on Desk One), and the third and fourth
 *      copies were sitting in the tree unreported.
 *
 * All three are invisible to vitest: jsdom does not compute custom properties, does not load
 * stylesheets, and does not care what `data-lang` says. They are found by looking at the screen.
 * One component means the next `.pp` screen cannot re-buy any of them by forgetting.
 */
export function PaperScreen({
  children,
  testId,
  style,
}: {
  children: React.ReactNode;
  /** Screens that already have a testid keep it, so their suites do not move. */
  testId?: string;
  /** Layout only. Palette and primitives come from the class, never from an inline override. */
  style?: React.CSSProperties;
}): React.ReactElement {
  const { i18n } = useTranslation();

  /**
   * ═══ THE SHELL'S HEIGHT IS MEASURED, NOT ASSUMED ═══
   *
   * This read `calc(100vh - 96px)`, and 96 was a guess. The shell is 119px on `/opd/vitals`, so
   * every `.pp` screen was 23px taller than the space it had: the page grew a scrollbar, and
   * whatever sits at the FOOT of the screen — which on three of these seats is the agent dock —
   * went under the fold. A dock a nurse has to scroll to is a dock nobody uses, and it is the
   * "footer agent bar" ruling quietly undone by an arithmetic constant.
   *
   * A second guess would be the same defect with a different number, so this measures its own
   * distance from the top of the viewport. `useLayoutEffect` runs before paint, so the screen is
   * never shown at the wrong height, and the listener re-measures when the shell reflows (a patient
   * strip appearing, a nav wrapping, a window resize).
   *
   * The fallback stays 96px for the first frame in an environment with no layout — jsdom returns 0
   * for every rect, and a suite must not see a screen with a nonsense height.
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = rootRef.current;
      if (el === null) return;
      /*
        THE OFFSET CHAIN, NOT A BOUNDING RECT. `getBoundingClientRect().top` is relative to the
        VIEWPORT, so it moves when the page scrolls, and the correction (`+ window.scrollY`) is only
        right while the window is the scroller. Chasing it produced a screen whose height changed as
        the nurse scrolled. `offsetTop` up the `offsetParent` chain is a layout position: it does not
        know what scrolled and cannot be wrong about it.
      */
      let top = 0;
      for (let n: HTMLElement | null = el; n !== null; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;

      /*
        AND WHAT THE SHELL PUTS BELOW US. `router.tsx` renders `<ShortcutLegend />` after the outlet,
        so a screen sized to `100vh - top` is exactly the legend's height too tall and the page grows
        a scrollbar — which is how the dock ended up 42px under the fold with the top offset already
        correct. This term is independent of our own height (`scrollHeight` moves with it, one for
        one), so the two settle in a single pass instead of chasing each other.
      */
      const below = Math.max(0, document.documentElement.scrollHeight - (top + el.offsetHeight));
      setOffset(top + below <= 0 ? null : Math.round(top + below));
    };
    measure();
    window.addEventListener("resize", measure);
    /*
      AND AGAIN WHENEVER THE SHELL MOVES. One measurement at mount is not enough and the browser
      proved it: the first read returned 77px against a real 119px, because the nav and the patient
      strip above this screen had not finished laying out when `useLayoutEffect` ran. The screen was
      then 42px too tall for the rest of its life, which is the same defect as the hardcoded 96 with
      an extra step.
      This converges rather than oscillating: the root's TOP does not depend on the root's own
      height, so a second pass reads the same number and React bails out on the identical state.
    */
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(document.body);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
  }, []);

  return (
    <div
      ref={rootRef}
      className="pp"
      /*
        The STYLESHEET's key, not the document's. `lib/i18n.ts` already stamps `<html lang>` for the
        screen reader; this is the separate, visual half — and it reads `i18n.language` off the live
        instance so a language switch repaints without a reload.
      */
      data-lang={i18n.language.startsWith("hi") ? "hi" : "en"}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      style={{
        display: "flex",
        flexDirection: "column",
        /*
          A `.pp` screen fills what is LEFT of the viewport rather than the whole of it — that is the
          entire difference from `.d1`, and it is why this screen keeps the nav above it.
        */
        minHeight: "var(--pp-h)",
        /*
          Published as a variable so a screen that wants to BE one viewport rather than at least one
          — the bay, which has a dock at its foot — can say `height: "var(--pp-h)"` without
          re-deriving the shell's height and getting a different answer.
        */
        ["--pp-h" as string]: `calc(100vh - ${String(offset ?? 96)}px)`,
        background: "var(--paper)",
        color: "var(--ink)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The screen's own title row — NOT a second header bar.
 *
 * ═══ THE TWO-HEADERS TRAP, RESOLVED ONCE HERE ═══
 *
 * Every three-seats artboard draws its own 44px top bar: `CRK | Registration`, the mono route, a
 * status pill and an action button. Drawn literally inside the shell that is TWO stacked header
 * bars, two brand marks and two competing rows of chrome — which is worse than either alone.
 *
 * The resolution is that the artboards were drawn as standalone canvases, so each had to say which
 * screen it was. Inside the shell the application already says that. What survives from the
 * artboard's bar is everything that is genuinely about THIS SCREEN and nothing that is about the
 * application: the seat's name, its route (a clerk reading a bug report needs it), and the bar's
 * right-hand actions. What is dropped is the `CRK` brand, which the shell owns.
 *
 * One app header, one screen title. That is the ordinary shape of every other screen in this
 * application, and the artboard's spirit — say where you are, put the actions where the eye lands —
 * is kept exactly.
 */
export function ScreenTitle({
  title,
  route,
  subtitle,
  actions,
}: {
  title: string;
  /** The mono path, e.g. `/registration`. Faint, and deliberately selectable. */
  route?: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 11, flexWrap: "wrap" }}>
      <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{title}</span>
      {route === undefined ? null : (
        <span className="mo" style={{ fontSize: 11, color: "var(--faint)" }}>{route}</span>
      )}
      {subtitle === undefined ? null : (
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{subtitle}</span>
      )}
      {actions === undefined ? null : (
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {actions}
        </span>
      )}
    </div>
  );
}
