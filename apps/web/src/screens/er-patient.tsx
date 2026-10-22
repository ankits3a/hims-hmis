import { useCallback, useEffect, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErCareView, ErDoctorOption, ErEpisodeView, ErItemOption, ErRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst, useDebounced } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import { searchOrderableTests } from "../lib/ordering-api";
import type { WireOrderableTest } from "../lib/ordering-api";
import {
  ER_BOARD_TOPIC, ER_CODE_KINDS, ER_INJURY_KINDS, ER_MED_ROUTES, ER_MLC_CATEGORIES, ER_REFERRAL_REASONS, ER_RETURN_IF_SIGNS, abscondApi, answerCallApi, callCodeApi, deathApi,
  dischargeApi, handToUnitApi, lamaApi, lwbsApi, newKey, referApi, callApi, consentApi, cosignApi, doseApi, returnMedApi, erRefusalOf, fetchErCare, fetchErEpisode,
  fetchErItems, fetchTriageDoctors, issueApi, noteApi, openMlcApi, orderApi, procedureApi, signVerbalApi, stabilisedApi,
} from "../lib/er-api";
import { EsiBadge, ageSexWords, aliasFirst } from "./er-board";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 3 (#810) — THE ER PATIENT (spec SPEC-emergency §5 D: phone or tablet; "one bar for order · call specialty ·
 * stabilised · disposition"). One patient's care in one place: open critical results first (in words, in red), then the
 * medication record (give / hold / refuse; a high-alert dose asks a second person's username and PIN), tests through
 * the ordering door at STAT, notes (a resident's note shows "Draft" until a senior co-signs), procedures, consent,
 * specialty calls with their clocks, and "Stabilised" — a clinical word only.
 *
 * Lane 4 (#811): "MLC" opens the medico-legal case (a doctor; the MLC desk carries the rest). It never gates care.
 *
 * NO MONEY ANYWHERE (decision 0058): no price on a test, no rate on a drug, no paid word. Disposition is lane 5's.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
type Panel = null | "order" | "med" | "note" | "procedure" | "consent" | "call" | "mlc" | "dispo" | "code";
/** The specialties a call can go to; each is a roster department master code (pinned by er-departments.test.ts, #870). */
export const ER_CALL_DEPARTMENTS = ["MED", "SUR", "ORT", "OBG", "PED", "CAR", "ANAE"] as const;

function Refusal({ r, t }: { r: ErRefusalBody | string; t: T }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  return (
    <div className="erd-refusal" role="alert" data-testid="er-patient-refusal">
      <b>{t(`er.refusal.${r.code}.rule`, { defaultValue: r.rule })}</b>
      <span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span>
    </div>
  );
}

export function ErPatient(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { can, actor } = useAuth();
  const search = useSearch({ strict: false }) as { episode?: string };
  const episodeId = typeof search.episode === "string" && search.episode !== "" ? search.episode : null;
  const [view, setView] = useState<ErEpisodeView | null>(null);
  const [care, setCare] = useState<ErCareView | null>(null);
  const [doctors, setDoctors] = useState<ErDoctorOption[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    if (episodeId === null) return;
    fetchErEpisode(episodeId).then(setView, () => setView(null));
    fetchErCare(episodeId).then(setCare, () => setCare(null));
  }, [episodeId]);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  useEffect(() => { if (doctors.length === 0) fetchTriageDoctors().then(setDoctors, () => undefined); }, [doctors.length]);

  const act = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true); setRefusal(null); setNote(null);
    try { const said = await work(); if (said !== null) setNote(said); setPanel(null); load(); }
    catch (e) { setRefusal(erRefusalOf(e) ?? t("erDesk.failed")); } finally { setBusy(false); }
  };

  if (episodeId === null) {
    return (
      <div className="erx ert" data-testid="er-patient">
        <header className="erb-head"><div className="erb-title"><h1>{t("erPatient.title")}</h1></div>
          <div className="erb-tools"><Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link></div></header>
        <div className="erb-empty">{t("erPatient.pick")}</div>
      </div>
    );
  }
  const tile = view?.tile ?? null;
  const name = tile === null ? null : aliasFirst(tile.label, tile.labelHi, i18n.language);
  const me = actor?.id ?? null;

  return (
    <div className="erx ert erp" data-testid="er-patient">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erPatient.title")}</h1><span>{fmtIst(new Date().toISOString())}</span></div>
        <div className="erb-tools">
          <Link to="/er/triage" search={{ episode: episodeId } as never} className="erx-btn">{t("erTriage.title")}</Link>
          <Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link>
        </div>
      </header>
      <div className="erp-body">
        {tile !== null ? (
          <section className="ert-who" data-testid="er-patient-who">
            <div>
              <b>{name!.main}</b>{name!.other !== null ? <span className="dim"> {name!.other}</span> : null}
              <span className="dim"> · {ageSexWords(t, tile.ageYears, tile.ageBand, tile.sex)} · <span className="mono">{tile.episodeNo}</span></span>
            </div>
            <div className="erb-esi-row">
              <EsiBadge level={tile.esi} t={t} />
              {tile.bayCode !== null ? <span className="erb-bay mono">{tile.bayCode}</span> : null}
              {tile.doctor !== null ? <span>{t("erBoard.doctor", { name: tile.doctor })}</span> : null}
              {care?.stabilisedAt ? <span className="erb-chip stabilised" data-testid="er-patient-stabilised">{t("erPatient.stabilisedAt", { time: fmtIst(care.stabilisedAt) })}</span> : null}
            </div>
            {care !== null ? <div className="erp-allergy" data-testid="er-patient-allergy">{care.allergyWords.join(" · ")}</div> : null}
          </section>
        ) : <div className="erb-empty">{t("erTriage.loading")}</div>}

        {care !== null && care.criticals.length > 0 ? (
          <section className="erp-critical" role="alert" data-testid="er-patient-critical">
            <b>{t("erPatient.critical")}</b>
            {care.criticals.map((c) => <span key={c.callId}>{c.analyte} {c.value}{c.unit === null ? "" : ` ${c.unit}`} · {fmtIst(c.openedAt)}</span>)}
            <span className="dim">{t("erPatient.criticalHint")}</span>
          </section>
        ) : null}

        {/* The one bar (spec §5 D): order · call specialty · stabilised; plus the medicine, note, procedure and consent forms. */}
        <nav className="erp-bar" aria-label={t("erPatient.actions")}>
          {(["order", "med", "note", "call", "procedure", "consent"] as const).map((p) => (
            <button key={p} type="button" className={`erd-opt${panel === p ? " on" : ""}`} aria-pressed={panel === p} onClick={() => setPanel(panel === p ? null : p)}
              data-testid={`er-patient-bar-${p}`}>{t(`erPatient.bar.${p}`)}</button>
          ))}
          {can("er.codes") ? (
            <button type="button" className={`erd-opt erc-bar${panel === "code" ? " on" : ""}`} aria-pressed={panel === "code"} onClick={() => setPanel(panel === "code" ? null : "code")}
              data-testid="er-patient-bar-code">{t("erPatient.bar.code")}</button>
          ) : null}
          {can("er.disposition") ? (
            <button type="button" className={`erd-opt${panel === "dispo" ? " on" : ""}`} aria-pressed={panel === "dispo"} onClick={() => setPanel(panel === "dispo" ? null : "dispo")}
              data-testid="er-patient-bar-dispo">{t("erPatient.bar.dispo")}</button>
          ) : null}
          {can("er.mlc") ? (
            <button type="button" className={`erd-opt${panel === "mlc" ? " on" : ""}`} aria-pressed={panel === "mlc"} onClick={() => setPanel(panel === "mlc" ? null : "mlc")}
              data-testid="er-patient-bar-mlc">{t("erPatient.bar.mlc")}</button>
          ) : null}
          {care !== null && care.stabilisedAt === null && can("er.care") ? (
            <button type="button" className="erx-btn pri" disabled={busy} data-testid="er-patient-stabilise"
              onClick={() => void act(async () => { await stabilisedApi(episodeId); return t("erPatient.stabilisedDone"); })}>{t("erPatient.bar.stabilised")}</button>
          ) : null}
        </nav>
        {refusal !== null ? <Refusal r={refusal} t={t} /> : null}
        {note !== null ? <div className="erd-note" role="status">{note}</div> : null}

        {panel === "order" ? <OrderPanel t={t} busy={busy} onOrder={(serviceIds, indication) => act(async () => {
          const r = await orderApi({ episodeId, serviceIds, indication });
          const dup = r.duplicates.length > 0 ? ` · ${t("erPatient.order.duplicates", { n: r.duplicates.length })}` : "";
          const skipped = r.skipped.length > 0 ? ` · ${r.skipped.map((x) => x.message).join("; ")}` : "";
          return `${t("erPatient.order.sent")}${dup}${skipped}`;
        })} /> : null}
        {panel === "med" ? <MedPanel t={t} busy={busy} doctors={doctors} onIssue={(body) => act(async () => {
          const r = await issueApi({ episodeId, ...body });
          return `${t("erPatient.med.issued")} · ${r.labelLines.join(" | ")}`;
        })} /> : null}
        {panel === "note" ? <NotePanel t={t} busy={busy} onSave={(kind, text) => act(async () => {
          const r = await noteApi({ episodeId, kind, text });
          return r.status === "draft" ? t("erPatient.note.draftSaved") : t("erPatient.note.saved");
        })} /> : null}
        {panel === "procedure" ? <ProcedurePanel t={t} busy={busy} doctors={doctors} onSave={(nm, by) => act(async () => {
          await procedureApi({ episodeId, name: nm, performedBy: by }); return t("erPatient.procedure.saved");
        })} /> : null}
        {panel === "consent" ? <ConsentPanel t={t} busy={busy} onSave={(body) => act(async () => {
          await consentApi({ episodeId, ...body }); return t("erPatient.consent.saved");
        })} /> : null}
        {panel === "call" ? <CallPanel t={t} busy={busy} onCall={(departmentCode, urgency, reason) => act(async () => {
          const r = await callApi({ episodeId, departmentCode, urgency, reason });
          return t("erPatient.call.sent", { who: r.callees.map((c) => c.name).join(", ") || t("erPatient.call.noRoster") });
        })} /> : null}

        {panel === "dispo" && tile !== null ? <DispoPanel t={t} busy={busy} doctors={doctors} state={tile.state} act={(work) => act(async () => {
          const said = await work(episodeId);
          return said;
        })} /> : null}
        {panel === "code" ? (
          <section className="erp-panel" data-testid="er-patient-codeform">
            <div className="erd-opts">{ER_CODE_KINDS.map((k) => (
              <button key={k} type="button" className={`erd-opt${k === "code_blue" ? " erc-blue" : k === "code_grey" ? " erc-grey" : ""}`} disabled={busy} data-testid={`er-patient-code-${k}`}
                onClick={() => void act(async () => { const r = await callCodeApi({ kind: k, episodeId }); return t("erCodes.calledFor", { what: t(`erCodes.kind.${k}`), n: r.paged }); })}>
                {t(`erCodes.kind.${k}`)}</button>
            ))}</div>
            <Link to="/er/codes" className="erx-btn sm">{t("erCodes.openScribe")}</Link>
          </section>
        ) : null}
        {panel === "mlc" ? <MlcPanel t={t} busy={busy} onOpen={(body) => act(async () => {
          const r = await openMlcApi({ episodeId, ...body });
          return t(r.late ? "erPatient.mlc.openedLate" : "erPatient.mlc.opened", { no: r.mlcNo });
        })} /> : null}

        {care !== null ? (
          <div className="erp-cols">
            <section aria-label={t("erPatient.meds")} data-testid="er-patient-meds">
              <h2>{t("erPatient.meds")}</h2>
              {care.meds.length === 0 ? <div className="erb-empty">{t("erPatient.none")}</div> : care.meds.map((m) => (
                <MedRow key={m.issueId} m={m} t={t} me={me} busy={busy} act={act} />
              ))}
            </section>
            <section aria-label={t("erPatient.calls")}>
              <h2>{t("erPatient.calls")}</h2>
              {care.calls.length === 0 ? <div className="erb-empty">{t("erPatient.none")}</div> : care.calls.map((c) => {
                const waited = Math.max(0, Math.floor((Date.now() - new Date(c.calledAt).getTime()) / 60_000));
                return (
                  <article key={c.callId} className="erd-ep" data-testid="er-patient-call">
                    <div className="erd-ep-top"><b>{t(`erTriage.depts.${c.departmentCode}`, { defaultValue: c.departmentCode })} · {t(`erPatient.call.urgency.${c.urgency}`)}</b>
                      <span className={`erb-clock${c.answeredAt === null && waited >= 15 ? " late" : ""}`}>
                        {c.seenAt !== null ? t("erPatient.call.seenAt", { time: fmtIst(c.seenAt) })
                          : c.answeredAt !== null ? t("erPatient.call.answeredAt", { time: fmtIst(c.answeredAt) })
                            : t("erPatient.call.waiting", { minutes: waited })}
                      </span></div>
                    <div className="erb-meta"><span>{c.reason}</span>{c.callees.length > 0 ? <span>{c.callees.join(", ")}</span> : null}</div>
                    {c.seenAt === null ? (
                      <div className="erd-row">
                        {c.answeredAt === null ? <button type="button" className="erx-btn sm" disabled={busy} onClick={() => void act(async () => { await answerCallApi(c.callId, "answered"); return null; })}>{t("erPatient.call.answered")}</button> : null}
                        <button type="button" className="erx-btn sm" disabled={busy} onClick={() => void act(async () => { await answerCallApi(c.callId, "seen"); return null; })}>{t("erPatient.call.seen")}</button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </section>
            <section aria-label={t("erPatient.orders")}>
              <h2>{t("erPatient.orders")}</h2>
              {care.orders.length === 0 ? <div className="erb-empty">{t("erPatient.none")}</div> : care.orders.map((o) => (
                <article key={o.orderId} className="erd-ep"><div className="erd-ep-top"><b>{o.tests.join(", ")}</b>
                  <span className="erd-state">{(o.priority ?? "").toUpperCase()} · {fmtIst(o.at)}</span></div></article>
              ))}
            </section>
            <section aria-label={t("erPatient.notes")} data-testid="er-patient-notes">
              <h2>{t("erPatient.notes")}</h2>
              {care.notes.length === 0 ? <div className="erb-empty">{t("erPatient.none")}</div> : care.notes.map((n) => (
                <article key={n.noteId} className="erd-ep">
                  <div className="erd-ep-top"><b>{t(`erPatient.note.kind.${n.kind}`, { defaultValue: n.kind })}</b>
                    <span className="erd-state">{n.status === "draft" ? <span className="erb-chip name_alert">{t("erPatient.note.draft")}</span> : null} {n.author} · {fmtIst(n.at)}</span></div>
                  <p className="erp-text">{n.text}</p>
                  {n.status === "draft" && can("er.care") ? <button type="button" className="erx-btn sm" disabled={busy}
                    onClick={() => void act(async () => { await cosignApi(n.noteId); return t("erPatient.note.cosigned"); })}>{t("erPatient.note.cosign")}</button> : null}
                </article>
              ))}
            </section>
            <section aria-label={t("erPatient.procedures")}>
              <h2>{t("erPatient.procedures")}</h2>
              {[...care.procedures.map((p) => ({ k: p.procedureId, a: p.name, b: `${p.by} · ${fmtIst(p.at)}` })),
                ...care.consents.map((c) => ({ k: c.consentId, a: `${t("erPatient.consent.word")} · ${c.about}`, b: `${t(`erPatient.consent.signer.${c.signedBy}`)} · ${fmtIst(c.at)}` }))]
                .map((r) => <article key={r.k} className="erd-ep"><div className="erd-ep-top"><b>{r.a}</b><span className="erd-state">{r.b}</span></div></article>)}
              {care.procedures.length + care.consents.length === 0 ? <div className="erb-empty">{t("erPatient.none")}</div> : null}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Act = (work: () => Promise<string | null>) => Promise<void>;

function MedRow({ m, t, me, busy, act }: { m: ErCareView["meds"][number]; t: T; me: string | null; busy: boolean; act: Act }): React.ReactElement {
  const [user, setUser] = useState("");
  const [pin, setPin] = useState("");
  const [why, setWhy] = useState("");
  const second = m.highAlert ? { secondCheck: { username: user.trim(), pin } } : {};
  return (
    <article className={`erd-ep${m.highAlert ? " erp-high" : ""}`} data-testid="er-patient-med">
      <div className="erd-ep-top"><b>{m.name}</b>
        <span className="erd-state">{m.doseWords} · {m.route.toUpperCase()} · {fmtIst(m.at)}</span></div>
      <div className="erb-chips">
        {m.highAlert ? <span className="erb-chip critical">{t("erPatient.med.highAlert")}</span> : null}
        {m.own ? <span className="erb-chip">{t("erPatient.med.own")}</span> : null}
        {m.verbalPending ? <span className="erb-chip name_alert">{t("erPatient.med.verbalPending")}</span> : null}
        <span className="dim">{t("erPatient.med.orderedBy", { name: m.orderedBy })}</span>
      </div>
      {m.returned !== null ? <span className="erb-chip">{t(`erPatient.med.${m.returned}`)}</span> : null}
      {m.dose !== null ? (
        <>
          <p className="erp-text"><b>{t(`erPatient.med.outcome.${m.dose.outcome}`)}</b> · {m.dose.by} · {fmtIst(m.dose.at)}{m.dose.reason !== null ? ` · ${m.dose.reason}` : ""}</p>
          {m.dose.outcome !== "given" && !m.own && m.returned === null ? (
            // ER review 2: a held or refused dose prompts the return (unopened → stock; opened → wastage).
            <div className="erp-give" data-testid="er-patient-return">
              <b>{t("erPatient.med.returnPrompt")}</b>
              {m.highAlert ? (
                <div className="erd-pair">
                  <label className="erd-field"><span>{t("erPatient.med.secondUser")}</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
                  <label className="erd-field"><span>{t("erPatient.med.secondPin")}</span><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete="off" /></label>
                </div>
              ) : null}
              {m.highAlert ? <p className="erd-hint">{t("erPatient.med.witnessHint")}</p> : null}
              <div className="erd-row">
                <button type="button" className="erx-btn sm" disabled={busy}
                  onClick={() => void act(async () => { await returnMedApi({ issueId: m.issueId, condition: "unopened", reason: m.dose!.reason ?? t(`erPatient.med.outcome.${m.dose!.outcome}`) }); return t("erPatient.med.returned"); })}>{t("erPatient.med.returnUnopened")}</button>
                <button type="button" className="erx-btn sm" disabled={busy || (m.highAlert && (user.trim() === "" || pin.length < 4))}
                  onClick={() => void act(async () => { await returnMedApi({ issueId: m.issueId, condition: "opened", reason: m.dose!.reason ?? t(`erPatient.med.outcome.${m.dose!.outcome}`), ...(m.highAlert ? { witness: { username: user.trim(), pin } } : {}) }); return t("erPatient.med.wasted"); })}>{t("erPatient.med.returnOpened")}</button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="erp-give">
          {m.highAlert ? (
            <div className="erd-pair">
              <label className="erd-field"><span>{t("erPatient.med.secondUser")}</span><input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" /></label>
              <label className="erd-field"><span>{t("erPatient.med.secondPin")}</span><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete="off" /></label>
            </div>
          ) : null}
          <label className="erd-field"><span>{t("erPatient.med.whyNot")}</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <div className="erd-row">
            <button type="button" className="erx-btn sm pri" disabled={busy || (m.highAlert && (user.trim() === "" || pin.length < 4))} data-testid="er-patient-give"
              onClick={() => void act(async () => { await doseApi({ issueId: m.issueId, outcome: "given", ...second }); return t("erPatient.med.given"); })}>{t("erPatient.med.give")}</button>
            <button type="button" className="erx-btn sm" disabled={busy || why.trim() === ""} onClick={() => void act(async () => { await doseApi({ issueId: m.issueId, outcome: "held", reason: why.trim() }); return null; })}>{t("erPatient.med.hold")}</button>
            <button type="button" className="erx-btn sm" disabled={busy || why.trim() === ""} onClick={() => void act(async () => { await doseApi({ issueId: m.issueId, outcome: "refused", reason: why.trim() }); return null; })}>{t("erPatient.med.refused")}</button>
          </div>
        </div>
      )}
      {m.verbalPending && me !== null ? (
        <button type="button" className="erx-btn sm" disabled={busy} onClick={() => void act(async () => { await signVerbalApi(m.issueId); return t("erPatient.med.signed"); })}>{t("erPatient.med.signVerbal")}</button>
      ) : null}
    </article>
  );
}

function OrderPanel({ t, busy, onOrder }: { t: T; busy: boolean; onOrder: (serviceIds: string[], indication: string) => Promise<void> }): React.ReactElement {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [hits, setHits] = useState<WireOrderableTest[]>([]);
  const [picked, setPicked] = useState<WireOrderableTest[]>([]);
  const [why, setWhy] = useState("");
  useEffect(() => { if (dq.trim().length < 2) { setHits([]); return; } searchOrderableTests(dq).then(setHits, () => setHits([])); }, [dq]);
  return (
    <section className="erp-panel" data-testid="er-patient-order">
      <label className="erd-field"><span>{t("erPatient.order.find")}</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("erPatient.order.findHint")} /></label>
      <ul className="erd-hits">{hits.filter((h) => h.department === "lab" || h.department === "imaging").slice(0, 8).map((h) => (
        <li key={h.serviceId}><button type="button" onClick={() => { if (!picked.some((p) => p.serviceId === h.serviceId)) setPicked([...picked, h]); setQ(""); }}>
          <b>{h.name}</b><span className="dim">{h.code}</span></button></li>
      ))}</ul>
      {picked.length > 0 ? <div className="erb-chips">{picked.map((p) => <button key={p.serviceId} type="button" className="erb-chip" onClick={() => setPicked(picked.filter((x) => x.serviceId !== p.serviceId))}>{p.name} ✕</button>)}</div> : null}
      <label className="erd-field"><span>{t("erPatient.order.why")}</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
      <button type="button" className="erx-btn pri big" disabled={busy || picked.length === 0 || why.trim() === ""}
        onClick={() => void onOrder(picked.map((p) => p.serviceId), why.trim())}>{t("erPatient.order.send")}</button>
    </section>
  );
}

function MedPanel({ t, busy, doctors, onIssue }: { t: T; busy: boolean; doctors: ErDoctorOption[]; onIssue: (body: Record<string, unknown>) => Promise<void> }): React.ReactElement {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [items, setItems] = useState<ErItemOption[]>([]);
  const [item, setItem] = useState<ErItemOption | null>(null);
  const [own, setOwn] = useState("");
  const [dose, setDose] = useState("");
  const [route, setRoute] = useState<(typeof ER_MED_ROUTES)[number]>("iv");
  const [units, setUnits] = useState(1);
  const [by, setBy] = useState("");
  const [verbal, setVerbal] = useState(false);
  const [override, setOverride] = useState("");
  useEffect(() => { fetchErItems(dq).then(setItems, () => setItems([])); }, [dq]);
  const ready = (item !== null || own.trim() !== "") && dose.trim() !== "" && by !== "";
  return (
    <section className="erp-panel" data-testid="er-patient-medform">
      <label className="erd-field"><span>{t("erPatient.med.find")}</span><input value={q} onChange={(e) => { setQ(e.target.value); setItem(null); }} placeholder={t("erPatient.med.findHint")} /></label>
      {item === null ? (
        <div className="erd-opts">{items.slice(0, 8).map((i) => (
          <button key={i.itemId} type="button" className="erd-opt sm" onClick={() => { setItem(i); setOwn(""); }}>{i.name}{i.highAlert ? ` · ${t("erPatient.med.highAlert")}` : ""}</button>
        ))}</div>
      ) : <div className="erd-picked"><b>{item.name}</b>{item.highAlert ? <span className="erb-chip critical">{t("erPatient.med.highAlert")}</span> : null}</div>}
      <label className="erd-field"><span>{t("erPatient.med.ownLabel")}</span><input value={own} onChange={(e) => { setOwn(e.target.value); if (e.target.value !== "") setItem(null); }} /></label>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erPatient.med.dose")}</span><input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="1 g" /></label>
        <label className="erd-field"><span>{t("erPatient.med.units")}</span><input inputMode="numeric" value={String(units)} onChange={(e) => setUnits(Math.max(1, Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 1)))} /></label>
      </div>
      <div className="erd-opts">{ER_MED_ROUTES.map((r) => (
        <button key={r} type="button" className={`erd-opt sm${route === r ? " on" : ""}`} aria-pressed={route === r} onClick={() => setRoute(r)}>{r.toUpperCase()}</button>
      ))}</div>
      <label className="erd-field"><span>{t("erPatient.med.orderedBy", { name: "" })}</span>
        <select value={by} onChange={(e) => setBy(e.target.value)}><option value="">{t("erDesk.dead.pickDoctor")}</option>{doctors.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}</select>
      </label>
      <label className="erd-check"><input type="checkbox" checked={verbal} onChange={(e) => setVerbal(e.target.checked)} />{t("erPatient.med.verbal")}</label>
      <label className="erd-field"><span>{t("erPatient.med.override")}</span><input value={override} onChange={(e) => setOverride(e.target.value)} placeholder={t("erPatient.med.overrideHint")} /></label>
      <button type="button" className="erx-btn pri big" disabled={busy || !ready} data-testid="er-patient-issue"
        onClick={() => void onIssue({
          ...(item !== null ? { itemId: item.itemId } : { ownMedicine: own.trim() }), doseWords: dose.trim(), route, units, orderedBy: by,
          ...(verbal ? { verbal: { readBack: true } } : {}), ...(override.trim() !== "" ? { allergyOverride: override.trim() } : {}),
        })}>{t("erPatient.med.issue")}</button>
    </section>
  );
}

function NotePanel({ t, busy, onSave }: { t: T; busy: boolean; onSave: (kind: string, text: string) => Promise<void> }): React.ReactElement {
  const [kind, setKind] = useState("assessment");
  const [text, setText] = useState("");
  return (
    <section className="erp-panel">
      <div className="erd-opts">{["assessment", "progress", "nursing", "procedure", "handover"].map((k) => (
        <button key={k} type="button" className={`erd-opt sm${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`erPatient.note.kind.${k}`)}</button>
      ))}</div>
      <label className="erd-field"><span>{t("erPatient.note.text")}</span><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button type="button" className="erx-btn pri big" disabled={busy || text.trim() === ""} onClick={() => void onSave(kind, text.trim())}>{t("erPatient.note.save")}</button>
    </section>
  );
}

function ProcedurePanel({ t, busy, doctors, onSave }: { t: T; busy: boolean; doctors: ErDoctorOption[]; onSave: (name: string, by: string) => Promise<void> }): React.ReactElement {
  const [nm, setNm] = useState("");
  const [by, setBy] = useState("");
  return (
    <section className="erp-panel">
      <label className="erd-field"><span>{t("erPatient.procedure.name")}</span><input value={nm} onChange={(e) => setNm(e.target.value)} placeholder={t("erPatient.procedure.hint")} /></label>
      <label className="erd-field"><span>{t("erPatient.procedure.by")}</span>
        <select value={by} onChange={(e) => setBy(e.target.value)}><option value="">{t("erDesk.dead.pickDoctor")}</option>{doctors.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}</select></label>
      <button type="button" className="erx-btn pri big" disabled={busy || nm.trim() === "" || by === ""} onClick={() => void onSave(nm.trim(), by)}>{t("erPatient.procedure.save")}</button>
    </section>
  );
}

function ConsentPanel({ t, busy, onSave }: { t: T; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }): React.ReactElement {
  const [kind, setKind] = useState("procedure");
  const [about, setAbout] = useState("");
  const [signedBy, setSignedBy] = useState<"patient" | "guardian" | "representative" | "emergency">("patient");
  const [signer, setSigner] = useState("");
  const [relation, setRelation] = useState("");
  const [witness, setWitness] = useState("");
  const [secondUser, setSecondUser] = useState("");
  const [secondPin, setSecondPin] = useState("");
  return (
    <section className="erp-panel">
      <div className="erd-opts">{["general", "procedure", "blood", "high_risk", "refusal_of_treatment"].map((k) => (
        <button key={k} type="button" className={`erd-opt sm${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`erPatient.consent.kind.${k}`)}</button>
      ))}</div>
      <label className="erd-field"><span>{t("erPatient.consent.about")}</span><input value={about} onChange={(e) => setAbout(e.target.value)} /></label>
      <div className="erd-opts">{(["patient", "guardian", "representative", "emergency"] as const).map((s) => (
        <button key={s} type="button" className={`erd-opt sm${signedBy === s ? " on" : ""}`} aria-pressed={signedBy === s} onClick={() => setSignedBy(s)}>{t(`erPatient.consent.signer.${s}`)}</button>
      ))}</div>
      {signedBy === "guardian" || signedBy === "representative" ? (
        <div className="erd-pair">
          <label className="erd-field"><span>{t("erPatient.consent.signerName")}</span><input value={signer} onChange={(e) => setSigner(e.target.value)} /></label>
          <label className="erd-field"><span>{t("erPatient.consent.relation")}</span><input value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
        </div>
      ) : null}
      {signedBy === "emergency" ? (
        // ER review 2: the second doctor confirms with their own username and PIN.
        <div className="erd-pair">
          <label className="erd-field"><span>{t("erPatient.consent.secondDoctor")}</span><input value={secondUser} onChange={(e) => setSecondUser(e.target.value)} autoComplete="off" placeholder={t("erPatient.med.secondUser")} /></label>
          <label className="erd-field"><span>{t("erPatient.med.secondPin")}</span><input value={secondPin} onChange={(e) => setSecondPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric" autoComplete="off" /></label>
        </div>
      ) : (
        <label className="erd-field"><span>{t("erPatient.consent.witness")}</span><input value={witness} onChange={(e) => setWitness(e.target.value)} /></label>
      )}
      <button type="button" className="erx-btn pri big" disabled={busy || about.trim() === ""}
        onClick={() => void onSave({
          kind, about: about.trim(), signedBy, method: "paper",
          ...(signer.trim() !== "" ? { signerName: signer.trim() } : {}), ...(relation.trim() !== "" ? { relation: relation.trim() } : {}),
          ...(witness.trim() !== "" && signedBy !== "emergency" ? { witnessName: witness.trim() } : {}),
          ...(signedBy === "emergency" ? { secondDoctor: { username: secondUser.trim(), pin: secondPin } } : {}),
        })}>{t("erPatient.consent.save")}</button>
      <p className="erd-hint">{t("erPatient.consent.hint")}</p>
    </section>
  );
}

function CallPanel({ t, busy, onCall }: { t: T; busy: boolean; onCall: (dept: string, urgency: string, reason: string) => Promise<void> }): React.ReactElement {
  const [dept, setDept] = useState<string | null>(null);
  const [urgency, setUrgency] = useState("urgent");
  const [reason, setReason] = useState("");
  return (
    <section className="erp-panel" data-testid="er-patient-callform">
      <div className="erd-opts">{ER_CALL_DEPARTMENTS.map((d) => (
        <button key={d} type="button" className={`erd-opt sm${dept === d ? " on" : ""}`} aria-pressed={dept === d} onClick={() => setDept(d)}>{t(`erTriage.depts.${d}`, { defaultValue: d })}</button>
      ))}</div>
      <div className="erd-opts">{["immediate", "urgent", "routine"].map((u) => (
        <button key={u} type="button" className={`erd-opt sm${urgency === u ? " on" : ""}`} aria-pressed={urgency === u} onClick={() => setUrgency(u)}>{t(`erPatient.call.urgency.${u}`)}</button>
      ))}</div>
      <label className="erd-field"><span>{t("erPatient.call.reason")}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button type="button" className="erx-btn pri big" disabled={busy || dept === null || reason.trim() === ""} onClick={() => void onCall(dept!, urgency, reason.trim())}>{t("erPatient.call.send")}</button>
    </section>
  );
}

/** Lane 4 (#811) — open the MLC: the category, the informant in their own words, the injuries seen (one line at a time). */
function MlcPanel({ t, busy, onOpen }: { t: T; busy: boolean; onOpen: (body: Record<string, unknown>) => Promise<void> }): React.ReactElement {
  const [category, setCategory] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [words, setWords] = useState("");
  const [site, setSite] = useState("");
  const [kind, setKind] = useState<string>("contusion");
  const [injuries, setInjuries] = useState<{ site: string; kind: string }[]>([]);
  const informant = name.trim() !== "" && relation.trim() !== "" && words.trim() !== ""
    ? { informant: { name: name.trim(), relation: relation.trim(), words: words.trim() } } : {};
  const all = site.trim() === "" ? injuries : [...injuries, { site: site.trim(), kind }];
  return (
    <section className="erp-panel" data-testid="er-patient-mlcform">
      <div className="erd-opts">{ER_MLC_CATEGORIES.filter((c) => c !== "brought_dead").map((c) => (
        <button key={c} type="button" className={`erd-opt sm${category === c ? " on" : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{t(`erMlc.category.${c}`)}</button>
      ))}</div>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erMlc.informant")}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="erd-field"><span>{t("erMlc.relation")}</span><input value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
      </div>
      <label className="erd-field"><span>{t("erMlc.words")}</span><textarea rows={2} value={words} onChange={(e) => setWords(e.target.value)} /></label>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erMlc.injurySite")}</span><input value={site} onChange={(e) => setSite(e.target.value)} /></label>
        <label className="erd-field"><span>{t("erMlc.injuryKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{ER_INJURY_KINDS.map((k) => <option key={k} value={k}>{t(`erMlc.injury.${k}`)}</option>)}</select></label>
      </div>
      {injuries.length > 0 ? <div className="erb-chips">{injuries.map((i, n) => <span key={n} className="erb-chip">{i.site} · {t(`erMlc.injury.${i.kind}`)}</span>)}</div> : null}
      <div className="erd-row">
        <button type="button" className="erx-btn sm" disabled={site.trim() === ""} onClick={() => { setInjuries(all); setSite(""); }}>{t("erMlc.addInjury")}</button>
        <button type="button" className="erx-btn pri big" disabled={busy || category === null} data-testid="er-patient-mlc-open"
          onClick={() => void onOpen({ category, ...informant, ...(all.length > 0 ? { injuries: all } : {}) })}>{t("erPatient.mlc.open")}</button>
      </div>
    </section>
  );
}

/**
 * Lane 5 (#812) — the way out (spec §4.5): discharge with the summary, admit (hand to a unit; the patient boards until the
 * bed), refer out, LAMA, death, and "left" (without being seen / absconded). The reason is asked when no disposition is
 * decided yet. No money anywhere: nobody is held, and "cannot pay" is not a referral reason.
 */
type DispoTab = "discharge" | "admit" | "refer" | "lama" | "death" | "left";
function DispoPanel({ t, busy, doctors, state, act }: {
  t: T; busy: boolean; doctors: ErDoctorOption[]; state: string; act: (work: (episodeId: string) => Promise<string | null>) => Promise<void>;
}): React.ReactElement {
  const [tab, setTab] = useState<DispoTab>("discharge");
  const [reason, setReason] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [treatment, setTreatment] = useState("");
  const [meds, setMeds] = useState("");
  const [signs, setSigns] = useState<string[]>([]);
  const [followDept, setFollowDept] = useState("");
  const [followOn, setFollowOn] = useState("");
  const [consultant, setConsultant] = useState("");
  const [cls, setCls] = useState("general");
  const [dx, setDx] = useState("");
  const [refReason, setRefReason] = useState<string>(ER_REFERRAL_REASONS[0]);
  const [facility, setFacility] = useState("");
  const [refNote, setRefNote] = useState("");
  const [escort, setEscort] = useState("nurse");
  const [transport, setTransport] = useState("own_ambulance");
  const [risks, setRisks] = useState("");
  const [signer, setSigner] = useState<"patient" | "representative" | "refused_to_sign">("patient");
  const [signerName, setSignerName] = useState("");
  const [relation, setRelation] = useState("");
  const [witness, setWitness] = useState("");
  const [diedAt, setDiedAt] = useState("");
  const [mccd, setMccd] = useState("");
  const [lastSeen, setLastSeen] = useState("");
  const [searched, setSearched] = useState<boolean | null>(null);
  // Review #4: one key per attempt — a retry after a failed request reuses it; a success starts a new attempt.
  const [attempt, setAttempt] = useState(() => newKey());
  const go = (work: (episodeId: string, k: string) => Promise<string | null>) => act(async (episodeId) => {
    try {
      const said = await work(episodeId, attempt);
      setAttempt(newKey());
      return said;
    } catch (e) {
      // The server answered (a refusal): the next try is a new attempt. A lost request keeps its key for the retry.
      if (erRefusalOf(e) !== null) setAttempt(newKey());
      throw e;
    }
  });
  const decided = state === "disposition_decided";
  const needReason = !decided && reason.trim() === "";
  const why = reason.trim() === "" ? {} : { reason: reason.trim() };
  const doctorOpts = <>{doctors.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}</>;
  const toIso = (v: string) => new Date(v).toISOString();
  const tabs: DispoTab[] = state === "arrived" ? ["left", "death"] : state === "triaged" ? ["left", "death"] : ["discharge", "admit", "refer", "lama", "death", "left"];
  const shown = tabs.includes(tab) ? tab : tabs[0]!;
  return (
    <section className="erp-panel" data-testid="er-patient-dispoform">
      <div className="erd-opts">{tabs.map((x) => (
        <button key={x} type="button" className={`erd-opt sm${shown === x ? " on" : ""}`} aria-pressed={shown === x} onClick={() => setTab(x)}>{t(`erPatient.dispo.tab.${x}`)}</button>
      ))}</div>
      {(shown === "discharge" || shown === "admit") && !decided ? (
        <label className="erd-field"><span>{t("erPatient.dispo.reason")}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      ) : null}
      {shown === "discharge" ? (
        <>
          <label className="erd-field"><span>{t("erPatient.dispo.diagnosis")}</span><input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></label>
          <label className="erd-field"><span>{t("erPatient.dispo.treatment")}</span><textarea rows={2} value={treatment} onChange={(e) => setTreatment(e.target.value)} /></label>
          <label className="erd-field"><span>{t("erPatient.dispo.medicines")}</span><textarea rows={3} value={meds} onChange={(e) => setMeds(e.target.value)} placeholder={t("erPatient.dispo.medicinesHint")} /></label>
          <fieldset className="erd-choice"><legend>{t("erPatient.dispo.returnIf")}</legend>
            <div className="erd-opts">{ER_RETURN_IF_SIGNS.map((x) => (
              <button key={x} type="button" className={`erd-opt sm${signs.includes(x) ? " on" : ""}`} aria-pressed={signs.includes(x)}
                onClick={() => setSigns(signs.includes(x) ? signs.filter((y) => y !== x) : [...signs, x])}>{t(`erPatient.dispo.sign.${x}`)}</button>
            ))}</div></fieldset>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erPatient.dispo.followDept")}</span><input value={followDept} onChange={(e) => setFollowDept(e.target.value.toUpperCase())} /></label>
            <label className="erd-field"><span>{t("erPatient.dispo.followOn")}</span><input type="date" value={followOn} onChange={(e) => setFollowOn(e.target.value)} /></label>
          </div>
          <button type="button" className="erx-btn pri big" data-testid="er-patient-discharge"
            disabled={busy || needReason || diagnosis.trim() === "" || treatment.trim() === "" || signs.length === 0}
            onClick={() => void go(async (episodeId, k) => {
              const medicines = meds.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => {
                const [name, dose, frequency] = l.split("·").map((x) => x.trim());
                return { name: name!, dose: dose || "as advised", frequency: frequency || "as advised" };
              });
              await dischargeApi({
                episodeId, ...why, summary: {
                  diagnosis: diagnosis.trim(), treatmentGiven: treatment.trim(), medicines, returnIf: signs,
                  ...(followDept !== "" && followOn !== "" ? { followUp: { department: followDept, onDate: followOn } } : {}),
                },
              }, k);
              return t("erPatient.dispo.discharged");
            })}>{t("erPatient.dispo.dischargeNow")}</button>
        </>
      ) : null}
      {shown === "admit" ? (
        <>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erPatient.dispo.consultant")}</span><select value={consultant} onChange={(e) => setConsultant(e.target.value)}><option value="">—</option>{doctorOpts}</select></label>
            <label className="erd-field"><span>{t("erPatient.dispo.class")}</span>
              <select value={cls} onChange={(e) => setCls(e.target.value)}>{["general", "semi_private", "private", "icu"].map((c) => <option key={c} value={c}>{t(`erPatient.dispo.cls.${c}`)}</option>)}</select></label>
          </div>
          <label className="erd-field"><span>{t("erPatient.dispo.provisional")}</span><input value={dx} onChange={(e) => setDx(e.target.value)} /></label>
          <button type="button" className="erx-btn pri big" data-testid="er-patient-admit" disabled={busy || needReason || consultant === "" || dx.trim() === ""}
            onClick={() => void go(async (episodeId, k) => {
              const r = await handToUnitApi({ episodeId, ...why, consultantId: consultant, requestedClass: cls, provisionalDiagnosis: dx.trim() }, k);
              return r.boarding ? t("erPatient.dispo.boarding") : t("erPatient.dispo.admitted");
            })}>{t("erPatient.dispo.admitNow")}</button>
        </>
      ) : null}
      {shown === "refer" ? (
        <>
          <div className="erd-opts">{ER_REFERRAL_REASONS.map((x) => (
            <button key={x} type="button" className={`erd-opt sm${refReason === x ? " on" : ""}`} aria-pressed={refReason === x} onClick={() => setRefReason(x)}>{t(`erPatient.dispo.referReason.${x}`)}</button>
          ))}</div>
          <label className="erd-field"><span>{t("erPatient.dispo.facility")}</span><input value={facility} onChange={(e) => setFacility(e.target.value)} /></label>
          <label className="erd-field"><span>{t("erPatient.dispo.referralNote")}</span><textarea rows={3} value={refNote} onChange={(e) => setRefNote(e.target.value)} /></label>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erPatient.dispo.escort")}</span>
              <select value={escort} onChange={(e) => setEscort(e.target.value)}>{["doctor", "nurse", "paramedic", "family"].map((x) => <option key={x} value={x}>{t(`erPatient.dispo.escortOf.${x}`)}</option>)}</select></label>
            <label className="erd-field"><span>{t("erPatient.dispo.transport")}</span>
              <select value={transport} onChange={(e) => setTransport(e.target.value)}>{["own_ambulance", "ambulance_108", "private_vehicle", "other"].map((x) => <option key={x} value={x}>{t(`erPatient.dispo.transportOf.${x}`)}</option>)}</select></label>
          </div>
          <button type="button" className="erx-btn pri big" data-testid="er-patient-refer" disabled={busy || facility.trim() === "" || refNote.trim() === ""}
            onClick={() => void go(async (episodeId, k) => {
              await referApi({ episodeId, reason: refReason, facility: facility.trim(), note: refNote.trim(), escort, transport }, k);
              return t("erPatient.dispo.referred");
            })}>{t("erPatient.dispo.referNow")}</button>
        </>
      ) : null}
      {shown === "lama" ? (
        <>
          <label className="erd-field"><span>{t("erPatient.dispo.risks")}</span><textarea rows={3} value={risks} onChange={(e) => setRisks(e.target.value)} /></label>
          <div className="erd-opts">{(["patient", "representative", "refused_to_sign"] as const).map((x) => (
            <button key={x} type="button" className={`erd-opt sm${signer === x ? " on" : ""}`} aria-pressed={signer === x} onClick={() => setSigner(x)}>{t(`erPatient.dispo.signer.${x}`)}</button>
          ))}</div>
          {signer === "refused_to_sign" ? (
            <label className="erd-field"><span>{t("erPatient.dispo.witness")}</span><select value={witness} onChange={(e) => setWitness(e.target.value)}><option value="">—</option>{doctorOpts}</select></label>
          ) : (
            <div className="erd-pair">
              <label className="erd-field"><span>{t("erPatient.dispo.signerName")}</span><input value={signerName} onChange={(e) => setSignerName(e.target.value)} /></label>
              {signer === "representative" ? <label className="erd-field"><span>{t("erPatient.dispo.relation")}</span><input value={relation} onChange={(e) => setRelation(e.target.value)} /></label> : null}
            </div>
          )}
          <button type="button" className="erx-btn danger big" data-testid="er-patient-lama"
            disabled={busy || risks.trim() === "" || (signer === "refused_to_sign" ? witness === "" : signerName.trim() === "" || (signer === "representative" && relation.trim() === ""))}
            onClick={() => void go(async (episodeId, k) => {
              const s = signer === "refused_to_sign" ? { kind: signer, witnessId: witness }
                : signer === "representative" ? { kind: signer, name: signerName.trim(), relation: relation.trim() } : { kind: signer, name: signerName.trim() };
              await lamaApi({ episodeId, risksExplained: risks.trim(), signer: s }, k);
              return t("erPatient.dispo.lamaDone");
            })}>{t("erPatient.dispo.lamaNow")}</button>
        </>
      ) : null}
      {shown === "death" ? (
        <>
          <div className="erd-pair">
            <label className="erd-field"><span>{t("erPatient.dispo.diedAt")}</span><input type="datetime-local" value={diedAt} onChange={(e) => setDiedAt(e.target.value)} /></label>
            <label className="erd-field"><span>{t("erPatient.dispo.mccd")}</span><input value={mccd} onChange={(e) => setMccd(e.target.value)} /></label>
          </div>
          <p className="erd-hint">{t("erPatient.dispo.mccdHint")}</p>
          <button type="button" className="erx-btn danger big" data-testid="er-patient-death" disabled={busy || diedAt === ""}
            onClick={() => void go(async (episodeId, k) => {
              await deathApi({ episodeId, diedAt: toIso(diedAt), ...(mccd.trim() !== "" ? { mccdNo: mccd.trim() } : {}) }, k);
              return t("erPatient.dispo.deathDone");
            })}>{t("erPatient.dispo.deathNow")}</button>
        </>
      ) : null}
      {shown === "left" ? (
        <>
          <label className="erd-field"><span>{t("erPatient.dispo.lastSeen")}</span><input type="datetime-local" value={lastSeen} onChange={(e) => setLastSeen(e.target.value)} /></label>
          {state !== "arrived" ? (
            <fieldset className="erd-choice" data-testid="er-patient-searched"><legend>{t("erPatient.dispo.searched")}</legend>
              <div className="erd-opts">{([true, false] as const).map((v) => (
                <button key={String(v)} type="button" className={`erd-opt sm${searched === v ? " on" : ""}`} aria-pressed={searched === v} onClick={() => setSearched(v)}>
                  {t(v ? "erPatient.dispo.searchedYes" : "erPatient.dispo.searchedNo")}</button>
              ))}</div>
            </fieldset>
          ) : null}
          <div className="erd-row">
            {state === "arrived" || state === "triaged" ? (
              <button type="button" className="erx-btn" data-testid="er-patient-lwbs" disabled={busy || lastSeen === ""}
                onClick={() => void go(async (episodeId, k) => { await lwbsApi({ episodeId, lastSeenAt: toIso(lastSeen) }, k); return t("erPatient.dispo.lwbsDone"); })}>{t("erPatient.dispo.lwbsNow")}</button>
            ) : null}
            {state !== "arrived" ? (
              <button type="button" className="erx-btn danger" data-testid="er-patient-abscond" disabled={busy || lastSeen === "" || searched === null}
                onClick={() => void go(async (episodeId, k) => {
                  const r = await abscondApi({ episodeId, lastSeenAt: toIso(lastSeen), searched: searched! }, k);
                  return r.policeToBeInformed ? t("erPatient.dispo.abscondPolice") : t("erPatient.dispo.abscondDone");
                })}>{t("erPatient.dispo.abscondNow")}</button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
