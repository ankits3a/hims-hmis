import { useTranslation } from "react-i18next";
import { StationShell } from "../components/station/station-shell";
import type { StationLink, StationStat } from "../components/station/station-shell";

/**
 * PLAN 18-S RS1 — THE IMAGING DEPARTMENT'S SCREENS share the station shell the lab built (17-F F1).
 *
 * The board (`docs/design/2026-09-28-radiology-stations/`) draws ten stations. The code today has
 * three screens a person can browse to — the desk, the worklist and radiation safety — so those are
 * the three the switch offers; the study console and the report are reached FROM the worklist and
 * sit inside that station. Later phases add the rest (RS3 onward) by adding a row here and a route.
 *
 * **No behaviour changed**: every section, control and refusal of 18a / 18c is the one it shipped,
 * moved into a column, not rewritten.
 *
 * The shell wears `data-seat="radiology"`; `styles.css` scopes the paper / pine tokens to it the same
 * way it scopes the lab's, so the shadcn controls inside keep the board's values and nothing outside
 * the department turns green.
 */

export type RadiologyStationKey = "desk" | "worklist" | "safety";

/** The browsable stations, their routes and the grant each is reached by — the same pairs as `router.tsx`'s NAV. */
export const RADIOLOGY_STATIONS: readonly (Omit<StationLink, "label"> & { key: RadiologyStationKey; labelKey: string })[] = [
  { key: "desk", to: "/radiology/reception", labelKey: "nav.radiologyReception", permission: "radiology.schedule" },
  { key: "worklist", to: "/radiology/worklist", labelKey: "nav.radiologyWorklist", permission: "radiology.worklist.read" },
  { key: "safety", to: "/radiology/radiation-safety", labelKey: "nav.radiationSafety", permission: "aerb.registers.read" },
];

export function RadiologyStation({
  station, title, place, stats, list, clocks, clocksSummary, clocksAlert, children,
}: {
  station: RadiologyStationKey;
  title: string;
  place: string;
  stats: StationStat[];
  /** The station's one list, in the right column. */
  list?: React.ReactNode;
  clocks?: React.ReactNode;
  clocksSummary?: React.ReactNode;
  clocksAlert?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <StationShell
      seat="radiology"
      brand={t("radiology.station.department")}
      stations={RADIOLOGY_STATIONS.map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current={station}
      title={title}
      place={place}
      stats={stats}
      statsLabel={t("radiology.station.stats")}
      list={list}
      clocks={clocks}
      clocksSummary={clocksSummary}
      clocksAlert={clocksAlert}
    >
      {children}
    </StationShell>
  );
}
