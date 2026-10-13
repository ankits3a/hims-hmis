import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdNurseStation, IpdNursingChart, IpdRefusalBody, IpdStationBed } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { acknowledgeEws, addNote, getChart, getStation, recordAssessment, recordIntakeOutput } from "../lib/ipd-nursing-api";
import type { AssessmentInput } from "../lib/ipd-nursing-api";
import { LiveLine, ScoreBadge, VitalsForm, ageFromAgeSex, dueWords, savedWords, spanWords, useLiveLoad, useNight } from "./ipd-nursing-shared";
import type { T } from "./ipd-nursing-shared";
import "./ipd-nursing.css";

/**
 * E4.1 (#733) — BOARD C, THE WARD NURSE STATION (spec SPEC-ipd-core §4.9 C). Tablet landscape and ward wall, 16:9:
 * the PAGE never scrolls at 1920×1080 or 1366×768; a 60-bed hall scrolls inside the grid.
 *
 * Bed cards in bed order: bed, identity, consultant, day of stay, alert chips IN WORDS, the early-warning score with
 * its band word and trend arrow, the next due item with a live countdown, an open alert with Acknowledge, the
 * discharge state. Empty beds say "Free · since 10:12", "Cleaning · 34 min", "Reserved". "Needs me" order (score
 * rising, alert, overdue, assessment due) is the default above 30 beds. Night mode follows the server (22:00–06:00
 * IST) with a manual switch; prints are never dark. A bed opens the patient's nursing chart in a drawer.
 * Everything shown is the server's (`GET /ipd/nursing/station`); the screen adds nothing but the countdown.
 */

const TICK_MS = 30_000;
const NEEDS_ME_DEFAULT_ABOVE = 30;

export function IpdWard(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { ward?: string; admission?: string };
  const [station, setStation] = useState<IpdNurseStation | null>(null);
  const [error, setError] = useState<"forbidden" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [needsMe, setNeedsMe] = useState<boolean | null>(null);
  const wardId = search.ward ?? null;

  const load = useCallback(() => getStation(wardId).then(
    (s) => { setStation(s); setError(null); setNow(Date.now()); },
    (e: unknown) => { if (e instanceof ApiError && e.status === 403) setError("forbidden"); throw e; },
  ), [wardId]);
  const live = useLiveLoad(load);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);
  const [night, flipNight] = useNight(station?.night);

  const setSearch = (next: { ward?: string | undefined; admission?: string | undefined }): void => {
    void navigate({ to: "/ipd/ward", search: { ...(search.ward ? { ward: search.ward } : {}), ...(search.admission ? { admission: search.admission } : {}), ...next } as never });
  };

  const beds = useMemo(() => station?.beds ?? [], [station]);
  const sortNeeds = needsMe ?? beds.length > NEEDS_ME_DEFAULT_ABOVE;
  const shown = useMemo(() => (sortNeeds
    ? [...beds].sort((a, b) => b.needs - a.needs || (a.code ?? "").localeCompare(b.code ?? "", undefined, { numeric: true }))
    : [...beds].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "", undefined, { numeric: true }))), [beds, sortNeeds]);
  const open = search.admission ? beds.find((b) => b.patient?.admissionId === search.admission) ?? null : null;

  return (
    <main className={`ipdn ipdn-ward${night ? " night" : ""}`} data-testid="ipd-ward">
      <header className="ipdn-head">
        <div className="ipdn-title">
          <h1>{station?.ward?.name ?? t("ipdNursing.ward.title")}</h1>
          {station !== null ? (
            <span className="dim">{t(`ipdNursing.shift.${station.shift.key}`)} · {fmtIst(station.shift.startsAt)}–{fmtIst(station.shift.endsAt)}</span>
          ) : null}
        </div>
        <div className="ipdn-tools">
          <LiveLine online={live.online} lastUpdate={live.lastUpdate} />
          <button type="button" className="ipdn-btn sm" aria-pressed={sortNeeds} onClick={() => setNeedsMe(!sortNeeds)} data-testid="ipdn-needs-toggle">
            {sortNeeds ? t("ipdNursing.ward.needsMeOn") : t("ipdNursing.ward.bedOrder")}
          </button>
          <button type="button" className="ipdn-btn sm" aria-pressed={night} onClick={flipNight} data-testid="ipdn-night-toggle">
            {night ? `☾ ${t("ipdNursing.night")}` : `☀ ${t("ipdNursing.day")}`}
          </button>
        </div>
      </header>
      {station !== null && station.wards.length > 1 ? (
        <nav className="ipdn-chips" aria-label={t("ipdNursing.ward.wards")}>
          {station.wards.map((w) => (
            <button key={w.id} type="button" className="ipdn-chip" aria-pressed={station.ward?.id === w.id} onClick={() => setSearch({ ward: w.id, admission: undefined })}>
              {w.name}
            </button>
          ))}
        </nav>
      ) : null}
      {station !== null ? <TopBar s={station} t={t as T} /> : null}
      {error === "forbidden" ? <div className="ipdn-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {station === null && error === null ? <div className="ipdn-empty">{t("ipdNursing.loading")}</div> : null}
      {station !== null && station.ward === null ? <div className="ipdn-empty">{t("ipdNursing.ward.noWard")}</div> : null}
      <section className="ipdn-grid" aria-label={t("ipdNursing.ward.beds")}>
        {shown.map((b) => <BedCard key={b.bedId} b={b} now={now} onOpen={(id) => setSearch({ admission: id })} onDone={() => void load().catch(() => undefined)} />)}
      </section>
      {open !== null && open.patient !== null ? (
        <ChartDrawer bed={open} onClose={() => setSearch({ admission: undefined })} onChanged={() => void load().catch(() => undefined)} />
      ) : null}
    </main>
  );
}

function TopBar({ s, t }: { s: IpdNurseStation; t: T }): React.ReactElement {
  const items: [string, string, boolean][] = [
    ["census", t("ipdNursing.top.census", { n: s.top.census, total: s.top.beds }), false],
    ["free", t("ipdNursing.top.free", { n: s.top.free }), false],
    ["expected", t("ipdNursing.top.expected", { n: s.top.expected }), false],
    ["discharges", t("ipdNursing.top.discharges", { n: s.top.dischargesToday }), false],
    ["overdue", t("ipdNursing.top.overdue", { n: s.top.overdue }), s.top.overdue > 0],
    ["alerts", t("ipdNursing.top.alerts", { n: s.top.alerts }), s.top.alerts > 0],
    ["handovers", t("ipdNursing.top.handovers", { n: s.top.handoversWaiting }), s.top.handoversWaiting > 0],
  ];
  return (
    <ul className="ipdn-top" data-testid="ipdn-top">
      {items.map(([k, words, hot]) => <li key={k} className={hot ? "hot" : ""}>{hot ? "⚠ " : ""}{words}</li>)}
    </ul>
  );
}

function emptyWords(b: IpdStationBed, now: number, t: T): string {
  const since = b.since === null ? null : new Date(b.since).getTime();
  if (b.status === "cleaning") return since === null ? t("ipdNursing.bed.cleaning") : t("ipdNursing.bed.cleaningFor", { span: spanWords(now - since, t) });
  if (b.status === "available") return since === null ? t("ipdNursing.bed.free") : t("ipdNursing.bed.freeSince", { time: fmtIst(b.since!) });
  return t(`ipdNursing.bed.${b.status}`);
}

function BedCard({ b, now, onOpen, onDone }: { b: IpdStationBed; now: number; onOpen: (admissionId: string) => void; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  if (b.patient === null) {
    return (
      <article className={`ipdn-bed empty s-${b.status}`} data-testid={`ipdn-bed-${b.code ?? b.bedId}`}>
        <div className="ipdn-bedcode mono">{b.code ?? "—"}</div>
        <div className="ipdn-emptyline">{emptyWords(b, now, t as T)}</div>
      </article>
    );
  }
  const p = b.patient;
  const overdue = b.next?.overdue === true || (b.next !== null && new Date(b.next.dueAt).getTime() < now);
  const ack = (): void => {
    if (b.alert === null) return;
    setBusy(true); setRefusal(null);
    acknowledgeEws(b.alert.alertId).then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  return (
    <article className={`ipdn-bed${b.alert !== null ? " alert" : ""}${overdue ? " overdue" : ""}`} data-testid={`ipdn-bed-${b.code ?? b.bedId}`}>
      <button type="button" className="ipdn-bedopen" onClick={() => onOpen(p.admissionId)} aria-label={t("ipdNursing.ward.openChart", { bed: b.code ?? p.name })}>
        <div className="ipdn-bedrow">
          <span className="ipdn-bedcode mono">{b.code ?? "—"}</span>
          {b.dayOfStay !== null ? <span className="dim">{t("ipdNursing.bed.day", { n: b.dayOfStay })}</span> : null}
        </div>
        <div className="ipdn-who"><b>{p.name}</b> <span className="dim">{p.ageSex}</span></div>
        <div className="ipdn-sub dim">{[p.uhid ? `UHID ${p.uhid}` : null, b.consultant].filter(Boolean).join(" · ")}</div>
        {b.chips.length > 0 ? (
          <div className="ipdn-chiprow">{b.chips.map((c) => <span key={c} className={`ipdn-tag c-${c}`}>{t(`ipdNursing.chip.${c}`)}</span>)}</div>
        ) : null}
        <div className="ipdn-bedrow">
          {b.score !== null ? <ScoreBadge kind={b.score.kind} value={b.score.value} band={b.score.band} trend={b.score.trend} complete={b.score.complete} />
            : <span className="dim">{b.scoreKind !== null ? t("ipdNursing.noScoreYet", { kind: t(`ipdNursing.kind.${b.scoreKind}`) }) : ""}</span>}
        </div>
        {b.next !== null ? (
          <div className={`ipdn-due${overdue ? " late" : ""}`}>{overdue ? "⚠" : "⏱"} {dueWords(b.next.kind, b.next.dueAt, now, t as T)}</div>
        ) : null}
        {b.discharge !== null ? <div className="ipdn-sub">{t(`ipdNursing.discharge.${b.discharge}`)}</div> : null}
        {b.transferring ? <div className="ipdn-sub">{t("ipdNursing.transferring")}</div> : null}
      </button>
      {b.alert !== null ? (
        <div className="ipdn-alertrow" role="status">
          <span>⚠ {t("ipdNursing.alert", { band: t(`ipdNursing.band.${b.alert.band}`) })} · {fmtIst(b.alert.raisedAt)}</span>
          {!b.alert.doctorReached ? <b className="ipdn-nodoc" data-testid="ipdn-nodoc">☎ {t("ipdNursing.noDoctorReached")}</b> : null}
          {b.alert.acknowledgedAt === null && b.alert.seenAt !== null ? <span className="dim">{t("ipdNursing.seenNoDoctor")}</span> : null}
          {b.alert.acknowledgedAt !== null ? <span className="dim">✓ {t("ipdNursing.acked")}</span>
            : can("ipd.ews.respond") ? <button type="button" className="ipdn-btn sm pri" disabled={busy} onClick={ack} data-testid="ipdn-ack">{t("ipdNursing.ack")}</button> : null}
        </div>
      ) : null}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
    </article>
  );
}

// ═══════════════════════════════════════════ the chart drawer ═══════════════════════════════════════════

function ChartDrawer({ bed, onClose, onChanged }: { bed: IpdStationBed; onClose: () => void; onChanged: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const p = bed.patient!;
  const [chart, setChart] = useState<IpdNursingChart | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"vitals" | "assessment" | "io" | "notes">("vitals");
  const [entering, setEntering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => { getChart(p.admissionId).then((c) => { setChart(c); setFailed(false); }, () => setFailed(true)); }, [p.admissionId]);
  useEffect(() => { load(); }, [load]);
  const changed = (words: string): void => { setNotice(words); load(); onChanged(); };
  return (
    <aside className="ipdn-drawer" role="dialog" aria-label={t("ipdNursing.chart.title")} data-testid="ipdn-chart">
      <header className="ipdn-drawerhead">
        <div>
          <div className="ipdn-who"><b>{p.name}</b> <span className="dim">{p.ageSex}</span></div>
          <div className="ipdn-sub dim">{[bed.code, p.uhid ? `UHID ${p.uhid}` : null, p.admissionNo].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" className="ipdn-btn sm" onClick={onClose}>{t("ipdNursing.close")}</button>
      </header>
      <nav className="ipdn-tabs" role="tablist">
        {(["vitals", "assessment", "io", "notes"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setNotice(null); }}>{t(`ipdNursing.chart.tab.${k}`)}</button>
        ))}
      </nav>
      {notice !== null ? <div className="ipdn-ok" role="status">✓ {notice}</div> : null}
      {failed ? <div className="ipdn-refusal" role="alert">{t("ipdNursing.loadFailed")}</div> : null}
      {chart === null ? (failed ? null : <div className="ipdn-empty">{t("ipdNursing.loading")}</div>) : (
        <div className="ipdn-drawerbody">
          {tab === "vitals" ? (
            <>
              {entering ? (
                <VitalsForm admissionId={p.admissionId} kind={chart.scoreKind} ageYears={ageFromAgeSex(p.ageSex)} label={p.name}
                  onCancel={() => setEntering(false)} onDone={(d) => { setEntering(false); changed(savedWords(d, t as T)); }} />
              ) : can("ipd.vitals.record") ? (
                <button type="button" className="ipdn-btn pri" onClick={() => setEntering(true)} data-testid="ipdn-add-vitals">{t("ipdNursing.chart.addVitals")}</button>
              ) : null}
              <Trend chart={chart} />
              <VitalsTable chart={chart} />
            </>
          ) : null}
          {tab === "assessment" ? <Assessment chart={chart} canRecord={can("ipd.assessment.record")} onSaved={() => changed(t("ipdNursing.assess.saved"))} /> : null}
          {tab === "io" ? <IntakeOutput chart={chart} canRecord={can("ipd.vitals.record")} onSaved={() => changed(t("ipdNursing.io.saved"))} /> : null}
          {tab === "notes" ? <Notes chart={chart} canRecord={can("ipd.vitals.record")} onSaved={() => changed(t("ipdNursing.notes.saved"))} /> : null}
        </div>
      )}
    </aside>
  );
}

/** The score over the last sets: an inline sparkline WITH the numbers on it (never a line without values). */
function Trend({ chart }: { chart: IpdNursingChart }): React.ReactElement | null {
  const { t } = useTranslation();
  const pts = chart.vitals.filter((v) => v.score !== null).slice(0, 12).reverse();
  if (pts.length === 0) return <p className="dim">{t("ipdNursing.chart.noVitals")}</p>;
  const W = 320; const H = 64; const max = Math.max(7, ...pts.map((v) => v.score!.value));
  const x = (i: number): number => (pts.length === 1 ? W / 2 : 14 + (i * (W - 28)) / (pts.length - 1));
  const y = (v: number): number => H - 12 - (v / max) * (H - 26);
  return (
    <figure className="ipdn-trend" aria-label={t("ipdNursing.chart.trend")}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        <polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts.map((v, i) => `${x(i)},${y(v.score!.value)}`).join(" ")} />
        {pts.map((v, i) => (
          <g key={v.id}>
            <circle cx={x(i)} cy={y(v.score!.value)} r="3" fill="currentColor" />
            <text x={x(i)} y={y(v.score!.value) - 6} textAnchor="middle" fontSize="11" fill="currentColor">{v.score!.value}</text>
          </g>
        ))}
      </svg>
      <figcaption className="dim">{t("ipdNursing.chart.trendCaption", { kind: t(`ipdNursing.kind.${chart.scoreKind}`), n: pts.length })}</figcaption>
    </figure>
  );
}

function VitalsTable({ chart }: { chart: IpdNursingChart }): React.ReactElement | null {
  const { t } = useTranslation();
  if (chart.vitals.length === 0) return null;
  const cell = (n: number | null): string => (n === null ? "—" : String(n));
  return (
    <div className="ipdn-tablewrap">
      <table className="ipdn-table">
        <thead><tr>
          <th>{t("ipdNursing.chart.time")}</th><th>T</th><th>P</th><th>RR</th><th>BP</th><th>SpO₂</th><th>O₂</th><th>AVPU</th><th>{t("ipdNursing.chart.score")}</th><th>{t("ipdNursing.chart.by")}</th>
        </tr></thead>
        <tbody>
          {chart.vitals.map((v) => (
            <tr key={v.id}>
              <td className="mono">{fmtIst(v.observedAt)}{v.lateEntry ? <em className="late"> {t("ipdNursing.lateEntry", { time: fmtIst(v.recordedAt) })}</em> : null}</td>
              {v.refused ? <td colSpan={7}>{t("ipdNursing.chart.refused")}</td> : (
                <>
                  <td>{cell(v.values.temperatureC)}</td><td>{cell(v.values.pulse)}</td><td>{cell(v.values.respRate)}</td>
                  <td>{v.values.systolic === null ? "—" : `${v.values.systolic}/${cell(v.values.diastolic)}`}</td>
                  <td>{cell(v.values.spo2)}</td>
                  <td>{v.values.onOxygen === null ? "—" : v.values.onOxygen ? t("ipdNursing.v.oxygen") : t("ipdNursing.v.air")}</td>
                  <td>{v.values.consciousness === null ? "—" : t(`ipdNursing.avpu.${v.values.consciousness}`)}</td>
                </>
              )}
              <td>{v.score === null ? "—" : `${v.score.value} · ${t(`ipdNursing.band.${v.score.band}`)}`}</td>
              <td><span className="ipdn-src">{v.recordedBy} · {t(`ipdNursing.source.${v.source}`)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LINE_KINDS = ["peripheral_iv", "central_line", "urinary_catheter", "ng_tube", "drain", "tracheostomy", "oxygen", "other"] as const;

function Assessment({ chart, canRecord, onSaved }: { chart: IpdNursingChart; canRecord: boolean; onSaved: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const a = chart.assessment;
  const [f, setF] = useState({ morse: "", braden: "", pain: "", nutrition: "no_risk", allergies: "", confirmed: false, obstetric: "" });
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  if (a !== null) {
    return (
      <dl className="ipdn-facts" data-testid="ipdn-assessment">
        <div><dt>{t("ipdNursing.assess.morse")}</dt><dd>{a.morse} · {t(`ipdNursing.assess.morseRisk.${a.morseRisk}`)}</dd></div>
        <div><dt>{t("ipdNursing.assess.braden")}</dt><dd>{a.braden} · {t(`ipdNursing.assess.bradenRisk.${a.bradenRisk}`)}</dd></div>
        <div><dt>{t("ipdNursing.assess.pain")}</dt><dd>{a.painScore}/10</dd></div>
        <div><dt>{t("ipdNursing.assess.nutrition")}</dt><dd>{t(`ipdNursing.assess.nutritionOpt.${a.nutrition}`)}</dd></div>
        <div><dt>{t("ipdNursing.assess.allergies")}</dt><dd>{a.allergies.length === 0 ? t("ipdNursing.assess.noAllergies") : a.allergies.join(", ")}</dd></div>
        <div><dt>{t("ipdNursing.assess.lines")}</dt><dd>{a.linesDevices.length === 0 ? "—" : a.linesDevices.map((l) => t(`ipdNursing.line.${l.kind}`)).join(", ")}</dd></div>
        <div><dt>{t("ipdNursing.assess.recorded")}</dt><dd>{a.recordedBy} · {fmtIst(a.happenedAt)}{a.lateEntry ? ` · ${t("ipdNursing.lateEntry", { time: fmtIst(a.recordedAt) })}` : ""}</dd></div>
      </dl>
    );
  }
  const num = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
  const morse = num(f.morse); const braden = num(f.braden); const pain = num(f.pain);
  const ok = morse !== null && morse >= 0 && morse <= 125 && braden !== null && braden >= 6 && braden <= 23 && pain !== null && pain >= 0 && pain <= 10 && f.confirmed;
  const save = (): void => {
    if (!ok) return;
    const input: AssessmentInput = {
      admissionId: chart.identity.admissionId, morse: morse!, braden: braden!, painScore: pain!, nutrition: f.nutrition as AssessmentInput["nutrition"],
      allergies: f.allergies.split(",").map((s) => s.trim()).filter(Boolean), linesDevices: lines.map((kind) => ({ kind })),
    };
    if (f.obstetric !== "") input.obstetric = f.obstetric as NonNullable<AssessmentInput["obstetric"]>;
    setBusy(true); setRefusal(null);
    recordAssessment(input).then(() => { setBusy(false); onSaved(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  return (
    <form className="ipdn-form" onSubmit={(e) => { e.preventDefault(); save(); }} data-testid="ipdn-assessment-form">
      {chart.assessmentDueAt !== null ? <p className="ipdn-warn">⏱ {dueWords("assessment", chart.assessmentDueAt, Date.now(), t as T)}</p> : null}
      <label>{t("ipdNursing.assess.morse")} <i>0–125</i><input inputMode="numeric" value={f.morse} onChange={(e) => setF({ ...f, morse: e.target.value })} /></label>
      <label>{t("ipdNursing.assess.braden")} <i>6–23</i><input inputMode="numeric" value={f.braden} onChange={(e) => setF({ ...f, braden: e.target.value })} /></label>
      <label>{t("ipdNursing.assess.pain")} <i>0–10</i><input inputMode="numeric" value={f.pain} onChange={(e) => setF({ ...f, pain: e.target.value })} /></label>
      <label>{t("ipdNursing.assess.nutrition")}
        <select value={f.nutrition} onChange={(e) => setF({ ...f, nutrition: e.target.value })}>
          {(["no_risk", "at_risk", "malnourished"] as const).map((n) => <option key={n} value={n}>{t(`ipdNursing.assess.nutritionOpt.${n}`)}</option>)}
        </select>
      </label>
      <label>{t("ipdNursing.assess.allergies")}<input value={f.allergies} placeholder={t("ipdNursing.assess.allergiesHint")} onChange={(e) => setF({ ...f, allergies: e.target.value })} /></label>
      <label className="ipdn-check"><input type="checkbox" checked={f.confirmed} onChange={(e) => setF({ ...f, confirmed: e.target.checked })} /> {t("ipdNursing.assess.allergiesConfirmed")}</label>
      <fieldset><legend>{t("ipdNursing.assess.lines")}</legend>
        <div className="ipdn-chiprow">
          {LINE_KINDS.map((k) => (
            <button key={k} type="button" className="ipdn-chip" aria-pressed={lines.includes(k)} onClick={() => setLines(lines.includes(k) ? lines.filter((x) => x !== k) : [...lines, k])}>
              {t(`ipdNursing.line.${k}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <label>{t("ipdNursing.assess.obstetric")}
        <select value={f.obstetric} onChange={(e) => setF({ ...f, obstetric: e.target.value })}>
          <option value="">{t("ipdNursing.assess.obstetricOpt.unanswered")}</option>
          {(["none", "pregnant", "postpartum"] as const).map((n) => <option key={n} value={n}>{t(`ipdNursing.assess.obstetricOpt.${n}`)}</option>)}
        </select>
      </label>
      <p className="dim">{t("ipdNursing.assess.pressurePhotos")}</p>
      {canRecord ? <button type="submit" className="ipdn-btn pri" disabled={!ok || busy}>{t("ipdNursing.assess.save")}</button> : null}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
    </form>
  );
}

function IntakeOutput({ chart, canRecord, onSaved }: { chart: IpdNursingChart; canRecord: boolean; onSaved: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [dir, setDir] = useState<"in" | "out">("in");
  const [kind, setKind] = useState("oral");
  const [ml, setMl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const kinds = dir === "in" ? ["oral", "iv", "ng_feed", "blood"] : ["urine", "drain", "vomit", "stool", "ng_aspirate"];
  const vol = Number(ml);
  const save = (): void => {
    setBusy(true); setRefusal(null);
    recordIntakeOutput({ admissionId: chart.identity.admissionId, direction: dir, kind, volumeMl: vol }).then(
      () => { setBusy(false); setMl(""); onSaved(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); },
    );
  };
  const io = chart.io;
  return (
    <div data-testid="ipdn-io">
      <p className="ipdn-iototal">
        {t("ipdNursing.io.totals", { inMl: io.inMl, outMl: io.outMl, balance: io.inMl - io.outMl, since: fmtIst(io.since) })}
      </p>
      {canRecord ? (
        <form className="ipdn-form row" onSubmit={(e) => { e.preventDefault(); if (vol >= 1 && vol <= 5000) save(); }}>
          <div className="ipdn-seg">
            <button type="button" aria-pressed={dir === "in"} onClick={() => { setDir("in"); setKind("oral"); }}>{t("ipdNursing.io.in")}</button>
            <button type="button" aria-pressed={dir === "out"} onClick={() => { setDir("out"); setKind("urine"); }}>{t("ipdNursing.io.out")}</button>
          </div>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t("ipdNursing.io.kind")}>
            {kinds.map((k) => <option key={k} value={k}>{t(`ipdNursing.io.k.${k}`)}</option>)}
          </select>
          <input inputMode="numeric" value={ml} onChange={(e) => setMl(e.target.value)} aria-label={t("ipdNursing.io.ml")} placeholder="ml" />
          <button type="submit" className="ipdn-btn pri" disabled={busy || !(vol >= 1 && vol <= 5000)}>{t("ipdNursing.io.add")}</button>
        </form>
      ) : null}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <ul className="ipdn-list">
        {io.entries.map((e) => (
          <li key={e.id}><span className="mono">{fmtIst(e.observedAt)}</span> {t(`ipdNursing.io.${e.direction}`)} · {t(`ipdNursing.io.k.${e.kind}`)} · <b>{e.volumeMl} ml</b> <span className="ipdn-src">{e.recordedBy} · {t(`ipdNursing.source.${e.source}`)}</span></li>
        ))}
      </ul>
    </div>
  );
}

const NOTE_CATS = ["general", "fall", "pain", "wound", "behaviour", "escalation", "refused_care"] as const;

function Notes({ chart, canRecord, onSaved }: { chart: IpdNursingChart; canRecord: boolean; onSaved: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [cat, setCat] = useState<string>("general");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const save = (): void => {
    setBusy(true); setRefusal(null);
    addNote({ admissionId: chart.identity.admissionId, category: cat, text: text.trim() }).then(
      () => { setBusy(false); setText(""); onSaved(); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); },
    );
  };
  return (
    <div data-testid="ipdn-notes">
      {canRecord ? (
        <form className="ipdn-form" onSubmit={(e) => { e.preventDefault(); if (text.trim() !== "") save(); }}>
          <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("ipdNursing.notes.category")}>
            {NOTE_CATS.map((c) => <option key={c} value={c}>{t(`ipdNursing.notes.cat.${c}`)}</option>)}
          </select>
          <textarea value={text} rows={3} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label={t("ipdNursing.notes.text")} />
          <button type="submit" className="ipdn-btn pri" disabled={busy || text.trim() === ""}>{t("ipdNursing.notes.add")}</button>
        </form>
      ) : null}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <ul className="ipdn-list">
        {chart.notes.map((n) => (
          <li key={n.id}>
            <div><span className="mono">{fmtIst(n.observedAt)}</span> · {t(`ipdNursing.notes.cat.${n.category}`)}</div>
            <p>{n.text}</p>
            <span className="ipdn-src">{n.recordedBy} · {t(`ipdNursing.source.${n.source}`)}{n.lateEntry ? ` · ${t("ipdNursing.lateEntry", { time: fmtIst(n.recordedAt) })}` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
