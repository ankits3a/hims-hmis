import { eq } from "drizzle-orm";
import { patients } from "../../kernel/db/schema";
import { registerKidneyFunctionReader } from "../opd";
import { latestVerifiedCreatinine } from "./creatinine";
import type { LatestCreatinine } from "./creatinine";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #621 — THE PATIENT'S LATEST eGFR, FROM THE LAB'S OWN SIGNED CREATININE ═══
 *
 * The equation is **CKD-EPI 2021** (Inker et al., NEJM 2021; the NKF–ASN race-free refit), in
 * mL/min/1.73 m². It lived in `radiology/egfr.ts` for the contrast gate (18-S RS5); it moved HERE
 * when the renal dose check needed it too, because the module that holds the creatinine is the one
 * both readers already depend on, and `opd` cannot import `radiology` (radiology depends on opd).
 * `radiology/egfr.ts` re-exports it, so the gate is unchanged.
 *
 *     eGFR = 142 × min(Scr/κ, 1)^α × max(Scr/κ, 1)^−1.200 × 0.9938^age × 1.012 [if female]
 *     κ = 0.7 (female) / 0.9 (male);  α = −0.241 (female) / −0.302 (male);  Scr in mg/dL
 *
 * Defined for adults only: under 18 the equation is not valid (paediatric eGFR is Schwartz, which
 * needs height), so a child gets a REASON, never an adult number that looks authoritative.
 */
export type EgfrSex = "female" | "male";

/** CKD-EPI 2021 in mL/min/1.73 m², unrounded. Throws on a non-positive creatinine or age. */
export function ckdEpi2021(creatinineMgDl: number, ageYears: number, sex: EgfrSex): number {
  if (!(creatinineMgDl > 0)) throw new RangeError("creatinine must be positive");
  if (!(ageYears > 0)) throw new RangeError("age must be positive");
  const kappa = sex === "female" ? 0.7 : 0.9;
  const alpha = sex === "female" ? -0.241 : -0.302;
  const ratio = creatinineMgDl / kappa;
  return 142
    * Math.min(ratio, 1) ** alpha
    * Math.max(ratio, 1) ** -1.2
    * 0.9938 ** ageYears
    * (sex === "female" ? 1.012 : 1);
}

const UMOL_PER_MG_DL = 88.42;
const DAY_MS = 86_400_000;
const EGFR_MIN_AGE_YEARS = 18;

/** Whole years between a date of birth and an instant, by calendar (UTC dates; a birthday counts on the day). */
function wholeYears(dob: Date, at: Date): number {
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = at.getUTCMonth() < dob.getUTCMonth()
    || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

export type LatestEgfr =
  | { computed: true; egfr: number; sampledAt: Date; ageDays: number; creatinine: LatestCreatinine }
  | { computed: false; reason: "no_dob" | "sex_not_binary" | "under_18"; sampledAt: Date; ageDays: number; creatinine: LatestCreatinine };

/**
 * The latest SIGNED serum creatinine (`latestVerifiedCreatinine`: verified, not superseded, not
 * restricted, across the merge chain) as an eGFR, ROUNDED the way every lab prints it. `null` when the
 * lab holds no signed creatinine for this patient. The age is the patient's age on the day the sample
 * was drawn; `ageDays` is how old the sample is at `now`. Whether that is recent enough is the
 * caller's decision — the lab only says how old.
 */
export async function latestEgfr(exec: Db | Tx, patientId: string, now: Date): Promise<LatestEgfr | null> {
  const creatinine = await latestVerifiedCreatinine(exec, patientId);
  if (creatinine === null) return null;
  const sampledAt = creatinine.sampledAt;
  const ageDays = Math.max(0, Math.floor((now.getTime() - sampledAt.getTime()) / DAY_MS));
  const person = (await (exec as Db).select({ sex: patients.sex, dob: patients.dob }).from(patients).where(eq(patients.id, patientId)))[0];
  const base = { sampledAt, ageDays, creatinine };
  if (person === undefined || person.dob === null) return { computed: false, reason: "no_dob", ...base };
  if (person.sex !== "female" && person.sex !== "male") return { computed: false, reason: "sex_not_binary", ...base };
  const ageYears = wholeYears(person.dob, sampledAt);
  if (ageYears < EGFR_MIN_AGE_YEARS) return { computed: false, reason: "under_18", ...base };
  const egfr = Math.round(ckdEpi2021(creatinine.valueUmolL / UMOL_PER_MG_DL, ageYears, person.sex));
  return { computed: true, egfr, ...base };
}

/**
 * #621 — hands opd's renal dose check this module's answer (`latestEgfr`, without the creatinine row).
 * `LabModule.onModuleInit` is the production path; a suite calls it directly, like the opd resolvers.
 */
export function registerLabKidneyFunctionReader(): () => void {
  return registerKidneyFunctionReader(async (db, patientId, now) => {
    const got = await latestEgfr(db, patientId, now);
    if (got === null) return null;
    return got.computed
      ? { computed: true, egfr: got.egfr, sampledAt: got.sampledAt, ageDays: got.ageDays }
      : { computed: false, reason: got.reason, sampledAt: got.sampledAt, ageDays: got.ageDays };
  });
}
