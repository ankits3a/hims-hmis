/**
 * PLAN 07c T7 — THE DARK THEME EXISTS AND HAS NEVER BEEN APPLIED.
 *
 * `styles.css` carries a complete `.dark` block — every shadcn token redefined, plus this phase's
 * four state tokens — and `@custom-variant dark (&:is(.dark *))` to drive it. Measured at kickoff:
 * **no code anywhere in the SPA adds that class.** The theme was shipped and then never wired, which
 * is the most expensive kind of dead code: it looks done in review and does nothing in the hospital.
 *
 * ═══ WHY A HOSPITAL WANTS IT, SO THIS IS NOT A PREFERENCE TOGGLE ═══
 *
 * The screens that run overnight — the token display in a corridor, a ward terminal, the counter on
 * a night shift — sit in dark rooms where a full-white page is the brightest object in the room.
 * That is a real complaint on real hardware, not a taste.
 *
 * ═══ WHY IT IS PER BROWSER AND NOT PER USER ═══
 *
 * The choice belongs to the TERMINAL, not to the person: the same clerk wants light at a bright
 * front counter at 11am and dark on the ward machine at 2am, and a preference stored against their
 * account would follow them to the wrong one. `localStorage` is per device per browser, which is
 * exactly the grain. It also means it survives sign-out, which a shared terminal wants.
 */
const THEME_KEY = "hmis.theme";
export type Theme = "light" | "dark";

export function storedTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

/**
 * Applied to `<html>` rather than to a wrapper element, because `@custom-variant dark` matches
 * `.dark *` — a descendant selector, so the class must sit ABOVE everything it should recolour, and
 * `body`'s own `bg-background` is one of those things. A wrapper inside `body` would leave the page
 * background light behind a dark app, which is the exact half-applied look that reads as a bug.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}
