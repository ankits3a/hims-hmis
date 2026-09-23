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
