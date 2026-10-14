/**
 * IPD walk 2026-10-14 — A DATE IN THE READER'S LANGUAGE, ON THE HOSPITAL'S CLOCK.
 *
 * The MAR header printed `2026-10-14` (an ISO string) and the beds board hard-coded `en-IN`, so a Hindi screen read
 * "Wed, 14 Oct". Both now go through here: the calendar day is always Asia/Kolkata (a desk machine's own timezone is
 * routinely wrong), and the words follow the language the person chose.
 */
export function intlLocale(lang: string | undefined): string {
  return lang !== undefined && lang.toLowerCase().startsWith("hi") ? "hi-IN" : "en-IN";
}

export function istDayLabel(
  at: Date | string,
  lang: string | undefined,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" },
): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(lang), { ...opts, timeZone: "Asia/Kolkata" }).format(d);
}
