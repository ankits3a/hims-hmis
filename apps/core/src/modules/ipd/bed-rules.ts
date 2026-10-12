import { IPD_BED_CLASS_INFO } from "@hmis/contracts";
import type { IpdBedClass, IpdBedNeed, IpdRefusalCode } from "@hmis/contracts";
import type { IpdBedAttributes, IpdIsolationType } from "./bed-attributes";

/**
 * E1.1 (#718) — THE BED RULES, as one pure function (spec §4.1). Every bed act (reserve, assign, and later
 * transfer and the Bed Flow proposals) asks this one question, so a rule removed from a screen still refuses
 * through the intent, and a proposal can never offer a bed the intent would refuse.
 *
 * The first broken rule wins, in the order a desk would explain it: overflow approval, class, gender (bed rule,
 * then the twin-share room's gender), age, isolation, ICU. A refusal carries its contract code and `bedRule`,
 * the bed's own rule in words ("Female-only bed").
 */

/** The ward classes that may be swapped by a flagged upgrade or downgrade, lowest first. */
const WARD_CLASS_LADDER: readonly IpdBedClass[] = ["general", "semi_private", "private", "deluxe", "suite"];

/**
 * DECIDED (E1.1, standard Indian corporate practice): a child is under 14 years on the day of the act. A patient
 * with no date of birth is not refused on age (the desk cannot know; the ward nurse checks).
 */
export const PAEDIATRIC_AGE_LIMIT_YEARS = 14;

export type BedRuleBed = { code: string; attributes: IpdBedAttributes };
export type BedRulePatient = {
  /** Administrative gender as recorded; `other` and `unknown` place by `need.placeAs`. */
  gender: "male" | "female" | "other" | "unknown";
  ageYears: number | null;
};
export type BedRuleContext = {
  /** The twin-share room's gender, fixed by its first occupant until the room is empty; null when empty or not a room. */
  roomGender: "male" | "female" | null;
  /** The actor holds `ipd.beds.overflow` (the duty manager). */
  mayUseOverflow: boolean;
};
export type BedRuleBreach = { code: IpdRefusalCode; bedRule: string };

const ISOLATION_RANK: Record<IpdIsolationType, number> = { none: 0, contact: 1, droplet: 2, airborne: 3 };

/** The gender the patient is placed as: recorded, or stated when the record says other or unknown. */
export function placementGender(p: BedRulePatient, need: IpdBedNeed): "male" | "female" | null {
  if (p.gender === "male" || p.gender === "female") return need.placeAs ?? p.gender;
  return need.placeAs ?? null;
}

export function ageInYears(dob: Date | string | null, at: Date): number | null {
  if (dob === null) return null;
  const d = typeof dob === "string" ? new Date(`${dob.slice(0, 10)}T00:00:00Z`) : dob;
  let years = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) years -= 1;
  return years;
}

function classBreach(bed: IpdBedAttributes, need: IpdBedNeed, classChange: "upgrade" | "downgrade" | undefined): BedRuleBreach | null {
  // An overflow bed is the surge answer for any class; its gate is the duty manager's approval, checked first.
  if (bed.class === "overflow" || bed.class === need.requestedClass) return null;
  const label = IPD_BED_CLASS_INFO[bed.class].label;
  const from = WARD_CLASS_LADDER.indexOf(need.requestedClass);
  const to = WARD_CLASS_LADDER.indexOf(bed.class);
  if (from >= 0 && to >= 0 && classChange !== undefined) {
    if (classChange === "upgrade" && to > from) return null;
    if (classChange === "downgrade" && to < from) return null;
  }
  return { code: "bed_class_mismatch", bedRule: `${label} bed` };
}

export function checkBedRules(
  bed: BedRuleBed,
  patient: BedRulePatient,
  need: IpdBedNeed,
  classChange: "upgrade" | "downgrade" | undefined,
  ctx: BedRuleContext,
): BedRuleBreach | null {
  const a = bed.attributes;
  if (a.overflow && !ctx.mayUseOverflow) return { code: "overflow_needs_duty_manager", bedRule: "Overflow bed" };

  const cls = classBreach(a, need, classChange);
  if (cls !== null) return cls;

  const gender = placementGender(patient, need);
  if (a.genderRule === "male" && gender !== "male") return { code: "bed_gender_mismatch", bedRule: "Male-only bed" };
  if (a.genderRule === "female" && gender !== "female") return { code: "bed_gender_mismatch", bedRule: "Female-only bed" };
  if (a.genderRule === "any" && ctx.roomGender !== null && gender !== ctx.roomGender) {
    return { code: "bed_gender_mismatch", bedRule: ctx.roomGender === "male" ? "Shared room is male" : "Shared room is female" };
  }

  const child = patient.ageYears !== null && patient.ageYears < PAEDIATRIC_AGE_LIMIT_YEARS;
  const adult = patient.ageYears !== null && patient.ageYears >= PAEDIATRIC_AGE_LIMIT_YEARS;
  const paediatricBed = a.genderRule === "paediatric" || a.class === "nicu" || a.class === "picu";
  if (paediatricBed && adult) return { code: "bed_age_mismatch", bedRule: "Paediatric bed" };
  // DECIDED (E1.1): a child is refused an adult ICU bed and a gender-segregated adult ward bed; rooms admit children.
  if (child && a.class === "icu") return { code: "bed_age_mismatch", bedRule: "Adult ICU bed" };
  if (child && (a.genderRule === "male" || a.genderRule === "female") && a.class === "general") {
    return { code: "bed_age_mismatch", bedRule: "Adult ward bed" };
  }

  if (ISOLATION_RANK[a.isolation] < ISOLATION_RANK[need.isolation]) {
    return { code: "bed_isolation_mismatch", bedRule: a.isolation === "none" ? "No isolation" : `${cap(a.isolation)} isolation only` };
  }
  if (need.isolation === "airborne" && !a.negativePressure) {
    return { code: "bed_isolation_mismatch", bedRule: "No negative pressure" };
  }

  if (a.icu && !need.icu) return { code: "bed_class_mismatch", bedRule: "ICU bed" };
  if (!a.icu && need.icu) return { code: "bed_class_mismatch", bedRule: "Not an ICU bed" };
  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
