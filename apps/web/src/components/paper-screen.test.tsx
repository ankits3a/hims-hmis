import { act, render } from "@testing-library/react";
import "../lib/i18n";
import { PaperScreen } from "./paper-screen";

/**
 * Owner 2026-10-05, a phone on production: the vitals bay shrank to a strip and its ask bar sat in
 * the middle of the screen with blank page below it.
 *
 * The shell is `min-h-screen` with the screen in a `flex-1` wrapper, so whenever the screen fits,
 * the page is exactly one viewport tall and the "what sits below me" term read off
 * `scrollHeight` came out as whatever the wrapper had stretched to fill — the screen's own old
 * offset. Once the offset was too big (the header taller for a moment, a patient strip that then
 * went away) nothing could make it smaller again. The model below lays the shell out the way the
 * browser does, and moves the header stack.
 */
describe("PaperScreen height", () => {
  const VIEWPORT = 780;
  const LEGEND = 25;
  let header = 60;
  let strip = 120;

  function offsetOf(el: HTMLElement): number {
    const m = /- (\d+)px\)$/.exec(el.style.getPropertyValue("--pp-h"));
    return m === null ? 96 : Number(m[1]);
  }

  function layOut(screen: HTMLElement, wrap: HTMLElement, legend: HTMLElement): void {
    const own = (): number => VIEWPORT - offsetOf(screen);
    Object.defineProperty(screen, "offsetParent", { configurable: true, get: () => null });
    Object.defineProperty(screen, "offsetTop", { configurable: true, get: () => header + strip });
    Object.defineProperty(screen, "offsetHeight", { configurable: true, get: own });
    Object.defineProperty(wrap, "offsetHeight", { configurable: true, get: () => Math.max(own(), VIEWPORT - header - strip - LEGEND) });
    Object.defineProperty(legend, "offsetHeight", { configurable: true, get: () => LEGEND });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true, get: () => Math.max(VIEWPORT, header + strip + own() + LEGEND),
    });
  }

  it("gives the space back when the header stack gets shorter", () => {
    header = 60; strip = 120;
    const wrap = document.createElement("div");
    const legend = document.createElement("footer");
    document.body.append(wrap, legend);
    // Lay out before mount, so the first measurement already sees the model.
    const probe = document.createElement("div");
    wrap.append(probe);
    const { container } = render(<PaperScreen testId="pp"><p>bay</p></PaperScreen>, { container: probe });
    const screen = container.querySelector<HTMLElement>("[data-testid=pp]")!;
    layOut(screen, wrap, legend);
    act(() => { window.dispatchEvent(new Event("resize")); });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(offsetOf(screen)).toBe(60 + 120 + LEGEND);

    strip = 0; // the patient is released: the strip goes away
    act(() => { window.dispatchEvent(new Event("resize")); });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(offsetOf(screen)).toBe(60 + LEGEND);
    wrap.remove(); legend.remove();
  });
});
