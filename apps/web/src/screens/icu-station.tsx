import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ICU_POLL_MS, ackIcuAlarm, bpOf, fetchIcuHalls, fetchIcuStation, icuRefusal, istHHMM, num, severityRank } from "../lib/icu-api";
import type React from "react";
import type { IcuStationView, IcuTile } from "@hmis/contracts";
import "./icu.css";

/**
 * ═══ ICU IC-1 (#984) — THE HALLS AND THE CENTRAL STATION (design board "ICU nurse station · central view") ═══
 *
 * Option A (decision 0090): HMIS shows NUMBERS, freshness, 6-hour sparklines and alarms per bed; the monitor maker's
 * central station keeps the waves and stays the primary alarm ("Monitors are the alarm"). Every number comes from a
 * linked, confirmed device only. When the hall's feed is silent for more than 5 minutes every tile turns GREY and a banner
 * says "Feed lost — chart by hand every hour" (D7). The page polls every 5 s. An alarm's "I'm going" acknowledges it in
 * HMIS (who and when) and never silences the device.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

/** A sparkline of one-per-minute values (no axis; the number beside it is the reading). */
export function Spark({ values, color, width = 120, height = 26, label }: { values: number[] | undefined; color: string; width?: number; height?: number; label: string }): React.ReactElement {
  const v = values ?? [];
  if (v.length < 2) return <svg width={width} height={height} role="img" aria-label={label} />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * width).toFixed(1)},${(height - 2 - ((x - lo) / span) * (height - 4)).toFixed(1)}`).join(" ");
  return <svg width="100%" height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} preserveAspectRatio="none" role="img" aria-label={label}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" /></svg>;
}

export function tileState(tile: IcuTile): "alarm" | "limit" | "ok" {
  if (tile.openAlarms.some((a) => a.severity !== "advisory")) return "alarm";
  if (tile.openAlarms.length > 0) return "limit";
  return "ok";
}

/** The four big numbers as the board draws them: HR, SpO₂, BP, RR. */
export function TileNumbers({ tile, t, big = false }: { tile: IcuTile; t: T; big?: boolean }): React.ReactElement {
  const bp = bpOf(tile);
  const alarm = tileState(tile) === "alarm";
  return (
    <div className={`icu-nums${big ? " big" : ""}`}>
      <div><span style={{ color: "var(--i-hr)" }}>{t("icu.p.hr")}</span><b style={{ color: alarm ? "var(--i-alarm)" : "var(--i-hr)" }}>{num(tile.latest.hr?.value)}</b></div>
      <div><span style={{ color: "var(--i-spo2)" }}>{t("icu.p.spo2")}</span><b style={{ color: "var(--i-spo2)" }}>{num(tile.latest.spo2?.value)}</b></div>
      <div><span style={{ color: "var(--i-bp)" }}>{bp === null ? t("icu.p.bp") : bp.map === null ? bp.label : `${bp.label} · ${t("icu.p.map")} ${String(Math.round(bp.map))}`}</span><b style={{ color: "var(--i-bp)", fontSize: big ? undefined : 15 }}>{bp === null ? "—" : bp.sysDia}</b></div>
      <div><span style={{ color: "var(--i-rr)" }}>{t("icu.p.rr")}</span><b style={{ color: "var(--i-rr)" }}>{num(tile.latest.rr?.value)}</b></div>
    </div>
  );
}

function freshnessWords(t: T, s: number | null): string {
  if (s === null) return t("icu.noDevice");
  if (s < 60) return t("icu.freshSec", { n: s });
  return t("icu.freshMin", { n: Math.floor(s / 60) });
}

function Tile({ tile, grey, t }: { tile: IcuTile; grey: boolean; t: T }): React.ReactElement {
  const state = tileState(tile);
  const tag = state === "alarm" ? t("icu.tag.alarm") : state === "limit" ? t("icu.tag.limit") : t("icu.tag.ok");
  const tagColor = state === "alarm" ? "var(--i-alarm)" : state === "limit" ? "var(--i-rr)" : "var(--i-hr)";
  return (
    <Link to="/icu/bed/$admissionId" params={{ admissionId: tile.admissionId }} className={`icu-tile${state === "alarm" ? " alarm" : ""}${grey ? " grey" : ""}`} data-testid="icu-tile">
      <div className="bed"><b>{tile.bedName}</b><span className="mo" style={{ fontSize: 11, color: grey ? "var(--i-d-dim)" : tagColor }}>{grey ? t("icu.tag.grey") : tag}</span></div>
      <div className="who">{tile.patientName} · {tile.uhid} · {t("icu.day", { n: tile.dayOfStay })}</div>
      <TileNumbers tile={tile} t={t} />
      <Spark values={tile.spark.hr} color="#3ddc84" width={240} label={t("icu.sparkHr")} />
      <div className="icu-chips">
        {tile.devices.map((d) => <span key={d.code}>{t(`icu.device.${d.type}`)}</span>)}
        <span>{freshnessWords(t, tile.freshnessSeconds)}</span>
        {tile.hourDue ? <span style={{ color: "var(--i-spo2)" }}>{t("icu.hourDue")}</span> : null}
        {tile.bundlesMissed > 0 ? <span style={{ color: "var(--i-alarm)" }}>{t("icu.bundlesMissed", { n: tile.bundlesMissed })}</span> : null}
        {tile.storm ? <span style={{ color: "var(--i-alarm)" }}>{t("icu.storm")}</span> : null}
      </div>
    </Link>
  );
}

export function AlarmsAside({ view, t, onAcked }: { view: Pick<IcuStationView, "tiles">; t: T; onAcked: () => void }): React.ReactElement {
  const [err, setErr] = useState<string | null>(null);
  const rows = view.tiles.flatMap((tile) => tile.openAlarms.map((a) => ({ tile, a })))
    .sort((x, y) => severityRank(x.a.severity) - severityRank(y.a.severity) || x.a.raisedAt.localeCompare(y.a.raisedAt));
  const ack = async (alarmId: string) => {
    setErr(null);
    try { await ackIcuAlarm(alarmId); onAcked(); } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  };
  return (
    <aside className="icu-aside" aria-label={t("icu.alarmsNow")}>
      <h2>{t("icu.alarmsNow")}</h2>
      {rows.length === 0 ? <div className="icu-alarm"><small>{t("icu.noAlarms")}</small></div> : null}
      {rows.map(({ tile, a }) => (
        <div key={a.id} className={`icu-alarm${a.severity === "life_threatening" ? " lt" : ""}`}>
          <div className="grow">
            <b>{tile.bedName} · {a.message}</b>
            <small>{istHHMM(a.raisedAt)} · {t(`icu.sev.${a.severity}`)} · {t(`icu.rung.${a.rung}`)}</small>
          </div>
          <button type="button" className="icu-ack" onClick={() => { void ack(a.id); }}>{t("icu.imGoing")}</button>
        </div>
      ))}
      {err !== null ? <div className="icu-alarm"><small style={{ color: "var(--i-alarm)" }}>{err}</small></div> : null}
      <div className="icu-alarm" style={{ marginTop: "auto" }}><small>{t("icu.neverSilences")}</small></div>
    </aside>
  );
}

/** `/icu/station/$hallId` — the central station of one hall. */
export function IcuStation(props: { hallId?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { hallId?: string };
  const hallId = props.hallId ?? params.hallId;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["icu", "station", hallId], queryFn: () => fetchIcuStation(hallId ?? ""), enabled: hallId !== undefined, refetchInterval: ICU_POLL_MS });
  if (q.isError) return <div className="icu dark"><div className="icu-page"><p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p></div></div>;
  const v = q.data;
  if (v === undefined) return <div className="icu dark"><div className="icu-page">{t("icu.loading")}</div></div>;
  return (
    <div className="icu dark" data-testid="icu-station">
      <header className="icu-head">
        <h1 style={{ fontSize: 14, letterSpacing: ".08em" }}>{v.hallName.toUpperCase()} · {t("icu.central")}</h1>
        <span className="sub mo">{t("icu.bedsShown", { n: v.tiles.length })} · {v.grey ? t("icu.feedLost") : t("icu.feedLive")}</span>
        <span style={{ flexGrow: 1 }} />
        <span className="mo" style={{ fontSize: 12, color: "var(--i-rr)" }}>{t("icu.monitorsAreAlarm")}</span>
        <span className="mo" style={{ fontSize: 14, fontWeight: 700 }}>{istHHMM(v.asOf)}</span>
      </header>
      <div className="icu-station">
        <section>
          {v.grey ? <div className="icu-banner" role="status">{t("icu.greyBanner", { since: v.gapSince === null ? "—" : istHHMM(v.gapSince) })}</div> : null}
          <div className="icu-tiles">
            {v.tiles.length === 0 ? <p style={{ color: "var(--i-d-dim)" }}>{t("icu.noPatients")}</p> : null}
            {v.tiles.map((tile) => <Tile key={tile.admissionId} tile={tile} grey={v.grey} t={t} />)}
          </div>
        </section>
        <AlarmsAside view={v} t={t} onAcked={() => { void qc.invalidateQueries({ queryKey: ["icu", "station", hallId] }); }} />
      </div>
    </div>
  );
}

/** `/icu` — the halls, each with its beds, the alarms open and whether its feed is live. */
export function IcuHalls(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["icu", "halls"], queryFn: fetchIcuHalls, refetchInterval: ICU_POLL_MS });
  return (
    <div className="icu" data-testid="icu-halls">
      <header className="icu-head"><h1>{t("icu.hallsTitle")}</h1><span className="sub">{t("icu.hallsSub")}</span><span style={{ flexGrow: 1 }} /><Link to="/icu/requests">{t("icu.requestsLink")}</Link></header>
      <div className="icu-page">
        {q.isError ? <p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p> : null}
        {q.data?.length === 0 ? <p>{t("icu.noHalls")}</p> : null}
        <div className="icu-grid2">
          {(q.data ?? []).map((h) => (
            <Link key={h.hallId} to="/icu/station/$hallId" params={{ hallId: h.hallId }} className="icu-card" style={{ textDecoration: "none", color: "inherit" }}>
              <h2>{h.hallName}</h2>
              <div className="icu-row"><span className="grow">{t("icu.occupied", { n: h.occupied, of: h.beds })}</span>
                {h.grey ? <span className="icu-badge">{t("icu.feedLost")}</span> : <span className="icu-badge green">{t("icu.feedLive")}</span>}
                {h.openAlarms > 0 ? <span className="icu-badge red">{t("icu.openAlarms", { n: h.openAlarms })}</span> : null}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
