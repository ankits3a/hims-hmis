import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdHandoverDraft, IpdMyShift, IpdRefusalBody, IpdShiftHandoverList, IpdShiftItem } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { acceptShiftHandover, getHandoverDraft, getMyShift, getShiftHandovers, giveShiftHandover } from "../lib/ipd-nursing-api";
import type { SbarText } from "../lib/ipd-nursing-api";
import { LiveLine, VitalsForm, ageFromAgeSex, dueWords, savedWords, useLiveLoad, useNight } from "./ipd-nursing-shared";
import type { T } from "./ipd-nursing-shared";
import "./ipd-nursing.css";

/**
 * E4.1 (#733) — BOARD D1, MY SHIFT ON THE NURSE'S PHONE (spec SPEC-ipd-core §4.9 D). 390 px, one hand, gloves: every
 * target 48 px, the acts at the bottom in the thumb zone, text that still fits at 130 %.
 *
 * Header: ward, shift, my patients. The Now list in time order — early-warning alerts, overdue vitals, assessments
 * due, handovers — each with bed, patient and a countdown in words. A patient opens the vitals entry (the score shows
 * as the numbers are typed; the numbers read back large before Save). Handover: "N ready" → each patient's SBAR drafted
 * from the record (every line with its source) → edit → Give; and the handovers waiting for me (never one I gave).
 *
 * OFFLINE: vitals queue (up to 30 minutes, stamped with the time taken) and send themselves when the network returns.
 * Every other act is off with a few words. Phone notices are a few words on one line (owner rule).
 */

const TICK_MS = 30_000;
type Mode = { kind: "list" } | { kind: "vitals"; admissionId: string } | { kind: "handover" };

export function IpdMyShift(): React.ReactElement {
  const { t } = useTranslation();
  const [shift, setShift] = useState<IpdMyShift | null>(null);
  const [handovers, setHandovers] = useState<IpdShiftHandoverList | null>(null);
  const [error, setError] = useState<"forbidden" | null>(null);
  const [wardId, setWardId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => Promise.all([
    getMyShift(wardId).then((s) => { setShift(s); setError(null); setNow(Date.now()); }),
    getShiftHandovers(wardId).then(setHandovers, () => setHandovers(null)),
  ]).catch((e: unknown) => { if (e instanceof ApiError && e.status === 403) setError("forbidden"); throw e; }), [wardId]);
  const live = useLiveLoad(load);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);
  const [night, flipNight] = useNight(shift?.night);

  const patient = mode.kind === "vitals" ? shift?.patients.find((p) => p.identity.admissionId === mode.admissionId) ?? null : null;
  const toAccept = (handovers?.handovers ?? []).filter((h) => !h.givenByViewer);

  return (
    <main className={`ipdn ipdn-phone${night ? " night" : ""}`} data-testid="ipd-my-shift">
      <header className="ipdn-phead">
        <div className="ipdn-prow">
          <b className="ipdn-wardname">{shift?.ward?.name ?? t("ipdNursing.shiftPage.title")}</b>
          <button type="button" className="ipdn-btn sm" aria-pressed={night} onClick={flipNight} data-testid="ipdn-night-toggle">{night ? "☾" : "☀"}<span className="sr">{night ? t("ipdNursing.night") : t("ipdNursing.day")}</span></button>
        </div>
        {shift !== null ? (
          <div className="ipdn-prow dim">
            <span>{t(`ipdNursing.shift.${shift.shift.key}`)} · {fmtIst(shift.shift.startsAt)}–{fmtIst(shift.shift.endsAt)}</span>
            <span>{t("ipdNursing.shiftPage.patients", { count: shift.patients.length })}</span>
          </div>
        ) : null}
        <LiveLine online={live.online} lastUpdate={live.lastUpdate} />
        {shift !== null && shift.wards.length > 1 ? (
          <nav className="ipdn-chips" aria-label={t("ipdNursing.ward.wards")}>
            {shift.wards.map((w) => (
              <button key={w.id} type="button" className="ipdn-chip" aria-pressed={shift.ward?.id === w.id} onClick={() => setWardId(w.id)}>{w.code}</button>
            ))}
          </nav>
        ) : null}
      </header>
      {notice === null ? null : notice === t("ipdNursing.noDoctorReached")
        // Review walk: "No doctor reached — call" is a warning to act on, never a success tick.
        ? <div className="ipdn-warn" role="alert" data-testid="ipdn-notice">☎ {notice}</div>
        : <div className="ipdn-ok" role="status" data-testid="ipdn-notice">✓ {notice}</div>}
      {error === "forbidden" ? <div className="ipdn-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {shift === null && error === null ? <div className="ipdn-empty">{t("ipdNursing.loading")}</div> : null}

      {mode.kind === "list" && shift !== null ? (
        <>
          <section aria-label={t("ipdNursing.shiftPage.now")}>
            <h2 className="ipdn-h2">{t("ipdNursing.shiftPage.now")}</h2>
            {shift.now.length === 0 ? <div className="ipdn-empty">{t("ipdNursing.shiftPage.nothingDue")}</div> : null}
            <ul className="ipdn-now" data-testid="ipdn-now">
              {shift.now.map((i) => <NowItem key={`${i.kind}-${i.refId ?? i.admissionId}`} i={i} now={now}
                onOpen={() => { setNotice(null); setMode(i.kind === "handover" ? { kind: "handover" } : { kind: "vitals", admissionId: i.admissionId }); }} />)}
            </ul>
          </section>
          <section aria-label={t("ipdNursing.shiftPage.patientsTitle")}>
            <h2 className="ipdn-h2">{t("ipdNursing.shiftPage.patientsTitle")}</h2>
            <ul className="ipdn-now">
              {shift.patients.map((p) => (
                <li key={p.identity.admissionId}>
                  <button type="button" className="ipdn-nowbtn" onClick={() => { setNotice(null); setMode({ kind: "vitals", admissionId: p.identity.admissionId }); }}>
                    <span className="bed mono">{p.bedCode ?? "—"}</span>
                    <span className="nm">{p.identity.name}</span>
                    <span className="dim">{t(`ipdNursing.kind.${p.scoreKind}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {mode.kind === "vitals" && patient !== null ? (
        <section className="ipdn-pane" aria-label={t("ipdNursing.v.title")}>
          <div className="ipdn-idhead">
            <b>{patient.identity.name}</b> <span className="dim">{patient.identity.ageSex}</span>
            <div className="dim">{[patient.bedCode, patient.identity.uhid ? `UHID ${patient.identity.uhid}` : null].filter(Boolean).join(" · ")}</div>
          </div>
          <VitalsForm admissionId={patient.identity.admissionId} kind={patient.scoreKind} ageYears={ageFromAgeSex(patient.identity.ageSex)} label={patient.identity.name}
            onCancel={() => setMode({ kind: "list" })}
            onDone={(d) => { setNotice(savedWords(d, t as T)); setMode({ kind: "list" }); if (!d.queued) void load().catch(() => undefined); }} />
        </section>
      ) : null}

      {mode.kind === "handover" && shift !== null ? (
        <HandoverPane shift={shift} toAccept={toAccept} online={live.online} onBack={() => setMode({ kind: "list" })}
          onDone={(w) => { setNotice(w); void load().catch(() => undefined); }} />
      ) : null}

      {mode.kind === "list" && shift !== null ? (
        <footer className="ipdn-thumb">
          <button type="button" className="ipdn-btn pri wide" onClick={() => setMode({ kind: "handover" })} data-testid="ipdn-handover-open">
            {t("ipdNursing.handover.ready", { count: shift.patients.length })}{toAccept.length > 0 ? ` · ${t("ipdNursing.handover.toAccept", { count: toAccept.length })}` : ""}
          </button>
        </footer>
      ) : null}
    </main>
  );
}

function NowItem({ i, now, onOpen }: { i: IpdShiftItem; now: number; onOpen: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const late = i.overdue || new Date(i.dueAt).getTime() < now;
  return (
    <li className={`k-${i.kind}${late ? " late" : ""}`}>
      <button type="button" className="ipdn-nowbtn" onClick={onOpen} data-testid={`ipdn-now-${i.kind}-${i.admissionId}`}>
        <span className="bed mono">{i.bedCode ?? "—"}</span>
        <span className="nm">{i.name}</span>
        <span className="what">{late ? "⚠ " : ""}{i.kind === "ews" && i.band !== null
          ? `${t("ipdNursing.alert", { band: t(`ipdNursing.band.${i.band}`) })}`
          : dueWords(i.kind, i.dueAt, now, t as T)}</span>
      </button>
    </li>
  );
}

const EMPTY_SBAR: SbarText = { situation: "", background: "", assessment: "", recommendation: "" };
const SBAR_KEYS = ["situation", "background", "assessment", "recommendation"] as const;

function HandoverPane({ shift, toAccept, online, onBack, onDone }: {
  shift: IpdMyShift; toAccept: IpdShiftHandoverList["handovers"]; online: boolean; onBack: () => void; onDone: (words: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<IpdHandoverDraft | null>(null);
  const [sbar, setSbar] = useState<SbarText>(EMPTY_SBAR);
  const [given, setGiven] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const mayAct = online && can("ipd.handover.shift");

  const pick = (id: string): void => {
    setAdmissionId(id); setDraft(null); setRefusal(null);
    getHandoverDraft(id).then((d) => {
      setDraft(d);
      setSbar({
        situation: d.situation.map((l) => l.text).join("\n"), background: d.background.map((l) => l.text).join("\n"),
        assessment: d.assessment.map((l) => l.text).join("\n"), recommendation: d.recommendation.map((l) => l.text).join("\n"),
      });
    }, () => setSbar(EMPTY_SBAR));
  };
  const give = (): void => {
    if (admissionId === null) return;
    setBusy(true); setRefusal(null);
    giveShiftHandover(admissionId, sbar).then(() => {
      setBusy(false); setGiven(new Set([...given, admissionId])); setAdmissionId(null); onDone(t("ipdNursing.handover.given"));
    }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  const accept = (handoverId: string): void => {
    setBusy(true); setRefusal(null);
    acceptShiftHandover(handoverId).then(() => { setBusy(false); onDone(t("ipdNursing.handover.accepted")); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  const sbarFilled = SBAR_KEYS.every((k) => sbar[k].trim() !== "");

  return (
    <section className="ipdn-pane" aria-label={t("ipdNursing.handover.title")} data-testid="ipdn-handover">
      {!online ? <p className="ipdn-warn">⚠ {t("ipdNursing.offlineActs")}</p> : null}
      {toAccept.length > 0 ? (
        <>
          <h2 className="ipdn-h2">{t("ipdNursing.handover.waiting")}</h2>
          <ul className="ipdn-cards">
            {toAccept.map((h) => (
              <li key={h.handoverId} className="ipdn-card" data-testid={`ipdn-shift-handover-${h.handoverId}`}>
                <div><span className="mono">{h.bedCode ?? "—"}</span> · <b>{h.identity.name}</b></div>
                <div className="dim">{t("ipdNursing.handover.from", { name: h.givenBy.name, time: fmtIst(h.givenAt) })}</div>
                <dl className="ipdn-sbar">{SBAR_KEYS.map((k) => <div key={k}><dt>{t(`ipdNursing.sbar.${k}`)}</dt><dd>{h.sbar[k]}</dd></div>)}</dl>
                <button type="button" className="ipdn-btn pri wide" disabled={busy || !mayAct} onClick={() => accept(h.handoverId)}>{t("ipdNursing.handover.accept")}</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2 className="ipdn-h2">{t("ipdNursing.handover.give")}</h2>
      {admissionId === null ? (
        <ul className="ipdn-now">
          {shift.patients.map((p) => (
            <li key={p.identity.admissionId}>
              <button type="button" className="ipdn-nowbtn" disabled={!mayAct || given.has(p.identity.admissionId)} onClick={() => pick(p.identity.admissionId)}>
                <span className="bed mono">{p.bedCode ?? "—"}</span>
                <span className="nm">{p.identity.name}</span>
                <span className="what">{given.has(p.identity.admissionId) ? `✓ ${t("ipdNursing.handover.done")}` : t("ipdNursing.handover.draft")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form className="ipdn-form" onSubmit={(e) => { e.preventDefault(); if (sbarFilled) give(); }}>
          {SBAR_KEYS.map((k) => (
            <label key={k}>{t(`ipdNursing.sbar.${k}`)}
              {draft !== null && draft[k].length > 0 ? (
                <span className="ipdn-chiprow">{[...new Set(draft[k].map((l) => l.source))].map((s) => <span key={s} className="ipdn-src">{t(`ipdNursing.sbarSource.${s}`)}</span>)}</span>
              ) : null}
              <textarea rows={3} value={sbar[k]} onChange={(e) => setSbar({ ...sbar, [k]: e.target.value })} />
            </label>
          ))}
          <div className="ipdn-acts">
            <button type="button" className="ipdn-btn" onClick={() => setAdmissionId(null)}>{t("ipdNursing.cancel")}</button>
            <button type="submit" className="ipdn-btn pri" disabled={busy || !sbarFilled || !mayAct}>{t("ipdNursing.handover.giveBtn")}</button>
          </div>
        </form>
      )}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <footer className="ipdn-thumb"><button type="button" className="ipdn-btn wide" onClick={onBack}>{t("ipdNursing.back")}</button></footer>
    </section>
  );
}
