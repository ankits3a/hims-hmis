import { ckdEpi2021 } from "../lab";
import type { EgfrSex } from "../lab";
/**
 * PLAN 18-S RS5 T1 (Gap 3, DECIDED clinical standard) — **eGFR in the kidney gate.**
 *
 * The kidney gate was creatinine-only: one ceiling (176.8 µmol/L, 2.0 mg/dL) for every patient. A
 * creatinine of 1.4 mg/dL is an eGFR near 90 in a 25-year-old man and near 38 in a 75-year-old
 * woman, and the ceiling passes both. So the gate now computes an eGFR and decides by it:
 *
 *   · **eGFR < 30** — iodinated or gadolinium contrast is held for the radiologist. The gate cannot
 *     be SATISFIED; the lane is the radiologist's override with a reason, as it always was.
 *   · **30–44** — satisfiable, but only with the IV-hydration instruction recorded in the evidence.
 *   · **< 45** — metformin is held for 48 h after contrast (a note carried in the evidence).
 *   · **No eGFR** (no date of birth, or a sex the equation has no coefficient for) — the creatinine
 *     ceiling stays as the fallback, exactly as before.
 *
 * The equation is **CKD-EPI 2021** (Inker et al., NEJM 2021; the NKF–ASN race-free refit), in
 * mL/min/1.73 m²:
 *
 *     eGFR = 142 × min(Scr/κ, 1)^α × max(Scr/κ, 1)^−1.200 × 0.9938^age × 1.012 [if female]
 *     κ = 0.7 (female) / 0.9 (male);  α = −0.241 (female) / −0.302 (male);  Scr in mg/dL
 *
 * There is no race term (the 2021 refit removed it). It is defined for adults: under 18 the
 * equation is not valid (paediatric eGFR is Schwartz, which needs height), so a child falls back to
 * the ceiling rather than getting an adult number that looks authoritative.
 *
 * Pure, so every band edge is walked without a database.
 */

/** µmol/L per mg/dL for creatinine (molar mass 113.12 g/mol). */
export const CREATININE_UMOL_PER_MG_DL = 88.42;

/** Below this eGFR contrast is held for the radiologist's override. */
export const EGFR_HOLD_BELOW = 30;
/** Below this eGFR (and at or above the hold) the IV-hydration instruction is required. */
export const EGFR_HYDRATE_BELOW = 45;
/** Below this eGFR metformin is held for 48 h after contrast. */
export const EGFR_METFORMIN_BELOW = 45;
/** CKD-EPI is an adult equation. */
export const EGFR_MIN_AGE_YEARS = 18;

/**
 * The instruction the gate records for eGFR 30–44. The ordinary Indian-hospital protocol (ESUR /
 * ACR): isotonic saline, 1 mL/kg/h for 6 h before and 6 h after the injection.
 */
export const IV_HYDRATION_INSTRUCTION =
  "IV 0.9% normal saline 1 mL/kg/h for 6 hours before and 6 hours after contrast";

/** The metformin note the gate records below eGFR 45. */
export const METFORMIN_NOTE =
  "If the patient takes metformin: hold it for 48 hours after contrast and restart only after renal function is rechecked";

/**
 * #621 — the equation now lives in the lab (`lab/egfr.ts`), beside the creatinine it reads, so the
 * renal dose check and this gate compute one number one way. Re-exported unchanged for this module.
 */
export { ckdEpi2021 } from "../lab";
export type { EgfrSex } from "../lab";
export type RenalBand = "hold" | "hydrate" | "clear";

/** The gate's three lanes, by eGFR. */
export function renalBand(egfr: number): RenalBand {
  if (egfr < EGFR_HOLD_BELOW) return "hold";
  if (egfr < EGFR_HYDRATE_BELOW) return "hydrate";
  return "clear";
}

export type EgfrAssessment =
  | {
    computed: true; egfr: number; band: RenalBand; creatinineMgDl: number;
    ageYears: number; sex: EgfrSex; metforminHold: boolean;
  }
  | { computed: false; reason: "no_dob" | "sex_not_binary" | "under_18"; creatinineMgDl: number };

/**
 * The whole decision, from what the patient master holds. `egfr` is ROUNDED to a whole number, the
 * way every lab prints it, and the band is decided on the rounded figure so the number a nurse reads
 * and the lane the gate takes cannot disagree at an edge (29.6 prints "30" and is not held).
 */
export function assessEgfr(
  creatinineUmolL: number, patient: { sex: string; ageYears: number | null },
): EgfrAssessment {
  const creatinineMgDl = creatinineUmolL / CREATININE_UMOL_PER_MG_DL;
  if (patient.ageYears === null) return { computed: false, reason: "no_dob", creatinineMgDl };
  if (patient.sex !== "female" && patient.sex !== "male") {
    return { computed: false, reason: "sex_not_binary", creatinineMgDl };
  }
  if (patient.ageYears < EGFR_MIN_AGE_YEARS) return { computed: false, reason: "under_18", creatinineMgDl };
  const egfr = Math.round(ckdEpi2021(creatinineMgDl, patient.ageYears, patient.sex));
  return {
    computed: true, egfr, band: renalBand(egfr), creatinineMgDl,
    ageYears: patient.ageYears, sex: patient.sex, metforminHold: egfr < EGFR_METFORMIN_BELOW,
  };
}
