import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErCodeView, ErCodes, ErRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_BOARD_TOPIC, ER_CODE_MILESTONES, ER_RHYTHMS, callCodeApi, codeEventApi, debriefApi, endCodeApi, erRefusalOf, fetchErCode, fetchErCodes,
} from "../lib/er-api";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 7 (#814) — THE RESUS SCRIBE (spec SPEC-emergency §5 F: tablet landscape, one tap per event, 48 px targets, the
 * timer always on screen). Left: the codes running (and the last day's). Right: one code — its timer, the activation clocks
 * from the door, the one-tap event pads (CPR, rhythm, shock, drugs, airway, ROSC, death, the milestones), the timeline, and
 * the end (the team leader) and the debrief. Code Blue / Code Grey can be called from here for a place with no patient.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
type Act = (work: () => Promise<string | null>) => Promise<void>;

function mmss(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return <div className="erd-refusal" role="alert"><b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b><span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span></div>;
}

export function ErCodesScreen(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const search = useSearch({ strict: false }) as { code?: string };
  const navigate = useNavigate();
  const picked = typeof search.code === "string" && search.code !== "" ? search.code : null;
  const [list, setList] = useState<ErCodes | null>(null);
  const [code, setCode] = useState<ErCodeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [place, setPlace] = useState("");
  const load = useCallback(() => {
    fetchErCodes().then(setList, () => setList(null));
    if (picked !== null) fetchErCode(picked).then(setCode, () => setCode(null)); else setCode(null);
  }, [picked]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useRealtime([ER_BOARD_TOPIC], () => load());
  const act: Act = async (work) => {
    setBusy(true); setRefusal(null); setNote(null);
    try { const said = await work(); if (said !== null) setNote(said); load(); }
    catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };
  const pick = (id: string) => void navigate({ to: "/er/codes", search: { code: id } as never });
  const row = (c: ErCodeView) => (
    <button key={c.codeId} type="button" className={`ert-row erm-row${c.codeId === picked ? " on" : ""}`} onClick={() => pick(c.codeId)} data-testid="er-code-row">
      <span className="ert-row-main"><b>{t(`erCodes.kind.${c.kind}`)} · {c.where}</b>
        <span className="dim">{c.episodeNo ?? t("erCodes.noPatient")} · {fmtIst(c.calledAt)}</span></span>
      <span className={`mono erc-timer${c.endedAt === null ? " live" : ""}`}>{c.endedAt === null ? mmss(c.calledAt, now) : t(`erCodes.outcome.${c.outcome ?? "resolved"}`)}</span>
    </button>
  );
  return (
    <div className="erx erd erm erc" data-testid="er-codes">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erCodes.title")}</h1></div>
        <div className="erb-tools"><Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link></div>
      </header>
      <div className="erd-cols">
        <section className="erd-list erm-list" aria-label={t("erCodes.running")}>
          {can("er.codes") ? (
            <div className="erc-call">
              <label className="erd-field"><span>{t("erCodes.where")}</span><input value={place} onChange={(e) => setPlace(e.target.value)} placeholder={t("erCodes.whereHint")} /></label>
              <div className="erd-row">
                {(["code_blue", "code_grey"] as const).map((k) => (
                  <button key={k} type="button" className={`erx-btn ${k === "code_blue" ? "erc-blue" : "erc-grey"}`} disabled={busy || place.trim() === ""} data-testid={`er-code-call-${k}`}
                    onClick={() => void act(async () => { const r = await callCodeApi({ kind: k, place: place.trim() }); pick(r.codeId); return t("erCodes.paged", { n: r.paged }); })}>
                    {t(`erCodes.kind.${k}`)}</button>
                ))}
              </div>
            </div>
          ) : null}
          <h2>{t("erCodes.running")} <span className="erb-badge">{list?.active.length ?? 0}</span></h2>
          {list === null ? <div className="erb-empty">{t("erTriage.loading")}</div>
            : list.active.length === 0 ? <div className="erb-empty">{t("erCodes.none")}</div> : list.active.map(row)}
          {list !== null && list.recent.length > 0 ? <><h2>{t("erCodes.recent")}</h2>{list.recent.map(row)}</> : null}
        </section>
        <section className="erd-new erm-case" data-testid="er-code-case">
          {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
          {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
          {code === null ? <div className="erb-empty">{t("erCodes.pick")}</div> : <Code c={code} t={t} now={now} busy={busy} act={act} />}
        </section>
      </div>
    </div>
  );
}

function Code({ c, t, now, busy, act }: { c: ErCodeView; t: T; now: number; busy: boolean; act: Act }): React.ReactElement {
  const [drug, setDrug] = useState("");
  const [dose, setDose] = useState("");
  const [well, setWell] = useState("");
  const [improve, setImprove] = useState("");
  const live = c.endedAt === null;
  const tap = (body: Record<string, unknown>, said: string | null = null) => act(async () => { await codeEventApi({ codeId: c.codeId, ...body }); return said; });
  return (
    <div className="erm-detail">
      <div className="erd-ep-top">
        <div className="erd-ep-name"><b>{t(`erCodes.kind.${c.kind}`)} · {c.where}</b>{c.patientLabel !== null ? <span>{c.patientLabel}</span> : null}{c.episodeNo !== null ? <span className="mono">{c.episodeNo}</span> : null}</div>
        <span className={`mono erc-timer big${live ? " live" : ""}`} data-testid="er-code-timer">{mmss(c.calledAt, live ? now : new Date(c.endedAt!).getTime())}</span>
      </div>
      {c.clocks.length > 0 ? (
        <div className="erb-chips" data-testid="er-code-clocks">
          {c.clocks.map((k) => {
            const late = k.metAt === null ? now > new Date(k.dueAt).getTime() : new Date(k.metAt).getTime() > new Date(k.dueAt).getTime();
            return (
              <span key={k.milestone} className={`erb-clock${late ? " late" : ""}`}>
                {t(`erCodes.milestone.${k.milestone}`)} ≤ {k.targetMin} {t("erCodes.min")} {t(`erCodes.from.${k.from}`)} · {k.metAt === null ? t("erCodes.dueAt", { time: fmtIst(k.dueAt) }) : t("erCodes.metAt", { time: fmtIst(k.metAt) })}
              </span>
            );
          })}
        </div>
      ) : null}
      {live ? (
        <>
          <div className="erc-pads" data-testid="er-code-pads">
            {(["cpr_start", "cpr_pause", "airway", "rosc", "death"] as const).map((k) => (
              <button key={k} type="button" className="erd-opt" disabled={busy} onClick={() => void tap({ kind: k })}>{t(`erCodes.event.${k}`)}</button>
            ))}
          </div>
          <div className="erc-pads">{ER_RHYTHMS.map((r) => (
            <button key={r} type="button" className="erd-opt sm" disabled={busy} onClick={() => void tap({ kind: "rhythm", rhythm: r })}>{t(`erCodes.rhythm.${r}`)}</button>
          ))}</div>
          <div className="erc-pads">{[150, 200, 360].map((j) => (
            <button key={j} type="button" className="erd-opt sm" disabled={busy} data-testid={`er-code-shock-${j}`} onClick={() => void tap({ kind: "shock", joules: j })}>{t("erCodes.shock", { j })}</button>
          ))}
            {[["Adrenaline", "1 mg IV"], ["Amiodarone", "300 mg IV"], ["Atropine", "0.6 mg IV"]].map(([d, q]) => (
              <button key={d} type="button" className="erd-opt sm" disabled={busy} onClick={() => void tap({ kind: "drug", drug: d, dose: q })}>{d} {q}</button>
            ))}
          </div>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erCodes.drug")}</span><input value={drug} onChange={(e) => setDrug(e.target.value)} /></label>
            <label className="erd-field"><span>{t("erCodes.dose")}</span><input value={dose} onChange={(e) => setDose(e.target.value)} /></label>
          </div>
          <button type="button" className="erx-btn sm" disabled={busy || drug.trim() === "" || dose.trim() === ""} onClick={() => void tap({ kind: "drug", drug: drug.trim(), dose: dose.trim() })}>{t("erCodes.addDrug")}</button>
          {ER_CODE_MILESTONES[c.kind]!.length > 0 ? (
            <div className="erc-pads">{ER_CODE_MILESTONES[c.kind]!.map((m) => (
              <button key={m} type="button" className="erd-opt sm" disabled={busy || c.clocks.find((k) => k.milestone === m)?.metAt != null} data-testid={`er-code-milestone-${m}`}
                onClick={() => void tap({ kind: "milestone", milestone: m })}>{t(`erCodes.milestone.${m}`)}</button>
            ))}</div>
          ) : null}
          <div className="erd-row">{(["rosc", "died", "stood_down", "transferred", "resolved"] as const).map((o) => (
            <button key={o} type="button" className="erx-btn sm" disabled={busy} onClick={() => void act(async () => { await endCodeApi({ codeId: c.codeId, outcome: o }); return t("erCodes.ended"); })}>
              {t("erCodes.end", { outcome: t(`erCodes.outcome.${o}`) })}</button>
          ))}</div>
        </>
      ) : !c.debriefed ? (
        <div className="erd-form erm-form" data-testid="er-code-debrief">
          <label className="erd-field"><span>{t("erCodes.wentWell")}</span><input value={well} onChange={(e) => setWell(e.target.value)} /></label>
          <label className="erd-field"><span>{t("erCodes.improve")}</span><input value={improve} onChange={(e) => setImprove(e.target.value)} /></label>
          <button type="button" className="erx-btn pri" disabled={busy || well.trim() === "" || improve.trim() === ""}
            onClick={() => void act(async () => { await debriefApi({ codeId: c.codeId, wentWell: well.trim(), improve: improve.trim() }); return t("erCodes.debriefed"); })}>{t("erCodes.saveDebrief")}</button>
        </div>
      ) : <p className="erp-text">{t("erCodes.debriefDone")}</p>}
      <h2>{t("erCodes.timeline")}</h2>
      <ol className="erc-timeline" data-testid="er-code-timeline">
        {c.events.map((e) => (
          <li key={e.eventId}><span className="mono">{mmss(c.calledAt, new Date(e.at).getTime())}</span> <b>{t(`erCodes.event.${e.kind}`)}</b> {e.kind === "rhythm" ? t(`erCodes.rhythm.${e.words}`, { defaultValue: e.words }) : e.kind === "milestone" ? t(`erCodes.milestone.${e.words}`, { defaultValue: e.words }) : e.words}
            {e.fromPaper ? <span className="erb-chip name_alert">{t("erCodes.paper")}</span> : null}<span className="dim"> · {e.by}</span></li>
        ))}
      </ol>
    </div>
  );
}
