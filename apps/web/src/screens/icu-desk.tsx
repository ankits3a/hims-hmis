import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { searchPatients } from "../lib/patients-api";
import { confirmIcuLimitOnMonitor, decideIcuRequest, fetchIcuIncharge, fetchIcuRequests, icuRefusal, istHHMM, num, raiseIcuRequest } from "../lib/icu-api";
import type React from "react";
import type { IcuDecision, IcuRequestSource, IcuRequestView } from "@hmis/contracts";
import type { WirePatientHit } from "../lib/patients-api";
import "./icu.css";

/**
 * ═══ ICU IC-1 (#984) — THE ICU REQUESTS AND THE IN-CHARGE VIEW ═══
 *
 * Requests (D1): a doctor raises one from the ER, a ward or OT with a priority class 1–4 and the scores (NEWS2 and qSOFA
 * fill themselves from the ward's latest vitals on the server); the intensivist approves, holds with monitoring or
 * refuses, always with a reason, and the decision shows with its name. The approval is the one the admit desk passes.
 * The in-charge view (D6, D7, D8): missed bundles, alarm storms, "set the same limit on the monitor" tasks to tick, and
 * halls whose feed is lost.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

function RequestRow({ r, t, canDecide, onDone }: { r: IcuRequestView; t: T; canDecide: boolean; onDone: () => void }): React.ReactElement {
  const [reason, setReason] = useState("");
  const [monitoring, setMonitoring] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const open = r.state === "pending" || r.state === "on_hold";
  const decide = async (decision: IcuDecision) => {
    setErr(null);
    try {
      await decideIcuRequest(r.id, { decision, reason, ...(decision === "hold" && monitoring.trim() !== "" ? { monitoring } : {}) });
      setReason(""); setMonitoring(""); onDone();
    } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  };
  const scores = Object.entries(r.triage).map(([k, v]) => `${t(`icu.score.${k}`)} ${String(v)}`).join(" · ");
  return (
    <div className="icu-row" data-testid="icu-request">
      <div className="grow">
        <b>{r.patientName}</b> <span className="mo" style={{ fontSize: 12, color: "var(--i-dim)" }}>{r.uhid}</span>
        <small>{t(`icu.source.${r.source}`)} · {t("icu.priority", { n: r.priorityClass })} · {scores === "" ? t("icu.noScores") : scores}</small>
        <small>{r.reason}</small>
        {r.decidedBy !== null ? <small>{t(`icu.state.${r.state}`)} · {r.decisionReason ?? ""}{r.monitoring !== null ? ` · ${r.monitoring}` : ""}{r.reviewAt !== null ? ` · ${t("icu.reviewAt", { at: istHHMM(r.reviewAt) })}` : ""}</small> : null}
      </div>
      <span className={`icu-badge${r.state === "approved" ? " green" : r.state === "refused" ? " red" : r.state === "on_hold" ? " gold" : ""}`}>{t(`icu.state.${r.state}`)}</span>
      {open && canDecide ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", width: "100%" }}>
          <input className="icu-input" style={{ flex: "2 1 200px" }} aria-label={t("icu.reason")} placeholder={t("icu.reasonNeeded")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <input className="icu-input" style={{ flex: "1 1 160px" }} aria-label={t("icu.monitoring")} placeholder={t("icu.monitoringHold")} value={monitoring} onChange={(e) => setMonitoring(e.target.value)} />
          <button type="button" className="icu-btn pri" disabled={reason.trim() === ""} onClick={() => { void decide("approve"); }}>{t("icu.approve")}</button>
          <button type="button" className="icu-btn" disabled={reason.trim() === ""} onClick={() => { void decide("hold"); }}>{t("icu.hold")}</button>
          <button type="button" className="icu-btn red" disabled={reason.trim() === ""} onClick={() => { void decide("refuse"); }}>{t("icu.refuse")}</button>
        </div>
      ) : null}
      {err !== null ? <p className="icu-err" style={{ width: "100%" }}>{err}</p> : null}
    </div>
  );
}

function NewRequest({ t, onDone }: { t: T; onDone: () => void }): React.ReactElement {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WirePatientHit[]>([]);
  const [patient, setPatient] = useState<WirePatientHit | null>(null);
  const [source, setSource] = useState<IcuRequestSource>("er");
  const [priority, setPriority] = useState(2);
  const [reason, setReason] = useState("");
  const [sofa, setSofa] = useState("");
  const [gcs, setGcs] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const find = async () => { try { setHits(await searchPatients(q)); } catch { setHits([]); } };
  const send = async () => {
    if (patient === null) return;
    setErr(null);
    try {
      const triage: Record<string, number> = {};
      if (sofa !== "") triage.sofa = Number(sofa);
      if (gcs !== "") triage.gcs = Number(gcs);
      await raiseIcuRequest({ patientId: patient.id, source, priorityClass: priority, reason, triage });
      setPatient(null); setReason(""); setSofa(""); setGcs(""); setHits([]); setQ(""); onDone();
    } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  };
  return (
    <div className="icu-card">
      <h2>{t("icu.newRequest")}</h2>
      {patient === null ? (
        <form style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <input className="icu-input" style={{ flex: "1 1 200px" }} aria-label={t("icu.findPatient")} placeholder={t("icu.findPatient")} value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="icu-btn" disabled={q.trim().length < 2}>{t("icu.find")}</button>
          {hits.map((h) => <button key={h.id} type="button" className="icu-btn" style={{ width: "100%", textAlign: "left" }} onClick={() => setPatient(h)}>{h.name} · {h.uhid}</button>)}
        </form>
      ) : (
        <form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div style={{ width: "100%" }}><b>{patient.name}</b> · {patient.uhid} <button type="button" className="icu-btn" style={{ height: 30 }} onClick={() => setPatient(null)}>{t("icu.change")}</button></div>
          <label className="icu-field">{t("icu.from")}
            <select className="icu-input" value={source} onChange={(e) => setSource(e.target.value as IcuRequestSource)}>
              {(["er", "ward", "ot"] as const).map((s) => <option key={s} value={s}>{t(`icu.source.${s}`)}</option>)}
            </select></label>
          <label className="icu-field">{t("icu.priorityClass")}
            <select className="icu-input" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("icu.priority", { n })}</option>)}
            </select></label>
          <label className="icu-field">{t("icu.score.sofa")}<input className="icu-input" style={{ width: 70 }} inputMode="numeric" value={sofa} onChange={(e) => setSofa(e.target.value)} /></label>
          <label className="icu-field">{t("icu.score.gcs")}<input className="icu-input" style={{ width: 70 }} inputMode="numeric" value={gcs} onChange={(e) => setGcs(e.target.value)} /></label>
          <label className="icu-field" style={{ flex: "1 1 240px" }}>{t("icu.reason")}<input className="icu-input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="submit" className="icu-btn pri" disabled={reason.trim() === ""}>{t("icu.send")}</button>
        </form>
      )}
      <p style={{ fontSize: 12, color: "var(--i-dim)", margin: "8px 0 0" }}>{t("icu.requestNote")}</p>
      {err !== null ? <p className="icu-err">{err}</p> : null}
    </div>
  );
}

/** `/icu/requests`. */
export function IcuRequests(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["icu", "requests"], queryFn: fetchIcuRequests, refetchInterval: 15_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["icu", "requests"] }); };
  return (
    <div className="icu" data-testid="icu-requests">
      <header className="icu-head"><h1>{t("icu.requestsTitle")}</h1><span className="sub">{t("icu.requestsSub")}</span></header>
      <div className="icu-page">
        {can("icu.request") ? <NewRequest t={t} onDone={refresh} /> : null}
        <div className="icu-card">
          {q.isError ? <p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p> : null}
          {q.data?.length === 0 ? <p>{t("icu.noRequests")}</p> : null}
          {(q.data ?? []).map((r) => <RequestRow key={r.id} r={r} t={t} canDecide={can("icu.decide")} onDone={refresh} />)}
        </div>
      </div>
    </div>
  );
}

/** `/icu/incharge`. */
export function IcuIncharge(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["icu", "incharge"], queryFn: fetchIcuIncharge, refetchInterval: 15_000 });
  const [err, setErr] = useState<string | null>(null);
  const v = q.data;
  const tick = async (limitId: string) => {
    setErr(null);
    try { await confirmIcuLimitOnMonitor(limitId); await qc.invalidateQueries({ queryKey: ["icu", "incharge"] }); } catch (e) { setErr(t(`icu.refusal.${icuRefusal(e) ?? "bad_input"}`)); }
  };
  return (
    <div className="icu" data-testid="icu-incharge">
      <header className="icu-head"><h1>{t("icu.inchargeTitle")}</h1><span className="sub">{v === undefined ? "" : istHHMM(v.asOf)}</span></header>
      <div className="icu-page">
        {q.isError ? <p className="icu-err">{t(`icu.refusal.${icuRefusal(q.error) ?? "bad_input"}`)}</p> : null}
        {err !== null ? <p className="icu-err">{err}</p> : null}
        <div className="icu-grid2">
          <div className="icu-card">
            <h2>{t("icu.missedBundles")}</h2>
            {v?.missedBundles.length === 0 ? <small>{t("icu.noneMissed")}</small> : null}
            {(v?.missedBundles ?? []).map((m) => (
              <div key={m.bundleId} className="icu-row"><b style={{ width: 90 }}>{m.bedName}</b><div className="grow">{t(`icu.bundle.${m.kind}`)}<small>{m.patientName} · {t("icu.dueAt", { at: istHHMM(m.dueAt) })}</small></div><span className="icu-badge red">{t("icu.missed")}</span></div>
            ))}
          </div>
          <div className="icu-card">
            <h2>{t("icu.monitorTasks")}</h2>
            {v?.monitorTasks.length === 0 ? <small>{t("icu.noMonitorTasks")}</small> : null}
            {(v?.monitorTasks ?? []).map((m) => (
              <div key={m.limitId} className="icu-row"><b style={{ width: 90 }}>{m.bedName}</b><div className="grow">{t(`icu.p.${m.param}`)} {num(m.low)}–{num(m.high)}<small>{t("icu.orderedAt", { at: istHHMM(m.orderedAt) })}</small></div>
                <button type="button" className="icu-btn pri" onClick={() => { void tick(m.limitId); }}>{t("icu.setOnMonitor")}</button></div>
            ))}
          </div>
          <div className="icu-card">
            <h2>{t("icu.storms")}</h2>
            {v?.storms.length === 0 ? <small>{t("icu.noStorms")}</small> : null}
            {(v?.storms ?? []).map((s) => <div key={s.admissionId} className="icu-row"><b style={{ width: 90 }}>{s.bedName}</b><div className="grow">{t("icu.stormCount", { n: s.count })}</div></div>)}
          </div>
          <div className="icu-card">
            <h2>{t("icu.feeds")}</h2>
            {v?.greyHalls.length === 0 ? <small>{t("icu.allFeedsLive")}</small> : null}
            {(v?.greyHalls ?? []).map((g) => <div key={g.hallId} className="icu-row"><b className="grow">{g.hallName}</b><span className="icu-badge">{t("icu.feedLostSince", { at: g.since === null ? "—" : istHHMM(g.since) })}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
