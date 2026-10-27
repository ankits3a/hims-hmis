import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ICU_CHART_ENTRY, ICU_PARAM_ORDER, chartNum, correctIcuValue, enterIcuManualHour, fetchIcuChart, icuRefusal, istHHMM, istHourOf, prefillIcuHour, signIcuHour,
} from "../lib/icu-api";
import type React from "react";
import type { IcuChartHourView, IcuChartValueView, IcuParam } from "@hmis/contracts";
import "./icu.css";

/**
 * ═══ ICU IC-1 (#984, D4, D7) — THE HOURLY CHART (design board "Hourly flowsheet · the legal record, nurse-validated") ═══
 *
 * Columns are IST hours, newest on the right. A value from the device and not yet checked is BLUE ITALIC; a signed hour
 * is BLACK; a corrected value shows the original struck through with the new value and its reason beside it; a technical
 * reading (probe off) says so and is never a number. "Check and sign HH:00" makes the hour the record. While the hall's
 * feed is lost the screen says "Charting by hand" and the nurse types the hour, with the time it was observed (the entry
 * time is the server's).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

const current = (vs: IcuChartValueView[], p: IcuParam) => vs.find((v) => v.param === p && v.current);
const original = (vs: IcuChartValueView[], v: IcuChartValueView) => (v.supersedes === null ? undefined : vs.find((x) => x.id === v.supersedes));

function Cell({ hour, p, t }: { hour: IcuChartHourView; p: IcuParam; t: T }): React.ReactElement {
  const v = current(hour.values, p);
  if (v === undefined) return <td />;
  const cls = hour.state === "signed" ? "sig" : "dev";
  if (v.technical !== null) return <td><span className="tech">{t(`icu.tech.${v.technical}`)}</span></td>;
  const was = original(hour.values, v);
  return (
    <td className={cls} title={v.reason ?? undefined}>
      {was !== undefined && was.value !== null ? <span className="old">{chartNum(was.value)}</span> : null}
      {v.value === null ? "" : chartNum(v.value)}
      {v.source === "manual" ? <span className="tech" style={{ color: "var(--i-dim)" }}> {t("icu.byHand")}</span> : null}
    </td>
  );
}

/** `/icu/chart/$admissionId`. */
export function IcuChart(props: { admissionId?: string } = {}): React.ReactElement {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { admissionId?: string };
  const admissionId = props.admissionId ?? params.admissionId;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["icu", "chart", admissionId], queryFn: () => fetchIcuChart(admissionId ?? ""), enabled: admissionId !== undefined, refetchInterval: 15_000 });
  const [err, setErr] = useState<string | null>(null);
  const [fix, setFix] = useState<{ param: IcuParam; value: string; reason: string } | null>(null);
  const [manual, setManual] = useState<Partial<Record<IcuParam, string>>>({});
  const [observedAt, setObservedAt] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ["icu", "chart", admissionId] }); } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  };
  const chart = q.data;
  if (q.isError) return <div className="icu"><div className="icu-page"><p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p></div></div>;
  if (chart === undefined) return <div className="icu"><div className="icu-page">{t("icu.loading")}</div></div>;
  const hours = [...chart.hours].sort((a, b) => a.hourStart.localeCompare(b.hourStart)).slice(-8);
  const shown = ICU_PARAM_ORDER.filter((p) => hours.some((h) => h.values.some((v) => v.param === p)));
  const nowHour = istHourOf(Date.now());
  const thisHour = hours.find((h) => h.hourStart === nowHour);
  const draft = [...hours].reverse().find((h) => h.state === "draft");
  return (
    <div className="icu" data-testid="icu-chart">
      <header className="icu-head">
        <h1>{t("icu.chartTitle")}</h1>
        <span className="sub">{chart.mode === "manual" ? t("icu.chartManual") : t("icu.chartLive")}</span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ fontSize: 12.5 }}><span className="dev" style={{ color: "var(--i-blue)", fontStyle: "italic" }}>{t("icu.legendDevice")}</span> · <b>{t("icu.legendSigned")}</b></span>
        <Link to="/icu/bed/$admissionId" params={{ admissionId: chart.admissionId }}>{t("icu.backToBed")}</Link>
      </header>
      <div className="icu-page">
        <div className="icu-table-wrap">
          <table className="icu-table">
            <thead><tr><th>{t("icu.hour")}</th>{hours.map((h) => <th key={h.id} className={h.hourStart === nowHour ? "cur" : undefined}>{istHHMM(h.hourStart)}{h.state === "signed" ? " ✓" : ""}</th>)}</tr></thead>
            <tbody>
              {shown.map((p) => <tr key={p}><td>{t(`icu.p.${p}`)}</td>{hours.map((h) => <Cell key={h.id} hour={h} p={p} t={t} />)}</tr>)}
              <tr><td>{t("icu.signedBy")}</td>{hours.map((h) => <td key={h.id} className="mo">{h.signedAt === null ? "—" : istHHMM(h.signedAt)}</td>)}</tr>
            </tbody>
          </table>
          {hours.length === 0 ? <p style={{ padding: 12, margin: 0 }}>{t("icu.noHours")}</p> : null}
        </div>
        {err !== null ? <p className="icu-err" role="alert">{err}</p> : null}
        <p style={{ fontSize: 12.5, color: "var(--i-dim)", margin: 0 }}>{t("icu.signNote")}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {chart.mode === "live" && thisHour === undefined ? (
            <button type="button" className="icu-btn" onClick={() => { void act(() => prefillIcuHour(chart.admissionId, nowHour)); }}>{t("icu.prefill", { at: istHHMM(nowHour) })}</button>
          ) : null}
          {draft !== undefined ? <button type="button" className="icu-btn" onClick={() => setFix({ param: draft.values[0]?.param ?? "hr", value: "", reason: "" })}>{t("icu.correct")}</button> : null}
          {draft !== undefined ? <button type="button" className="icu-btn pri" onClick={() => { void act(() => signIcuHour(draft.id)); }}>{t("icu.checkAndSign", { at: istHHMM(draft.hourStart) })}</button> : null}
        </div>
        {fix !== null && draft !== undefined ? (
          <form className="icu-card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => {
            e.preventDefault();
            void act(async () => { await correctIcuValue(draft.id, fix.param, Number(fix.value), fix.reason); setFix(null); });
          }}>
            <label className="icu-field">{t("icu.param")}
              <select className="icu-input" value={fix.param} onChange={(e) => setFix({ ...fix, param: e.target.value as IcuParam })}>
                {[...new Set(draft.values.map((v) => v.param))].map((p) => <option key={p} value={p}>{t(`icu.p.${p}`)}</option>)}
              </select></label>
            <label className="icu-field">{t("icu.newValue")}<input className="icu-input" style={{ width: 90 }} inputMode="decimal" value={fix.value} onChange={(e) => setFix({ ...fix, value: e.target.value })} /></label>
            <label className="icu-field" style={{ flex: "1 1 200px" }}>{t("icu.reason")}<input className="icu-input" value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} /></label>
            <button type="submit" className="icu-btn pri" disabled={fix.value === ""}>{t("icu.saveCorrection")}</button>
            <button type="button" className="icu-btn" onClick={() => setFix(null)}>{t("icu.cancel")}</button>
          </form>
        ) : null}
        {chart.mode === "manual" ? (
          <form className="icu-card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => {
            e.preventDefault();
            const values = Object.fromEntries(Object.entries(manual).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, Number(v)])) as Partial<Record<IcuParam, number>>;
            const happened = observedAt === "" ? undefined : new Date(`${new Date(Date.parse(nowHour) + 5.5 * 3_600_000).toISOString().slice(0, 10)}T${observedAt}:00+05:30`).toISOString();
            void act(async () => { await enterIcuManualHour(chart.admissionId, nowHour, values, happened); setManual({}); });
          }}>
            <b style={{ width: "100%" }}>{t("icu.manualHour", { at: istHHMM(nowHour) })}</b>
            {ICU_CHART_ENTRY.map((p) => (
              <label key={p} className="icu-field">{t(`icu.p.${p}`)}<input className="icu-input" style={{ width: 80 }} inputMode="decimal" value={manual[p] ?? ""} onChange={(e) => setManual({ ...manual, [p]: e.target.value })} /></label>
            ))}
            <label className="icu-field">{t("icu.observedAt")}<input className="icu-input" type="time" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} /></label>
            <button type="submit" className="icu-btn pri">{t("icu.saveHour")}</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
