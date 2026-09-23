import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

/*
  CONSULT V2 (2026-09-23) — the consult remembers its side columns for the browser SESSION. jsdom's
  sessionStorage lives for the whole test file, so without this a pane one test opened would already be
  open in the next test, and a suite would pass or fail by the order its tests ran in.
*/
afterEach(() => {
  try { window.sessionStorage.clear(); } catch { /* a non-DOM environment has none */ }
});

/*
 * THE CONSULT SCREEN'S DEFAULTS FOLLOW THE VIEWPORT (≥1440 both side columns open). jsdom reports
 * 1024, which would fold both columns in every suite; suites are written for the desktop the screen
 * is designed for, and the responsive defaults are exercised by the browser walk, not by jsdom.
 */
Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
