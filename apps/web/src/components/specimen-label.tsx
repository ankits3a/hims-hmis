/**
 * PLAN 17c T2 / D5 — THE FIRST LABEL ANYONE CAN PRINT.
 *
 * `printLabels` (17a T5) mints `S` numbers and fires `lab.label_printed`, and nothing in the
 * repository ever drew a barcode: the chair saw an id and a container name (17c §2 row 3). This
 * component is the paper — a 50 × 25 mm label, one per tube, Code 128 (subset B) over the
 * specimen number, the patient beside it so a tube can never be matched to a person by memory.
 *
 * ═══ WHY CODE 128 B, AND WHY IT IS WRITTEN HERE RATHER THAN LOADED ═══
 *
 * Every bench scanner and every analyser barcode reader on the owner's list (design board 6)
 * reads Code 128 out of the box; it is what the national chains print. Subset B carries the `S`
 * and the digits in one symbology at ~40 mm for an eleven-character number, which fits the label
 * with quiet zones. The encoder is ~40 lines and a checksum; a library would be a network fetch
 * the SPA does not make (`caddyfile-parity`'s ONE DOOR rule) for less code than this file.
 *
 * ═══ THE ORDER OF DRAW IS THE SERVER'S, COPIED ONCE ═══
 *
 * `DRAW_ORDER` mirrors `modules/lab/desk.ts` — CLSI order keyed on the catalogue's container
 * vocabulary. Two copies that must agree, disclosed here; the server's tube plan is already sorted
 * and the chair re-sorts the LABELLED tubes it reads back from the queue, which come by number.
 */

const CODE128_PATTERNS: readonly string[] = [
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
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

/** Subset B value of a printable ASCII character (space … DEL). Anything else is refused. */
function code128BValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 127) throw new Error(`code128: "${ch}" is outside subset B`);
  return code - 32;
}

/** The checksum symbol value: (START B + Σ valueᵢ × i) mod 103, i from 1. */
export function code128BChecksum(text: string): number {
  let sum = START_B;
  for (let i = 0; i < text.length; i += 1) sum += code128BValue(text[i]!) * (i + 1);
  return sum % 103;
}

/** The symbol as module widths — bar, space, bar, space … — including start, checksum and stop. */
export function code128BPattern(text: string): string {
  if (text.length === 0) throw new Error("code128: nothing to encode");
  const values = [START_B, ...[...text].map(code128BValue), code128BChecksum(text), STOP];
  return values.map((v) => CODE128_PATTERNS[v]!).join("");
}

export type Bar = { x: number; width: number };

/** Bars only (spaces are the gaps), in modules from the left edge after the quiet zone. */
export function code128BBars(text: string, quietZone = 10): { bars: Bar[]; widthModules: number } {
  const pattern = code128BPattern(text);
  const bars: Bar[] = [];
  let x = quietZone;
  for (let i = 0; i < pattern.length; i += 1) {
    const w = Number(pattern[i]);
    if (i % 2 === 0) bars.push({ x, width: w });
    x += w;
  }
  return { bars, widthModules: x + quietZone };
}

export const DRAW_ORDER: readonly string[] = [
  "blood_culture", "citrate", "sst", "plain", "heparin", "edta", "fluoride",
];
export function drawRank(container: string): number {
  const i = DRAW_ORDER.indexOf(container);
  return i === -1 ? DRAW_ORDER.length : i;
}

/** The colour of the cap, by container — what the phlebotomist reaches for. */
const CAP: Record<string, string> = {
  blood_culture: "bottle", citrate: "blue", sst: "gold", plain: "red", heparin: "green",
  edta: "lavender", fluoride: "grey", urine_container: "cup", stool_container: "cup", sterile_container: "sterile",
};
export function capFor(container: string): string {
  return CAP[container] ?? container;
}

export type SpecimenLabelProps = {
  specimenNo: string;
  patientDisplay: string;
  uhid: string;
  container: string;
  specimenType: string;
  codes: string[];
  /** ISO date of the service day; printed as-is. */
  serviceDate: string;
  tokenNo?: number | null;
};

const MODULE_MM = 0.25;
const LABEL_W = 50;
const LABEL_H = 25;

/**
 * One label. Rendered as SVG at physical size so the browser's print dialog puts the bars on the
 * paper at exactly 0.25 mm per module — the widest reader tolerance on the owner's bench.
 */
export function SpecimenLabel(props: SpecimenLabelProps): React.ReactElement {
  const { bars, widthModules } = code128BBars(props.specimenNo);
  const barcodeW = widthModules * MODULE_MM;
  const left = (LABEL_W - barcodeW) / 2;
  return (
    <svg
      className="specimen-label"
      data-testid={`label-${props.specimenNo}`}
      width={`${LABEL_W}mm`}
      height={`${LABEL_H}mm`}
      viewBox={`0 0 ${LABEL_W} ${LABEL_H}`}
      role="img"
      aria-label={`${props.specimenNo} ${props.patientDisplay} ${props.container}`}
    >
      <rect x="0" y="0" width={LABEL_W} height={LABEL_H} fill="white" />
      <text x="1.5" y="3.2" fontSize="2.6" fontFamily="sans-serif" fontWeight="700">{props.patientDisplay}</text>
      <text x={LABEL_W - 1.5} y="3.2" fontSize="2.2" fontFamily="monospace" textAnchor="end">{props.uhid}</text>
      <g data-testid="barcode" transform={`translate(${left} 4.5)`}>
        {bars.map((b) => (
          <rect key={b.x} x={b.x * MODULE_MM} y="0" width={b.width * MODULE_MM} height="9" fill="black" />
        ))}
      </g>
      <text x={LABEL_W / 2} y="16.8" fontSize="3" fontFamily="monospace" textAnchor="middle" letterSpacing="0.3">
        {props.specimenNo}
      </text>
      <text x="1.5" y="20.5" fontSize="2.2" fontFamily="sans-serif" fontWeight="700">
        {capFor(props.container)} · {props.specimenType}
      </text>
      <text x="1.5" y="23.6" fontSize="2.1" fontFamily="sans-serif">
        {props.codes.join(" · ")}
      </text>
      <text x={LABEL_W - 1.5} y="23.6" fontSize="2" fontFamily="monospace" textAnchor="end">
        {props.tokenNo !== null && props.tokenNo !== undefined ? `T-${String(props.tokenNo)} · ` : ""}{props.serviceDate}
      </text>
    </svg>
  );
}
