import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { getTower, getTowerSummary } from "../lib/stores-api";
import { StoresCopilot } from "../components/stores/stores-copilot";
import "./stores.css";
import type { StoresTowerLane, WireRedCard, WireTowerCard, WireTowerView } from "@hmis/contracts";

/**
 * STORES S3 (#1113) — `/stores/tower`, THE CONTROL TOWER (spec "## Screens").
 *
 * A 16:9 wall (designed at 1920 × 1080, fits 1366 × 768 with no vertical scroll): the red-card strip on top (at
 * most 8, oldest first: what · where · clock), six lanes in the middle, the floor map on the right, the numbers
 * strip at the foot (spend only when the server sent it, i.e. for `stores.spend.read`). The screen is one
 * viewport-high box that hides overflow: a lane shows the cards that fit and says how many more, so the page can
 * never grow a scroll. Every status is a word; colour only repeats it.
 *
 * It refreshes every 15 s and keeps the last board with "Offline" when a refresh fails. Each hour the whole board
 * moves a few pixels so nothing burns into a wall screen. The wall has no primary button; on a desktop a card
 * opens the ticket's timeline.
 *
 * At phone width (< 700 px) it is the owner's one line instead: "3 stuck · 4B, OT", and See stuck.
 */
/**
 * The six lanes in board order (`STORES_TOWER_LANES` in the contracts). Spelled here because the web imports only
 * TYPES from `@hmis/contracts` (its built entry is CommonJS, which the browser bundle does not load).
 */
const LANES: readonly StoresTowerLane[] = ["requested", "approved", "picking", "in_transit", "delivered", "stuck"];
const REFRESH_MS = 15_000;
const PHONE_MAX = 700;
/** Header 52 + red strip 92 + numbers 84 + gaps and padding 52 + a lane's own header 40. */
const CHROME_PX = 320;
const CARD_PX = 58;
const RED_MAX = 8;
/** The "+N more" line under a full lane. */
const MORE_PX = 22;

/**
 * How many cards a lane's body holds, measured on the body itself (a ResizeObserver), so a lane is filled to its
 * real height. Before the first measurement — and in a test DOM with no layout — the viewport estimate stands.
 */
function useFit(estimate: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { setHeight(el.clientHeight); });
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => { ro.disconnect(); };
  }, []);
  if (height <= 0) return [ref, estimate];
  // 8 px of bottom padding; each card is CARD_PX with its gap.
  return [ref, Math.max(1, Math.floor((height - 8 + 6) / CARD_PX))];
}

const TONE: Record<StoresTowerLane, string> = {
  requested: "var(--tw-violet)", approved: "var(--tw-blue)", picking: "var(--tw-amber)", in_transit: "var(--tw-blue)", delivered: "var(--tw-green)", stuck: "var(--tw-red)",
};
const STATUS_TONE = { ok: "var(--tw-green)", low: "var(--tw-amber)", out: "var(--tw-red)" } as const;

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = (): void => { setV({ w: window.innerWidth, h: window.innerHeight }); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); };
  }, []);
  return v;
}

type Tr = (key: string, opts?: Record<string, unknown>) => string;
/** Minutes as a wall reads them: "74 min", past two hours "25 h", past two days "3 d". */
export function spanWords(minutes: number, t: Tr): string {
  if (minutes < 120) return t("stores.tower.min", { n: minutes });
  if (minutes < 48 * 60) return t("stores.tower.hours", { n: Math.floor(minutes / 60) });
  return t("stores.tower.days", { n: Math.floor(minutes / 1440) });
}

const refused = (e: unknown): boolean => e instanceof ApiError && e.status === 403;
const last4 = (no: string): string => no.slice(-4);

export function StoresTower(): React.ReactElement {
  const { w } = useViewport();
  return w < PHONE_MAX ? <OwnerSummary /> : <Wall />;
}

/* ═══════════════════════════════ the wall ═══════════════════════════════ */

function Wall(): React.ReactElement {
  const { t } = useTranslation();
  const { h } = useViewport();
  const q = useQuery({ queryKey: ["stores", "tower"], queryFn: getTower, refetchInterval: REFRESH_MS, retry: false });
  const [ask, setAsk] = useState(false);
  // Anti burn-in: a few pixels each hour, in a small square.
  const hour = new Date().getHours();
  const shift = { x: ((hour % 3) - 1) * 3, y: ((Math.floor(hour / 3) % 3) - 1) * 2 };
  const perLane = Math.max(1, Math.floor((h - CHROME_PX) / CARD_PX));
  const view = q.data;
  const offline = q.isError && !refused(q.error) && view !== undefined;

  const root: React.CSSProperties = {
    // The wall is the whole screen: fixed over the shell, so the page itself never scrolls; "Stores" leads back.
    height: "100vh", overflow: "hidden", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 10,
    transform: `translate(${String(shift.x)}px, ${String(shift.y)}px)`, position: "fixed", inset: 0, zIndex: 30,
  };

  if (q.isError && refused(q.error)) {
    return (
      <div data-testid="stores-tower" className="stores-ui stores-tower" style={{ ...root, alignItems: "center", justifyContent: "center" }}>
        <p data-testid="tower-refused" style={{ fontSize: 24, margin: 0 }}>{t("stores.tower.refused")}</p>
      </div>
    );
  }

  return (
    <div data-testid="stores-tower" className="stores-ui stores-tower" style={root}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, height: 40, flexShrink: 0 }}>
        <Link to="/stores" className="tw-dim" style={{ fontSize: 14, color: "var(--tw-dim)" }}>‹ {t("stores.tower.back")}</Link>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase" }}>{t("stores.tower.title")}</h1>
        <span className="tw-dim" style={{ fontSize: 14 }}>
          {view === undefined ? "" : t("stores.tower.updated", { time: new Date(view.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) })}
        </span>
        {offline && <span data-testid="tower-offline" className="tw-badge" style={{ background: "var(--tw-red)", color: "#000", fontSize: 14 }}>{t("stores.tower.offline")}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="tw-btn" aria-expanded={ask} onClick={() => setAsk((a) => !a)}>{ask ? t("stores.tower.hide") : t("stores.tower.ask")}</button>
      </header>

      <RedStrip cards={view?.redCards} />

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr)) minmax(220px, 280px)", gap: 10 }}>
        {LANES.map((lane) => <Lane key={lane} lane={lane} cards={view?.lanes[lane]} fit={perLane} />)}
        <Floors view={view} />
      </div>

      <Numbers view={view} />

      {ask && (
        <div className="tw-copilot" style={{ position: "absolute", right: 16, bottom: 104, width: 380, height: 380, borderRadius: 10, boxShadow: "0 8px 30px #0008", display: "flex", flexDirection: "column", overflow: "hidden", zIndex: 5 }}>
          <StoresCopilot />
        </div>
      )}
    </div>
  );
}

function RedStrip({ cards }: { cards: WireRedCard[] | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const shown = (cards ?? []).slice(0, RED_MAX);
  return (
    <section data-testid="tower-redcards" aria-label={t("stores.tower.redStrip")} style={{ height: 84, flexShrink: 0, display: "grid", gridTemplateColumns: `repeat(${String(RED_MAX)}, minmax(0, 1fr))`, gap: 8 }}>
      {cards === undefined && Array.from({ length: 4 }, (_, i) => <div key={i} className="tw-ghost" />)}
      {cards !== undefined && shown.length === 0 && (
        <div className="tw-panel tw-dim" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", padding: "0 16px", fontSize: 18 }}>{t("stores.tower.noRed")}</div>
      )}
      {shown.map((c) => <RedCard key={c.id} card={c} />)}
    </section>
  );
}

function RedCard({ card }: { card: WireRedCard }): React.ReactElement {
  const { t } = useTranslation();
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span className="tw-badge" style={{ background: "var(--tw-red)", color: "#000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{t(`stores.tower.red.${card.kind}`)}</span>
        <b title={card.what} style={{ fontSize: 16, whiteSpace: "nowrap", flexShrink: 0 }}>{/^[A-Z]{1,4}\d{10}$/.test(card.what) ? last4(card.what) : card.what}</b>
      </div>
      <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{card.where}</div>
      <div className="tw-dim" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
        {card.clock === null ? "" : `${t(`stores.tower.clock.${card.clock}`)} · `}{spanWords(card.minutes, t)}
      </div>
    </>
  );
  const style: React.CSSProperties = { padding: "6px 10px", height: "100%", boxSizing: "border-box", ["--tw-tone" as string]: "var(--tw-red)", minWidth: 0 };
  const id = `tower-red-${card.id}`;
  if (card.indentId !== null) return <Link to="/stores/tickets/$indentId" params={{ indentId: card.indentId }} className="tw-card" data-testid={id} style={style}>{body}</Link>;
  if (card.shelfId !== null) return <Link to="/stores/shelf/$shelfId" params={{ shelfId: card.shelfId }} className="tw-card" data-testid={id} style={style}>{body}</Link>;
  return <Link to="/stores/passes" className="tw-card" data-testid={id} style={style}>{body}</Link>;
}

function Lane({ lane, cards, fit }: { lane: StoresTowerLane; cards: WireTowerCard[] | undefined; fit: number }): React.ReactElement {
  const { t } = useTranslation();
  const all = cards ?? [];
  const [body, slots] = useFit(fit);
  // A full lane gives up the room its "+N more" line needs, and no more than that.
  const roomWithMore = Math.max(1, Math.floor(((slots * CARD_PX) - MORE_PX) / CARD_PX));
  const more = all.length > slots ? all.length - roomWithMore : 0;
  const shown = more > 0 ? all.slice(0, roomWithMore) : all;
  return (
    <section data-testid={`tower-lane-${lane}`} className="tw-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflow: "hidden", borderTop: `4px solid ${TONE[lane]}` }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, padding: "8px 10px", height: 40, boxSizing: "border-box", flexShrink: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t(`stores.tower.lane.${lane}`)}</span>
        <span data-testid={`tower-count-${lane}`} style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: lane === "stuck" && all.length > 0 ? "var(--tw-red)" : undefined }}>
          {cards === undefined ? "" : all.length}
        </span>
      </div>
      <div ref={body} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 8px 8px", minHeight: 0, flex: 1, overflow: "hidden", boxSizing: "border-box" }}>
        {cards === undefined && Array.from({ length: 3 }, (_, i) => <div key={i} className="tw-ghost" style={{ height: CARD_PX - 6 }} />)}
        {cards !== undefined && all.length === 0 && <span className="tw-dim" style={{ padding: "4px 2px", fontSize: 14 }}>{t("stores.tower.none")}</span>}
        {shown.map((c) => <TowerCard key={c.id} card={c} />)}
        {more > 0 && <span className="tw-dim" style={{ padding: "2px 4px", fontSize: 14, fontWeight: 600 }}>{t("stores.tower.more", { n: more })}</span>}
      </div>
    </section>
  );
}

function TowerCard({ card }: { card: WireTowerCard }): React.ReactElement {
  const { t } = useTranslation();
  const when = card.clock === null ? spanWords(card.minutes, t) : `${t(`stores.tower.clock.${card.clock.kind}`)} ${spanWords(card.clock.minutes, t)}`;
  const style: React.CSSProperties = { height: CARD_PX - 6, boxSizing: "border-box", padding: "4px 8px", flexShrink: 0, ["--tw-tone" as string]: TONE[card.lane] };
  const badgeEl = card.priority === "routine" ? null : (
    <span className="tw-badge" title={t(`stores.tower.prio.${card.priority}`)} style={{
      background: card.priority === "emergency" ? "var(--tw-red)" : "var(--tw-amber)", color: "#000", flexShrink: 1, minWidth: 18,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    }}>{t(`stores.tower.prio.${card.priority}`)}</span>
  );
  return (
    <Link to="/stores/tickets/$indentId" params={{ indentId: card.id }} className="tw-card" data-testid={`tower-card-${card.id}`} style={style} title={`${card.indentNo} · ${card.department.name}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 15 }}>
        <b style={{ whiteSpace: "nowrap" }}>{last4(card.indentNo)} · {card.department.code}</b>
        {/* A Stuck card's second line carries its clock, so its priority rides on the first line, beside the number. */}
        {card.clock !== null && badgeEl}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, minWidth: 0 }} className="tw-dim">
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{card.holder?.name ?? card.department.name}</span>
        {card.clock === null && badgeEl}
        <span style={{ whiteSpace: "nowrap", flexShrink: 0, color: card.clock === null ? undefined : "var(--tw-red)", fontWeight: card.clock === null ? 400 : 700 }}>{when}</span>
      </div>
    </Link>
  );
}

function Floors({ view }: { view: WireTowerView | undefined }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section data-testid="tower-floors" className="tw-panel" style={{ minHeight: 0, overflow: "hidden", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 16, fontWeight: 700 }}>{t("stores.tower.floors")}</span>
      {view === undefined && Array.from({ length: 3 }, (_, i) => <div key={i} className="tw-ghost" style={{ height: 48 }} />)}
      {view?.floors.map((f) => (
        <div key={f.id ?? f.code} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span className="tw-dim" style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.code} · {f.name}</span>
          {f.departments.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, minWidth: 0 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: d.status === "ok" ? 4 : 1, background: STATUS_TONE[d.status], flexShrink: 0 }} />
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
              <b style={{ color: STATUS_TONE[d.status] }}>{t(`stores.tower.status.${d.status}`)}</b>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

const rupees = (paise: number): string => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100))}`;

function Numbers({ view }: { view: WireTowerView | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const n = view?.numbers;
  const dash = (v: number | null | undefined, unit: "min" | "pct" | "n"): string =>
    v == null ? "—" : unit === "min" ? t("stores.tower.min", { n: v }) : unit === "pct" ? `${String(v)}%` : String(v);
  const tiles: [string, string][] = [
    ["tickets", dash(n?.ticketsToday, "n")], ["approval", dash(n?.medianApprovalMin, "min")], ["deliver", dash(n?.medianDeliverMin, "min")],
    ["doubleSigned", dash(n?.doubleSignedPct, "pct")], ["shorts", dash(n?.openShorts, "n")],
  ];
  const spend = view?.spend;
  return (
    <section data-testid="tower-numbers" className="tw-panel" style={{ height: 76, flexShrink: 0, display: "flex", alignItems: "stretch", gap: 0, overflow: "hidden" }}>
      {tiles.map(([k, v]) => (
        <div key={k} style={{ padding: "8px 16px", borderRight: "1px solid var(--tw-line)", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
          <span className="tw-dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t(`stores.tower.n.${k}`)}</span>
          <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, whiteSpace: "nowrap" }}>{view === undefined ? "" : v}</span>
        </div>
      ))}
      {spend !== undefined && <Spend spend={spend} />}
    </section>
  );
}

/**
 * The month's spend per department, largest first: as many as fit on the line, then "+N more". Measured on a
 * hidden copy of the whole row, so the visible row never overflows and never measures itself.
 */
function Spend({ spend }: { spend: NonNullable<WireTowerView["spend"]> }): React.ReactElement {
  const { t } = useTranslation();
  const rows = [...spend.departments].sort((a, b) => b.chargePaise - a.chargePaise);
  const box = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(rows.length);
  useLayoutEffect(() => {
    const measure = (): void => {
      const width = (box.current?.clientWidth ?? 0) - 32;
      const items = [...(probe.current?.children ?? [])] as HTMLElement[];
      if (width <= 0 || items.length === 0) return;
      const GAP = 14;
      const MORE = 90;
      let used = 0;
      let n = 0;
      for (const [i, el] of items.entries()) {
        const w = el.offsetWidth + (i === 0 ? 0 : GAP);
        const needMore = i < items.length - 1 ? MORE : 0;
        if (used + w + needMore > width) break;
        used += w;
        n += 1;
      }
      setFit(n);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || box.current === null) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box.current);
    return () => { ro.disconnect(); };
  }, [spend]);
  const item = (d: (typeof rows)[number]): React.ReactElement => (
    <span key={d.id} title={d.name} style={{ flexShrink: 0 }}>
      <b>{d.code}</b> {rupees(d.chargePaise)}
      {d.perOpdVisitPaise !== null && <span className="tw-dim"> ({rupees(d.perOpdVisitPaise)}/{t("stores.tower.perVisit")})</span>}
    </span>
  );
  const shown = rows.slice(0, fit);
  return (
    <div data-testid="tower-spend" ref={box} style={{ padding: "8px 16px", display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0, flex: 1, position: "relative", overflow: "hidden" }}>
      <span className="tw-dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t("stores.tower.spend")} · {spend.month}</span>
      <div style={{ display: "flex", gap: 14, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden" }}>
        {shown.map(item)}
        {rows.length > shown.length && <span className="tw-dim" style={{ flexShrink: 0 }}>{t("stores.tower.more", { n: rows.length - shown.length })}</span>}
      </div>
      <div ref={probe} aria-hidden style={{ position: "absolute", visibility: "hidden", display: "flex", fontSize: 15, whiteSpace: "nowrap", left: 0, top: 0 }}>
        {rows.map(item)}
      </div>
    </div>
  );
}

/* ═══════════════════════════════ the owner's one line (390 px) ═══════════════════════════════ */

function OwnerSummary(): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sum = useQuery({ queryKey: ["stores", "tower", "summary"], queryFn: getTowerSummary, refetchInterval: REFRESH_MS, retry: false });
  const board = useQuery({ queryKey: ["stores", "tower"], queryFn: getTower, enabled: open, refetchInterval: open ? REFRESH_MS : false, retry: false });
  const root: React.CSSProperties = {
    maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: 16, display: "flex", flexDirection: "column", gap: 12, minHeight: "100vh",
  };
  const s = sum.data;
  return (
    <div data-testid="stores-tower-summary" className="stores-ui stores-tower" style={root}>
      <h1 style={{ margin: 0, fontSize: 16, letterSpacing: "0.04em", textTransform: "uppercase" }} className="tw-dim">{t("stores.tower.title")}</h1>
      {sum.isError && refused(sum.error) && <p data-testid="tower-refused" style={{ margin: 0, fontSize: 18 }}>{t("stores.tower.refused")}</p>}
      {sum.isError && !refused(sum.error) && <span className="tw-badge" style={{ background: "var(--tw-red)", color: "#000", alignSelf: "flex-start", fontSize: 14 }}>{t("stores.tower.offline")}</span>}
      {s === undefined && !sum.isError && <div className="tw-ghost" style={{ height: 40 }} />}
      {s !== undefined && (
        <p data-testid="tower-summary-line" style={{ margin: 0, fontSize: 28, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: s.stuck > 0 ? "var(--tw-red)" : "var(--tw-green)" }}>
          {s.stuck === 0 ? t("stores.tower.nothingStuck") : s.places.length === 0 ? t("stores.tower.summary", { n: s.stuck, places: "" }).replace(/ · $/, "") : t("stores.tower.summary", { n: s.stuck, places: s.places.join(", ") })}
        </p>
      )}
      {s !== undefined && s.stuck > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          style={{ minHeight: 48, borderRadius: 8, border: "none", background: "var(--tw-ink)", color: "var(--tw-bg)", fontSize: 18, fontWeight: 700 }}>
          {open ? t("stores.tower.hide") : t("stores.tower.seeStuck")}
        </button>
      )}
      {open && (
        <div data-testid="tower-stuck-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {board.data === undefined && Array.from({ length: 3 }, (_, i) => <div key={i} className="tw-ghost" style={{ height: CARD_PX - 6 }} />)}
          {board.data?.lanes.stuck.map((c) => <TowerCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
