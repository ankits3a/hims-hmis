import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getMode } from "../lib/ops-api";
import { useAuth } from "../lib/auth";
import { labErrorText } from "../lib/lab-api";
import { saveLabMode, shownInMode, useLabMode } from "../lib/lab-mode";
import type { LabMode } from "../lib/lab-mode";
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

export type LabStationKey = "desk" | "collection" | "bench" | "verify" | "reports" | "quick" | "counter" | "qcollect" | "qbench" | "qreports";

/** The five stations, their routes and the grant each is reached by — the same pairs as `router.tsx`'s NAV. */
export const LAB_STATIONS: readonly (Omit<StationLink, "label"> & { key: LabStationKey; labelKey: string; mode: LabMode | "never" })[] = [
  /** Owner 2026-10-11 — the quick chain, the lab's everyday path: counter → collect → bench → reports. */
  { key: "counter", to: "/lab/counter", labelKey: "nav.labCounter", permission: "lab.desk.operate", mode: "quick" },
  { key: "qcollect", to: "/lab/qcollect", labelKey: "nav.labQCollect", permission: "lab.worklist.read", mode: "quick" },
  { key: "qbench", to: "/lab/qbench", labelKey: "nav.labQBench", permission: "lab.results.enter", mode: "quick" },
  { key: "qreports", to: "/lab/qreports", labelKey: "nav.labQReports", permission: "lab.reports.print", mode: "quick" },
  { key: "desk", to: "/lab/desk", labelKey: "nav.labDesk", permission: "lab.desk.operate", mode: "full" },
  { key: "collection", to: "/lab/collection", labelKey: "nav.labCollection", permission: "lab.collection.operate", mode: "full" },
  { key: "bench", to: "/lab/bench", labelKey: "nav.labBench", permission: "lab.accession.operate", mode: "full" },
  { key: "verify", to: "/lab/verify", labelKey: "nav.labVerify", permission: "lab.results.verify", mode: "full" },
  { key: "reports", to: "/lab/reports", labelKey: "nav.labReports", permission: "lab.reports.print", mode: "full" },
  { key: "quick", to: "/lab/quick", labelKey: "nav.labQuick", permission: "lab.results.enter", mode: "never" },
];

export function LabStation({
  station, title, place, stats, list, clocks, clocksSummary, clocksAlert, lane, laneHead, children,
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
  /** The left lane's content below the station's day — the patient in hand (owner 2026-10-11, the lab desk). */
  lane?: React.ReactNode;
  /** `false` gives the lane to `lane` alone, with no station title and numbers over it. */
  laneHead?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const mode = useLabMode();
  const mine = LAB_STATIONS.find((s) => s.key === station)?.mode;
  /** Owner 2026-10-12 — a station of the mode the lab is NOT running says so instead of working. */
  const off = mode !== null && mine !== undefined && mine !== "never" && mine !== mode;
  return (
    <StationShell
      brand={t("lab.seat.department")}
      stations={LAB_STATIONS.filter((s) => s.key === station || shownInMode(s.mode, mode))
        .map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current={station}
      title={title}
      place={place}
      stats={stats}
      statsLabel={t("lab.seat.stats")}
      list={list}
      clocks={clocks}
      clocksSummary={clocksSummary}
      clocksAlert={clocksAlert}
      lane={lane}
      laneHead={laneHead}
    >
      {off ? <LabModeOff mode={mode} /> : children}
    </StationShell>
  );
}

/** The notice a station of the other mode shows, with the switch for the one person who may flip it. */
function LabModeOff({ mode }: { mode: LabMode }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="box" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }} data-testid="lab-mode-off">
      <b style={{ fontSize: 15 }}>{t(mode === "quick" ? "lab.mode.fullOff" : "lab.mode.quickOff")}</b>
      <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{t(mode === "quick" ? "lab.mode.useQuick" : "lab.mode.useFull")}</span>
      <LabModeSwitch />
    </div>
  );
}

/**
 * OWNER 2026-10-12 — the switch. Shown only to the lab's administrator (`lab.catalogue.manage`); a
 * change asks once, because every lab seat's menu changes with it.
 */
export function LabModeSwitch(): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const mode = useLabMode();
  const [asking, setAsking] = useState<LabMode | null>(null);
  const save = useMutation({
    mutationFn: saveLabMode,
    onSuccess: (r) => { qc.setQueryData(["lab", "mode"], r); setAsking(null); },
  });
  if (!can("lab.catalogue.manage") || mode === null) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} data-testid="lab-mode-switch">
      <span className="tag">{t("lab.mode.title")}</span>
      {(["quick", "full"] as const).map((m) => (
        <button key={m} type="button" className={m === mode ? "pill on" : "pill"} aria-pressed={m === mode}
          style={{ height: 28 }} onClick={() => { if (m !== mode) setAsking(m); }}>
          {t(`lab.mode.${m}`)}
        </button>
      ))}
      {asking !== null && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }} role="alertdialog" aria-label={t("lab.mode.confirm", { mode: t(`lab.mode.${asking}`) })}>
          <span style={{ fontSize: 12 }}>{t("lab.mode.confirm", { mode: t(`lab.mode.${asking}`) })}</span>
          <button type="button" className="pri" style={{ height: 28 }} disabled={save.isPending} onClick={() => save.mutate(asking)}>{t("lab.mode.yes")}</button>
          <button type="button" className="sec" style={{ height: 28 }} onClick={() => setAsking(null)}>{t("lab.mode.no")}</button>
        </span>
      )}
      {save.isError && <span role="alert" style={{ color: "var(--red)", fontSize: 12 }}>{labErrorText(save.error)}</span>}
    </div>
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
