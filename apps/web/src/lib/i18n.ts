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

export function switchLanguage(lng: "en" | "hi"): void {
  localStorage.setItem(LANG_KEY, lng);
  void i18next.changeLanguage(lng);
}

export default i18next;
