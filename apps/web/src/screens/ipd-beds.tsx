import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type {
  BedCleanView, BedTicketView, IpdBedBoard, IpdBedClass, IpdBoardBed, IpdBoardBedStatus, IpdBoardFloor, IpdBoardWard, IpdRefusalBody,
} from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { realtimeClient, useRealtime } from "../lib/realtime";
import {
  BLOCK_REASONS, IPD_BEDS_TOPIC, RELEASE_REASONS, assignBed, blockBed, getBedBoard, markBedClean, refusalOf,
  releaseIncumbentBed, releaseReservation, reserveBed, unblockBed,
} from "../lib/ipd-beds-api";
import type { BedActInput, BlockReason, ReleaseReason } from "../lib/ipd-beds-api";
import { cleanRefusal, fetchBedCleans, nudgeCleanApi, verifyCleanApi } from "../lib/housekeeping-api";
import { confirmTicketApi, fetchBedTickets, maintenanceRefusal } from "../lib/maintenance-api";
import { RaiseTicketSheet } from "./maintenance-raise";
import { TransferPanel } from "./ipd-transfer-panel";
import "../styles/paper-pine.css";
import "./ipd-beds.css";

/**
 * E1.1 (#718) — THE BEDS CAPACITY BOARD (spec §4.9 A; design board A, "Beds — capacity board").
 *
 * Bed manager, admission desk, nursing supervisor, duty manager and the owner on a desktop; the same board on
 * a wall display with `?wall=1`. What it shows is the server's (`GET /ipd/beds/board`): the counts follow the
 * midnight-census rules and the board never computes a number of its own beyond adding tiles up for a ward.
 *
 * DECIDED against the board, on purpose:
 * - The PAGE never scrolls at 1920×1080 or 1366×768 (owner rule: command boards fit 16:9). Desktop opens on all
 *   floors as the board does; when they outgrow the centre column it scrolls inside itself, and a floor chip
 *   narrows it to one. The wall display shows one floor at a time and cycles them.
 * - No Bed Flow card and no "N proposals" pill — proposals are a later lane, and this board shows no number it
 *   cannot source. The waiting column lists open admission requests (E1.2), each linking to the Admit sheet.
 * - "Next 24 hours" shows today's discharges (beds released since midnight) and says "Forecast comes later";
 *   blockers are only what the server measures (cleaning over 60 min, blocked past return date).
 * - A ward card opens a drawer of bed tiles; acts live there (the board's drag-and-drop arrives with the
 *   waiting list it would drag from).
 *
 * Live: every bed act and registry change arrives on `ipd_beds:board` and the board refetches. A heartbeat ping
 * every 2 s; no pong for 5 s, a closed socket or a failed fetch reads "Offline · last update HH:MM" (§0B) and the
 * live dot turns red — the board never presents stale data as live.
 */

const STATUSES: readonly IpdBoardBedStatus[] = ["occupied", "available", "cleaning", "reserved", "blocked", "incumbent"];
/** Tile order inside a ward: what is taken first, what can be given last — the board's own dot order. */
const DOT_ORDER: readonly IpdBoardBedStatus[] = ["occupied", "incumbent", "reserved", "cleaning", "available", "blocked"];
const CLASSES: readonly IpdBedClass[] = [
  "general", "semi_private", "private", "deluxe", "suite", "hdu", "icu", "nicu", "picu", "ldr", "daycare", "emergency", "overflow",
];
const HEARTBEAT_MS = 2_000;
const OFFLINE_AFTER_MS = 5_000;
const WALL_CYCLE_MS = 20_000;

type Act = null | "reserve" | "assign" | "block" | "releaseReservation";
type T = (k: string, o?: Record<string, unknown>) => string;
/** E1.4 — over this many minutes a clean is a blocker on the right (the board's own 60-minute line). */
const CLEAN_BLOCKER_MIN = 60;

/** "Cleaning · 34 min · assigned to A. K." — the clean's clock in words, from housekeeping's task. */
function cleanLine(c: BedCleanView, t: T, short = false): string {
  if (c.state === "done") return t("housekeeping.clean.done");
  const who = c.assigneeInitials === null ? t("housekeeping.clean.pool")
    : short ? c.assigneeInitials : t("housekeeping.clean.by", { who: c.assigneeInitials });
  const clock = short ? t("housekeeping.clean.minutes", { minutes: c.minutes }) : t("housekeeping.clean.line", { minutes: c.minutes });
  return [clock, who, c.late ? t("housekeeping.clean.late") : null].filter(Boolean).join(" · ");
}

/** E1.5 — "Blocked · repair #123 · fixed, waiting nurse": the bed's repair ticket in words, from maintenance. */
function repairLine(r: BedTicketView, t: T, short = false): string {
  const state = t(`maintenance.bedState.${r.state}`);
  if (short) return t("maintenance.bedShort", { n: r.number, state });
  const head = r.blockOnRelease ? t("maintenance.onRelease") : t("ipdBeds.status.blocked");
  return t("maintenance.bedLine", { head, n: r.number, state });
}
/** The blockers list shows this many slow cleans, then "+N more" (the right column never grows a page scroll). */
const SLOW_SHOWN = 4;

const istDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(d);
const istSeconds = (d: Date): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);

/** One floor's beds in DOT_ORDER, so a ward's dots read "taken … free" left to right. */
function orderedBeds(w: IpdBoardWard): IpdBoardBed[] {
  return [...w.beds].sort((a, b) => DOT_ORDER.indexOf(a.status) - DOT_ORDER.indexOf(b.status) || a.code.localeCompare(b.code));
}

export function IpdBeds(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { wall?: string | number | boolean };
  const wall = search.wall === "1" || search.wall === 1 || search.wall === true;

  const [board, setBoard] = useState<IpdBedBoard | null>(null);
  // E1.4 — housekeeping's cleaning clocks by bed; null until (or unless) the clocks load: the board still works.
  const [cleans, setCleans] = useState<Map<string, BedCleanView> | null>(null);
  // E1.5 — maintenance's open repair ticket by bed; null until (or unless) it loads: the board still works.
  const [tickets, setTickets] = useState<Map<string, BedTicketView> | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [wardId, setWardId] = useState<string | null>(null);
  const [bedId, setBedId] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const findRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getBedBoard(wall).then(
      (b) => { setBoard(b); setFetchFailed(false); setLastUpdate(new Date()); },
      () => { setFetchFailed(true); },
    );
    fetchBedCleans().then(
      (v) => setCleans(new Map((v.cleans ?? []).map((c) => [c.bedId, c]))),
      () => setCleans(null),
    );
    fetchBedTickets().then(
      (v) => setTickets(new Map((v.tickets ?? []).map((r) => [r.bedId, r]))),
      () => setTickets(null),
    );
  }, [wall]);
  useEffect(() => { load(); }, [load]);
  // A minute's tick keeps "cleaning for N min" honest between events; it is a refetch, not arithmetic.
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { connected } = useRealtime([IPD_BEDS_TOPIC], () => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; load(); }, 300);
  });
  useEffect(() => () => { if (debounce.current !== null) clearTimeout(debounce.current); }, []);

  // Heartbeat: a socket that dies without a close frame still turns the board "Offline" inside 5 s.
  const [lastPong, setLastPong] = useState(0);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.onPong(() => setLastPong(Date.now()));
    client.ping();
    const id = setInterval(() => { client.ping(); setNow(Date.now()); }, HEARTBEAT_MS);
    return () => { off(); clearInterval(id); };
  }, []);
  // Coming back online refetches: what happened while the socket was down was never pushed.
  const wasConnected = useRef(connected);
  useEffect(() => { if (connected && !wasConnected.current) load(); wasConnected.current = connected; }, [connected, load]);
  const online = connected && now - lastPong < OFFLINE_AFTER_MS && !fetchFailed;

  const floors = useMemo(() => board?.floors ?? [], [board]);
  // Desktop opens on every floor (the board's own view; the centre column scrolls inside itself when the
  // hospital has more floors than fit). A chip narrows to one floor; the wall display shows one at a time.
  const picked: IpdBoardFloor | undefined = floors.find((f) => f.id === floorId);
  const floor: IpdBoardFloor | undefined = picked ?? (wall ? floors[0] : undefined);
  const shown: IpdBoardFloor[] = floor !== undefined ? [floor] : floors;

  // The wall display cycles the floors.
  useEffect(() => {
    if (!wall || floors.length < 2) return;
    const id = setInterval(() => {
      setFloorId((cur) => {
        const i = floors.findIndex((f) => f.id === cur);
        return floors[(Math.max(i, 0) + 1) % floors.length]!.id;
      });
    }, WALL_CYCLE_MS);
    return () => clearInterval(id);
  }, [wall, floors]);

  // "/" focuses the find box, as the board's hint says.
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key !== "/" || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      findRef.current?.focus();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const runFind = (): void => {
    const q = find.trim().toLowerCase();
    if (q === "" || board === null) return;
    for (const f of board.floors) for (const w of f.wards) for (const b of w.beds) {
      const name = b.occupant?.name?.toLowerCase() ?? "";
      if (b.code.toLowerCase().includes(q) || (name !== "" && name.includes(q))) {
        setNotFound(false);
        setFloorId(f.id); setWardId(w.id); setBedId(b.id);
        return;
      }
    }
    setNotFound(true);
  };

  const ward = useMemo(() => {
    if (board === null || wardId === null) return null;
    for (const f of board.floors) for (const w of f.wards) if (w.id === wardId) return w;
    return null;
  }, [board, wardId]);

  const toggleWall = (): void => {
    setWardId(null);
    void navigate({ to: "/ipd/beds", search: wall ? {} : { wall: "1" } } as never);
  };

  const tot = board?.totals;
  const mayNudge = !wall && (can("ipd.beds.manage") || can("ipd.beds.clean") || can("housekeeping.view"));
  // Blockers: housekeeping's cleans past the line, longest first, with the bed's code from the board.
  const codeOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of board?.floors ?? []) for (const w of f.wards) for (const b of w.beds) m.set(b.id, b.code);
    return m;
  }, [board]);
  const slowCleans = [...(cleans?.values() ?? [])]
    .filter((c) => c.minutes > CLEAN_BLOCKER_MIN && codeOf.has(c.bedId))
    .sort((a, b) => b.minutes - a.minutes)
    .map((c) => ({ c, code: codeOf.get(c.bedId)! }));
  const pct = tot && tot.census.total > 0 ? ((tot.census.occupied / tot.census.total) * 100).toFixed(1) : null;
  const freeLine = tot
    ? CLASSES.filter((c) => (tot.freeByClass[c] ?? 0) > 0).map((c) => `${t(`ipdBeds.classShort.${c}`)} ${tot.freeByClass[c]}`).join(" · ")
    : "";
  // An hourly nudge of a few pixels so nothing burns into a wall panel (§4.10 edge 3).
  const shift = wall ? new Date(now).getHours() % 3 : 0;

  return (
    <div className={`ipdb${wall ? " wall" : ""}`} data-testid="ipd-beds" style={{ "--ipdb-shift": `${shift}px` } as React.CSSProperties}>
      <header className="ipdb-head">
        <div className="ipdb-title">
          <h1>{t("ipdBeds.title")}</h1>
          <span>{floor ? floor.name : t("ipdBeds.allFloors")} · {istDate(new Date(now))} · {fmtIst(new Date(now).toISOString())}</span>
        </div>
        <div className="ipdb-tools">
          {wall ? null : (
            <label className="ipdb-find">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ color: "var(--dim)" }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input
                ref={findRef} aria-label={t("ipdBeds.find")} placeholder={t("ipdBeds.find")} value={find}
                onChange={(e) => { setFind(e.target.value); setNotFound(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") runFind(); }}
              />
              {notFound ? <span role="status" className="dim" style={{ fontSize: 12 }}>{t("ipdBeds.notFound")}</span> : <kbd>/</kbd>}
            </label>
          )}
          <button type="button" className="ipdb-btn" onClick={toggleWall}>{wall ? t("ipdBeds.showNames") : t("ipdBeds.wallMode")}</button>
          {wall ? null : <Link to="/" className="ipdb-btn" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("ipdBeds.home")}</Link>}
        </div>
      </header>

      <section aria-label={t("ipdBeds.totals")} className="ipdb-stats">
        <Stat label={t("ipdBeds.stat.occupied")} value={tot ? String(tot.census.occupied) : "—"} of={tot ? `/ ${tot.census.total}` : ""}
          sub={tot ? t("ipdBeds.stat.occupiedSub", { pct: pct ?? "—", reserved: tot.reserved }) : ""}
          sub2={tot && tot.overflow.total > 0 ? t("ipdBeds.stat.overflow", { occupied: tot.overflow.occupied, total: tot.overflow.total }) : undefined} />
        <Stat label={t("ipdBeds.stat.free")} value={tot ? String(tot.free) : "—"} sub={freeLine || (tot ? t("ipdBeds.stat.noneFree") : "")} tone={tot && tot.free === 0 ? "bad" : undefined} />
        <Stat label={t("ipdBeds.stat.cleaning")} value={tot ? String(tot.cleaning) : "—"} sub={tot ? t("ipdBeds.stat.cleaningSub", { n: tot.cleaningOver60 }) : ""} tone={tot && tot.cleaningOver60 > 0 ? "warn" : undefined} />
        <Stat label={t("ipdBeds.stat.blocked")} value={tot ? String(tot.blocked) : "—"} sub={tot ? t("ipdBeds.stat.blockedSub", { n: tot.blockedPastReturn }) : ""} tone={tot && tot.blockedPastReturn > 0 ? "warn" : undefined} />
        <Stat label={t("ipdBeds.stat.discharges")} value={tot ? String(tot.dischargesToday) : "—"} sub={t("ipdBeds.stat.dischargesSub")} />
        <Stat label={t("ipdBeds.stat.waiting")} value={tot ? String(tot.waiting.count) : "—"}
          sub={tot && tot.waiting.longestMinutes !== null ? t("ipdBeds.stat.longest", { minutes: tot.waiting.longestMinutes }) : t("ipdBeds.stat.waitingSub")} />
      </section>

      <div className="ipdb-cols">
        <section aria-label={t("ipdBeds.waiting.title")} className="ipdb-col ipdb-left">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2>{t("ipdBeds.waiting.title")}</h2>
            <span className="ipdb-badge">{tot ? tot.waiting.count : 0}</span>
          </div>
          {board === null || board.waiting.length === 0 ? (
            <div className="ipdb-empty" data-testid="ipd-beds-waiting-empty">
              <b>{t("ipdBeds.waiting.empty")}</b>
              <span>{t("ipdBeds.waiting.emptySub")}</span>
            </div>
          ) : board.waiting.map((w) => (
            // E1.2 — one card per open admission request, oldest first; wall mode shows initials only.
            <div key={w.admissionId} className="ipdb-card ipdb-wait" data-testid="ipd-beds-waiting-card">
              <div className="ipdb-wait-top">
                <span className="ipdb-wait-av" aria-hidden="true">{w.initials}</span>
                <span className="ipdb-wait-who"><b>{w.name ?? w.initials}</b><span className="dim">{t(`ipdAdmit.source.${w.source}`)}</span></span>
                <span className="mono ipdb-wait-clock">{t("ipdBeds.waiting.wait", { minutes: w.waitMinutes })}</span>
              </div>
              <span className="dim ipdb-wait-need">
                {t(`ipdBeds.class.${w.requestedClass}`)}
                {w.isolation !== "none" ? ` · ${t(`ipdBeds.isolation.${w.isolation}`)}` : ""}
                {w.icu && !["icu", "nicu", "picu"].includes(w.requestedClass) ? ` · ${t("ipdBeds.waiting.icu")}` : ""}
                {w.reservedBedCode !== null ? ` · ${t("ipdBeds.waiting.held", { bed: w.reservedBedCode })}` : ""}
              </span>
              {!wall && can("ipd.admit") ? (
                <Link to="/ipd/admit" search={{ admission: w.admissionId }} className="ipdb-btn sm">{t("ipdBeds.waiting.open")}</Link>
              ) : null}
            </div>
          ))}
        </section>

        <section aria-label={t("ipdBeds.floors")} className="ipdb-col ipdb-centre">
          <div className="ipdb-floorbar">
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h2>{t("ipdBeds.floors")}</h2>
              <span className="dim" style={{ fontSize: 12 }}>{t("ipdBeds.floorsHint", { shown: shown.length, total: floors.length })}</span>
            </div>
            <div className="ipdb-legend">
              {STATUSES.map((s) => (
                <span key={s}><i className={`ipdb-dot s-${s}`} aria-hidden="true" />{t(`ipdBeds.status.${s}`)}</span>
              ))}
            </div>
          </div>
          <div className="ipdb-chips" role="group" aria-label={t("ipdBeds.pickFloor")}>
            {wall ? null : (
              <button type="button" className="ipdb-chip" aria-pressed={floor === undefined} onClick={() => setFloorId(null)}>
                {t("ipdBeds.allFloors")} <span className="mono">{tot ? `${tot.census.occupied}/${tot.census.total}` : ""}</span>
              </button>
            )}
            {floors.map((f) => (
              <button key={f.id} type="button" className="ipdb-chip" aria-pressed={floor?.id === f.id} onClick={() => setFloorId(f.id)}>
                {f.name} <span className="mono">{f.census.occupied}/{f.census.total}</span>
              </button>
            ))}
          </div>
          {board === null ? (
            <p className="dim" role="status">{fetchFailed ? t("ipdBeds.loadFailed") : t("ipdBeds.loading")}</p>
          ) : shown.length === 0 ? (
            <p className="dim">{t("ipdBeds.noBeds")}</p>
          ) : (
            <div className="ipdb-floorlist" data-testid="ipd-beds-floor">
              {shown.map((f) => (
                <div key={f.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="ipdb-floorhead">
                    <span>{f.name}</span>
                    <span>{t("ipdBeds.floorCount", { occupied: f.census.occupied, total: f.census.total })}</span>
                  </div>
                  <div className="ipdb-wards">
                    {f.wards.map((w) => <WardCard key={w.id} ward={w} cleans={cleans} tickets={tickets} onOpen={() => { setWardId(w.id); setBedId(null); }} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside aria-label={t("ipdBeds.next.title")} className="ipdb-col ipdb-right">
          <div className="ipdb-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <h2>{t("ipdBeds.next.title")}</h2>
            </div>
            <div className="ipdb-big"><b>{tot ? tot.dischargesToday : "—"}</b><span className="dim" style={{ fontSize: 13 }}>{t("ipdBeds.next.discharges")}</span></div>
            <span className="dim" style={{ fontSize: 12 }}>{t("ipdBeds.next.forecast")}</span>
          </div>
          <div className="ipdb-card">
            <h2>{t("ipdBeds.blockers.title")}</h2>
            {board && slowCleans.length === 0 && board.next24h.cleaningOver60.length === 0 && board.next24h.blockedPastReturn.length === 0
              ? <span className="dim" style={{ fontSize: 13 }}>{t("ipdBeds.blockers.none")}</span> : null}
            {slowCleans.length > 0 ? (
              <div className="ipdb-block" data-testid="ipd-beds-slow-cleans">
                <span className="t">{t("ipdBeds.blockers.cleaning")} <span className="mono">{slowCleans.length}</span></span>
                {slowCleans.slice(0, SLOW_SHOWN).map(({ c, code }) => (
                  <span key={c.taskId} className="ipdb-slow">
                    <span className="d" title={cleanLine(c, t)}>
                      <b className="mono">{code}</b> · {cleanLine(c, t, true)}{c.terminal ? ` · ${t("housekeeping.clean.terminal")}` : ""}
                    </span>
                    {mayNudge && c.state !== "done" ? <NudgeButton taskId={c.taskId} onDone={load} /> : null}
                  </span>
                ))}
                {slowCleans.length > SLOW_SHOWN ? <span className="d">{t("tasks.board.more", { count: slowCleans.length - SLOW_SHOWN })}</span> : null}
              </div>
            ) : board && board.next24h.cleaningOver60.length > 0 ? (
              <div className="ipdb-block">
                <span className="t">{t("ipdBeds.blockers.cleaning")} <span className="mono">{board.next24h.cleaningOver60.length}</span></span>
                <span className="d">{board.next24h.cleaningOver60.map((c) => t("ipdBeds.blockers.cleaningItem", { bed: c.bedCode, minutes: c.minutes })).join(" · ")}</span>
              </div>
            ) : null}
            {board && board.next24h.blockedPastReturn.length > 0 ? (
              <div className="ipdb-block">
                <span className="t">{t("ipdBeds.blockers.blocked")} <span className="mono">{board.next24h.blockedPastReturn.length}</span></span>
                <span className="d">{board.next24h.blockedPastReturn.map((c) => c.bedCode).join(" · ")}</span>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <footer className="ipdb-foot">
        {online && lastUpdate !== null ? (
          <span className="ipdb-live" data-testid="ipd-beds-live"><i />{t("ipdBeds.live")} <span className="mono">{istSeconds(lastUpdate)}</span></span>
        ) : (
          <span className="ipdb-live off" role="status" data-testid="ipd-beds-offline"><i />
            {lastUpdate === null ? t("ipdBeds.offlineNever") : t("ipdBeds.offline", { time: fmtIst(lastUpdate.toISOString()) })}
          </span>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {tot && tot.outsideCensus.total > 0 ? <span>{t("ipdBeds.outsideCensus", { occupied: tot.outsideCensus.occupied, total: tot.outsideCensus.total })}</span> : null}
          <button type="button" className="ipdb-btn sm" onClick={() => window.print()}>{t("ipdBeds.print")}</button>
        </span>
      </footer>

      {ward !== null ? (
        <WardDrawer
          ward={ward} wall={wall} selected={bedId} onSelect={setBedId} onClose={() => { setWardId(null); setBedId(null); }}
          mayManage={!wall && can("ipd.beds.manage")} mayClean={!wall && can("ipd.beds.clean")} onDone={load}
          cleans={cleans} mayVerify={!wall && (can("ipd.beds.clean") || can("housekeeping.verify_terminal"))} mayNudge={mayNudge}
          tickets={tickets} mayRaise={!wall && can("maintenance.raise")} mayConfirmRepair={!wall && (can("ipd.beds.clean") || can("maintenance.confirm"))}
          mayTransfer={!wall && can("ipd.transfer.start")} mayClass={!wall && can("ipd.admit")}
        />
      ) : null}
    </div>
  );
}

function Stat(p: { label: string; value: string; of?: string; sub: string; sub2?: string; tone?: "warn" | "bad" }): React.ReactElement {
  return (
    <div className="ipdb-stat">
      <span className="lbl">{p.label}</span>
      <span className="val"><b>{p.value}</b>{p.of ? <span>{p.of}</span> : null}</span>
      <span className={`sub${p.tone ? ` ${p.tone}` : ""}`} title={p.sub}>{p.sub}</span>
      {p.sub2 ? <span className="sub" title={p.sub2}>{p.sub2}</span> : null}
    </div>
  );
}

/** "Nudge housekeeping": escalates the clean now; a second nudge within five minutes is refused (said in words). */
function NudgeButton({ taskId, onDone }: { taskId: string; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  if (state === "done") return <span className="ipdb-ok" role="status">✓ {t("housekeeping.clean.nudged")}</span>;
  if (state !== "idle" && state !== "busy") return <span className="dim" role="status" style={{ fontSize: 12 }}>{state}</span>;
  return (
    <button type="button" className="ipdb-btn sm" disabled={state === "busy"} onClick={() => {
      setState("busy");
      // A nudge bumps the task's version: refetch, so the board never acts on what it read before.
      nudgeCleanApi(taskId).then(() => { setState("done"); onDone(); }, (e: unknown) => {
        const r = cleanRefusal(e);
        setState(r === null ? t("ipdBeds.actFailed") : t(`tasks.refusal.${r.code}`, { defaultValue: r.message }));
      });
    }}>{t("ipdBeds.blockers.nudge")}</button>
  );
}

function WardCard({ ward, onOpen, cleans, tickets }: {
  ward: IpdBoardWard; onOpen: () => void; cleans: Map<string, BedCleanView> | null; tickets: Map<string, BedTicketView> | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const c = ward.counts;
  const parts: string[] = [];
  if (c.available) parts.push(`${t("ipdBeds.status.available")} ${c.available}`);
  if (c.cleaning) parts.push(`${t("ipdBeds.status.cleaning")} ${c.cleaning}`);
  if (c.reserved) parts.push(`${t("ipdBeds.status.reserved")} ${c.reserved}`);
  if (c.blocked) parts.push(`${t("ipdBeds.status.blocked")} ${c.blocked}`);
  if (c.incumbent) parts.push(`${t("ipdBeds.status.incumbent")} ${c.incumbent}`);
  const full = parts.length === 0;
  if (full) parts.push(t("ipdBeds.full"));
  const sub = (ward.inCensus ? "" : `${t("ipdBeds.notInCensus")} · `) + parts.join(" · ");
  return (
    <button type="button" className="ipdb-ward" onClick={onOpen} data-testid={`ipd-ward-${ward.code}`}>
      <span className="top"><b>{ward.name}</b><span>{c.occupied + c.incumbent} / {c.total}</span></span>
      <span className={`sub${full ? " full" : ""}`}>{sub}</span>
      <span className="ipdb-dots">
        {orderedBeds(ward).map((b) => {
          const clean = b.status === "cleaning" ? cleans?.get(b.id) : undefined;
          const repair = tickets?.get(b.id);
          const word = clean !== undefined ? cleanLine(clean, t) : repair !== undefined ? repairLine(repair, t) : t(`ipdBeds.status.${b.status}`);
          return <span key={b.id} className={`ipdb-dot s-${b.status}`} title={`${b.code} · ${word}`} aria-label={`${b.code} · ${word}`} role="img" />;
        })}
      </span>
    </button>
  );
}

function WardDrawer(p: {
  ward: IpdBoardWard; wall: boolean; selected: string | null; onSelect: (id: string | null) => void; onClose: () => void;
  mayManage: boolean; mayClean: boolean; onDone: () => void; mayTransfer: boolean; mayClass: boolean;
  cleans: Map<string, BedCleanView> | null; mayVerify: boolean; mayNudge: boolean;
  tickets: Map<string, BedTicketView> | null; mayRaise: boolean; mayConfirmRepair: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const bed = p.ward.beds.find((b) => b.id === p.selected) ?? null;
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [p]);
  return (
    <>
      <div className="ipdb-scrim" onClick={p.onClose} aria-hidden="true" />
      <aside className="ipdb-drawer" role="dialog" aria-modal="true" aria-label={p.ward.name} data-testid="ipd-ward-drawer">
        <header>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>{p.ward.name}</h2>
            <span className="dim" style={{ fontSize: 12 }}>
              {p.ward.inCensus ? "" : `${t("ipdBeds.notInCensus")} · `}{p.ward.counts.occupied + p.ward.counts.incumbent} / {p.ward.counts.total}
            </span>
          </div>
          <button type="button" className="ipdb-btn sm" onClick={p.onClose}>{t("ipdBeds.close")}</button>
        </header>
        <div className="body">
          {bed !== null ? (
            <BedActs key={bed.id} bed={bed} mayManage={p.mayManage} mayClean={p.mayClean} onDone={p.onDone}
              clean={bed.status === "cleaning" ? p.cleans?.get(bed.id) ?? null : null} mayVerify={p.mayVerify} mayNudge={p.mayNudge}
              repair={p.tickets?.get(bed.id) ?? null} mayRaise={p.mayRaise} mayConfirmRepair={p.mayConfirmRepair} mayTransfer={p.mayTransfer} mayClass={p.mayClass} />
          ) : (
            <span className="dim" style={{ fontSize: 13 }}>{t("ipdBeds.pickBed")}</span>
          )}
          <div className="ipdb-tiles">
            {orderedBeds(p.ward).map((b) => (
              <button key={b.id} type="button" className="ipdb-tile" aria-pressed={b.id === p.selected} onClick={() => p.onSelect(b.id)} data-testid={`ipd-bed-${b.code}`}>
                <span className="code"><i className={`ipdb-dot s-${b.status}`} aria-hidden="true" />{b.code}</span>
                <span className="word">{t(`ipdBeds.status.${b.status}`)}{b.transfer ? (
                  <em className={`ipdt-mark ${b.transfer.role}`}>{b.transfer.role === "origin" ? `⇢ ${t("ipdTransfer.mark.origin")}` : `⇠ ${t("ipdTransfer.mark.target")}`}</em>
                ) : null}</span>
                <span className="who">{tileLine(b, p.wall, t, b.status === "cleaning" ? p.cleans?.get(b.id) : undefined, p.tickets?.get(b.id))}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}

function tileLine(b: IpdBoardBed, wall: boolean, t: T, clean?: BedCleanView, repair?: BedTicketView): string {
  if (clean !== undefined) return cleanLine(clean, t, true);
  if (repair !== undefined && b.status === "blocked") return repairLine(repair, t, true);
  if (b.occupant !== null) return wall ? b.occupant.initials : (b.occupant.name ?? b.occupant.initials);
  if (b.reservation !== null) return t("ipdBeds.until", { time: fmtIst(b.reservation.expiresAt) });
  if (b.block !== null) return t(`ipdBeds.blockReason.${b.block.reason}`);
  if (b.status === "cleaning" && b.since !== null) return t("ipdBeds.since", { time: fmtIst(b.since) });
  return t(`ipdBeds.class.${b.class}`);
}

function BedActs({ bed, mayManage, mayClean, onDone, clean, mayVerify, mayNudge, repair, mayRaise, mayConfirmRepair, mayTransfer = false, mayClass = false }: {
  bed: IpdBoardBed; mayManage: boolean; mayClean: boolean; onDone: () => void;
  clean: BedCleanView | null; mayVerify: boolean; mayNudge: boolean;
  repair: BedTicketView | null; mayRaise: boolean; mayConfirmRepair: boolean; mayTransfer?: boolean; mayClass?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [act, setAct] = useState<Act>(null);
  const [raising, setRaising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  const run = (p: Promise<unknown>, done: string): void => {
    setBusy(true); setRefusal(null); setFailed(false); setOk(null);
    p.then(
      () => { setBusy(false); setAct(null); setOk(done); onDone(); },
      (e: unknown) => { setBusy(false); const r = refusalOf(e); if (r) setRefusal(r); else setFailed(true); },
    );
  };

  const s = bed.status;
  const buttons: { key: string; label: string; onClick: () => void }[] = [];
  if (mayManage && s === "available") {
    buttons.push({ key: "reserve", label: t("ipdBeds.act.reserve"), onClick: () => setAct("reserve") });
    buttons.push({ key: "assign", label: t("ipdBeds.act.assign"), onClick: () => setAct("assign") });
  }
  if (mayManage && s === "reserved") {
    buttons.push({ key: "assign", label: t("ipdBeds.act.assign"), onClick: () => setAct("assign") });
    buttons.push({ key: "release", label: t("ipdBeds.act.releaseReservation"), onClick: () => setAct("releaseReservation") });
  }
  // E1.4 — a bed with a housekeeping clean is freed by CHECKING the clean (the bed turns available in the same
  // transaction); the hand tap "Mark clean" stays for a bed housekeeping has no task for.
  if (clean !== null && clean.state === "done" && mayVerify) {
    buttons.push({
      key: "verify", label: t("housekeeping.clean.verify"),
      onClick: () => {
        setBusy(true); setRefusal(null); setFailed(false); setOk(null);
        verifyCleanApi(clean.taskId, clean.version).then(
          () => { setBusy(false); setOk(t("housekeeping.clean.verified")); onDone(); },
          (e: unknown) => {
            setBusy(false);
            const r = cleanRefusal(e);
            if (r === null) setFailed(true);
            else setRefusal({ statusCode: 403, code: r.code, message: r.message, rule: r.message, fix: r.fix });
          },
        );
      },
    });
  }
  if (mayClean && s === "cleaning" && clean === null) {
    buttons.push({ key: "clean", label: t("ipdBeds.act.clean"), onClick: () => run(markBedClean(bed.id), t("ipdBeds.done.clean")) });
  }
  if (mayManage && s === "incumbent") {
    buttons.push({ key: "incumbent", label: t("ipdBeds.act.releaseIncumbent"), onClick: () => run(releaseIncumbentBed(bed.id), t("ipdBeds.done.released")) });
  }
  // E1.5 — a fixed repair is closed by the nurse's confirmation, which also ends the block (the bed goes to cleaning).
  if (repair !== null && repair.state === "fixed" && mayConfirmRepair) {
    buttons.push({
      key: "confirmRepair", label: t("maintenance.confirmRepair"),
      onClick: () => {
        setBusy(true); setRefusal(null); setFailed(false); setOk(null);
        confirmTicketApi(repair.ticketId).then(
          () => { setBusy(false); setOk(t("maintenance.confirmed")); onDone(); },
          (e: unknown) => {
            setBusy(false);
            const r = maintenanceRefusal(e);
            if (r === null) setFailed(true);
            else setRefusal({ statusCode: 409, code: r.code, message: r.message, rule: r.message, fix: r.fix });
          },
        );
      },
    });
  }
  // A bed a repair ticket holds is unblocked only by closing the ticket (the server refuses a hand unblock).
  if (mayManage && s === "blocked" && repair === null) {
    buttons.push({ key: "unblock", label: t("ipdBeds.act.unblock"), onClick: () => run(unblockBed(bed.id), t("ipdBeds.done.unblocked")) });
  }
  if (mayManage && (s === "available" || s === "cleaning" || s === "occupied" || s === "incumbent") && !(bed.block?.onRelease ?? false)) {
    buttons.push({ key: "block", label: s === "occupied" || s === "incumbent" ? t("ipdBeds.act.blockOnRelease") : t("ipdBeds.act.block"), onClick: () => setAct("block") });
  }
  if (mayRaise) {
    buttons.push({ key: "fault", label: t("maintenance.report"), onClick: () => setRaising(true) });
  }

  return (
    <div className="ipdb-act" data-testid="ipd-bed-acts">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <b className="mono" style={{ fontSize: 15 }}>{bed.code}</b>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t(`ipdBeds.status.${bed.status}`)} · {t(`ipdBeds.class.${bed.class}`)}</span>
      </div>
      <span className="dim" style={{ fontSize: 12 }}>
        {[t(`ipdBeds.gender.${bed.genderRule}`), bed.isolation !== "none" ? t(`ipdBeds.isolation.${bed.isolation}`) : null, bed.icu ? t("ipdBeds.icu") : null,
          bed.overflow ? t("ipdBeds.overflowBed") : null].filter(Boolean).join(" · ")}
      </span>
      {bed.block !== null ? (
        <span style={{ fontSize: 13 }}>
          {bed.block.onRelease ? t("ipdBeds.blockOnReleaseLine") : t("ipdBeds.blockedLine")} — {t(`ipdBeds.blockReason.${bed.block.reason}`)}: {bed.block.note} · {t("ipdBeds.back", { time: fmtIst(bed.block.expectedReturnAt) })}
        </span>
      ) : null}
      {repair !== null ? (
        <span style={{ fontSize: 13, fontWeight: 600 }} data-testid="ipd-bed-repair">
          {repairLine(repair, t)} · {t(`maintenance.item.${repair.itemKind}`)}{repair.urgency !== "routine" ? ` · ${t(`maintenance.urgency.${repair.urgency}`)}` : ""}
        </span>
      ) : null}
      {raising ? <RaiseTicketSheet place={{ id: bed.id, code: bed.code, name: bed.code }} onClose={() => { setRaising(false); onDone(); }} /> : null}
      {bed.reservation !== null ? <span style={{ fontSize: 13 }}>{t("ipdBeds.reservedLine", { time: fmtIst(bed.reservation.expiresAt) })}</span> : null}
      {clean !== null ? (
        <span style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="ipd-bed-clean">
          <span>{cleanLine(clean, t)}{clean.terminal ? ` · ${t("housekeeping.clean.terminal")}` : ""}</span>
          {mayNudge && clean.state !== "done" ? <NudgeButton taskId={clean.taskId} onDone={onDone} /> : null}
        </span>
      ) : null}
      {buttons.length > 0 && act === null ? (
        <div className="row">
          {buttons.map((b) => <button key={b.key} type="button" className="ipdb-btn sm" disabled={busy} onClick={b.onClick}>{b.label}</button>)}
        </div>
      ) : null}
      {act === "reserve" || act === "assign" ? (
        <PlaceForm bed={bed} mode={act} busy={busy} onCancel={() => setAct(null)}
          onSubmit={(input) => run(act === "reserve" ? reserveBed(input) : assignBed(input), act === "reserve" ? t("ipdBeds.done.reserved") : t("ipdBeds.done.assigned"))} />
      ) : null}
      {act === "block" ? (
        <BlockForm busy={busy} onCancel={() => setAct(null)} onSubmit={(b) => run(blockBed({ bedId: bed.id, ...b }), t("ipdBeds.done.blocked"))} />
      ) : null}
      {act === "releaseReservation" && bed.reservation !== null ? (
        <ReleaseForm busy={busy} onCancel={() => setAct(null)} onSubmit={(r) => run(releaseReservation(bed.reservation!.id, r), t("ipdBeds.done.reservationReleased"))} />
      ) : null}
      {refusal !== null ? (
        <div className="ipdb-refusal" role="alert" data-testid="ipd-bed-refusal">
          {refusal.bedRule ? <b>{refusal.bedRule}</b> : null}
          <span>{refusal.rule}</span>
          <div><button type="button" className="ipdb-btn sm" onClick={() => { setRefusal(null); setAct(null); onDone(); }}>{refusal.fix}</button></div>
        </div>
      ) : null}
      {failed ? <span role="alert" style={{ color: "var(--red)", fontSize: 13 }}>{t("ipdBeds.actFailed")}</span> : null}
      {ok !== null ? <span className="ipdb-ok" role="status">✓ {ok}</span> : null}
      {/* E3.1 (#729): transfer, swap and class change for the patient on this bed. */}
      {bed.occupant?.admissionId && (mayTransfer || mayClass) && act === null ? (
        <TransferPanel admissionId={bed.occupant.admissionId} mayTransfer={mayTransfer} mayClass={mayClass} onDone={onDone} />
      ) : null}
    </div>
  );
}

function PlaceForm(p: { bed: IpdBoardBed; mode: "reserve" | "assign"; busy: boolean; onCancel: () => void; onSubmit: (i: BedActInput) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState(p.bed.reservation?.admissionId ?? "");
  const [cls, setCls] = useState<IpdBedClass>(p.bed.class === "overflow" ? "general" : p.bed.class);
  const [isolation, setIsolation] = useState<BedActInput["need"]["isolation"]>("none");
  const [icu, setIcu] = useState(p.bed.icu);
  const [change, setChange] = useState<"" | "upgrade" | "downgrade">("");
  const ready = patientId.trim() !== "" && admissionId.trim() !== "";
  return (
    <form className="ipdb-form" onSubmit={(e) => {
      e.preventDefault();
      if (!ready) return;
      p.onSubmit({
        bedId: p.bed.id, patientId: patientId.trim(), admissionId: admissionId.trim(),
        need: { requestedClass: cls, isolation, icu }, ...(change === "" ? {} : { classChange: change }),
      });
    }}>
      <label>{t("ipdBeds.form.patientId")}<input value={patientId} onChange={(e) => setPatientId(e.target.value)} autoComplete="off" /></label>
      <label>{t("ipdBeds.form.admissionId")}<input value={admissionId} onChange={(e) => setAdmissionId(e.target.value)} autoComplete="off" /></label>
      <label>{t("ipdBeds.form.class")}
        <select value={cls} onChange={(e) => setCls(e.target.value as IpdBedClass)}>
          {CLASSES.filter((c) => c !== "overflow").map((c) => <option key={c} value={c}>{t(`ipdBeds.class.${c}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdBeds.form.isolation")}
        <select value={isolation} onChange={(e) => setIsolation(e.target.value as typeof isolation)}>
          {(["none", "contact", "droplet", "airborne"] as const).map((i) => <option key={i} value={i}>{t(`ipdBeds.isolation.${i}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdBeds.form.classChange")}
        <select value={change} onChange={(e) => setChange(e.target.value as typeof change)}>
          <option value="">{t("ipdBeds.form.noChange")}</option>
          <option value="upgrade">{t("ipdBeds.form.upgrade")}</option>
          <option value="downgrade">{t("ipdBeds.form.downgrade")}</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={icu} onChange={(e) => setIcu(e.target.checked)} />{t("ipdBeds.form.icu")}</label>
      <div className="row wide" style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="submit" className="ipdb-btn sm pri" disabled={!ready || p.busy}>{p.mode === "reserve" ? t("ipdBeds.act.reserve") : t("ipdBeds.act.assign")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}

/** `datetime-local` is wall-clock time with no zone; the hospital's clock is IST, so the instant carries +05:30. */
const istInstant = (local: string): string => `${local.length === 16 ? `${local}:00` : local}+05:30`;

function BlockForm(p: { busy: boolean; onCancel: () => void; onSubmit: (b: { reason: BlockReason; note: string; expectedReturnAt: string }) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState<BlockReason>("maintenance");
  const [note, setNote] = useState("");
  const [back, setBack] = useState("");
  const ready = note.trim() !== "" && back !== "";
  return (
    <form className="ipdb-form" onSubmit={(e) => { e.preventDefault(); if (ready) p.onSubmit({ reason, note: note.trim(), expectedReturnAt: istInstant(back) }); }}>
      <label>{t("ipdBeds.form.reason")}
        <select value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
          {BLOCK_REASONS.map((r) => <option key={r} value={r}>{t(`ipdBeds.blockReason.${r}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdBeds.form.expectedBack")}<input type="datetime-local" value={back} onChange={(e) => setBack(e.target.value)} /></label>
      <label className="wide">{t("ipdBeds.form.note")}<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="submit" className="ipdb-btn sm pri" disabled={!ready || p.busy}>{t("ipdBeds.act.block")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}

function ReleaseForm(p: { busy: boolean; onCancel: () => void; onSubmit: (r: ReleaseReason) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReleaseReason>("plan_changed");
  return (
    <form className="ipdb-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit(reason); }}>
      <label className="wide">{t("ipdBeds.form.reason")}
        <select value={reason} onChange={(e) => setReason(e.target.value as ReleaseReason)}>
          {RELEASE_REASONS.map((r) => <option key={r} value={r}>{t(`ipdBeds.releaseReason.${r}`)}</option>)}
        </select>
      </label>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="submit" className="ipdb-btn sm pri" disabled={p.busy}>{t("ipdBeds.act.releaseReservation")}</button>
        <button type="button" className="ipdb-btn sm" onClick={p.onCancel}>{t("ipdBeds.cancel")}</button>
      </div>
    </form>
  );
}
