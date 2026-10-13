import { z } from "zod";

/**
 * IPD bed classes — the one list the bed registry (E0.3), the rate card (E0.4) and inpatient billing read.
 * Decision 0072: go-live is blocked until every class that `needsRates` has a room rent, a nursing charge and a
 * doctor-visit fee. Standard Indian corporate-hospital structure, DECIDED under that ruling:
 * - ward classes general → suite; critical care as its own classes (every adult ICU unit — MICU, SICU, CCU,
 *   CTVS, neuro, onco, burns — bills at `icu`; the unit is a ward attribute, not a class);
 * - `overflow` (extra bed, corridor trolley) bills at `general`, is counted apart and is never normal capacity;
 * - `daycare` and `emergency` beds are not in the midnight inpatient census.
 */
export const IPD_BED_CLASSES = [
  "general",
  "semi_private",
  "private",
  "deluxe",
  "suite",
  "hdu",
  "icu",
  "nicu",
  "picu",
  "ldr",
  "daycare",
  "emergency",
  "overflow",
] as const;

export type IpdBedClass = (typeof IPD_BED_CLASSES)[number];
export const IpdBedClassSchema = z.enum(IPD_BED_CLASSES);

export type IpdBedClassInfo = {
  label: string;
  /** Counted in the midnight inpatient census. */
  inCensus: boolean;
  /** Go-live needs room rent, nursing charge and visit fee for this class. */
  needsRates: boolean;
  /** The class whose rates it bills at, when not its own. */
  billsAs?: IpdBedClass;
};

export const IPD_BED_CLASS_INFO: Record<IpdBedClass, IpdBedClassInfo> = {
  general: { label: "General ward", inCensus: true, needsRates: true },
  semi_private: { label: "Semi-private (twin sharing)", inCensus: true, needsRates: true },
  private: { label: "Private room", inCensus: true, needsRates: true },
  deluxe: { label: "Deluxe room", inCensus: true, needsRates: true },
  suite: { label: "Suite", inCensus: true, needsRates: true },
  hdu: { label: "High dependency unit", inCensus: true, needsRates: true },
  icu: { label: "Intensive care", inCensus: true, needsRates: true },
  nicu: { label: "Neonatal intensive care", inCensus: true, needsRates: true },
  picu: { label: "Paediatric intensive care", inCensus: true, needsRates: true },
  ldr: { label: "Labour, delivery and recovery", inCensus: true, needsRates: false },
  daycare: { label: "Day care", inCensus: false, needsRates: false },
  emergency: { label: "Emergency observation", inCensus: false, needsRates: false },
  overflow: { label: "Overflow (extra bed)", inCensus: true, needsRates: false, billsAs: "general" },
};

/** The three daily components go-live requires per rated class (decision 0072, answer 2). */
export const IPD_REQUIRED_RATE_COMPONENTS = ["room", "nursing", "visit"] as const;
/** Every component the rate card may carry per class; `rmo` and `cross_visit` are optional at go-live. */
export const IPD_RATE_COMPONENTS = ["room", "nursing", "rmo", "visit", "cross_visit"] as const;
export type IpdRateComponent = (typeof IPD_RATE_COMPONENTS)[number];
export const IpdRateComponentSchema = z.enum(IPD_RATE_COMPONENTS);

/** Tariff service code for one class and component, e.g. `IPD_ROOM_PRIVATE`. One place builds it. */
export function ipdRateServiceCode(cls: IpdBedClass, component: IpdRateComponent): string {
  return `IPD_${component.toUpperCase()}_${cls.toUpperCase()}`;
}
