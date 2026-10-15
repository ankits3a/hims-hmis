import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErBoard, ErExpectedCard, ErTile } from "@hmis/contracts";
import { fmtIst } from "../lib/format";
import { realtimeClient, useRealtime } from "../lib/realtime";
import { ER_BOARD_TOPIC, ER_WALL_TOPIC, fetchErBoard, minutesSince } from "../lib/er-api";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 1 (#808) — THE TRACKING BOARD v1 (spec SPEC-emergency §5 A). The ER's wall screen (16:9, `?wall=1`) and the
 * desktop view of the same board. What it shows is the server's (`GET /er/board`); the board computes only clocks
 * from the gate time the server sends.
 *
 * - The PAGE never scrolls at 1920×1080 or 1366×768 (owner rule: command boards fit 16:9); a column scrolls inside
 *   itself when it must. At phone width the columns stack and the page scrolls.
 * - The wall display carries no names: the server sends an unknown's alias or a named patient's initials, no UHID and
 *   no complaint words. Every colour comes with a word (ESI and chips are words, never colour alone).
 * - Clocks: time since the gate, and door-to-triage (≤ 5 min) while the patient waits — "overdue" in words when late.
 *   Lane 2 (er-triage) adds ESI, bays, the doctor and the re-triage clock to the same tiles.
 * - No money anywhere (decision 0058).
 * - Live: every arrival act arrives on `er:board` and the board refetches; a heartbeat every 2 s; no pong for 5 s, a
 *   closed socket or a failed fetch reads "Offline · last update HH:MM" — never stale data shown as live.
 */
const HEARTBEAT_MS = 2_000;
const OFFLINE_AFTER_MS = 5_000;
type T = (k: string, o?: Record<string, unknown>) => string;

/** "42 y M" from a DOB, "~30 y M" from the age band. */
export function ageSexWords(t: T, ageYears: number | null, band: string | null, sex: string): string {
  const age = ageYears !== null ? t("er.ageYears", { n: ageYears }) : band !== null ? t(`er.bandShort.${band}`) : "?";
  return `${age} ${t(`er.sexShort.${sex}`)}`;
}

function etaWords(t: T, c: ErExpectedCard, now: number): { text: string; late: boolean } {
  const m = minutesSince(c.expectedAt, now);
  if (m < 0) return { text: t("erBoard.eta.in", { minutes: -m }), late: false };
  if (m === 0) return { text: t("erBoard.eta.now"), late: false };
  return { text: t("erBoard.eta.late", { minutes: m }), late: true };
}

function triageClock(t: T, tile: ErTile, now: number): { text: string; late: boolean } | null {
  if (tile.triageDueAt === null) return null;
  const left = -minutesSince(tile.triageDueAt, now);
  if (left === 0) return { text: t("erBoard.triageNow"), late: false };
  return left > 0 ? { text: t("erBoard.triageDue", { minutes: left }), late: false }
    : { text: t("erBoard.triageLate", { minutes: -left }), late: true };
}

/** An unknown's alias in the reader's script: "अज्ञात-0412" in Hindi, "Unknown-0412" in English (the other below). */
export function aliasFirst(label: string, labelHi: string | null, lang: string): { main: string; other: string | null } {
  if (labelHi === null) return { main: label, other: null };
  return lang.startsWith("hi") ? { main: labelHi, other: label } : { main: label, other: labelHi };
}

function Tile({ tile, now, wall }: { tile: ErTile; now: number; wall: boolean }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const name = aliasFirst(tile.label, tile.labelHi, i18n.language);
  const clock = triageClock(t, tile, now);
  return (
    <article className={`erb-tile${clock?.late ? " late" : ""}`} data-testid="er-board-tile">
      <div className="erb-tile-top">
        <b className="erb-name" title={name.main}>{name.main}</b>
        <span className="erb-since mono">{t("erBoard.since", { minutes: Math.max(0, minutesSince(tile.arrivedAt, now)) })}</span>
      </div>
      {name.other !== null && !wall ? <span className="erb-alias-hi">{name.other}</span> : null}
      <div className="erb-meta">
        <span>{ageSexWords(t, tile.ageYears, tile.ageBand, tile.sex)}</span>
        <span className="mono">{tile.episodeNo}</span>
        {tile.arrivalMode !== null ? <span>{t(`er.mode.${tile.arrivalMode}`)}</span> : null}
      </div>
      {clock !== null ? (
        <div className={`erb-clock${clock.late ? " late" : ""}`} role={clock.late ? "alert" : undefined}>
          <i aria-hidden="true">{clock.late ? "■" : "○"}</i>{clock.text}
        </div>
      ) : <div className="erb-clock">{t(`er.state.${tile.state}`)}</div>}
      {tile.chips.length > 0 ? (
        <div className="erb-chips">{tile.chips.map((c) => <span key={c} className={`erb-chip ${c}`}>{t(`er.chip.${c}`)}</span>)}</div>
      ) : null}
    </article>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "bad" }): React.ReactElement {
  return (
    <div className="erb-stat">
      <span className="lbl">{label}</span>
      <span className="val"><b>{value}</b></span>
      {sub !== undefined ? <span className={`sub${tone ? ` ${tone}` : ""}`}>{sub}</span> : null}
    </div>
  );
}

export function ErBoardScreen(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { wall?: string | number | boolean };
  const wall = search.wall === "1" || search.wall === 1 || search.wall === true;
  const [board, setBoard] = useState<ErBoard | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    fetchErBoard(wall).then(
      (b) => { setBoard(b); setFetchFailed(false); setLastUpdate(new Date()); },
      () => { setFetchFailed(true); },
    );
  }, [wall]);
  useEffect(() => { load(); }, [load]);
  // A minute's refetch keeps the expected list honest (a lapsed pre-alert leaves); the clocks tick every heartbeat.
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { connected } = useRealtime([wall ? ER_WALL_TOPIC : ER_BOARD_TOPIC], () => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; load(); }, 300);
  });
  useEffect(() => () => { if (debounce.current !== null) clearTimeout(debounce.current); }, []);
  const [lastPong, setLastPong] = useState(0);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.onPong(() => setLastPong(Date.now()));
    client.ping();
    const id = setInterval(() => { client.ping(); setNow(Date.now()); }, HEARTBEAT_MS);
    return () => { off(); clearInterval(id); };
  }, []);
  const wasConnected = useRef(connected);
  useEffect(() => { if (connected && !wasConnected.current) load(); wasConnected.current = connected; }, [connected, load]);
  const online = connected && now - lastPong < OFFLINE_AFTER_MS && !fetchFailed;

  const s = board?.stats;
  const shift = wall ? new Date(now).getHours() % 3 : 0;
  const toggleWall = (): void => { void navigate({ to: "/er/board", search: wall ? {} : { wall: "1" } } as never); };

  return (
    <div className={`erx erb${wall ? " wall" : ""}`} data-testid="er-board" style={{ "--erb-shift": `${shift}px` } as React.CSSProperties}>
      <header className="erb-head">
        <div className="erb-title">
          <h1>{t("erBoard.title")}</h1>
          <span>{fmtIst(new Date(now).toISOString())}</span>
        </div>
        <div className="erb-tools">
          <button type="button" className="erx-btn" onClick={toggleWall}>{wall ? t("erBoard.showNames") : t("erBoard.wallMode")}</button>
          {wall ? null : <Link to="/er/desk" className="erx-btn">{t("erBoard.desk")}</Link>}
          {wall ? null : <Link to="/" className="erx-btn">{t("erBoard.home")}</Link>}
        </div>
      </header>

      <section className="erb-stats" aria-label={t("erBoard.totals")}>
        <Stat label={t("erBoard.stat.inDept")} value={s ? String(s.inDepartment) : "—"} />
        <Stat label={t("erBoard.stat.waiting")} value={s ? String(s.waitingTriage) : "—"}
          sub={s ? (s.longestTriageWaitMinutes === null ? t("erBoard.stat.noneWaiting") : t("erBoard.stat.longest", { minutes: s.longestTriageWaitMinutes })) : undefined}
          tone={s && s.longestTriageWaitMinutes !== null && s.longestTriageWaitMinutes > 5 ? "bad" : undefined} />
        <Stat label={t("erBoard.stat.expected")} value={s ? String(s.expected) : "—"} />
        <Stat label={t("erBoard.stat.bays")} value={s ? String(s.bays.free) : "—"} sub={s ? t("erBoard.stat.baysOf", { total: s.bays.total }) : undefined}
          tone={s && s.bays.total > 0 && s.bays.free === 0 ? "bad" : undefined} />
        <Stat label={t("erBoard.stat.arrivals")} value={s ? String(s.arrivalsToday) : "—"} />
        <Stat label={t("erBoard.stat.broughtDead")} value={s ? String(s.broughtDeadToday) : "—"} />
      </section>

      <div className="erb-cols">
        <section className="erb-col erb-expected" aria-label={t("erBoard.col.expected")}>
          <h2>{t("erBoard.col.expected")} <span className="erb-badge">{board?.expected.length ?? 0}</span></h2>
          {board !== null && board.expected.length === 0 ? <div className="erb-empty">{t("erBoard.empty.expected")}</div> : null}
          {board?.expected.map((c) => {
            const eta = etaWords(t, c, now);
            return (
              <article key={c.preAlertId} className={`erb-exp${eta.late ? " late" : ""}`} data-testid="er-board-expected">
                <div className="erb-tile-top"><b>{c.mode !== null ? t(`er.mode.${c.mode}`) : t("erBoard.col.expected")}</b><span className={`erb-eta${eta.late ? " late" : ""}`}>{eta.text}</span></div>
                <div className="erb-meta">
                  {c.count > 1 ? <span>{t("erBoard.count", { arrived: c.arrivedCount, total: c.count })}</span> : null}
                  {c.sex !== null || c.ageBand !== null ? <span>{[c.ageBand !== null ? t(`er.bandShort.${c.ageBand}`) : null, c.sex !== null ? t(`er.sex.${c.sex}`) : null].filter(Boolean).join(" ")}</span> : null}
                </div>
                {c.complaint !== null ? <p className="erb-complaint">{c.complaint}</p> : null}
              </article>
            );
          })}
        </section>

        <section className="erb-col erb-waiting" aria-label={t("erBoard.col.waiting")}>
          <h2>{t("erBoard.col.waiting")} <span className="erb-badge">{board?.waiting.length ?? 0}</span></h2>
          {board !== null && board.waiting.length === 0 ? <div className="erb-empty">{t("erBoard.empty.waiting")}</div> : null}
          <div className="erb-grid">{board?.waiting.map((tile) => <Tile key={tile.episodeId} tile={tile} now={now} wall={wall} />)}</div>
        </section>

        <section className="erb-col erb-treat" aria-label={t("erBoard.col.inTreatment")}>
          <h2>{t("erBoard.col.inTreatment")} <span className="erb-badge">{board?.inTreatment.length ?? 0}</span></h2>
          {board !== null && board.inTreatment.length === 0 ? <div className="erb-empty">{t("erBoard.empty.inTreatment")}</div> : null}
          <div className="erb-grid">{board?.inTreatment.map((tile) => <Tile key={tile.episodeId} tile={tile} now={now} wall={wall} />)}</div>
        </section>
      </div>

      <footer className="erb-foot">
        {online ? (
          <span className="erb-live" role="status" data-testid="er-board-live"><i />{t("erBoard.live", { time: lastUpdate ? fmtIst(lastUpdate.toISOString()) : "—" })}</span>
        ) : (
          <span className="erb-live off" role="status" data-testid="er-board-offline"><i />
            {lastUpdate === null ? t("erBoard.offlineNever") : t("erBoard.offline", { time: fmtIst(lastUpdate.toISOString()) })}
          </span>
        )}
        <span className="dim">{t("erBoard.legend")}</span>
      </footer>
    </div>
  );
}
