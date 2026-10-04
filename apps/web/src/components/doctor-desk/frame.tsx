import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../../lib/auth";
import { useCopilot } from "../../lib/use-copilot";
import { ModeBanner } from "../mode-banner";
import "./frame.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 20-U U5 — THE DOCTOR DESK FRAME (layout only)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The frame the owner approved on 2026-09-18 (`docs/design/2026-09-18-doctor-desk/Tower.dc.html`)
 * and drew the roster boards inside (`docs/design/2026-09-20-roster/Main.dc.html`): a white 48px
 * header (◆ DESK ONE, a context line, a centre context pill, the date and time, who is signed in),
 * a grouped LEFT menu that opens and closes, the work in the centre, a RIGHT rail of cards, and a
 * dark ask bar at the foot of the centre column. Markup and sizes are the board's; `frame.css`
 * carries them, with the breakpoints.
 *
 * ═══ THE MENU SHOWS ONLY PLACES THAT EXIST ═══
 *
 * The board's menu has twenty-four entries (Dashboard, My Patients, Clocks Running, Unit Board,
 * Handover, AI Briefs, …). Most of those screens are not built, and a menu entry that goes nowhere is
 * a dead link a doctor taps once and then distrusts the whole menu. So the groups keep the board's
 * names and order and list ONLY built destinations the person may open (`can(permission)`): My OPD
 * (`/opd/consult`), the unit's Roster and Who is on now. A group with nothing in it is not drawn. A
 * new screen joins by adding one row to `MENU` below.
 *
 * The frame owns the viewport (the routes carry `staticData.fullViewport`), so it draws the hospital's
 * `ModeBanner` itself, and the ◆ DESK ONE wordmark is the way back to the rest of HMIS.
 */

type IconKey = "doc" | "cal" | "phone";
const ICON: Record<IconKey, string> = {
  doc: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5",
  cal: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  phone: "M3 2.5h3l1 3-1.7 1.2a8 8 0 004 4L10.5 9l3 1v3a1 1 0 01-1 1A10.5 10.5 0 012 3.5a1 1 0 011-1z",
};

export type DeskMenuKey = "myOpd" | "roster" | "onNow";
type MenuItem = { key: DeskMenuKey; to: string; label: string; permission: string; icon: IconKey };
type MenuGroup = { key: string; label: string; items: MenuItem[] };

/** The board's groups, in the board's order, with only the destinations that are built. */
export const MENU: readonly MenuGroup[] = [
  { key: "desk", label: "doctorDesk.group.desk", items: [
    { key: "myOpd", to: "/opd/consult", label: "doctorDesk.item.myOpd", permission: "opd.consult", icon: "doc" },
  ] },
  { key: "unit", label: "doctorDesk.group.unit", items: [
    { key: "roster", to: "/roster/month", label: "doctorDesk.item.roster", permission: "roster.read", icon: "cal" },
    { key: "onNow", to: "/roster/on-now", label: "doctorDesk.item.onNow", permission: "roster.read", icon: "phone" },
  ] },
];

/** "Sun 4 Oct 2026 · 16:41" in IST, ticking every half-minute. Display only. */
function useDeskClock(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const d = new Date(now);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .format(d).replace(/,/g, "");
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day} · ${time}`;
}

function useNarrow(query: string): boolean {
  const get = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = (): void => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

export function DoctorDeskFrame({
  active, context, pill, rail, ask, menuDefault = "open", railWidth = 348, testId, children,
}: {
  active: DeskMenuKey;
  /** The header's context line — "Doctor Desk · General Medicine · Unit I". */
  context: string;
  /** The centre context pill: a tag ("TODAY") and its line. Omitted when the screen has none. */
  pill?: { tag: string; text: string };
  /** The right rail's cards. */
  rail?: React.ReactNode;
  /** The ask bar, at the foot of the centre. */
  ask?: React.ReactNode;
  /** The OnNow board is drawn without the menu; the person can still open it. */
  menuDefault?: "open" | "closed";
  railWidth?: number;
  testId?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can, username } = useAuth();
  const router = useRouter({ warn: false });
  const clock = useDeskClock();
  const drawerMode = useNarrow("(max-width: 1099px)");
  const [menuOpen, setMenuOpen] = useState(menuDefault === "open");
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const go = (e: React.MouseEvent, to: string): void => {
    setDrawer(false);
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to });
  };
  const groups = MENU.map((g) => ({ ...g, items: g.items.filter((i) => i.key === active || can(i.permission)) }))
    .filter((g) => g.items.length > 0);
  const shownOpen = drawerMode ? drawer : menuOpen;
  const initials = (username ?? "").replace(/[^a-z]/gi, "").slice(0, 2) || "·";

  return (
    <div
      className="ddf"
      data-menu={menuOpen ? "open" : "closed"}
      data-drawer={drawer ? "open" : "closed"}
      data-rail={rail === undefined ? "none" : "some"}
      style={{ ["--rail-w" as string]: `${String(railWidth)}px` }}
      data-testid={testId}
    >
      <header className="ddf-top">
        <button
          type="button" className="ddf-toggle" data-testid="desk-menu-toggle"
          aria-expanded={shownOpen} aria-controls="ddf-menu"
          aria-label={shownOpen ? t("doctorDesk.hideMenu") : t("doctorDesk.showMenu")}
          onClick={() => (drawerMode ? setDrawer((o) => !o) : setMenuOpen((o) => !o))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
          <span className="ddf-toggle-word">{t("doctorDesk.menu")}</span>
        </button>
        <a href="/" className="ddf-brand" aria-label={t("doctorDesk.home")} onClick={(e) => go(e, "/")}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 0l7 7-7 7-7-7z" fill="#0e6b4e" /></svg>
          <span>DESK ONE</span>
        </a>
        <div className="ddf-context" data-testid="desk-context">{context}</div>
        <div className="ddf-grow" />
        {pill !== undefined && (
          <div className="ddf-pill" data-testid="desk-pill">
            <span className="ddf-pill-tag">{pill.tag}</span>
            <span className="ddf-pill-text">{pill.text}</span>
          </div>
        )}
        <div className="ddf-grow" />
        <div className="ddf-when" data-testid="desk-clock">{clock}</div>
        <span className="ddf-user">
          <span className="ddf-avatar" aria-hidden="true">{initials}</span>
          <span className="ddf-user-name">{username ?? ""}</span>
        </span>
      </header>
      <ModeBanner />
      <div className="ddf-body">
        {drawerMode && drawer && <button type="button" className="ddf-scrim" aria-label={t("doctorDesk.hideMenu")} onClick={() => setDrawer(false)} />}
        <nav className="ddf-menu" id="ddf-menu" aria-label={t("doctorDesk.menu")} data-testid="desk-menu">
          {groups.map((g) => (
            <div key={g.key} className="ddf-group">
              <div className="ddf-group-label">{t(g.label)}</div>
              {g.items.map((it) => (
                <a
                  key={it.key} href={it.to} className="ddf-item" data-testid={`desk-menu-${it.key}`}
                  aria-current={it.key === active ? "page" : undefined}
                  onClick={(e) => go(e, it.to)}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[it.icon]} /></svg>
                  <span style={{ flexGrow: 1 }}>{t(it.label)}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="ddf-main">
          {pill !== undefined && (
            <div className="ddf-pill ddf-pill-inline">
              <span className="ddf-pill-tag">{pill.tag}</span>
              <span className="ddf-pill-text">{pill.text}</span>
            </div>
          )}
          {children}
          {ask}
        </main>
        {rail !== undefined && <aside className="ddf-rail" aria-label={t("doctorDesk.rail")}>{rail}</aside>}
      </div>
    </div>
  );
}

/**
 * THE ASK BAR — the board's dark 44px bar ("ask —" and a question), wired to the hospital's copilot
 * (`useCopilot`: the server's catalog first, this screen's own answerer when the server does not
 * understand or cannot be reached). The answer appears inside the bar, on the dark ground the machine
 * always speaks on. `terms` are the names on the screen, masked by value before anything leaves.
 */
export function AskBar({ id, placeholder, fallback, terms }: {
  id: string;
  placeholder: string;
  fallback: (question: string) => string | null;
  terms: () => string[];
}): React.ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const copilot = useCopilot({ fallback, terms });
  return (
    <form
      className="ddf-ask" data-testid="desk-ask"
      onSubmit={(e) => { e.preventDefault(); copilot.ask(draft); }}
    >
      {(copilot.answer !== null || copilot.busy) && (
        <div className="ddf-ask-answer" role="status" data-testid="desk-ask-answer">
          {copilot.busy ? t("doctorDesk.asking") : copilot.answer}
        </div>
      )}
      <div className="ddf-ask-row">
        <span className="ddf-ask-word">{t("doctorDesk.ask")}</span>
        <label htmlFor={id} className="sr">{t("doctorDesk.askLabel")}</label>
        <input
          id={id} className="ddf-ask-input" type="text" value={draft} placeholder={placeholder}
          autoComplete="off" onChange={(e) => setDraft(e.target.value)}
        />
      </div>
    </form>
  );
}
