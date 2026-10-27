import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import {
  ICU_BUNDLE_ORDER, ICU_POLL_MS, completeIcuBundle, fetchIcuBed, fetchIcuTrends, icuRefusal, insertIcuLine, istHHMM,
  linkIcuDevice, logIcuFamilyUpdate, logIcuVisit, num, removeIcuLine, setIcuLimit, startIcuSepsis, unlinkIcuDevice,
} from "../lib/icu-api";
import { AlarmsAside, TileNumbers } from "./icu-station";
import type React from "react";
import type { IcuBedView, IcuLineKind, IcuParam, IcuTrendView } from "@hmis/contracts";
import "./icu.css";

/**
 * ═══ ICU IC-1 (#984) — ONE BED (design board "One bed · waves, 24-hour trends, flowsheet, ventilator, drips") ═══
 *
 * Option A: the big numbers and 24-hour trends (one point a minute, the doctor's limits dashed), never waves. Beside them:
 * the devices linked by scan (D2), the lines and their days, today's bundles with "done" (D8), the doctor's limits with
 * their 24-hour expiry (D6), and the family log — visits and the daily update (D9). The hourly chart is one tap away.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

const TRENDS: { p: IcuParam; color: string }[] = [
  { p: "hr", color: "#3ddc84" }, { p: "spo2", color: "#4cc9f0" }, { p: "abp_map", color: "#ff8fa3" }, { p: "nibp_map", color: "#ff8fa3" },
  { p: "rr", color: "#ffd166" }, { p: "temp", color: "#ffffff" },
];

function TrendRow({ p, color, trends, limit, t }: { p: IcuParam; color: string; trends: IcuTrendView; limit?: { low: number | null; high: number | null }; t: T }): React.ReactElement | null {
  const s = trends.series[p];
  if (s === undefined || s.length === 0) return null;
  const from = Date.parse(trends.from);
  const span = Date.parse(trends.to) - from || 1;
  const vals = s.map((x) => x.value);
  const lo = Math.min(...vals, limit?.low ?? Infinity) - 2;
  const hi = Math.max(...vals, limit?.high ?? -Infinity) + 2;
  const y = (v: number) => (50 - ((v - lo) / (hi - lo || 1)) * 48).toFixed(1);
  const pts = s.map((x) => `${(((Date.parse(x.at) - from) / span) * 700).toFixed(1)},${y(x.value)}`).join(" ");
  return (
    <div className="icu-trend">
      <span className="mo" style={{ color, fontSize: 10.5, letterSpacing: ".1em" }}>{t(`icu.p.${p}`)}</span>
      <svg width="100%" height="52" viewBox="0 0 700 52" preserveAspectRatio="none" role="img" aria-label={t("icu.trendOf", { p: t(`icu.p.${p}`) })}>
        {limit?.low != null ? <line x1="0" x2="700" y1={y(limit.low)} y2={y(limit.low)} stroke="#5a6a64" strokeDasharray="4 4" /> : null}
        {limit?.high != null ? <line x1="0" x2="700" y1={y(limit.high)} y2={y(limit.high)} stroke="#5a6a64" strokeDasharray="4 4" /> : null}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" />
      </svg>
      <span className="mo" style={{ color, fontSize: 16, fontWeight: 700 }}>{num(vals.at(-1), p === "temp" ? 1 : 0)}</span>
    </div>
  );
}

function useAct(onDone: () => void, t: T): [string | null, (fn: () => Promise<unknown>) => Promise<void>] {
  const [err, setErr] = useState<string | null>(null);
  return [err, async (fn) => {
    setErr(null);
    try { await fn(); onDone(); } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  }];
}

function Devices({ bed, t, refresh }: { bed: IcuBedView; t: T; refresh: () => void }): React.ReactElement {
  const [device, setDevice] = useState("");
  const [band, setBand] = useState("");
  const [err, act] = useAct(refresh, t);
  return (
    <div className="icu-dpane">
      <h2>{t("icu.devices")}</h2>
      {bed.links.map((l) => (
        <div key={l.id} className="icu-kv"><span>{t(`icu.device.${l.type}`)} · {l.deviceCode}</span><b>{t("icu.since", { at: istHHMM(l.linkedAt) })}</b>
          <button type="button" className="icu-btn" style={{ height: 30 }} onClick={() => { void act(() => unlinkIcuDevice(l.deviceCode)); }}>{t("icu.unlink")}</button></div>
      ))}
      <form style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await linkIcuDevice(device, band); setDevice(""); setBand(""); }); }}>
        <input className="icu-input" style={{ flex: "1 1 120px" }} aria-label={t("icu.scanDevice")} placeholder={t("icu.scanDevice")} value={device} onChange={(e) => setDevice(e.target.value)} />
        <input className="icu-input" style={{ flex: "1 1 120px" }} aria-label={t("icu.scanBand")} placeholder={t("icu.scanBand")} value={band} onChange={(e) => setBand(e.target.value)} />
        <button type="submit" className="icu-btn pri" disabled={device.trim() === "" || band.trim() === ""}>{t("icu.link")}</button>
      </form>
      {err !== null ? <p className="icu-err">{err}</p> : null}
    </div>
  );
}

function LinesAndBundles({ bed, t, refresh }: { bed: IcuBedView; t: T; refresh: () => void }): React.ReactElement {
  const [kind, setKind] = useState<IcuLineKind>("central_line");
  const [site, setSite] = useState("");
  const [err, act] = useAct(refresh, t);
  const open = bed.bundles.filter((b) => b.doneAt === null).sort((a, b) => ICU_BUNDLE_ORDER.indexOf(a.kind) - ICU_BUNDLE_ORDER.indexOf(b.kind));
  return (
    <>
      <div className="icu-dpane">
        <h2>{t("icu.bundlesToday")}</h2>
        {open.length === 0 ? <div className="icu-kv"><span>{t("icu.noBundles")}</span></div> : null}
        {open.map((b) => (
          <div key={b.id} className="icu-kv">
            <span>{t(`icu.bundle.${b.kind}`)}</span>
            <b style={{ color: b.missed ? "var(--i-alarm)" : "var(--i-rr)" }}>{b.missed ? t("icu.missed") : t("icu.dueAt", { at: istHHMM(b.dueAt) })}</b>
            <button type="button" className="icu-btn" style={{ height: 30 }} onClick={() => { void act(() => completeIcuBundle(b.id, [t(`icu.bundle.${b.kind}`)])); }}>{t("icu.done")}</button>
          </div>
        ))}
        <button type="button" className="icu-btn" style={{ marginTop: 8 }} onClick={() => { void act(() => startIcuSepsis(bed.tile.admissionId)); }}>{t("icu.sepsisStart")}</button>
      </div>
      <div className="icu-dpane">
        <h2>{t("icu.linesAndDays")}</h2>
        <div className="icu-kv"><span>{t("icu.ventDays")}</span><b>{bed.days.ventilatorDays}</b></div>
        <div className="icu-kv"><span>{t("icu.lineDays")}</span><b>{bed.days.centralLineDays}</b></div>
        <div className="icu-kv"><span>{t("icu.catheterDays")}</span><b>{bed.days.catheterDays}</b></div>
        {bed.lines.filter((l) => l.removedAt === null).map((l) => (
          <div key={l.id} className="icu-kv"><span>{t(`icu.line.${l.kind}`)} · {l.site}</span>
            <button type="button" className="icu-btn" style={{ height: 30 }} onClick={() => { void act(() => removeIcuLine(l.id)); }}>{t("icu.removeLine")}</button></div>
        ))}
        <form style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await insertIcuLine(bed.tile.admissionId, kind, site); setSite(""); }); }}>
          <select className="icu-input" aria-label={t("icu.lineKind")} value={kind} onChange={(e) => setKind(e.target.value as IcuLineKind)}>
            {(["central_line", "arterial_line", "urinary_catheter", "endotracheal_tube"] as const).map((k) => <option key={k} value={k}>{t(`icu.line.${k}`)}</option>)}
          </select>
          <input className="icu-input" style={{ flex: "1 1 100px" }} aria-label={t("icu.site")} placeholder={t("icu.site")} value={site} onChange={(e) => setSite(e.target.value)} />
          <button type="submit" className="icu-btn" disabled={site.trim() === ""}>{t("icu.addLine")}</button>
        </form>
        {err !== null ? <p className="icu-err">{err}</p> : null}
      </div>
    </>
  );
}

function Limits({ bed, t, refresh, canDecide }: { bed: IcuBedView; t: T; refresh: () => void; canDecide: boolean }): React.ReactElement {
  const [param, setParam] = useState<IcuParam>("hr");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [err, act] = useAct(refresh, t);
  return (
    <div className="icu-dpane">
      <h2>{t("icu.limits")}</h2>
      {bed.tile.limits.length === 0 ? <div className="icu-kv"><span>{t("icu.noLimits")}</span></div> : null}
      {bed.tile.limits.map((l) => (
        <div key={l.param} className="icu-kv"><span>{t(`icu.p.${l.param}`)} {num(l.low)}–{num(l.high)}</span><b>{t("icu.until", { at: istHHMM(l.expiresAt) })}</b></div>
      ))}
      {canDecide ? (
        <form style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await setIcuLimit({ admissionId: bed.tile.admissionId, param, ...(low === "" ? {} : { low: Number(low) }), ...(high === "" ? {} : { high: Number(high) }) });
            setLow(""); setHigh("");
          });
        }}>
          <select className="icu-input" aria-label={t("icu.param")} value={param} onChange={(e) => setParam(e.target.value as IcuParam)}>
            {(["hr", "spo2", "rr", "nibp_sys", "abp_map", "nibp_map", "temp"] as const).map((p) => <option key={p} value={p}>{t(`icu.p.${p}`)}</option>)}
          </select>
          <input className="icu-input" style={{ width: 70 }} inputMode="decimal" aria-label={t("icu.low")} placeholder={t("icu.low")} value={low} onChange={(e) => setLow(e.target.value)} />
          <input className="icu-input" style={{ width: 70 }} inputMode="decimal" aria-label={t("icu.high")} placeholder={t("icu.high")} value={high} onChange={(e) => setHigh(e.target.value)} />
          <button type="submit" className="icu-btn pri" disabled={low === "" && high === ""}>{t("icu.setLimit")}</button>
        </form>
      ) : null}
      <p style={{ fontSize: 11.5, color: "var(--i-d-dim)", margin: "6px 0 0" }}>{t("icu.limitNote")}</p>
      {err !== null ? <p className="icu-err">{err}</p> : null}
    </div>
  );
}

function Family({ bed, t, refresh }: { bed: IcuBedView; t: T; refresh: () => void }): React.ReactElement {
  const [summary, setSummary] = useState("");
  const [givenTo, setGivenTo] = useState("");
  const [relation, setRelation] = useState("");
  const [err, act] = useAct(refresh, t);
  return (
    <div className="icu-dpane">
      <h2>{t("icu.family")}</h2>
      {bed.familyUpdates.slice(0, 3).map((u) => <div key={u.id} className="icu-kv"><span>{istHHMM(u.at)} · {u.givenTo} ({u.relation})</span><b style={{ fontFamily: "inherit", fontWeight: 400 }}>{u.summary}</b></div>)}
      {bed.visits.slice(0, 3).map((v) => <div key={v.id} className="icu-kv"><span>{t("icu.visit")} {istHHMM(v.startsAt)}–{istHHMM(v.endsAt)}</span><b>{v.visitorName} ({v.relation})</b></div>)}
      <form style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }} onSubmit={(e) => {
        e.preventDefault();
        void act(async () => { await logIcuFamilyUpdate({ admissionId: bed.tile.admissionId, summary, givenTo, relation, mode: "in_person" }); setSummary(""); });
      }}>
        <textarea className="icu-input" style={{ height: 60, padding: 8 }} aria-label={t("icu.updateWords")} placeholder={t("icu.updateWords")} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input className="icu-input" style={{ flex: "1 1 110px" }} aria-label={t("icu.givenTo")} placeholder={t("icu.givenTo")} value={givenTo} onChange={(e) => setGivenTo(e.target.value)} />
          <input className="icu-input" style={{ flex: "1 1 80px" }} aria-label={t("icu.relation")} placeholder={t("icu.relation")} value={relation} onChange={(e) => setRelation(e.target.value)} />
          <button type="submit" className="icu-btn pri" disabled={summary.trim().length < 2 || givenTo.trim() === "" || relation.trim() === ""}>{t("icu.logUpdate")}</button>
          <button type="button" className="icu-btn" disabled={givenTo.trim() === "" || relation.trim() === ""} onClick={() => {
            const now = Date.now();
            void act(() => logIcuVisit({ admissionId: bed.tile.admissionId, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 30 * 60_000).toISOString(), visitorName: givenTo, relation }));
          }}>{t("icu.logVisit")}</button>
        </div>
      </form>
      <p style={{ fontSize: 11.5, color: "var(--i-d-dim)", margin: "6px 0 0" }}>{t("icu.familyNote")}</p>
      {err !== null ? <p className="icu-err">{err}</p> : null}
    </div>
  );
}

/** `/icu/bed/$admissionId`. */
export function IcuBed(props: { admissionId?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const params = useParams({ strict: false }) as { admissionId?: string };
  const admissionId = props.admissionId ?? params.admissionId;
  const qc = useQueryClient();
  const bedQ = useQuery({ queryKey: ["icu", "bed", admissionId], queryFn: () => fetchIcuBed(admissionId ?? ""), enabled: admissionId !== undefined, refetchInterval: ICU_POLL_MS });
  const trendQ = useQuery({ queryKey: ["icu", "trends", admissionId], queryFn: () => fetchIcuTrends(admissionId ?? ""), enabled: admissionId !== undefined, refetchInterval: 60_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["icu"] }); };
  if (bedQ.isError) return <div className="icu dark"><div className="icu-page"><p className="icu-err">{t(`icu.refusal.${icuRefusal(bedQ.error) ?? "bad_input"}`)}</p></div></div>;
  const bed = bedQ.data;
  if (bed === undefined) return <div className="icu dark"><div className="icu-page">{t("icu.loading")}</div></div>;
  const tile = bed.tile;
  const limitOf = (p: IcuParam) => tile.limits.find((l) => l.param === p);
  return (
    <div className="icu dark" data-testid="icu-bed">
      <header className="icu-head">
        <h1>{tile.bedName}</h1>
        <span className="sub">{tile.patientName} · {tile.uhid} · {bed.admissionNo ?? ""} · {t("icu.day", { n: tile.dayOfStay })}</span>
        <span style={{ flexGrow: 1 }} />
        <Link to="/icu/chart/$admissionId" params={{ admissionId: tile.admissionId }} className="icu-btn pri" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("icu.hourlyChart")}</Link>
      </header>
      <div className="icu-bedgrid">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <div className="icu-dpane">
            <TileNumbers tile={tile} t={t} big />
            <div className="icu-chips" style={{ marginTop: 8 }}>
              {(["temp", "etco2", "fio2", "peep", "vt"] as const).filter((p) => tile.latest[p] !== undefined).map((p) => (
                <span key={p}>{t(`icu.p.${p}`)} {num(tile.latest[p]?.value, p === "temp" ? 1 : 0)}</span>
              ))}
            </div>
          </div>
          <div className="icu-dpane" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h2>{t("icu.last24")}</h2>
            <span className="mo" style={{ fontSize: 11, color: "var(--i-d-dim)" }}>{t("icu.trendNote")}</span>
            {trendQ.data === undefined ? null : TRENDS.map(({ p, color }) => <TrendRow key={p} p={p} color={color} trends={trendQ.data} limit={limitOf(p)} t={t} />)}
            {trendQ.data !== undefined && Object.keys(trendQ.data.series).length === 0 ? <span style={{ color: "var(--i-d-dim)" }}>{t("icu.noTrend")}</span> : null}
          </div>
          <AlarmsAside view={{ tiles: [tile] }} t={t} onAcked={refresh} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <Devices bed={bed} t={t} refresh={refresh} />
          <LinesAndBundles bed={bed} t={t} refresh={refresh} />
          <Limits bed={bed} t={t} refresh={refresh} canDecide={can("icu.decide")} />
          <Family bed={bed} t={t} refresh={refresh} />
        </div>
      </div>
    </div>
  );
}

