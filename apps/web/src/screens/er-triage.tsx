import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErBay, ErBoard, ErDoctorOption, ErEpisodeView, ErRefusalBody, ErTile } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_BOARD_TOPIC, assignDoctorApi, callCodeApi, erRefusalOf, esiProposal, fetchErBays, fetchErBoard, fetchErEpisode, fetchTriageDoctors,
  minutesSince, moveBayApi, newKey, placeInBayApi, reTriageApi, triageApi, vitalsApi,
} from "../lib/er-api";
import type { EsiDecision, EsiLevel } from "../lib/er-api";
import { EsiBadge, ageSexWords, aliasFirst, doctorClock } from "./er-board";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 2 (#809) — TRIAGE (spec SPEC-emergency §4.2, §5 B: tablet or phone at 390 px; budget ≤ 90 s).
 *
 * The ESI decision points are four big questions; the proposal they give is shown with its reason; the LEVEL is the
 * nurse's tap — five buttons, each a colour AND a word AND a number. Picking less urgent than the proposal or the last
 * level opens the reason box (the server refuses without one); an up-triage asks nothing. Vitals are taps into number
 * fields with the early-warning score the server returns shown beside the level. Then the bay (free emergency beds) and
 * the ER doctor of record. No money anywhere.
 *
 * Without `?episode=` the screen is the queue: everyone waiting for triage first, longest wait first, then the rest.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const LEVELS: readonly EsiLevel[] = [1, 2, 3, 4, 5];
/** The take-unit specialties; each is a roster department master code (pinned by er-departments.test.ts, #870). */
export const ER_TRIAGE_DEPARTMENTS = ["MED", "SUR", "ORT", "OBG", "PED", "ENT", "OPH"] as const;
const AVPU = ["alert", "confused", "voice", "pain", "unresponsive"] as const;
type VitalKey = "respRate" | "spo2" | "systolic" | "pulse" | "temperatureC";
const VITALS: readonly VitalKey[] = ["respRate", "spo2", "systolic", "pulse", "temperatureC"];

function YesNo({ label, hint, value, onPick, testid, t }: { label: string; hint: string; value: boolean | null; onPick: (v: boolean) => void; testid: string; t: T }): React.ReactElement {
  return (
    <fieldset className="erd-choice ert-q" data-testid={testid}>
      <legend>{label}</legend>
      <span className="erd-hint">{hint}</span>
      <div className="erd-opts">
        <button type="button" className={`erd-opt${value === true ? " on" : ""}`} aria-pressed={value === true} onClick={() => onPick(true)}>{t("erTriage.yes")}</button>
        <button type="button" className={`erd-opt${value === false ? " on" : ""}`} aria-pressed={value === false} onClick={() => onPick(false)}>{t("erTriage.no")}</button>
      </div>
    </fieldset>
  );
}

function Queue({ board, t }: { board: ErBoard | null; t: T }): React.ReactElement {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const now = Date.now();
  const row = (tile: ErTile): React.ReactElement => {
    const name = aliasFirst(tile.label, tile.labelHi, i18n.language);
    return (
      <button key={tile.episodeId} type="button" className="ert-row" data-testid="er-triage-queue-row"
        onClick={() => void navigate({ to: "/er/triage", search: { episode: tile.episodeId } } as never)}>
        <span className="ert-row-main"><b>{name.main}</b><span className="dim">{ageSexWords(t, tile.ageYears, tile.ageBand, tile.sex)} · {tile.episodeNo}</span></span>
        {tile.esi !== null ? <EsiBadge level={tile.esi} t={t} /> : <span className="erb-chip">{t("erTriage.notTriaged")}</span>}
        <span className="mono">{t("erBoard.since", { minutes: Math.max(0, minutesSince(tile.arrivedAt, now)) })}</span>
      </button>
    );
  };
  return (
    <section className="ert-queue" aria-label={t("erTriage.queue")}>
      <h2>{t("erBoard.col.waiting")} <span className="erb-badge">{board?.waiting.length ?? 0}</span></h2>
      {board !== null && board.waiting.length === 0 ? <div className="erb-empty">{t("erBoard.empty.waiting")}</div> : null}
      {board?.waiting.map(row)}
      <h2>{t("erBoard.col.inTreatment")} <span className="erb-badge">{board?.inTreatment.length ?? 0}</span></h2>
      {board?.inTreatment.map(row)}
    </section>
  );
}

export function ErTriage(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const search = useSearch({ strict: false }) as { episode?: string };
  const episodeId = typeof search.episode === "string" && search.episode !== "" ? search.episode : null;
  const [board, setBoard] = useState<ErBoard | null>(null);
  const [view, setView] = useState<ErEpisodeView | null>(null);
  const [bays, setBays] = useState<ErBay[]>([]);
  const [doctors, setDoctors] = useState<ErDoctorOption[]>([]);
  const [d, setD] = useState<{ lifeSaving: boolean | null; highRisk: boolean | null; resources: EsiDecision["resources"] | null; dangerVitals: boolean | null }>(
    { lifeSaving: null, highRisk: null, resources: null, dangerVitals: null },
  );
  const [level, setLevel] = useState<EsiLevel | null>(null);
  const [reason, setReason] = useState("");
  const [vitals, setVitals] = useState<Partial<Record<VitalKey, string>>>({});
  const [onO2, setOnO2] = useState(false);
  const [avpu, setAvpu] = useState<(typeof AVPU)[number] | null>(null);
  const [dept, setDept] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const actKey = useRef(newKey());

  const load = useCallback(() => {
    fetchErBoard(false).then(setBoard, () => undefined);
    if (episodeId !== null) {
      fetchErEpisode(episodeId).then(setView, () => setView(null));
      fetchErBays().then(setBays, () => setBays([]));
    }
  }, [episodeId]);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  useEffect(() => { if (episodeId !== null && doctors.length === 0) fetchTriageDoctors().then(setDoctors, () => undefined); }, [episodeId, doctors.length]);
  useEffect(() => {
    setD({ lifeSaving: null, highRisk: null, resources: null, dangerVitals: null }); setLevel(null); setReason(""); setVitals({});
    setOnO2(false); setAvpu(null); setDept(null); setRefusal(null); setNote(null); actKey.current = newKey();
  }, [episodeId]);

  if (episodeId === null) {
    return (
      <div className="erx ert" data-testid="er-triage">
        <Header t={t} />
        <div className="ert-body"><Queue board={board} t={t} /></div>
      </div>
    );
  }

  const tile = view?.tile ?? null;
  const first = tile !== null && tile.state === "arrived";
  const last = (tile?.esi ?? null) as EsiLevel | null;
  const complete = d.lifeSaving !== null && d.highRisk !== null && d.resources !== null && d.dangerVitals !== null;
  const proposal = complete ? esiProposal(d as EsiDecision) : null;
  const down = level !== null && ((proposal !== null && level > proposal.level) || (last !== null && level > last));
  const vitalsBody = (): Record<string, unknown> | undefined => {
    const v: Record<string, unknown> = {};
    for (const k of VITALS) { const n = Number(vitals[k]); if (vitals[k] !== undefined && vitals[k] !== "" && Number.isFinite(n)) v[k] = n; }
    if (onO2) v.onOxygen = true;
    if (avpu !== null) v.consciousness = avpu;
    return Object.keys(v).length === 0 ? undefined : v;
  };
  const canSave = !busy && level !== null && (!first || complete) && (!down || reason.trim() !== "");

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setRefusal(null); setNote(null);
    try { await work(); load(); } catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };
  const save = (): Promise<void> => act(async () => {
    const v = vitalsBody();
    const body: Record<string, unknown> = { episodeId, level, ...(complete ? { decision: d } : {}), ...(reason.trim() !== "" ? { reason: reason.trim() } : {}), ...(v === undefined ? {} : { vitals: v }) };
    const out = first ? await triageApi({ ...body, ...(dept !== null ? { departmentCode: dept } : {}) }, actKey.current) : await reTriageApi(body, actKey.current);
    actKey.current = newKey();
    setNote(out.retriageDueAt === null ? t("erTriage.savedNoClock", { n: out.level }) : t("erTriage.saved", { n: out.level, time: fmtIst(out.retriageDueAt) }));
    setLevel(null); setReason("");
  });
  const saveVitals = (): Promise<void> => act(async () => {
    const v = vitalsBody();
    if (v === undefined) return;
    const out = await vitalsApi({ episodeId, vitals: v });
    setNote(out.worse ? t("erTriage.vitalsWorse") : t("erTriage.vitalsSaved"));
  });
  const name = tile === null ? null : aliasFirst(tile.label, tile.labelHi, i18n.language);
  const free = bays.filter((b) => b.status === "free");
  const yes = (k: keyof typeof d) => (v: boolean): void => setD({ ...d, [k]: v });

  return (
    <div className="erx ert" data-testid="er-triage">
      <Header t={t} />
      <div className="ert-body">
        <section className="ert-main" aria-label={t("erTriage.title")}>
          {tile === null ? <div className="erb-empty">{t("erTriage.loading")}</div> : (
            <header className="ert-who" data-testid="er-triage-who">
              <div>
                <b>{name!.main}</b>{name!.other !== null ? <span className="dim"> {name!.other}</span> : null}
                <span className="dim"> · {ageSexWords(t, tile.ageYears, tile.ageBand, tile.sex)} · <span className="mono">{tile.episodeNo}</span></span>
              </div>
              <div className="erb-meta">
                <span>{t(`er.mode.${tile.arrivalMode}`)}</span>
                <span>{t("erDesk.came", { time: fmtIst(tile.arrivedAt) })}</span>
                {tile.bayCode !== null ? <span>{t("erTriage.inBay", { bay: tile.bayCode })}</span> : null}
                {tile.ews !== null ? <span className={`er-ews ews-${tile.ews.band}`}>{t(`er.ews.${tile.ews.kind}`)} {tile.ews.value} · {t(`er.ewsBand.${tile.ews.band}`)}</span> : null}
              </div>
              {view?.complaint ? <p className="erb-complaint">{view.complaint}</p> : null}
              {last !== null ? <div><EsiBadge level={last} t={t} /></div> : null}
            </header>
          )}

          {tile !== null && first ? (
            <div className="ert-qs">
              <YesNo t={t} testid="er-triage-q-a" label={t("erTriage.q.lifeSaving")} hint={t("erTriage.q.lifeSavingHint")} value={d.lifeSaving} onPick={yes("lifeSaving")} />
              <YesNo t={t} testid="er-triage-q-b" label={t("erTriage.q.highRisk")} hint={t("erTriage.q.highRiskHint")} value={d.highRisk} onPick={yes("highRisk")} />
              <fieldset className="erd-choice ert-q" data-testid="er-triage-q-c">
                <legend>{t("erTriage.q.resources")}</legend>
                <span className="erd-hint">{t("erTriage.q.resourcesHint")}</span>
                <div className="erd-opts">
                  {(["none", "one", "many"] as const).map((r) => (
                    <button key={r} type="button" className={`erd-opt${d.resources === r ? " on" : ""}`} aria-pressed={d.resources === r} onClick={() => setD({ ...d, resources: r })}>{t(`erTriage.resources.${r}`)}</button>
                  ))}
                </div>
              </fieldset>
              <YesNo t={t} testid="er-triage-q-d" label={t("erTriage.q.danger")} hint={t("erTriage.q.dangerHint")} value={d.dangerVitals} onPick={yes("dangerVitals")} />
              {proposal !== null ? (
                <div className="ert-proposal" data-testid="er-triage-proposal">
                  <span>{t("erTriage.proposal")}</span> <EsiBadge level={proposal.level} t={t} /> <span className="dim">{t(`erTriage.why.${proposal.reasonKey}`)}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {tile !== null ? (
            <fieldset className="erd-choice" data-testid="er-triage-level">
              <legend>{first ? t("erTriage.level") : t("erTriage.relevel")}</legend>
              <div className="ert-levels">
                {LEVELS.map((n) => (
                  <button key={n} type="button" className={`ert-level esi-${String(n)}${level === n ? " on" : ""}`} aria-pressed={level === n} onClick={() => setLevel(n)}>
                    <b>{n}</b><span>{t(`er.esi.word.${String(n)}`)}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          {down ? (
            <label className="erd-field ert-reason" data-testid="er-triage-reason"><span>{t("erTriage.reason")}</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("erTriage.reasonHint")} />
            </label>
          ) : null}

          {tile !== null ? (
            <fieldset className="erd-choice" data-testid="er-triage-vitals">
              <legend>{t("erTriage.vitals")}</legend>
              <div className="ert-vitals">
                {VITALS.map((k) => (
                  <label key={k} className="erd-field"><span>{t(`erTriage.v.${k}`)}</span>
                    <input inputMode="decimal" value={vitals[k] ?? ""} onChange={(e) => setVitals({ ...vitals, [k]: e.target.value.replace(/[^0-9.]/g, "") })} />
                  </label>
                ))}
                <label className="erd-check"><input type="checkbox" checked={onO2} onChange={(e) => setOnO2(e.target.checked)} />{t("erTriage.v.onOxygen")}</label>
              </div>
              <div className="erd-opts">
                {AVPU.map((a) => (
                  <button key={a} type="button" className={`erd-opt sm${avpu === a ? " on" : ""}`} aria-pressed={avpu === a} onClick={() => setAvpu(a)}>{t(`erTriage.avpu.${a}`)}</button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {tile !== null && first ? (
            <fieldset className="erd-choice" data-testid="er-triage-dept">
              <legend>{t("erTriage.dept")}</legend>
              <div className="erd-opts">
                {ER_TRIAGE_DEPARTMENTS.map((c) => (
                  <button key={c} type="button" className={`erd-opt sm${dept === c ? " on" : ""}`} aria-pressed={dept === c} onClick={() => setDept(dept === c ? null : c)}>{t(`erTriage.depts.${c}`)}</button>
                ))}
              </div>
            </fieldset>
          ) : null}

          {tile !== null ? (
            <div className="erd-row ert-actions">
              <button type="button" className="erx-btn pri big" disabled={!canSave} onClick={() => void save()} data-testid="er-triage-save">
                {first ? t("erTriage.save") : t("erTriage.saveAgain")}
              </button>
              {!first ? <button type="button" className="erx-btn" disabled={busy || vitalsBody() === undefined} onClick={() => void saveVitals()}>{t("erTriage.saveVitals")}</button> : null}
            </div>
          ) : null}
          {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
          {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
        </section>

        {tile !== null ? (
          <aside className="ert-side">
            <section aria-label={t("erTriage.bay")}>
              <h2>{t("erTriage.bay")}{tile.bayCode !== null ? <span className="erb-badge">{tile.bayCode}</span> : null}</h2>
              {free.length === 0 ? <div className="erb-empty">{t("erTriage.noBay")}</div> : (
                <div className="ert-bays" data-testid="er-triage-bays">
                  {free.map((b) => (
                    <button key={b.bedId} type="button" className="erd-opt sm" disabled={busy}
                      onClick={() => void act(async () => { const r = tile.bayCode === null ? await placeInBayApi(tile.episodeId, b.bedId) : await moveBayApi(tile.episodeId, b.bedId); setNote(t("erTriage.placed", { bay: r.bayCode })); })}>
                      {b.code}{b.zone !== null ? <span className="dim"> · {b.zone}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section aria-label={t("erTriage.doctor")}>
              <h2>{t("erTriage.doctor")}</h2>
              {tile.doctor !== null ? <p><b>{tile.doctor}</b></p> : tile.doctorDueAt !== null ? (
                <p className={`erb-clock${minutesSince(tile.doctorDueAt, Date.now()) > 0 ? " late" : ""}`}>{doctorClock(t, tile.doctorDueAt, Date.now()).text}</p>
              ) : null}
              <label className="erd-field"><span>{t("erTriage.pickDoctor")}</span>
                <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} data-testid="er-triage-doctor">
                  <option value="">{t("erDesk.dead.pickDoctor")}</option>
                  {doctors.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
                </select>
              </label>
              <button type="button" className="erx-btn" disabled={busy || doctorId === ""}
                onClick={() => void act(async () => { await assignDoctorApi(tile.episodeId, doctorId); setNote(t("erTriage.doctorSet")); })}>{t("erTriage.setDoctor")}</button>
            </section>
            {view !== null && view.history.length > 0 ? (
              <section aria-label={t("erTriage.history")}>
                <h2>{t("erTriage.history")}</h2>
                <ul className="ert-history">
                  {view.history.map((h, i) => (
                    <li key={i}>
                      <span className="mono">{fmtIst(h.at)}</span>
                      {h.level !== null ? <EsiBadge level={h.level} t={t} /> : <span>{t("erTriage.vitalsOnly")}</span>}
                      {h.ews !== null ? <span className={`er-ews ews-${h.ews.band}`}>{t(`er.ews.${h.ews.kind}`)} {h.ews.value}</span> : null}
                      {h.reason !== null ? <span className="dim">“{h.reason}”</span> : null}
                      <span className="dim">{h.by}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}


function Header({ t }: { t: T }): React.ReactElement {
  return (
    <header className="erb-head">
      <div className="erb-title"><h1>{t("erTriage.title")}</h1><span>{fmtIst(new Date().toISOString())}</span></div>
      <div className="erb-tools">
        <CodeGreyButton t={t} />
        <Link to="/er/triage" className="erx-btn">{t("erTriage.queue")}</Link>
        <Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link>
      </div>
    </header>
  );
}

/**
 * Lane 7 (#814, spec §4.2: "violent or intoxicated patient → Code Grey available from the triage screen"). Two taps: the
 * button, then "Send" — security is paged to the triage desk; the confirmation says how many were paged.
 */
function CodeGreyButton({ t }: { t: T }): React.ReactElement | null {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (!can("er.codes")) return null;
  const status = said !== null ? <span role="status">{said}</span> : null;
  if (!open) {
    return (
      <>
        <button type="button" className="erx-btn erc-grey" data-testid="er-triage-code-grey" onClick={() => { setOpen(true); setSaid(null); }}>{t("erCodes.kind.code_grey")}</button>
        {status}
      </>
    );
  }
  return (
    <span className="erd-row" role="group">
      <button type="button" className="erx-btn danger" data-testid="er-triage-code-grey-send"
        onClick={() => void callCodeApi({ kind: "code_grey", place: t("erCodes.triageDesk") }).then((r) => { setSaid(t("erCodes.paged", { n: r.paged })); setOpen(false); }, () => setSaid(t("erDesk.failed")))}>
        {t("erCodes.sendGrey")}</button>
      <button type="button" className="erx-btn" onClick={() => setOpen(false)}>{t("erCodes.cancel")}</button>
      {status}
    </span>
  );
}

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return (
    <div className="erd-refusal" role="alert" data-testid="er-triage-refusal">
      <b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b>
      <span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span>
    </div>
  );
}

