/**
 * #1036 (owner 2026-11-06) — WIDAL TITRES, one rule for the server, the web bench and the phone.
 *
 * A positive Widal read as negative: S. typhi O and H carried the range "Negative", and a titre was never flagged
 * because only numbers are. A titre is an agglutination endpoint written `1:<dilution>`; the range book holds the
 * cut-off as text, "Up to 1:80", so the curator's sentence and the flag cannot drift apart. Above the limit is `A`
 * (abnormal), at or below it, and "Negative", is `N`.
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
 * `1:160`, `1 : 160`, `1;160` (the typo prod already holds) → `1:160`; `negative`, `NEG`, `nil` → `Negative`
 * (dilution 0). Anything else is not a titre.
 */
export function parseTitre(raw: string): ParsedTitre {
  const s = raw.trim();
  if (/^(negative|neg|nil)$/i.test(s)) return { ok: true, value: "Negative", dilution: 0 };
  const m = /^1\s*[:;]\s*(\d{1,5})$/.exec(s);
  if (m === null) return { ok: false };
  const dilution = Number(m[1]);
  if (dilution < 2) return { ok: false };
  return { ok: true, value: `1:${dilution}`, dilution };
}

/** "Up to 1:80" → 80. A range written any other way is not a titre range, and nothing is flagged by it. */
export function titreLimit(rangeText: string | null | undefined): number | null {
  const m = /^up to 1:(\d+)$/i.exec((rangeText ?? "").trim());
  return m === null ? null : Number(m[1]);
}

/** The flag for a titre against a titre range; null when either is not one. */
export function titreFlag(value: string, rangeText: string | null | undefined): "A" | "N" | null {
  const limit = titreLimit(rangeText);
  if (limit === null) return null;
  const t = parseTitre(value);
  if (!t.ok) return null;
  return t.dilution > limit ? "A" : "N";
}
