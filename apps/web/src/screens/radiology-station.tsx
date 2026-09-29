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

export type RadiologyStationKey = "desk" | "diary" | "display" | "worklist" | "room" | "portable" | "usg" | "safety" | "setup" | "prep";

/** The browsable stations, their routes and the grant each is reached by — the same pairs as `router.tsx`'s NAV. */
export const RADIOLOGY_STATIONS: readonly (Omit<StationLink, "label"> & { key: RadiologyStationKey; labelKey: string })[] = [
  { key: "desk", to: "/radiology/reception", labelKey: "nav.radiologyReception", permission: "radiology.schedule" },
  /** 18-S RS3 — the desk's diary (machines × time) and the waiting-hall TV. */
  { key: "diary", to: "/radiology/diary", labelKey: "nav.radiologyDiary", permission: "radiology.schedule" },
  { key: "display", to: "/radiology/display", labelKey: "nav.radiologyDisplay", permission: "radiology.display.read" },
  /** 18-S RS5 — the prep & safety bay: the gates the check-in opened, contrast and the reaction. */
  { key: "prep", to: "/radiology/prep", labelKey: "nav.radiologyPrep", permission: "radiology.gates.satisfy" },
  { key: "worklist", to: "/radiology/worklist", labelKey: "nav.radiologyWorklist", permission: "radiology.worklist.read" },
  /** 18-S RS6 — the modality rooms: console, dose log, rejects & repeats, downtime (header views). */
  { key: "room", to: "/radiology/room", labelKey: "nav.radiologyRoom", permission: "radiology.acquire" },
  /** 18-S RS2b — the technologist's round of the beds the trolley goes to. */
  { key: "portable", to: "/radiology/portable", labelKey: "nav.radiologyPortable", permission: "radiology.acquire" },
  /** 18-S RS7 — the sonologist's room, the Form F register, the §19 registration, the monthly return. */
  { key: "usg", to: "/radiology/usg", labelKey: "nav.radiologyUsg", permission: "pcpndt.form_f.write" },
  { key: "safety", to: "/radiology/radiation-safety", labelKey: "nav.radiationSafety", permission: "aerb.registers.read" },
  /** 18-S RS4 — machines, books and prices. Its three views sit in the header (`views`). */
  { key: "setup", to: "/radiology/setup", labelKey: "nav.radiologySetup", permission: "radiology.devices.manage" },
];

export function RadiologyStation({
  station, title, place, stats, lane, list, listSummary, inHand, closeListOn, clocks, clocksSummary, clocksAlert, views, children,
}: {
  /** 18-S RS4 — a station's own views in the header (Setup: machines · books · prices; RS6 Rooms: console · dose · rejects · downtime). */
  views?: React.ReactNode;
  station: RadiologyStationKey;
  title: string;
  place: string;
  stats: StationStat[];
  /** 18-S RS3 — the patient in hand, under the station's day in the left lane. */
  lane?: React.ReactNode;
  /** The station's one list, in the right column. */
  list?: React.ReactNode;
  listSummary?: React.ReactNode;
  inHand?: boolean;
  /** Closes the narrow-screen list drawer when it changes (a patient taken in hand from it). */
  closeListOn?: string | null;
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
      lane={lane}
      list={list}
      listSummary={listSummary}
      inHand={inHand}
      closeListOn={closeListOn}
      views={views}
      clocks={clocks}
      clocksSummary={clocksSummary}
      clocksAlert={clocksAlert}
    >
      {children}
    </StationShell>
  );
}
