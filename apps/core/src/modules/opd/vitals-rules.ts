import { OpdError } from "./errors";
import type { BandConfig, DangerRangesConfig, VitalKey } from "./config";
import type { DangerFlag } from "./events";

export type VitalsInput = {
  heightCm?: number | null; weightKg?: number | null; sbp?: number | null; dbp?: number | null;
  pulse?: number | null; rr?: number | null; spo2?: number | null; tempC?: number | null; notes?: string | null;
};
const RANGED: readonly DangerFlag["vital"][] = ["sbp", "dbp", "pulse", "rr", "spo2", "tempC"];
const PLAUSIBLE: Record<VitalKey, [number, number]> = {
  heightCm: [20, 250], weightKg: [0.3, 400], sbp: [30, 300], dbp: [10, 200], pulse: [10, 300], rr: [2, 100], spo2: [0, 100], tempC: [25, 45],
};

/** The band whose EXCLUSIVE upper bound the age is below; unknown age → the adult tail. */
export function bandFor(ageYears: number | null, cfg: DangerRangesConfig): BandConfig {
  const tail = cfg.bands[cfg.bands.length - 1]!;
  if (ageYears === null) return tail;
  return cfg.bands.find((b) => b.upToAgeYears !== null && ageYears < b.upToAgeYears) ?? tail;
}

function present(v: VitalsInput, k: VitalKey): boolean {
  const x = v[k];
  return x !== undefined && x !== null;
}

/** Completeness (S10 KPI "vitals completeness"): the band's required list, plus weight under cfg.weightRequiredUnderYears (§11.8). */
export function missingRequired(v: VitalsInput, ageYears: number | null, cfg: DangerRangesConfig): VitalKey[] {
  const band = bandFor(ageYears, cfg);
  const need = new Set<VitalKey>(band.required);
  if (ageYears !== null && ageYears < cfg.weightRequiredUnderYears) need.add("weightKg");
  return (["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse", "rr"] as VitalKey[]).filter((k) => need.has(k) && !present(v, k));
}

/** Every PRESENT ranged vital compared against the band's inclusive bounds. */
export function evaluateVitals(v: VitalsInput, band: BandConfig): DangerFlag[] {
  const flags: DangerFlag[] = [];
  for (const k of RANGED) {
    const value = v[k];
    if (value === undefined || value === null) continue;
    const r = band.ranges[k];
    if (!r) continue;
    if (r.min !== undefined && value < r.min) flags.push({ vital: k, value, bound: "min", limit: r.min });
    if (r.max !== undefined && value > r.max) flags.push({ vital: k, value, bound: "max", limit: r.max });
  }
  return flags;
}

export function validateVitalsRanges(v: VitalsInput): void {
  for (const k of Object.keys(PLAUSIBLE) as VitalKey[]) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    const [lo, hi] = PLAUSIBLE[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) throw new OpdError("invalid_vitals", `${k} out of plausible range ${lo}–${hi}`, { vital: k, value: x });
  }
}
