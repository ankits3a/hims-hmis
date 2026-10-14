import i18next from "i18next";

/**
 * The locale a date with a named month or weekday is written in: Hindi when the app is in Hindi,
 * otherwise the screen's own English (`en-IN` by default; some screens print the `en-GB` short
 * month). Read at render time, so a component that re-renders on a language switch follows it.
 */
export function dateLocale(lang: string | undefined = i18next.language, english = "en-IN"): string {
  return lang?.startsWith("hi") === true ? "hi-IN" : english;
}
