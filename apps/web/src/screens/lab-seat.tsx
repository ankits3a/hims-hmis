import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getMode } from "../lib/ops-api";
import { useAuth } from "../lib/auth";
import { StationShell } from "../components/station/station-shell";
import type { StationLink, StationStat } from "../components/station/station-shell";

/**
 * PLAN 17c T1 / D1, rebuilt by PLAN 17-F F1 — THE LABORATORY'S FIVE STATIONS share one frame.
 *
 * 17c drew each seat as one header (which seat, the IST clock, the two or three numbers it watches)
 * over a working surface of its own columns. 17-F F1 puts the same screens into the owner-approved
 * station shell (`components/station/station-shell.tsx`, board `docs/design/2026-09-25-lims-stations/`):
 * the header carries the station switch and the way out, the lane carries the station's numbers
 * while nobody is in hand, the centre is the work, and the right column is the seat's one list with
 * "Clocks running" under it. **No behaviour changed**: every section, control and refusal is the
 * one 17c shipped, moved into a column, not rewritten.
 *
 * It still wears Desk One through `data-seat="lab"` — `styles.css` scopes the shadcn tokens to that
 * attribute, so the controls inside keep the paper / pine values they had.
 *
 * Nothing here narrates. The board draws a copilot panel; no lab copilot exists in the repository
 * yet (17c D10), so no station passes one and the list never folds.
 */

export { useIstClock } from "../components/station/station-shell";
export type SeatStat = StationStat;

export type LabStationKey = "desk" | "collection" | "bench" | "verify" | "reports";

/** The five stations, their routes and the grant each is reached by — the same pairs as `router.tsx`'s NAV. */
export const LAB_STATIONS: readonly (Omit<StationLink, "label"> & { key: LabStationKey; labelKey: string })[] = [
  { key: "desk", to: "/lab/desk", labelKey: "nav.labDesk", permission: "lab.desk.operate" },
  { key: "collection", to: "/lab/collection", labelKey: "nav.labCollection", permission: "lab.collection.operate" },
  { key: "bench", to: "/lab/bench", labelKey: "nav.labBench", permission: "lab.accession.operate" },
  { key: "verify", to: "/lab/verify", labelKey: "nav.labVerify", permission: "lab.results.verify" },
  { key: "reports", to: "/lab/reports", labelKey: "nav.labReports", permission: "lab.reports.print" },
];

export function LabStation({
  station, title, place, stats, list, clocks, clocksSummary, clocksAlert, children,
}: {
  station: LabStationKey;
  /** The seat's name — "Lab reception". */
  title: string;
  /** Where it stands — "Counter L-01". */
  place: string;
  stats: SeatStat[];
  /** The seat's queue, in the right column. */
  list: React.ReactNode;
  /** What is running out of time, under the list. */
  clocks?: React.ReactNode;
  clocksSummary?: React.ReactNode;
  clocksAlert?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <StationShell
      brand={t("lab.seat.department")}
      stations={LAB_STATIONS.map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current={station}
      title={title}
      place={place}
      stats={stats}
      statsLabel={t("lab.seat.stats")}
      list={list}
      clocks={clocks}
      clocksSummary={clocksSummary}
      clocksAlert={clocksAlert}
    >
      {children}
    </StationShell>
  );
}

/** Age in whole years from an ISO date of birth, or null. Display only. */
export function ageYearsFrom(dob: string | null, now: Date = new Date()): number | null {
  if (dob === null) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
  return years;
}

/** "52 F" — the way every board writes a patient's sex and age beside the name. */
export function sexAge(administrativeGender: string, dob: string | null): string {
  const g = administrativeGender === "female" ? "F" : administrativeGender === "male" ? "M" : "—";
  const age = ageYearsFrom(dob);
  return age === null ? g : `${String(age)} ${g}`;
}

/* ═══════════ 17d T6 / D7 — DOWNTIME, AT THE SEAT (design board EdgeCases #20) ═══════════ */

/**
 * **THE LAB READS THE HOSPITAL'S MODE. IT NEVER SETS ONE.**
 *
 * `ModeBanner` already tells every screen in the building that the hospital is in `downtime`, and
 * that is not what this is for. The board's case is *"server or internet down for an hour"*, and
 * its complaint is sharper than "nobody knows": **the paper register and the later reconciliation
 * are a habit rather than a screen.** The tube still has to be labelled and accessioned, so the
 * seats need the pre-printed kit's serial — the field `printLabels` and `receive` have accepted
 * since 17a T5 (E20 / 02 C3) and no screen has ever offered.
 *
 * A second switch here would be a second truth: a lab that could declare its own downtime would
 * disagree with the duty manager's mode within the hour, and the reconciliation afterwards would
 * have two registers to believe. So this is a READ, and `/ops/mode` mints no read permission
 * precisely so that every screen may make it (`kernel/ops/manifest.ts`).
 *
 * Polls at `ModeBanner`'s own cadence so the two never disagree on the same screen.
 */
export function useDowntime(): boolean {
  const { actor } = useAuth();
  const mode = useQuery({
    queryKey: ["ops", "mode"],
    queryFn: getMode,
    enabled: actor !== null,
    refetchInterval: 15_000,
  });
  return mode.data?.mode === "downtime";
}

/**
 * What the operator is told when the printer cannot print and the network may not answer. Named
 * rather than inlined at two seats, because the chair and the bench must say the SAME thing about
 * the same kit — a reconciliation that reads two different instructions is the failure this is
 * written to prevent.
 */
export function DowntimeNotice({ children }: { children?: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      data-testid="lab-downtime"
      role="status"
      className="space-y-2 rounded border-2 p-2 text-sm"
      style={{ borderColor: "var(--state-danger)" }}
    >
      <p className="font-bold">{t("lab.seat.downtimeTitle")}</p>
      <p className="text-xs">{t("lab.seat.downtimeReconcile")}</p>
      {children}
    </div>
  );
}
