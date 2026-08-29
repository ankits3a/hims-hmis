import { applyTheme, setTheme, storedTheme } from "./theme";

/**
 * PLAN 07c T7 — the theme was fully defined in CSS and applied by NOTHING. These assertions are
 * about the wiring, which is the half that was missing: the class must land on `<html>` (the
 * `dark` variant is `&:is(.dark *)`, a descendant selector, so a wrapper inside `body` would leave
 * the page background light behind a dark app) and it must survive a reload.
 */
afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

it("defaults to light, including when the stored value is something else entirely", () => {
  expect(storedTheme()).toBe("light");
  localStorage.setItem("hmis.theme", "midnight");
  expect(storedTheme()).toBe("light");
});

it("puts the class on <html>, not on a wrapper — the dark variant is a descendant selector", () => {
  setTheme("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.body.classList.contains("dark")).toBe(false);
});

it("persists across a reload, which is what makes it a terminal's setting rather than a click", () => {
  setTheme("dark");
  document.documentElement.classList.remove("dark"); // a fresh document, as a reload gives
  expect(storedTheme()).toBe("dark");
  applyTheme(storedTheme());
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("going back to light REMOVES the class rather than leaving both states asserted", () => {
  setTheme("dark");
  setTheme("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(storedTheme()).toBe("light");
});
