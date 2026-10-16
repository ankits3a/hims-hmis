import { IPD_RATE_COMPONENTS } from "@hmis/contracts";
import { IPD_RATED_CLASSES, IPD_TARIFF_CSV_COLUMNS } from "../../src/modules/tariff";
import type { IpdBedClass, IpdRateComponent } from "@hmis/contracts";

/**
 * ═══ THE SUBSIDISED MEDICAL-COLLEGE IPD RATE CARD — DECISION 0074 (owner 2026-10-14) ═══
 *
 * The owner's interim inpatient daily rates for staging, until the incumbent's IPD tariff export arrives through
 * `scripts/import-ipd-tariff.ts` and replaces them. Rupees per day, one explicit cell per rated class × component —
 * no derived numbers. `overflow` is never emitted: it bills as general.
 *
 * The table is TypeScript, not a .csv, because the runtime image ships `dist/` only.
 */
export const UAT_SAMPLE_MARKER = "Subsidised medical-college rate card (decision 0074)";

/** The previous placeholder's marker — still recognised, so the existing staging draft is updated in place. */
export const LEGACY_SAMPLE_MARKERS: readonly string[] = ["UAT SAMPLE — not hospital rates"];

/** The draft tariff version's note. */
export const UAT_SAMPLE_TARIFF_NOTE =
  `${UAT_SAMPLE_MARKER}: interim IPD daily rates, owner 2026-10-14; to be replaced by the incumbent tariff export (scripts/stage-ipd-setup.ts)`;

type Row = Record<IpdRateComponent, number>;
/** Rupees per day: room / nursing / rmo / visit / cross_visit (decision 0074). */
export const RATE_CARD_RUPEES: Record<Exclude<IpdBedClass, "overflow">, Row> = {
  general:      { room: 150,  nursing: 100, rmo: 50,  visit: 100, cross_visit: 150 },
  semi_private: { room: 600,  nursing: 200, rmo: 100, visit: 250, cross_visit: 300 },
  private:      { room: 1200, nursing: 300, rmo: 150, visit: 400, cross_visit: 500 },
  deluxe:       { room: 1800, nursing: 400, rmo: 200, visit: 500, cross_visit: 600 },
  suite:        { room: 2500, nursing: 500, rmo: 250, visit: 600, cross_visit: 700 },
  hdu:          { room: 1000, nursing: 400, rmo: 200, visit: 300, cross_visit: 400 },
  icu:          { room: 1500, nursing: 500, rmo: 300, visit: 400, cross_visit: 500 },
  nicu:         { room: 1200, nursing: 500, rmo: 300, visit: 400, cross_visit: 500 },
  picu:         { room: 1200, nursing: 500, rmo: 300, visit: 400, cross_visit: 500 },
  ldr:          { room: 500,  nursing: 200, rmo: 100, visit: 200, cross_visit: 300 },
  daycare:      { room: 150,  nursing: 100, rmo: 50,  visit: 100, cross_visit: 150 },
  emergency:    { room: 300,  nursing: 150, rmo: 100, visit: 200, cross_visit: 300 },
};

export function uatSampleTariffRows(): { bedClass: IpdBedClass; component: IpdRateComponent; rupees: number }[] {
  return IPD_RATED_CLASSES.flatMap((bedClass) => {
    const row = RATE_CARD_RUPEES[bedClass as Exclude<IpdBedClass, "overflow">];
    if (row === undefined) throw new Error(`decision 0074 rate card has no row for rated class ${bedClass}`);
    return IPD_RATE_COMPONENTS.map((component) => ({ bedClass, component, rupees: row[component] }));
  });
}

/** The importer's CSV: one row per rated class × component, each named with the marker. */
export function uatSampleTariffCsv(): string {
  const lines = [IPD_TARIFF_CSV_COLUMNS.join(",")];
  for (const r of uatSampleTariffRows()) {
    const code = `D0074-${r.bedClass}-${r.component}`.toUpperCase();
    lines.push([code, `"${UAT_SAMPLE_MARKER} (${r.bedClass} ${r.component})"`, r.bedClass, r.component, String(r.rupees)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
