/**
 * #1036 (owner 2026-11-06) — WIDAL TITRES, one rule for the server, the web bench and the phone.
 *
 * A positive Widal read as negative: S. typhi O and H carried the range "Negative", and a titre was never flagged
 * because only numbers are. A titre is an agglutination endpoint written `1:<dilution>`; the range book holds the
 * cut-off as text, "Up to 1:80", so the curator's sentence and the flag cannot drift apart. Above the limit is `A`
 * (abnormal), at or below it, and "Non-Reactive", is `N`.
 *
 * Owner 2026-11-10 (two reference reports, tube and slide): the cut-off differs by antigen, so it lives here
 * (`WIDAL_SIGNIFICANT_FROM`) and no longer in the range text. S. typhi O and S. Paratyphi AH and BH are significant
 * at 1:80 or more, S. typhi H at 1:160 or more. Every antigen's range reads "Non-Reactive", no agglutination is
 * written "Non-Reactive", and the printed report writes a titre as "Reactive up to titre 1:320".
 *
 * No zod and no imports: the phone app reads this file too and installs only its own packages.
 */

/** The four antigens of the slide and tube Widal tests. Only these refuse a value that is not a titre. */
export const WIDAL_ANALYTE_CODES = ["WIDAL_TO", "WIDAL_TH", "WIDAL_AH", "WIDAL_BH"] as const;

/** The grid's dilutions. 1:640 is left out (owner: "we hardly use 1:640"); it can still be typed. */
export const WIDAL_DILUTIONS = [20, 40, 80, 160, 320] as const;

export const isWidalAnalyte = (code: string): boolean => (WIDAL_ANALYTE_CODES as readonly string[]).includes(code);

export type ParsedTitre = { ok: true; value: string; dilution: number } | { ok: false };

/**
 * `1:160`, `1 : 160`, `1;160` (the typo prod already holds) → `1:160`; `non-reactive`, `NR`, `negative`, `NEG`,
 * `nil` → `Non-Reactive` (dilution 0). Anything else is not a titre.
 */
export function parseTitre(raw: string): ParsedTitre {
  const s = raw.trim();
  if (/^(non[\s-]?reactive|nr|negative|neg|nil)$/i.test(s)) return { ok: true, value: "Non-Reactive", dilution: 0 };
  const m = /^1\s*[:;]\s*(\d{1,5})$/.exec(s);
  if (m === null) return { ok: false };
  const dilution = Number(m[1]);
  if (dilution < 2) return { ok: false };
  return { ok: true, value: `1:${dilution}`, dilution };
}

/** The lowest significant titre of each antigen (owner 2026-11-10, from the reference reports). */
export const WIDAL_SIGNIFICANT_FROM: Record<(typeof WIDAL_ANALYTE_CODES)[number], number> = {
  WIDAL_TO: 80, WIDAL_TH: 160, WIDAL_AH: 80, WIDAL_BH: 80,
};

/** `A` at or above the antigen's significant titre, `N` below it and for Non-Reactive; null when not a Widal titre. */
export function widalFlag(code: string, value: string): "A" | "N" | null {
  const from = (WIDAL_SIGNIFICANT_FROM as Record<string, number | undefined>)[code];
  if (from === undefined) return null;
  const t = parseTitre(value);
  if (!t.ok) return null;
  return t.dilution >= from ? "A" : "N";
}

/** How the printed report writes a Widal value: `1:320` → "Reactive up to titre 1:320"; anything else as saved. */
export function widalPrintValue(value: string): string {
  return /^1:\d+$/.test(value) ? `Reactive up to titre ${value}` : value;
}

/** The note printed under a Widal table (owner 2026-11-10: the short form of the reference report's notes). */
export const WIDAL_REPORT_NOTE = "Significant titres: S. typhi O 1:80 or more, S. typhi H 1:160 or more, S. Paratyphi AH and BH "
  + "1:80 or more. Rising titres in paired samples taken 7–10 days apart are more significant than a single test. "
  + "Confirm by blood culture before starting antibiotics.";
