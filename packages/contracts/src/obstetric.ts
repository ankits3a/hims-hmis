import { z } from "zod";

/**
 * PLAN 18-S RS7 T2 — **OBSTETRIC BIOMETRY: the published formulas, as pure functions both sides share.**
 *
 * The sonologist types what the machine measured (millimetres, beats per minute, centimetres of
 * liquor) and the hospital computes the rest. The server recomputes every derived value when the
 * report is saved — the screen's live figures are a preview of the same arithmetic, never an input.
 *
 * ═══ THE FORMULAS, AND WHERE EACH COMES FROM ═══
 *
 *   · **GA from CRL — Robinson & Fleming 1975** (Br J Obstet Gynaecol 82:702):
 *     GA (days) = 8.052 × √CRL(mm) + 23.73. The first-trimester dating standard (BMUS, ISUOG).
 *   · **GA from BPD, HC, AC, FL — Hadlock 1984** (Radiology 152:497), measurements in cm:
 *       BPD: 9.54 + 1.482·BPD + 0.1676·BPD²
 *       HC:  8.96 + 0.540·HC + 0.0003·HC³
 *       AC:  8.14 + 0.753·AC + 0.0036·AC²
 *       FL: 10.35 + 2.460·FL + 0.170·FL²
 *   · **EFW — Hadlock 1985** (Am J Obstet Gynecol 151:333), grams, measurements in cm:
 *       4-parameter: log₁₀EFW = 1.3596 − 0.00386·AC·FL + 0.0064·HC + 0.00061·BPD·AC + 0.0424·AC + 0.174·FL
 *       3-parameter (no BPD): log₁₀EFW = 1.326 − 0.00326·AC·FL + 0.0107·HC + 0.0438·AC + 0.158·FL
 *   · **Composite GA** — CRL when a CRL is given (it is the more accurate dating in the first
 *     trimester, and a CRL is not measured after it); otherwise the mean of the Hadlock parameter
 *     ages present (the machines' "AUA", average ultrasound age). DECIDED: the arithmetic mean, the
 *     convention every console in an Indian department prints.
 *   · **EDD** — by LMP, Naegele (LMP + 280 days); by scan, scan day + (280 − GA days).
 *   · **Liquor** — AFI < 5 cm oligohydramnios, 5–24 cm normal, ≥ 25 cm polyhydramnios.
 *
 * Out-of-range measurements are REFUSED by the schema rather than extrapolated: a CRL of 150 mm or a
 * FL of 20 cm is a typing error, and a dating formula applied outside the range it was fitted on
 * prints a confident wrong date.
 *
 * ═══ NO FIELD FOR THE SEX OF THE FOETUS ═══
 *
 * There is not one, anywhere in the input or the derived block, and there never will be (PCPNDT
 * Act 1994 s.5(2)). The schema is `strict`: an extra key — `sex`, `gender`, anything — is refused,
 * not ignored.
 */

const mm = (max: number) => z.number().positive().max(max).nullish();

export const PLACENTA_POSITIONS = [
  "anterior", "posterior", "fundal", "lateral", "low_lying", "praevia",
] as const;
export const PRESENTATIONS = ["cephalic", "breech", "transverse", "variable"] as const;

export const foetusBiometrySchema = z.object({
  /** "A", "B" … — twins are labelled the way the report names them. */
  label: z.string().regex(/^[A-D]$/),
  crlMm: mm(95),
  bpdMm: mm(110),
  hcMm: mm(400),
  acMm: mm(450),
  flMm: mm(85),
  fhrBpm: z.number().int().min(0).max(260).nullish(),
  presentation: z.enum(PRESENTATIONS).nullish(),
}).strict();

export const obstetricBiometryInputSchema = z.object({
  /** The last menstrual period, an IST calendar day. Optional — many women do not know it. */
  lmp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  foetuses: z.array(foetusBiometrySchema).min(1).max(4),
  afiCm: z.number().min(0).max(60).nullish(),
  placenta: z.enum(PLACENTA_POSITIONS).nullish(),
}).strict();

export type FoetusBiometry = z.infer<typeof foetusBiometrySchema>;
export type ObstetricBiometryInput = z.infer<typeof obstetricBiometryInputSchema>;

export type GaMethod = "crl" | "hadlock_mean" | null;
export type Liquor = "oligohydramnios" | "normal" | "polyhydramnios";

export type FoetusDerived = {
  label: string;
  gaDays: { crl: number | null; bpd: number | null; hc: number | null; ac: number | null; fl: number | null };
  /** The one age this foetus is dated by, and how. */
  gaCompositeDays: number | null;
  method: GaMethod;
  efwGrams: number | null;
  efwFormula: "hadlock_4" | "hadlock_3" | null;
  /** FHR outside 110–160 bpm (a flag for the reader, never a diagnosis). */
  fhrOutsideRange: boolean;
};

export type ObstetricDerived = {
  scanDate: string;
  gaByLmpDays: number | null;
  eddByLmp: string | null;
  foetuses: FoetusDerived[];
  numberOfFoetuses: number;
  /** Foetus A's composite age — the pregnancy is dated by the first-named foetus. */
  gaByScanDays: number | null;
  eddByScan: string | null;
  /** Scan age minus LMP age, in days; |x| > 14 is worth a sentence in the report. */
  discordanceDays: number | null;
  liquor: Liquor | null;
};

/** Robinson & Fleming 1975. GA in days, or null outside the fitted range (CRL 3–95 mm). */
export function gaFromCrlDays(crlMm: number): number | null {
  if (!(crlMm >= 3 && crlMm <= 95)) return null;
  return 8.052 * Math.sqrt(crlMm) + 23.73;
}

/** Hadlock 1984, one parameter. GA in days; measurements in MILLIMETRES (converted here). */
export function hadlockGaDays(param: "bpd" | "hc" | "ac" | "fl", valueMm: number): number | null {
  if (!(valueMm > 0)) return null;
  const x = valueMm / 10;
  const weeks = param === "bpd" ? 9.54 + 1.482 * x + 0.1676 * x * x
    : param === "hc" ? 8.96 + 0.540 * x + 0.0003 * x * x * x
      : param === "ac" ? 8.14 + 0.753 * x + 0.0036 * x * x
        : 10.35 + 2.460 * x + 0.170 * x * x;
  return weeks * 7;
}

/** Hadlock 1985. Grams; measurements in MILLIMETRES. 4-parameter when BPD is present, else 3. */
export function hadlockEfw(m: { bpdMm?: number | null; hcMm?: number | null; acMm?: number | null; flMm?: number | null }):
  { grams: number; formula: "hadlock_4" | "hadlock_3" } | null {
  if (!m.hcMm || !m.acMm || !m.flMm) return null;
  const hc = m.hcMm / 10; const ac = m.acMm / 10; const fl = m.flMm / 10;
  if (m.bpdMm) {
    const bpd = m.bpdMm / 10;
    const log = 1.3596 - 0.00386 * ac * fl + 0.0064 * hc + 0.00061 * bpd * ac + 0.0424 * ac + 0.174 * fl;
    return { grams: Math.round(10 ** log), formula: "hadlock_4" };
  }
  const log = 1.326 - 0.00326 * ac * fl + 0.0107 * hc + 0.0438 * ac + 0.158 * fl;
  return { grams: Math.round(10 ** log), formula: "hadlock_3" };
}

export function liquorFromAfi(afiCm: number | null | undefined): Liquor | null {
  if (afiCm === null || afiCm === undefined) return null;
  if (afiCm < 5) return "oligohydramnios";
  if (afiCm >= 25) return "polyhydramnios";
  return "normal";
}

/** A calendar day plus whole days, in UTC arithmetic (the day strings carry no zone). */
export function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenIso(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "20 w 3 d" — the way a report states an age. */
export function formatGa(days: number | null): string {
  if (days === null) return "—";
  const d = Math.round(days);
  return `${String(Math.floor(d / 7))} w ${String(d % 7)} d`;
}

export function deriveFoetus(f: FoetusBiometry): FoetusDerived {
  const ga = {
    crl: f.crlMm ? gaFromCrlDays(f.crlMm) : null,
    bpd: f.bpdMm ? hadlockGaDays("bpd", f.bpdMm) : null,
    hc: f.hcMm ? hadlockGaDays("hc", f.hcMm) : null,
    ac: f.acMm ? hadlockGaDays("ac", f.acMm) : null,
    fl: f.flMm ? hadlockGaDays("fl", f.flMm) : null,
  };
  const hadlock = [ga.bpd, ga.hc, ga.ac, ga.fl].filter((x): x is number => x !== null);
  let composite: number | null = null;
  let method: GaMethod = null;
  if (ga.crl !== null) { composite = ga.crl; method = "crl"; }
  else if (hadlock.length > 0) { composite = hadlock.reduce((a, b) => a + b, 0) / hadlock.length; method = "hadlock_mean"; }
  const efw = hadlockEfw(f);
  const r = (x: number | null): number | null => (x === null ? null : Math.round(x));
  return {
    label: f.label,
    gaDays: { crl: r(ga.crl), bpd: r(ga.bpd), hc: r(ga.hc), ac: r(ga.ac), fl: r(ga.fl) },
    gaCompositeDays: r(composite),
    method,
    efwGrams: efw?.grams ?? null,
    efwFormula: efw?.formula ?? null,
    fhrOutsideRange: f.fhrBpm !== null && f.fhrBpm !== undefined && (f.fhrBpm < 110 || f.fhrBpm > 160),
  };
}

/** Every derived value, from the inputs and the scan's IST calendar day. Pure; no clock read. */
export function deriveObstetric(input: ObstetricBiometryInput, scanDate: string): ObstetricDerived {
  const foetuses = input.foetuses.map(deriveFoetus);
  const gaByLmpDays = input.lmp ? daysBetweenIso(input.lmp, scanDate) : null;
  const first = foetuses[0]?.gaCompositeDays ?? null;
  return {
    scanDate,
    gaByLmpDays: gaByLmpDays !== null && gaByLmpDays >= 0 ? gaByLmpDays : null,
    eddByLmp: input.lmp ? addDaysIso(input.lmp, 280) : null,
    foetuses,
    numberOfFoetuses: foetuses.length,
    gaByScanDays: first,
    eddByScan: first === null ? null : addDaysIso(scanDate, 280 - first),
    discordanceDays: first !== null && gaByLmpDays !== null && gaByLmpDays >= 0 ? first - gaByLmpDays : null,
    liquor: liquorFromAfi(input.afiCm),
  };
}

/**
 * PLAN 18-S RS7 T2 — the fixed line every obstetric ultrasound report carries (Form F's own
 * declaration by the person conducting the ultrasonography, PCPNDT Rules r.9(4), in first person).
 * The server writes it into the signed version; no screen can edit it.
 */
export const PCPNDT_REPORT_DECLARATION_EN =
  "I declare that while conducting ultrasonography on this patient, I have neither detected nor "
  + "disclosed the sex of her foetus to anybody in any manner.";
export const PCPNDT_REPORT_DECLARATION_HI =
  "मैं घोषणा करता/करती हूँ कि इस रोगी की अल्ट्रासोनोग्राफी करते समय मैंने न तो उसके गर्भस्थ शिशु के "
  + "लिंग का पता लगाया है और न ही किसी को किसी भी प्रकार से बताया है।";
