import { IPD_RATE_COMPONENTS } from "@hmis/contracts";
import { IPD_RATED_CLASSES, IPD_TARIFF_CSV_COLUMNS } from "../../src/modules/tariff";
import type { IpdBedClass, IpdRateComponent } from "@hmis/contracts";

/**
 * ═══ UAT SAMPLE IPD TARIFF — NOT HOSPITAL RATES ═══
 *
 * PLACEHOLDER data that lets staging price an admission from end to end, so the owner can walk admit → charges →
 * bill → discharge. It is NOT a money ruling and NOT the incumbent's tariff. The real rate card arrives as the
 * incumbent's export through `scripts/import-ipd-tariff.ts`. Every row's `incumbent_name` and the draft version's
 * note carry the marker below, so nobody can mistake these numbers for real ones.
 *
 * The numbers are round placeholders scaled by class (general room 1000, ICU room 6000), with the other components
 * as fixed fractions of the room rent. The table is written as TypeScript rather than a .csv because the runtime image
 * ships `dist/` only: a sibling .csv file would be missing on UAT.
 */
export const UAT_SAMPLE_MARKER = "UAT SAMPLE — not hospital rates";

/** The draft tariff version's note. The importer stores it on the version the billing office sees. */
export const UAT_SAMPLE_TARIFF_NOTE = `${UAT_SAMPLE_MARKER}: IPD placeholder rate card for staging walk-throughs (scripts/stage-ipd-setup.ts)`;

/** Room rent in rupees per class (placeholder). */
const ROOM_RUPEES: Record<IpdBedClass, number> = {
  general: 1000, semi_private: 1500, private: 2500, deluxe: 3500, suite: 5000,
  hdu: 4000, icu: 6000, nicu: 6000, picu: 6000, ldr: 2000, daycare: 1000, emergency: 1500,
  overflow: 1000, // never emitted: overflow bills as general (the importer refuses a row for it)
};

/** Each component as a fraction of the room rent (placeholder). */
const SHARE: Record<IpdRateComponent, number> = { room: 1, nursing: 0.4, rmo: 0.2, visit: 0.5, cross_visit: 0.5 };

export function uatSampleTariffRows(): { bedClass: IpdBedClass; component: IpdRateComponent; rupees: number }[] {
  return IPD_RATED_CLASSES.flatMap((bedClass) => IPD_RATE_COMPONENTS.map((component) => ({
    bedClass, component, rupees: Math.round((ROOM_RUPEES[bedClass] * SHARE[component]) / 100) * 100,
  })));
}

/** The importer's CSV: one row per rated class × component, each named with the marker. */
export function uatSampleTariffCsv(): string {
  const lines = [IPD_TARIFF_CSV_COLUMNS.join(",")];
  for (const r of uatSampleTariffRows()) {
    const code = `UATS-${r.bedClass}-${r.component}`.toUpperCase();
    lines.push([code, `"${UAT_SAMPLE_MARKER} (${r.bedClass} ${r.component})"`, r.bedClass, r.component, String(r.rupees)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
