/**
 * PLAN 18-S RS7 — the web's copy of `@hmis/contracts` obstetric.ts: the published biometry formulas
 * (Robinson CRL, Hadlock 1984 GA, Hadlock 1985 EFW) and the fixed PCPNDT report declaration.
 *
 * The web imports only TYPES from that package (its runtime entry is `dist/`, which the web never
 * builds — see `eye-line.ts`), so the arithmetic is copied here for the Scan room's LIVE preview.
 * The SERVER recomputes every derived value on save; this copy only shows the sonologist what the
 * server will store. `obstetric.test.ts` runs both copies over the same measurements, so a drift
 * fails a test instead of showing a sonologist one GA and storing another.
 */
export const PLACENTA_POSITIONS = [
  "anterior", "posterior", "fundal", "lateral", "low_lying", "praevia",
] as const;
export const PRESENTATIONS = ["cephalic", "breech", "transverse", "variable"] as const;

export type FoetusBiometry = {
  label: string;
  crlMm?: number | null; bpdMm?: number | null; hcMm?: number | null; acMm?: number | null; flMm?: number | null;
  fhrBpm?: number | null; presentation?: (typeof PRESENTATIONS)[number] | null;
};
export type ObstetricBiometryInput = {
  lmp?: string | null; foetuses: FoetusBiometry[]; afiCm?: number | null;
  placenta?: (typeof PLACENTA_POSITIONS)[number] | null;
};

/** The server schema's ranges (`obstetricBiometryInputSchema`), so the preview refuses what the server will. */
export const BIOMETRY_MAX = { crlMm: 95, bpdMm: 110, hcMm: 400, acMm: 450, flMm: 85, fhrBpm: 260, afiCm: 60 } as const;

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
