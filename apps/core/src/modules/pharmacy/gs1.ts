/**
 * ═══ PHARMACY P13 — READING A GS1 ELEMENT STRING OFF A PACK ═══
 *
 * A GS1 DataMatrix (export packs, and more domestic packs each year) carries application
 * identifiers: (01) the GTIN, (17) the expiry YYMMDD, (10) the batch. Scanners send it one of two
 * ways, and both are read here:
 *   - bracketed, as printed under the symbol: `(01)08901234567897(17)270630(10)AB12`;
 *   - raw: `01…17…10…`, fixed-length fields back to back, a variable field ended by the ASCII group
 *     separator (29) or by the end of the string. A scanner may prefix a symbology identifier (`]d2`).
 * Anything without a 14-digit GTIN is not trusted as GS1: a plain EAN-13 is looked up as it is. An
 * expiry day of 00 means the month's last day (GS1 General Specifications 7.12). An impossible date
 * is no expiry, not a guess.
 */
export type Gs1 = { gtin: string; expiry: string | null; batch: string | null };

const GS = String.fromCharCode(29);
const FIXED: Record<string, number> = { "01": 14, "11": 6, "13": 6, "15": 6, "17": 6 };
const VARIABLE = new Set(["10", "21"]);

function yymmdd(v: string | undefined): string | null {
  if (v === undefined || !/^\d{6}$/.test(v)) return null;
  const year = 2000 + Number(v.slice(0, 2));
  const month = Number(v.slice(2, 4));
  let day = Number(v.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = last;
  if (day > last) return null;
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseGs1(raw: string): Gs1 | null {
  let s = raw.trim();
  if (/^\][A-Za-z]\d/.test(s)) s = s.slice(3);
  const fields = new Map<string, string>();
  if (s.startsWith("(")) {
    for (const m of s.matchAll(/\((\d{2})\)([^(]*)/g)) fields.set(m[1]!, m[2]!);
  } else {
    let i = 0;
    while (i < s.length) {
      const ai = s.slice(i, i + 2);
      const fixed = FIXED[ai];
      if (fixed !== undefined) {
        fields.set(ai, s.slice(i + 2, i + 2 + fixed));
        i += 2 + fixed;
      } else if (VARIABLE.has(ai)) {
        const end = s.indexOf(GS, i + 2);
        fields.set(ai, s.slice(i + 2, end === -1 ? s.length : end));
        i = end === -1 ? s.length : end;
      } else {
        break;
      }
      if (s[i] === GS) i += 1;
    }
  }
  const gtin = fields.get("01");
  if (gtin === undefined || !/^\d{14}$/.test(gtin)) return null;
  const batch = fields.get("10")?.trim() ?? "";
  return { gtin, expiry: yymmdd(fields.get("17")), batch: batch === "" ? null : batch };
}
