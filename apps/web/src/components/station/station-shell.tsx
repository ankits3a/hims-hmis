import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../../lib/auth";
import { fmtIst } from "../../lib/format";
import { usePaletteOptional } from "../command-palette";
import { ModeBanner } from "../mode-banner";
import "../../styles/paper-pine.css";
import "./station.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PLAN 17-F F1 — THE STATION SHELL: one frame for every station of a department
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's layout ruling (25 Sep 2026, `docs/design/2026-09-25-lims-stations/`), drawn once:
 *
 *   · the menu is in the HEADER — the station switch, and the way out (F8, the hospital's palette);
 *   · the LEFT lane is whoever is in hand; with nobody in hand it is the station's own day;
 *   · the CENTRE is the work;
 *   · the RIGHT is ONE list with no filter tabs, then "Clocks running", collapsed unless something on
 *     it has run out;
 *   · opening something shrinks the list to one line and the copilot panel takes the column — but
 *     only when the screen HAS a copilot. A screen without one keeps its list; a collapsed list with
 *     nothing in its place would be a column that hides work for no reason.
 *
 * Breakpoints are the board's: the list becomes a drawer below 1280px, the header's own views fold
 * into a Menu below 1100px, and at 1000px and below the station switch moves into that Menu too.
 *
 * The station switch is filtered by `can()` — a person sees the stations they may work, and the one
 * they are on. It navigates through the router when there is one and is a plain link when there is
 * not (a screen's own suite renders it without a router, and a link is still the right element).
 *
 * The shell owns the viewport (`staticData.fullViewport` on the route), so it draws the hospital's
 * `ModeBanner` itself: the app chrome that used to carry it is not in the DOM on these routes.
 */

export type StationLink = { key: string; to: string; label: string; permission: string };
export type StationStat = { label: string; value: string | number; tone?: "plain" | "live" | "waiting" | "danger" };

/** `HH:MM` in IST through the SPA's one formatter (`fmtIst`), ticking each half-minute. Display only. */
export function useIstClock(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return fmtIst(new Date(now).toISOString());
}

/** True while the viewport matches `query`. jsdom has no `matchMedia`, and there it is simply false. */
function useMedia(query: string): boolean {
  const [hit, setHit] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = (): void => setHit(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return hit;
}

const TONE: Record<NonNullable<StationStat["tone"]>, string | undefined> = {
  plain: undefined, live: "var(--green)", waiting: "var(--gold)", danger: "var(--red)",
};

export function StationShell({
  brand, stations, current, title, place, stats, statsLabel,
  lane, list, listSummary, clocks, clocksSummary, clocksAlert = false,
  copilot, inHand = false, views, children,
}: {
  /** The department, in the header and over the lane — "Central lab". */
  brand: string;
  /** Every station of the department; the switch shows the ones `can()` allows, and `current`. */
  stations: readonly StationLink[];
  current: string;
  /** The station's name and where it stands — "Lab reception", "Counter L-01". */
  title: string;
  place: string;
  /** The two or three numbers the station watches, shown in the lane while nobody is in hand. */
  stats: StationStat[];
  statsLabel: string;
  /** The lane's content below the station's day: the patient, run or escalation in hand. */
  lane?: React.ReactNode;
  /** The right column's one list. */
  list?: React.ReactNode;
  /** The list folded to one line while something is in hand ("15 on the list · next Kamla Devi"). */
  listSummary?: React.ReactNode;
  /** "Clocks running": collapsed by default, open by itself while `clocksAlert` is true. */
  clocks?: React.ReactNode;
  clocksSummary?: React.ReactNode;
  clocksAlert?: boolean;
  /** The copilot panel. With something in hand it replaces the list, which folds to its summary. */
  copilot?: React.ReactNode;
  inHand?: boolean;
  /** The station's own views (header nav); they fold into the Menu below 1100px. */
  views?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { can, username } = useAuth();
  const router = useRouter({ warn: false });
  const palette = usePaletteOptional();
  const clock = useIstClock();
  const narrow = useMedia("(max-width: 1279px)");
  const [listOpen, setListOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /* The person's choice wins; until they make one, the clocks follow the alert. */
  const [clocksChoice, setClocksChoice] = useState<boolean | null>(null);
  const clocksOpen = clocksChoice ?? clocksAlert;
  const [listChoice, setListChoice] = useState(false);
  const folded = inHand && copilot !== undefined && !listChoice;

  useEffect(() => { setListChoice(false); }, [inHand]);

  useEffect(() => {
    if (!listOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { setListOpen(false); setMenuOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen, menuOpen]);

  const visible = stations.filter((s) => s.key === current || can(s.permission));
  const go = (e: React.MouseEvent, to: string): void => {
    setMenuOpen(false);
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to });
  };
  const stationLinks = (inMenu: boolean): React.ReactNode => visible.map((s) => (
    <a
      key={s.key}
      href={s.to}
      className="st-nv"
      data-testid={inMenu ? `station-menu-${s.key}` : `station-to-${s.key}`}
      aria-current={s.key === current ? "page" : undefined}
      onClick={(e) => go(e, s.to)}
    >
      {s.label}
    </a>
  ));

  return (
    <div
      className={`st${listOpen ? " list-open" : ""}`}
      data-seat="lab"
      data-station={current}
      data-lang={i18n.language.startsWith("hi") ? "hi" : "en"}
      data-testid="station-shell"
    >
      <header className="st-top">
        <div className="st-brand">
          <span className="st-dia" aria-hidden="true" />
          <span className="st-bn mo">{brand.toUpperCase()}</span>
        </div>
        <nav className="st-switch" aria-label={t("station.switch")}>{stationLinks(false)}</nav>
        {views !== undefined && <div className="st-views">{views}</div>}
        <button
          type="button"
          className={`st-btn st-menubtn${views !== undefined ? " has-views" : ""}`}
          aria-expanded={menuOpen}
          data-testid="station-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {t("station.menu")} <span aria-hidden="true">▾</span>
        </button>
        {menuOpen && (
          <div className="st-drop" data-testid="station-menu-panel">
            <div className="st-drop-stations">{stationLinks(true)}</div>
            {views}
          </div>
        )}
        <div className="st-grow" />
        <button
          type="button"
          className="st-btn st-listbtn"
          aria-expanded={listOpen}
          data-testid="station-list-toggle"
          onClick={() => setListOpen((o) => !o)}
        >
          {t("station.list")}
        </button>
        <time className="mo st-clock" data-testid="seat-clock">{clock}</time>
        <span className="st-user">{username ?? ""}</span>
        {palette !== null && (
          <button type="button" className="st-btn st-cmd" data-testid="station-command" onClick={() => palette.open()}>
            ⌘ <span className="kb">F8</span>
          </button>
        )}
      </header>
      <ModeBanner />
      <div className="st-body">
        <aside className="st-lane" aria-label={t("station.lane")}>
          <h1 className="st-title">{title}</h1>
          <p className="st-place">{place}</p>
          <ul className="st-stats" aria-label={statsLabel}>
            {stats.map((s) => (
              <li key={s.label}>
                <span>{s.label}</span>
                <b className="mo" style={s.tone === undefined ? undefined : { color: TONE[s.tone] }}>{s.value}</b>
              </li>
            ))}
          </ul>
          {lane}
        </aside>
        <main className="st-centre">{children}</main>
        <aside
          className="st-right"
          aria-label={t("station.right")}
          data-testid="station-right"
          inert={narrow && !listOpen ? true : undefined}
        >
          {folded ? (
            <button type="button" className="st-plmin" data-testid="station-list-folded" onClick={() => setListChoice(true)}>
              {listSummary ?? t("station.list")} <span aria-hidden="true">▾</span>
            </button>
          ) : list}
          {folded && copilot}
          {clocks !== undefined && (
            <section className="st-clocks" data-alert={clocksAlert ? "true" : undefined}>
              <button
                type="button"
                className="st-fold"
                aria-expanded={clocksOpen}
                data-testid="station-clocks-toggle"
                onClick={() => setClocksChoice(!clocksOpen)}
              >
                <b>{t("station.clocks")}</b>
                <span className="st-fold-s">{clocksSummary}</span>
                <span className="st-chev" aria-hidden="true">▾</span>
              </button>
              {clocksOpen && <div className="st-clocks-body">{clocks}</div>}
            </section>
          )}
        </aside>
        <div className="st-scrim" aria-hidden="true" onClick={() => setListOpen(false)} />
      </div>
    </div>
  );
}
