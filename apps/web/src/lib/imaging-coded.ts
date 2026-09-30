/**
 * PLAN 18-S RS8a — the reading room's coded categories and calculators: THE WEB'S COPY.
 *
 * The server's one copy is `packages/contracts/src/imaging-coded.ts`. The web imports only TYPES
 * from `@hmis/contracts` (its runtime entry is the built `dist/`, which the web build does not
 * produce — `eye-line.ts` gives the same reason), so the functions below are a copy and
 * `imaging-coded.test.ts` holds them equal to the contracts source over the calculators' WHOLE
 * input space. A drift fails that test, not a report.
 *
 * The widgets compute live from these; the category that is signed is the radiologist's choice,
 * and the server validates it against its own copy (`checks.ts`).
 */

export const CODED_SYSTEMS = ["birads", "tirads", "lirads", "pirads", "orads", "lungrads", "fleischner", "aspects"] as const;
export type CodedSystem = (typeof CODED_SYSTEMS)[number];

/** One category of one system: its value as printed and what it tells the referring doctor. */
export type CodedCategory = { value: string; label: string };

export const CODED_CATEGORIES: Record<Exclude<CodedSystem, "fleischner" | "aspects">, readonly CodedCategory[]> = {
  birads: [
    { value: "0", label: "Incomplete — needs additional imaging or prior comparison" },
    { value: "1", label: "Negative" },
    { value: "2", label: "Benign" },
    { value: "3", label: "Probably benign — short-interval follow-up (6 months)" },
    { value: "4A", label: "Low suspicion for malignancy — tissue diagnosis" },
    { value: "4B", label: "Moderate suspicion for malignancy — tissue diagnosis" },
    { value: "4C", label: "High suspicion for malignancy — tissue diagnosis" },
    { value: "5", label: "Highly suggestive of malignancy — tissue diagnosis" },
    { value: "6", label: "Known biopsy-proven malignancy" },
  ],
  tirads: [
    { value: "TR1", label: "Benign — no FNA" },
    { value: "TR2", label: "Not suspicious — no FNA" },
    { value: "TR3", label: "Mildly suspicious — FNA if ≥ 2.5 cm, follow up if ≥ 1.5 cm" },
    { value: "TR4", label: "Moderately suspicious — FNA if ≥ 1.5 cm, follow up if ≥ 1.0 cm" },
    { value: "TR5", label: "Highly suspicious — FNA if ≥ 1.0 cm, follow up if ≥ 0.5 cm" },
  ],
  lirads: [
    { value: "LR-1", label: "Definitely benign" },
    { value: "LR-2", label: "Probably benign" },
    { value: "LR-3", label: "Intermediate probability of malignancy" },
    { value: "LR-4", label: "Probably HCC" },
    { value: "LR-5", label: "Definitely HCC" },
    { value: "LR-M", label: "Probably or definitely malignant, not HCC specific" },
    { value: "LR-TIV", label: "Tumour in vein" },
  ],
  pirads: [
    { value: "1", label: "Very low — clinically significant cancer highly unlikely" },
    { value: "2", label: "Low — clinically significant cancer unlikely" },
    { value: "3", label: "Intermediate — equivocal" },
    { value: "4", label: "High — clinically significant cancer likely" },
    { value: "5", label: "Very high — clinically significant cancer highly likely" },
  ],
  orads: [
    { value: "0", label: "Incomplete evaluation" },
    { value: "1", label: "Normal premenopausal ovary" },
    { value: "2", label: "Almost certainly benign (< 1%)" },
    { value: "3", label: "Low risk of malignancy (1 to < 10%)" },
    { value: "4", label: "Intermediate risk of malignancy (10 to < 50%)" },
    { value: "5", label: "High risk of malignancy (≥ 50%)" },
  ],
  lungrads: [
    { value: "0", label: "Incomplete" },
    { value: "1", label: "Negative — continue annual screening" },
    { value: "2", label: "Benign appearance — continue annual screening" },
    { value: "3", label: "Probably benign — LDCT in 6 months" },
    { value: "4A", label: "Suspicious — LDCT in 3 months; PET/CT if a solid component ≥ 8 mm" },
    { value: "4B", label: "Very suspicious — chest CT, PET/CT and/or tissue sampling" },
    { value: "4X", label: "Category 3 or 4 with features that increase suspicion" },
    { value: "S", label: "Significant other finding (modifier)" },
  ],
};

/** The printed name of each system — on the report's coded line and in the screen. */
export const CODED_SYSTEM_NAMES: Record<CodedSystem, string> = {
  birads: "BI-RADS", tirads: "ACR TI-RADS", lirads: "LI-RADS", pirads: "PI-RADS", orads: "O-RADS US",
  lungrads: "Lung-RADS", fleischner: "Fleischner 2017", aspects: "ASPECTS",
};

/* ═══════════════════════════════ ACR TI-RADS (2017) ═══════════════════════════════ */

export const TIRADS_COMPOSITION = { cystic: 0, spongiform: 0, mixed: 1, solid: 2 } as const;
export const TIRADS_ECHOGENICITY = { anechoic: 0, hyper_iso: 1, hypo: 2, very_hypo: 3 } as const;
export const TIRADS_SHAPE = { wider_than_tall: 0, taller_than_wide: 3 } as const;
export const TIRADS_MARGIN = { smooth: 0, ill_defined: 0, lobulated_irregular: 2, extrathyroidal: 3 } as const;
/** Echogenic foci are "choose ALL that apply" — the only additive feature. */
export const TIRADS_FOCI = { none: 0, macro: 1, rim: 2, punctate: 3 } as const;

export type TiradsInputs = {
  composition: keyof typeof TIRADS_COMPOSITION;
  echogenicity: keyof typeof TIRADS_ECHOGENICITY;
  shape: keyof typeof TIRADS_SHAPE;
  margin: keyof typeof TIRADS_MARGIN;
  foci: readonly (keyof typeof TIRADS_FOCI)[];
  /** Maximum diameter, cm. Optional: the level needs no size, the FNA advice does. */
  sizeCm?: number | null;
};

export type TiradsResult = {
  points: number;
  level: "TR1" | "TR2" | "TR3" | "TR4" | "TR5";
  /** null when no size was given; otherwise the white paper's size rule for the level. */
  advice: "fna" | "follow_up" | "no_further" | null;
};

/** Size thresholds per level, cm: FNA at or above the first, follow-up at or above the second. */
export const TIRADS_THRESHOLDS: Record<TiradsResult["level"], { fna: number | null; followUp: number | null }> = {
  TR1: { fna: null, followUp: null },
  TR2: { fna: null, followUp: null },
  TR3: { fna: 2.5, followUp: 1.5 },
  TR4: { fna: 1.5, followUp: 1.0 },
  TR5: { fna: 1.0, followUp: 0.5 },
};

/**
 * The points, the level and the size advice. Two rules from the chart's own notes: a SPONGIFORM
 * nodule adds no further points for any other feature, and `none` among the foci contributes
 * nothing while any other focus adds its own points (they sum).
 *
 * Levels: 0–1 points TR1, 2 TR2, 3 TR3, 4–6 TR4, ≥ 7 TR5. The chart names TR1 as "0 points"; 1 point
 * is reachable (cystic + anechoic + a macrocalcification) and every published calculator places it
 * in TR1 — benign — which is also the safe reading of "fewer points than TR2".
 */
export function tiradsScore(inputs: TiradsInputs): TiradsResult {
  const foci = [...new Set(inputs.foci)].reduce((sum, f) => sum + TIRADS_FOCI[f], 0);
  const points = inputs.composition === "spongiform"
    ? 0
    : TIRADS_COMPOSITION[inputs.composition] + TIRADS_ECHOGENICITY[inputs.echogenicity]
      + TIRADS_SHAPE[inputs.shape] + TIRADS_MARGIN[inputs.margin] + foci;
  const level: TiradsResult["level"] = points <= 1 ? "TR1" : points === 2 ? "TR2" : points === 3 ? "TR3" : points <= 6 ? "TR4" : "TR5";
  const size = inputs.sizeCm;
  let advice: TiradsResult["advice"] = null;
  if (size !== undefined && size !== null) {
    const t = TIRADS_THRESHOLDS[level];
    advice = t.fna !== null && size >= t.fna ? "fna" : t.followUp !== null && size >= t.followUp ? "follow_up" : "no_further";
  }
  return { points, level, advice };
}

/* ═══════════════════════════════ ASPECTS ═══════════════════════════════ */

/** The ten MCA-territory regions: caudate, lentiform, internal capsule, insular ribbon, M1–M6. */
export const ASPECTS_REGIONS = ["C", "L", "IC", "I", "M1", "M2", "M3", "M4", "M5", "M6"] as const;
export type AspectsRegion = (typeof ASPECTS_REGIONS)[number];

/** 10 minus one point for each region with early ischaemic change. Unknown or repeated regions count once. */
export function aspectsScore(affected: readonly string[]): number {
  const hit = new Set(affected.filter((r): r is AspectsRegion => (ASPECTS_REGIONS as readonly string[]).includes(r)));
  return 10 - hit.size;
}

/* ═══════════════════════════════ Fleischner 2017 ═══════════════════════════════ */

export type FleischnerInputs = {
  type: "solid" | "ground_glass" | "part_solid";
  count: "single" | "multiple";
  /** Average diameter (long + short axis ÷ 2), mm — the guideline's own measure. */
  sizeMm: number;
  risk: "low" | "high";
  /** Part-solid only: the solid component, mm. */
  solidComponentMm?: number | null;
};

export type FleischnerResult = {
  /** false when the lesion is ≥ 30 mm — a MASS, to which Fleischner does not apply. */
  applies: boolean;
  recommendation: string;
  /** The first follow-up interval, months, as [from, to]; null when no routine follow-up. */
  firstCtMonths: [number, number] | null;
};

/**
 * The 2017 table. Applies to INCIDENTAL nodules in adults ≥ 35; not to lung-cancer screening
 * (Lung-RADS), immunocompromised patients or patients with a known cancer — the screen says so
 * beside the widget; the function answers the table.
 */
export function fleischnerRecommendation(i: FleischnerInputs): FleischnerResult {
  if (i.sizeMm >= 30) {
    return { applies: false, recommendation: "A lesion of 3 cm or more is a mass, not a nodule — Fleischner does not apply; stage and obtain tissue.", firstCtMonths: null };
  }
  if (i.type === "solid") {
    if (i.count === "single") {
      if (i.sizeMm < 6) {
        return i.risk === "low"
          ? { applies: true, recommendation: "No routine follow-up.", firstCtMonths: null }
          : { applies: true, recommendation: "Optional CT at 12 months.", firstCtMonths: [12, 12] };
      }
      if (i.sizeMm <= 8) {
        return i.risk === "low"
          ? { applies: true, recommendation: "CT at 6–12 months, then consider CT at 18–24 months.", firstCtMonths: [6, 12] }
          : { applies: true, recommendation: "CT at 6–12 months, then CT at 18–24 months.", firstCtMonths: [6, 12] };
      }
      return { applies: true, recommendation: "Consider CT at 3 months, PET/CT, or tissue sampling.", firstCtMonths: [3, 3] };
    }
    if (i.sizeMm < 6) {
      return i.risk === "low"
        ? { applies: true, recommendation: "No routine follow-up.", firstCtMonths: null }
        : { applies: true, recommendation: "Optional CT at 12 months.", firstCtMonths: [12, 12] };
    }
    if (i.sizeMm <= 8) {
      return i.risk === "low"
        ? { applies: true, recommendation: "CT at 3–6 months, then consider CT at 18–24 months.", firstCtMonths: [3, 6] }
        : { applies: true, recommendation: "CT at 3–6 months, then CT at 18–24 months.", firstCtMonths: [3, 6] };
    }
    return { applies: true, recommendation: "CT at 3–6 months, then consider CT at 18–24 months.", firstCtMonths: [3, 6] };
  }
  /** Subsolid nodules: the guideline does not split them by risk. */
  if (i.count === "single") {
    if (i.sizeMm < 6) return { applies: true, recommendation: "No routine follow-up.", firstCtMonths: null };
    if (i.type === "ground_glass") {
      return { applies: true, recommendation: "CT at 6–12 months to confirm persistence, then CT every 2 years until 5 years.", firstCtMonths: [6, 12] };
    }
    const solid = i.solidComponentMm ?? null;
    return {
      applies: true,
      recommendation: solid !== null && solid >= 6
        ? "CT at 3–6 months to confirm persistence; a persistent solid component of 6 mm or more is highly suspicious."
        : "CT at 3–6 months to confirm persistence; if unchanged and the solid component stays under 6 mm, annual CT for 5 years.",
      firstCtMonths: [3, 6],
    };
  }
  if (i.sizeMm < 6) {
    return { applies: true, recommendation: "CT at 3–6 months; if stable, consider CT at 2 and 4 years.", firstCtMonths: [3, 6] };
  }
  return { applies: true, recommendation: "CT at 3–6 months; subsequent management based on the most suspicious nodule.", firstCtMonths: [3, 6] };
}

/* ═══════════════════════════════ membership ═══════════════════════════════ */

/**
 * Is `value` a category of `system`? Fleischner's value is its recommendation key (`fleischner`
 * carries inputs, not a category), so any non-empty recommendation counts; ASPECTS is 0–10.
 */
export function isCodedValue(system: CodedSystem, value: unknown): boolean {
  if (system === "aspects") return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10;
  if (system === "fleischner") return typeof value === "string" && value.trim() !== "";
  return typeof value === "string" && CODED_CATEGORIES[system].some((c) => c.value === value);
}

/**
 * One coded entry as the body carries it: `body.coded[system] = { value, inputs? }`. `inputs` is
 * what the calculator was given, kept so the category can be recomputed and questioned later.
 */
export type CodedEntry = { value: string | number; inputs?: unknown };

/** The line a report prints: "BI-RADS 4A — Low suspicion for malignancy — tissue diagnosis". */
export function codedLine(system: CodedSystem, value: string | number): string {
  const name = CODED_SYSTEM_NAMES[system];
  if (system === "aspects") return `${name} ${String(value)} / 10`;
  if (system === "fleischner") return `${name}: ${String(value)}`;
  const cat = CODED_CATEGORIES[system].find((c) => c.value === value);
  return cat === undefined ? `${name} ${String(value)}` : `${name} ${cat.value} — ${cat.label}`;
}
