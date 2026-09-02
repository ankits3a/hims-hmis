import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `HH:MM` in IST, ticking each minute. Display only — every stamp the server stores is its own. */
export function useIstClock(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const shifted = new Date(now + IST_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
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
