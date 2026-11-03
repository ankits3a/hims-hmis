/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #1029 — A CODE 128 THAT ACTUALLY SCANS, WITH NO DEPENDENCY AND NO NETWORK
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The OPD token slip used to carry `barField`, a bar-shaped picture seeded from the visit number
 * that no scanner could read. Owner 2026-11-03: *"both, phones and USB guns; go with QR plus Code
 * 128"*; after scanning both, the same day: *"keep only barcode on token slip"*. This is that
 * barcode: the counter's 1D guns read it, and so does the staff app's camera.
 *
 * Same constraints as `qr.ts`: no runtime dependency in the server image, and the output is a
 * self-contained SVG of `<rect>`s (the relay prints the HTML it is handed, with no script and no
 * fetch).
 *
 * ═══ SCOPE: PRINTABLE ASCII, CODE SETS B AND C ═══
 *
 * Code set B covers ASCII 32–126. Code set C packs two digits into one symbol, so a run of four or
 * more digits switches to C — `V2610060001` becomes Start B, `V`, Code C, five digit pairs, check,
 * Stop: 112 modules instead of 156. Code set A (control characters) is never needed for anything
 * HMIS prints, so it is absent; `encodeCode128` THROWS on any character outside ASCII 32–126
 * rather than printing a code that scans as something else.
 *
 * ═══ HOW IT IS KNOWN TO BE CORRECT ═══
 *
 * `code128.test.ts` pins the symbol values for the real payload by hand from the standard's table,
 * and pins every width pattern's module count. Before commit, the module patterns for every
 * character of code set B and every digit pair of code set C were rasterised and read back by
 * `@zxing/library@0.21.3` — an independent DECODER — which returned the exact input each time.
 */

/** Bar/space widths for symbol values 0–105, six elements each, summing to 11 modules. */
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
/** The stop symbol: seven elements, 13 modules (the trailing 2-module bar is the termination bar). */
const STOP = "2331112";

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

/** Exported for the test only. */
export const CODE128_PATTERNS = PATTERNS;
export const CODE128_STOP = STOP;

/** Length of the run of ASCII digits starting at `i`. */
function digitRun(s: string, i: number): number {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n += 1;
  return n;
}

/**
 * The symbol values for `payload`, from the start symbol through the check symbol (the stop
 * symbol is not a value and is appended by the drawing).
 */
export function code128Values(payload: string): number[] {
  if (payload === "") throw new Error("code128: empty payload");
  for (const ch of payload) {
    const c = ch.charCodeAt(0);
    if (ch.length !== 1 || c < 32 || c > 126) throw new Error(`code128: character outside ASCII 32-126 in ${JSON.stringify(payload)}`);
  }
  const values: number[] = [];
  let mode: "B" | "C";
  let i = 0;
  const lead = digitRun(payload, 0);
  if (lead >= 4 || (lead === payload.length && lead >= 2 && lead % 2 === 0)) {
    mode = "C";
    values.push(START_C);
  } else {
    mode = "B";
    values.push(START_B);
  }
  while (i < payload.length) {
    const run = digitRun(payload, i);
    if (mode === "C") {
      if (run >= 2) {
        values.push(Number(payload.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE_B);
      mode = "B";
      continue;
    }
    // Mode B. A run of four or more digits is cheaper in C; an odd run gives its first digit to B.
    if (run >= 4) {
      if (run % 2 === 1) {
        values.push(payload.charCodeAt(i) - 32);
        i += 1;
      }
      values.push(CODE_C);
      mode = "C";
      continue;
    }
    values.push(payload.charCodeAt(i) - 32);
    i += 1;
  }
  let sum = values[0]!;
  for (let k = 1; k < values.length; k += 1) sum += k * values[k]!;
  values.push(sum % 103);
  return values;
}

/** The element widths, bar first and alternating, for the whole symbol including stop. */
export function code128Widths(payload: string): number[] {
  const widths: number[] = [];
  for (const v of code128Values(payload)) for (const d of PATTERNS[v]!) widths.push(Number(d));
  for (const d of STOP) widths.push(Number(d));
  return widths;
}

/**
 * An SVG of the code, sized in millimetres so each module lands on whole printer dots.
 *
 * `moduleMm` defaults to 0.375 mm: three dots of a 203 dpi thermal head (0.125 mm a dot). A
 * fractional dot count makes bars of the same width print one dot apart, and a 1D reader measures
 * exactly those widths. `quietModules` defaults to the standard's minimum of ten each side.
 */
export function code128Svg(payload: string, heightMm = 10, moduleMm = 0.375, quietModules = 10): string {
  const widths = code128Widths(payload);
  const total = widths.reduce((a, b) => a + b, 0) + quietModules * 2;
  const rects: string[] = [];
  let x = quietModules;
  widths.forEach((w, k) => {
    if (k % 2 === 0) rects.push(`<rect x="${String(x)}" width="${String(w)}" height="1"/>`);
    x += w;
  });
  const wMm = (total * moduleMm).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wMm}mm" height="${String(heightMm)}mm" viewBox="0 0 ${String(total)} 1" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="visit number barcode"><rect width="${String(total)}" height="1" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}
