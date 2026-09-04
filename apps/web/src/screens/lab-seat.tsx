import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { getMode } from "../lib/ops-api";
import { useAuth } from "../lib/auth";

/**
 * PLAN 17c T1 / D1 — THE LABORATORY'S SEAT FRAME, shared by the five seats.
 *
 * A seat is a place a person stands all day (design boards 1–5): one header that says WHICH seat
 * this is, the IST clock, and the two or three numbers that seat watches, then the working
 * surface below. It wears Desk One through `data-seat="lab"` — `styles.css` scopes the paper /
 * pine tokens to that attribute, and nothing outside the frame changes colour (RC-3's ruling and
 * its limit: a portalled surface stays neutral).
 *
 * Nothing here narrates. The boards draw a "lab agent" strip; that surface does not exist in the
 * repository (17c D10) and the frame does not pretend it does.
 */

/** `HH:MM` in IST through the SPA's one formatter (`fmtIst`), ticking each half-minute. Display only. */
export function useIstClock(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return fmtIst(new Date(now).toISOString());
}

export type SeatStat = { label: string; value: string | number; tone?: "plain" | "live" | "waiting" | "danger" };

export function LabSeatFrame({
  title, place, stats, children,
}: {
  /** The seat's name — "Lab reception". */
  title: string;
  /** Where it stands — "Counter L-01". */
  place: string;
  stats: SeatStat[];
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const clock = useIstClock();
  return (
    <div data-seat="lab" className="min-h-full bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("lab.seat.department")}</div>
          <h1 className="text-lg font-semibold leading-tight">{title} <span className="font-normal text-muted-foreground">· {place}</span></h1>
        </div>
        <ul className="flex flex-wrap items-center gap-4" aria-label={t("lab.seat.stats")}>
          {stats.map((s) => (
            <li key={s.label} className="flex items-baseline gap-2">
              <span
                className="text-2xl font-semibold tabular-nums"
                style={s.tone === "live" ? { color: "var(--state-live)" }
                  : s.tone === "waiting" ? { color: "var(--state-waiting)" }
                    : s.tone === "danger" ? { color: "var(--state-danger)" } : undefined}
              >
                {s.value}
              </span>
              <span className="text-sm text-muted-foreground">{s.label}</span>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span className="rounded border border-border px-1.5 py-0.5 text-xs">Ctrl K</span>
          <time className="tabular-nums" data-testid="seat-clock">{clock}</time>
        </div>
      </header>
      <div className="p-4">{children}</div>
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
