import { z } from "zod";
import { IpdBedClassSchema } from "@hmis/contracts";

/**
 * E0.3 — what a bed and a ward ARE, beyond the kernel's place row.
 *
 * Bed attributes live in `resources.attributes` (jsonb) and are validated HERE, by the module that
 * owns the rules over the registry (kernel/db/schema/resources.ts: "IPD owns admissions, assignment
 * rules, gender segregation, isolation, quota — rules OVER the registry"). No kernel edit, no new
 * resource kind, no migration. Spec SPEC-ipd-core-2026-10-12 §4.1.
 */

export const IPD_GENDER_RULES = ["male", "female", "any", "paediatric"] as const;
export type IpdGenderRule = (typeof IPD_GENDER_RULES)[number];

export const IPD_ISOLATION_TYPES = ["none", "contact", "droplet", "airborne"] as const;
export type IpdIsolationType = (typeof IPD_ISOLATION_TYPES)[number];

export const IPD_BED_EQUIPMENT = ["monitor", "ventilator_ready", "oxygen_point", "suction", "infusion_pumps"] as const;
export type IpdBedEquipment = (typeof IPD_BED_EQUIPMENT)[number];

/** The unit a ward is. Every adult ICU bills at class `icu`; the unit is a ward attribute, not a class. */
export const IPD_UNIT_TYPES = [
  "MICU", "SICU", "CCU", "CTVS_ICU", "NEURO_ICU", "ONCO_ICU", "PICU", "BURNS", "HDU",
  "NICU", "SNCU", "LDR", "DAYCARE", "ER", "WARD",
] as const;
export type IpdUnitType = (typeof IPD_UNIT_TYPES)[number];

export const IPD_WARD_TYPES = ["ward", "hall"] as const;
export type IpdWardType = (typeof IPD_WARD_TYPES)[number];

/** Refusal codes a bed's attributes can carry. Stable words: the loader lists them per row. */
export const IPD_BED_RULE_CODES = {
  airborneNeedsNegativePressure: "airborne_needs_negative_pressure",
  overflowMismatch: "overflow_mismatch",
  daycareMismatch: "daycare_mismatch",
  duplicateEquipment: "duplicate_equipment",
} as const;

export const IpdBedAttributesSchema = z
  .object({
    class: IpdBedClassSchema,
    genderRule: z.enum(IPD_GENDER_RULES),
    isolation: z.enum(IPD_ISOLATION_TYPES),
    negativePressure: z.boolean(),
    icu: z.boolean(),
    equipment: z.array(z.enum(IPD_BED_EQUIPMENT)),
    daycare: z.boolean(),
    overflow: z.boolean(),
  })
  .superRefine((b, ctx) => {
    if (b.isolation === "airborne" && !b.negativePressure) {
      ctx.addIssue({
        code: "custom", path: ["negativePressure"],
        message: `${IPD_BED_RULE_CODES.airborneNeedsNegativePressure}: airborne isolation needs a negative-pressure room`,
      });
    }
    if ((b.class === "overflow") !== b.overflow) {
      ctx.addIssue({
        code: "custom", path: ["overflow"],
        message: `${IPD_BED_RULE_CODES.overflowMismatch}: class overflow and the overflow flag must agree (class "${b.class}", overflow ${String(b.overflow)})`,
      });
    }
    // DECIDED (E0.3): a day-care bed is exactly a bed of class `daycare`. The flag and the class
    // disagreeing would put a bed in the midnight census by one reading and out of it by the other.
    if ((b.class === "daycare") !== b.daycare) {
      ctx.addIssue({
        code: "custom", path: ["daycare"],
        message: `${IPD_BED_RULE_CODES.daycareMismatch}: class daycare and the daycare flag must agree (class "${b.class}", daycare ${String(b.daycare)})`,
      });
    }
    if (new Set(b.equipment).size !== b.equipment.length) {
      ctx.addIssue({
        code: "custom", path: ["equipment"],
        message: `${IPD_BED_RULE_CODES.duplicateEquipment}: an equipment tag is listed twice`,
      });
    }
  });
export type IpdBedAttributes = z.infer<typeof IpdBedAttributesSchema>;

export const IpdWardAttributesSchema = z.object({
  /** The owning department's code (org department, e.g. MED, SUR, ORT, OBG, PED, CAS; MULTI for shared floors). */
  department: z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/, "a department code is 2–16 capitals, digits or _"),
  unitType: z.enum(IPD_UNIT_TYPES),
  wardType: z.enum(IPD_WARD_TYPES),
});
export type IpdWardAttributes = z.infer<typeof IpdWardAttributesSchema>;

/** Equipment in one canonical order, so a re-ordered cell in a file is not a change. */
export function canonicalEquipment(list: readonly IpdBedEquipment[]): IpdBedEquipment[] {
  return IPD_BED_EQUIPMENT.filter((e) => list.includes(e));
}
