import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import hi from "../locales/hi.json";

const LANG_KEY = "hmis.lang";

void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: localStorage.getItem(LANG_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React escapes
});

/**
 * ═══ THE LANGUAGE HAS TO REACH `<html lang>`, NOT JUST THE STRINGS ═══
 *
 * FD-10 fixed the Devanagari type rules by stamping `data-lang` on the login root, which is what the
 * STYLESHEET needs. It is not what a screen reader needs. `index.html` ships `<html lang="en">` and
 * nothing ever changed it, so a clerk running a screen reader on the Hindi interface heard
 * Devanagari pronounced by an English voice — the same defect the type fix was about, one layer up
 * and inaudible in every screenshot. It is also what a browser uses to pick language-correct
 * hyphenation and font fallback, so it is not only an assistive-technology concern.
 *
 * Set on the switch AND on module load, because the language is restored from `localStorage` before
 * anybody touches the toggle: a person who chose Hindi yesterday gets a Hindi document today.
 */
function stampDocumentLanguage(lng: string): void {
  document.documentElement.lang = lng.startsWith("hi") ? "hi" : "en";
}

stampDocumentLanguage(i18next.language);

export function switchLanguage(lng: "en" | "hi"): void {
  localStorage.setItem(LANG_KEY, lng);
  void i18next.changeLanguage(lng);
  stampDocumentLanguage(lng);
}

export default i18next;
