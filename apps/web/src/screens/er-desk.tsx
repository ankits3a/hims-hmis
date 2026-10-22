import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { ErDeskRow, ErDeskView, ErDoctorOption, ErExpectedCard, ErPatientHit, ErRefusalBody } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { fmtIst, useDebounced } from "../lib/format";
import { useRealtime } from "../lib/realtime";
import {
  ER_AGE_BANDS, ER_ARRIVAL_MODES, ER_BOARD_TOPIC, ER_PRE_ALERT_MODES, ER_SEXES, broughtDeadApi, cancelPreAlertApi,
  erRefusalOf, fetchErDesk, fetchErDoctors, linkIdentityApi, newKey, preAlertApi, printBandApi, registerArrivalApi,
  registerUnidentifiedApi, reprintBandApi, searchErPatients,
} from "../lib/er-api";
import type { ArrivalOut, BandOut, ErAgeBandValue, ErArrivalModeValue, ErSexValue } from "../lib/er-api";
import { ageSexWords, aliasFirst } from "./er-board";
import "../styles/paper-pine.css";
import "./er.css";

/**
 * ER lane 1 (#808) — THE ER DESK (spec SPEC-emergency §4.1, §5 C).
 *
 * Arrival first, in at most three taps: an unknown patient is sex, an age band and "Register" (the arrival mode
 * starts at walk-in, or at the pre-alert's mode); a known patient is a scan or a search and "Register". The band prints
 * in the same act. Everything else (marks, complaint, who brought them, the gate time when entered late, the paper
 * serial in downtime) is optional and folded away. Nothing asks for money, an ID or a phone; a Good Samaritan is asked
 * nothing.
 *
 * The right column is the department since yesterday: band state (a band that names someone else now is "stale"),
 * identity (an unknown is identified by filing the existing merge — the MRD officer's `patients.merge`), and the
 * ambulance pre-alerts. Every refusal shows its rule and its fix, in the desk's language.
 */
type Tab = "unknown" | "known" | "expected" | "dead";
type T = (k: string, o?: Record<string, unknown>) => string;
const ETAS = [5, 10, 15, 30, 60] as const;
const IST_MS = 330 * 60_000;

/** "14:02" typed at the desk (IST, today) → an ISO instant; a time later than now is yesterday's. */
export function istClockToIso(hhmm: string, now: number): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null) return null;
  const shifted = new Date(now + IST_MS);
  let at = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), Number(m[1]), Number(m[2])) - IST_MS;
  if (at > now + 2 * 60_000) at -= 86_400_000;
  return new Date(at).toISOString();
}

function Choice<V extends string>({ label, values, value, onPick, word, testid }: {
  label: string; values: readonly V[]; value: V | null; onPick: (v: V) => void; word: (v: V) => string; testid: string;
}): React.ReactElement {
  return (
    <fieldset className="erd-choice" data-testid={testid}>
      <legend>{label}</legend>
      <div className="erd-opts">
        {values.map((v) => (
          <button key={v} type="button" className={`erd-opt${value === v ? " on" : ""}`} aria-pressed={value === v} onClick={() => onPick(v)}>{word(v)}</button>
        ))}
      </div>
    </fieldset>
  );
}

function Refusal({ r, t, onFix }: { r: ErRefusalBody | string; t: T; onFix?: () => void }): React.ReactElement {
  if (typeof r === "string") return <div className="erd-refusal" role="alert"><b>{r}</b></div>;
  const known = t(`er.refusal.${r.code}.rule`, { defaultValue: "" });
  const d = r.detail ?? {};
  const where = r.code === "patient_admitted" ? [d.wardName, d.bedCode].filter((x) => typeof x === "string").join(" · ") : "";
  return (
    <div className="erd-refusal" role="alert" data-testid="er-desk-refusal">
      <b>{known !== "" ? known : r.rule}</b>
      {where !== "" ? <span>{where}</span> : null}
      {onFix !== undefined ? <button type="button" className="erx-btn sm" onClick={onFix}>{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</button>
        : <span className="dim">{t(`er.refusal.${r.code}.fix`, { defaultValue: r.fix })}</span>}
    </div>
  );
}

/** The printed band, as it comes back from the act: what the thermal printer (or the browser) prints. */
function BandCard({ band, t, onNext }: { band: BandOut; t: T; onNext: () => void }): React.ReactElement {
  const b = band.band;
  return (
    <section className="erd-band-wrap" aria-label={t("erDesk.band.title")} data-testid="er-desk-band">
      <div className="erd-band">
        <div className="erd-band-id">
          <b>{b.name}</b>{b.nameHi !== null ? <span lang="hi">{b.nameHi}</span> : null}
          <span className="mono">{b.uhid} · {b.ageSex}</span>
          <span className="mono">{b.episodeNo} · {b.arrivedOn}</span>
          <span className="erd-band-alerts">{[...b.allergyWords, ...b.alertWords].join(" · ")}</span>
        </div>
        <div className="erd-band-code mono" aria-label={t("erDesk.band.barcode")}>{b.barcode}</div>
      </div>
      <div className="erd-row">
        <button type="button" className="erx-btn pri" onClick={() => window.print()}>{t("erDesk.band.print")}</button>
        <button type="button" className="erx-btn" onClick={onNext}>{t("erDesk.band.next")}</button>
      </div>
    </section>
  );
}

function More({ t, open, setOpen, children }: { t: T; open: boolean; setOpen: (b: boolean) => void; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="erd-more">
      <button type="button" className="erd-more-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("erDesk.less") : t("erDesk.more")}</button>
      {open ? <div className="erd-more-body">{children}</div> : null}
    </div>
  );
}

export function ErDesk(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [desk, setDesk] = useState<ErDeskView | null>(null);
  const [tab, setTab] = useState<Tab>("unknown");
  const [sex, setSex] = useState<ErSexValue | null>(null);
  const [band, setBand] = useState<ErAgeBandValue | null>(null);
  const [mode, setMode] = useState<ErArrivalModeValue>("walk_in");
  const [preAlert, setPreAlert] = useState<ErExpectedCard | null>(null);
  const [more, setMore] = useState(false);
  const [marks, setMarks] = useState("");
  const [complaint, setComplaint] = useState("");
  const [bringer, setBringer] = useState("");
  const [bringerPhone, setBringerPhone] = useState("");
  const [cameAt, setCameAt] = useState("");
  const [paper, setPaper] = useState("");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [hits, setHits] = useState<ErPatientHit[]>([]);
  const [picked, setPicked] = useState<ErPatientHit | null>(null);
  const [newName, setNewName] = useState("");
  const [eta, setEta] = useState<number>(10);
  const [count, setCount] = useState(1);
  const [paMode, setPaMode] = useState<(typeof ER_PRE_ALERT_MODES)[number]>("ambulance_108");
  const [doctors, setDoctors] = useState<ErDoctorOption[]>([]);
  const [examinedBy, setExaminedBy] = useState("");
  const [deadKnown, setDeadKnown] = useState(false);
  const [ecg, setEcg] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ErRefusalBody | string | null>(null);
  const [done, setDone] = useState<ArrivalOut | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const actKey = useRef(newKey());
  // The brought-dead examination time is set once per attempt: a retry under the same key sends the same body.
  const examinedAtRef = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => { fetchErDesk().then(setDesk, () => undefined); }, []);
  useEffect(() => { load(); }, [load]);
  useRealtime([ER_BOARD_TOPIC], () => load());
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);
  useEffect(() => {
    if (dq.trim().length < 2) { setHits([]); return; }
    searchErPatients(dq).then(setHits, () => setHits([]));
  }, [dq]);
  useEffect(() => { if (tab === "dead" && doctors.length === 0) fetchErDoctors().then(setDoctors, () => undefined); }, [tab, doctors.length]);
  useEffect(() => { if (tab === "known") searchRef.current?.focus(); }, [tab]);

  const reset = (): void => {
    setSex(null); setBand(null); setMode("walk_in"); setPreAlert(null); setMore(false); setMarks(""); setComplaint("");
    setBringer(""); setBringerPhone(""); setCameAt(""); setPaper(""); setQ(""); setHits([]); setPicked(null); setNewName("");
    setRefusal(null); setDone(null); setExaminedBy(""); setEcg(true); actKey.current = newKey(); examinedAtRef.current = null;
  };

  const optional = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    if (complaint.trim() !== "") o.complaint = complaint.trim();
    if (bringer.trim() !== "" || bringerPhone.trim() !== "") {
      o.broughtBy = { kind: mode === "police" ? "police" : "bystander", ...(bringer.trim() !== "" ? { name: bringer.trim() } : {}), ...(/^[6-9]\d{9}$/.test(bringerPhone.trim()) ? { phone: bringerPhone.trim() } : {}) };
    }
    if (cameAt.trim() !== "") { const iso = istClockToIso(cameAt, Date.now()); if (iso !== null) o.arrivedAt = iso; }
    if (paper.trim() !== "") o.paperSerial = paper.trim();
    if (preAlert !== null) o.preAlertId = preAlert.preAlertId;
    return o;
  };

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setRefusal(null); setNote(null);
    try { await work(); load(); } catch (e) {
      const r = erRefusalOf(e);
      setRefusal(r ?? t("erDesk.failed"));
      if (r?.code === "episode_already_open" && typeof r.detail?.episodeId === "string") setHighlight(r.detail.episodeId);
    } finally { setBusy(false); }
  };

  const registerUnknown = (): Promise<void> => act(async () => {
    const out = await registerUnidentifiedApi({ sex, ageBand: band, arrivalMode: mode, ...(marks.trim() !== "" ? { marks: marks.trim() } : {}), ...optional() }, actKey.current);
    setDone(out);
  });
  const registerKnown = (): Promise<void> => act(async () => {
    const who = picked !== null ? { patientId: picked.patientId } : { newPatient: { name: newName.trim(), sex, ageBand: band } };
    const out = await registerArrivalApi({ ...who, arrivalMode: mode, ...optional() }, actKey.current);
    setDone(out);
  });
  const sendPreAlert = (): Promise<void> => act(async () => {
    await preAlertApi({ mode: paMode, etaMinutes: eta, count, ...(sex !== null ? { sex } : {}), ...(band !== null ? { ageBand: band } : {}), ...(complaint.trim() !== "" ? { complaint: complaint.trim() } : {}) });
    reset(); setNote(t("erDesk.expected.sent"));
  });
  const recordDead = (): Promise<void> => act(async () => {
    const who = deadKnown && picked !== null ? { patientId: picked.patientId } : { unidentified: { sex, ageBand: band, ...(marks.trim() !== "" ? { marks: marks.trim() } : {}) } };
    const o = optional();
    examinedAtRef.current ??= new Date().toISOString();
    const out = await broughtDeadApi({ ...who, arrivalMode: mode, examinedBy, examinedAt: examinedAtRef.current, ecgStripRecorded: ecg,
      ...(o.arrivedAt !== undefined ? { arrivedAt: o.arrivedAt } : {}), ...(o.preAlertId !== undefined ? { preAlertId: o.preAlertId } : {}) }, actKey.current);
    reset(); setNote(t("erDesk.dead.done", { no: out.episodeNo }));
  });

  const fromPreAlert = (c: ErExpectedCard): void => {
    reset(); setPreAlert(c);
    // Lane 2 (E9): the OPD red flag's patient is known — straight to Known with them picked, walked in from OPD.
    if (c.mode === "opd_red_flag" && c.patientId !== null) {
      setTab("known"); setMode("walk_in");
      setPicked({ patientId: c.patientId, uhid: "", name: c.patientLabel ?? "", sex: c.sex ?? "unknown", ageYears: null, phoneTail: null, unidentified: false });
      return;
    }
    setMode(c.mode === "opd_red_flag" || c.mode === null ? "walk_in" : c.mode); setTab("unknown");
    if (c.sex !== null) setSex(c.sex);
    if (c.ageBand !== null) setBand(c.ageBand);
  };

  const sexWord = (v: ErSexValue): string => t(`er.sex.${v}`);
  const bandWord = (v: ErAgeBandValue): string => t(`er.band.${v}`);
  // A wall-masked card carries no mode (police); the desk reads the full card, so this is only the type's answer.
  const modeWord = (v: string | null): string => (v === null ? t("erBoard.col.expected") : t(`er.mode.${v}`));
  const canUnknown = sex !== null && band !== null && !busy;
  const canKnown = !busy && (picked !== null || (newName.trim() !== "" && sex !== null && band !== null));
  const canDead = !busy && examinedBy !== "" && (deadKnown ? picked !== null : sex !== null && band !== null);

  const moreFields = (withMarks: boolean): React.ReactElement => (
    <More t={t} open={more} setOpen={setMore}>
      {withMarks ? <label className="erd-field"><span>{t("erDesk.marks")}</span><input value={marks} onChange={(e) => setMarks(e.target.value)} placeholder={t("erDesk.marksHint")} /></label> : null}
      <label className="erd-field"><span>{t("erDesk.complaint")}</span><input value={complaint} onChange={(e) => setComplaint(e.target.value)} /></label>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erDesk.bringer")}</span><input value={bringer} onChange={(e) => setBringer(e.target.value)} /></label>
        <label className="erd-field"><span>{t("erDesk.bringerPhone")}</span><input inputMode="numeric" value={bringerPhone} onChange={(e) => setBringerPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} /></label>
      </div>
      <p className="erd-hint">{t("erDesk.samaritan")}</p>
      <div className="erd-pair">
        <label className="erd-field"><span>{t("erDesk.cameAt")}</span><input inputMode="numeric" placeholder="HH:MM" value={cameAt} onChange={(e) => setCameAt(e.target.value)} /></label>
        <label className="erd-field"><span>{t("erDesk.paper")}</span><input value={paper} onChange={(e) => setPaper(e.target.value)} /></label>
      </div>
    </More>
  );

  const patientPicker = (): React.ReactElement => (
    <div className="erd-find">
      <label className="erd-field"><span>{t("erDesk.known.find")}</span>
        <input ref={searchRef} value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} placeholder={t("erDesk.known.findHint")} data-testid="er-desk-search" />
      </label>
      {picked !== null ? (
        <div className="erd-picked" data-testid="er-desk-picked">
          <b>{picked.name}</b><span className="mono">{picked.uhid}</span>
          <span>{ageSexWords(t, picked.ageYears, null, picked.sex)}</span>
          <button type="button" className="erx-btn sm" onClick={() => setPicked(null)}>{t("erDesk.change")}</button>
        </div>
      ) : hits.length > 0 ? (
        <ul className="erd-hits">
          {hits.map((h) => (
            <li key={h.patientId}>
              <button type="button" onClick={() => { setPicked(h); setHits([]); }}>
                <b>{h.name}</b><span className="mono">{h.uhid}</span><span>{ageSexWords(t, h.ageYears, null, h.sex)}</span>
                {h.phoneTail !== null ? <span className="mono">••••{h.phoneTail}</span> : null}
                {h.unidentified ? <span className="erb-chip unidentified">{t("er.chip.unidentified")}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : q.trim().length >= 2 ? <p className="erd-hint">{t("erDesk.known.none")}</p> : null}
    </div>
  );

  return (
    <div className="erx erd" data-testid="er-desk">
      <header className="erb-head">
        <div className="erb-title"><h1>{t("erDesk.title")}</h1><span>{fmtIst(new Date().toISOString())}</span></div>
        <div className="erb-tools">
          <Link to="/er/board" className="erx-btn">{t("erDesk.board")}</Link>
          <Link to="/" className="erx-btn">{t("erBoard.home")}</Link>
        </div>
      </header>

      <div className="erd-cols">
        <section className="erd-new" aria-label={t("erDesk.newArrival")}>
          <div className="erd-tabs" role="tablist">
            {(["unknown", "known", "expected", "dead"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`erd-tab${tab === k ? " on" : ""}`}
                onClick={() => { if (k !== tab) { reset(); setTab(k); } }} data-testid={`er-desk-tab-${k}`}>{t(`erDesk.tab.${k}`)}</button>
            ))}
          </div>

          {preAlert !== null ? (
            <div className="erd-from" data-testid="er-desk-from-prealert">
              <span>{t("erDesk.fromPreAlert", { mode: modeWord(preAlert.mode), time: fmtIst(preAlert.expectedAt) })}</span>
              <button type="button" className="erx-btn sm" onClick={() => setPreAlert(null)}>{t("erDesk.clear")}</button>
            </div>
          ) : null}

          {done !== null ? <BandCard band={done.band} t={t} onNext={reset} /> : null}

          {done === null && tab === "unknown" ? (
            <div className="erd-form">
              <Choice label={t("erDesk.sex")} values={ER_SEXES} value={sex} onPick={setSex} word={sexWord} testid="er-desk-sex" />
              <Choice label={t("erDesk.age")} values={ER_AGE_BANDS} value={band} onPick={setBand} word={bandWord} testid="er-desk-age" />
              <Choice label={t("erDesk.mode")} values={ER_ARRIVAL_MODES} value={mode} onPick={setMode} word={modeWord} testid="er-desk-mode" />
              {moreFields(true)}
              <button type="button" className="erx-btn pri big" disabled={!canUnknown} onClick={() => void registerUnknown()} data-testid="er-desk-register-unknown">
                {t("erDesk.registerUnknown")}
              </button>
            </div>
          ) : null}

          {done === null && tab === "known" ? (
            <div className="erd-form">
              {patientPicker()}
              {picked === null ? (
                <details className="erd-newpatient">
                  <summary>{t("erDesk.known.newPatient")}</summary>
                  <label className="erd-field"><span>{t("erDesk.known.name")}</span><input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
                  <Choice label={t("erDesk.sex")} values={ER_SEXES} value={sex} onPick={setSex} word={sexWord} testid="er-desk-new-sex" />
                  <Choice label={t("erDesk.age")} values={ER_AGE_BANDS} value={band} onPick={setBand} word={bandWord} testid="er-desk-new-age" />
                </details>
              ) : null}
              <Choice label={t("erDesk.mode")} values={ER_ARRIVAL_MODES} value={mode} onPick={setMode} word={modeWord} testid="er-desk-known-mode" />
              {moreFields(false)}
              <button type="button" className="erx-btn pri big" disabled={!canKnown} onClick={() => void registerKnown()} data-testid="er-desk-register-known">
                {t("erDesk.registerKnown")}
              </button>
            </div>
          ) : null}

          {done === null && tab === "expected" ? (
            <div className="erd-form">
              <Choice label={t("erDesk.expected.mode")} values={ER_PRE_ALERT_MODES} value={paMode} onPick={setPaMode} word={modeWord} testid="er-desk-pa-mode" />
              <Choice label={t("erDesk.expected.eta")} values={ETAS.map(String)} value={String(eta)} onPick={(v) => setEta(Number(v))} word={(v) => t("erDesk.expected.minutes", { n: v })} testid="er-desk-pa-eta" />
              <div className="erd-count">
                <span>{t("erDesk.expected.count")}</span>
                <button type="button" className="erx-btn sm" aria-label={t("erDesk.expected.fewer")} onClick={() => setCount(Math.max(1, count - 1))}>−</button>
                <b className="mono">{count}</b>
                <button type="button" className="erx-btn sm" aria-label={t("erDesk.expected.more")} onClick={() => setCount(Math.min(20, count + 1))}>+</button>
              </div>
              <Choice label={t("erDesk.sexOptional")} values={ER_SEXES} value={sex} onPick={setSex} word={sexWord} testid="er-desk-pa-sex" />
              <Choice label={t("erDesk.ageOptional")} values={ER_AGE_BANDS} value={band} onPick={setBand} word={bandWord} testid="er-desk-pa-age" />
              <label className="erd-field"><span>{t("erDesk.complaint")}</span><input value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder={t("erDesk.expected.complaintHint")} /></label>
              <button type="button" className="erx-btn pri big" disabled={busy} onClick={() => void sendPreAlert()} data-testid="er-desk-prealert">{t("erDesk.expected.send")}</button>
            </div>
          ) : null}

          {done === null && tab === "dead" ? (
            <div className="erd-form">
              <div className="erd-opts">
                <button type="button" className={`erd-opt${!deadKnown ? " on" : ""}`} aria-pressed={!deadKnown} onClick={() => setDeadKnown(false)}>{t("erDesk.dead.unknown")}</button>
                <button type="button" className={`erd-opt${deadKnown ? " on" : ""}`} aria-pressed={deadKnown} onClick={() => setDeadKnown(true)}>{t("erDesk.dead.known")}</button>
              </div>
              {deadKnown ? patientPicker() : (
                <>
                  <Choice label={t("erDesk.sex")} values={ER_SEXES} value={sex} onPick={setSex} word={sexWord} testid="er-desk-dead-sex" />
                  <Choice label={t("erDesk.age")} values={ER_AGE_BANDS} value={band} onPick={setBand} word={bandWord} testid="er-desk-dead-age" />
                </>
              )}
              <Choice label={t("erDesk.mode")} values={ER_ARRIVAL_MODES} value={mode} onPick={setMode} word={modeWord} testid="er-desk-dead-mode" />
              <label className="erd-field"><span>{t("erDesk.dead.examinedBy")}</span>
                <select value={examinedBy} onChange={(e) => setExaminedBy(e.target.value)} data-testid="er-desk-dead-doctor">
                  <option value="">{t("erDesk.dead.pickDoctor")}</option>
                  {doctors.map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}
                </select>
              </label>
              <label className="erd-check"><input type="checkbox" checked={ecg} onChange={(e) => setEcg(e.target.checked)} />{t("erDesk.dead.ecg")}</label>
              <p className="erd-hint">{t("erDesk.dead.hint")}</p>
              <button type="button" className="erx-btn danger big" disabled={!canDead} onClick={() => void recordDead()} data-testid="er-desk-dead-record">{t("erDesk.dead.record")}</button>
            </div>
          ) : null}

          {refusal !== null ? <Refusal r={refusal} t={t} onFix={typeof refusal !== "string" && refusal.code === "episode_already_open" ? () => document.getElementById(`er-row-${String(refusal.detail?.episodeId)}`)?.scrollIntoView({ block: "center" }) : undefined} /> : null}
          {note !== null ? <div className="erd-note" role="status">{note}</div> : null}
        </section>

        <section className="erd-list" aria-label={t("erDesk.list")}>
          <h2>{t("erDesk.expected.title")} <span className="erb-badge">{desk?.expected.length ?? 0}</span></h2>
          {desk !== null && desk.expected.length === 0 ? <div className="erb-empty">{t("erBoard.empty.expected")}</div> : null}
          {desk?.expected.map((c) => (
            <article key={c.preAlertId} className="erd-exp" data-testid="er-desk-expected">
              {c.patientLabel !== null ? <div><b>{c.patientLabel}</b></div> : null}
              <div><b>{modeWord(c.mode)}</b> · {fmtIst(c.expectedAt)}{c.count > 1 ? ` · ${t("erBoard.count", { arrived: c.arrivedCount, total: c.count })}` : ""}</div>
              {c.complaint !== null ? <p className="erb-complaint">{c.complaint}</p> : null}
              <div className="erd-row">
                <button type="button" className="erx-btn sm pri" onClick={() => fromPreAlert(c)}>{t("erDesk.expected.arrived")}</button>
                <button type="button" className="erx-btn sm" onClick={() => void act(async () => { await cancelPreAlertApi(c.preAlertId, "not_coming"); })}>{t("erDesk.expected.notComing")}</button>
              </div>
            </article>
          ))}
          <h2>{t("erDesk.today")} <span className="erb-badge">{desk?.episodes.length ?? 0}</span></h2>
          {desk !== null && desk.episodes.length === 0 ? <div className="erb-empty">{t("erDesk.noneToday")}</div> : null}
          {desk?.episodes.map((row) => (
            <DeskRow key={row.episodeId} row={row} t={t} highlight={highlight === row.episodeId} mayLink={can("patients.merge")} onChanged={load} />
          ))}
        </section>
      </div>
    </div>
  );
}

function DeskRow({ row, t, highlight, mayLink, onChanged }: { row: ErDeskRow; t: T; highlight: boolean; mayLink: boolean; onChanged: () => void }): React.ReactElement {
  const { i18n } = useTranslation();
  const name = aliasFirst(row.name, row.nameHi, i18n.language);
  const [identify, setIdentify] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [hits, setHits] = useState<ErPatientHit[]>([]);
  const [truth, setTruth] = useState<ErPatientHit | null>(null);
  const [how, setHow] = useState("family");
  const [why, setWhy] = useState("");
  const [msg, setMsg] = useState<ErRefusalBody | string | null>(null);
  const [band, setBand] = useState<BandOut | null>(null);
  useEffect(() => {
    if (!identify || dq.trim().length < 2) { setHits([]); return; }
    searchErPatients(dq).then((h) => setHits(h.filter((x) => !x.unidentified && x.patientId !== row.patientId)), () => setHits([]));
  }, [dq, identify, row.patientId]);
  const open = ["arrived", "triaged", "in_treatment", "disposition_decided"].includes(row.state);
  const late = new Date(row.registeredAt).getTime() - new Date(row.arrivedAt).getTime() > 2 * 60_000;
  const run = async (w: () => Promise<void>): Promise<void> => {
    setMsg(null);
    try { await w(); onChanged(); } catch (e) { setMsg(erRefusalOf(e) ?? t("erDesk.failed")); }
  };
  return (
    <article id={`er-row-${row.episodeId}`} className={`erd-ep${highlight ? " hl" : ""}${open ? "" : " closed"}`} data-testid="er-desk-row">
      <div className="erd-ep-top">
        <div className="erd-ep-name">
          <b>{name.main}</b>{name.other !== null ? <span>{name.other}</span> : null}
        </div>
        <span className="erd-state">{t(`er.state.${row.state}`)}</span>
      </div>
      <div className="erb-meta">
        <span className="mono">{row.episodeNo}</span><span className="mono">{row.uhid}</span>
        <span>{ageSexWords(t, row.ageYears, row.ageBand, row.sex)}</span><span>{t(`er.mode.${row.arrivalMode}`)}</span>
        <span>{t("erDesk.came", { time: fmtIst(row.arrivedAt) })}{late ? ` · ${t("erDesk.entered", { time: fmtIst(row.registeredAt) })}` : ""}</span>
      </div>
      <div className="erb-chips">
        {row.unidentified ? <span className="erb-chip unidentified">{t("er.chip.unidentified")}</span> : null}
        {row.returnedWithin24h ? <span className="erb-chip returned_24h">{t("er.chip.returned_24h")}</span> : null}
        {row.identity !== null ? <span className={`erb-chip id-${row.identity.stage}`}>{t(`erDesk.identity.${row.identity.stage}`, { uhid: row.identity.trueUhid })}</span> : null}
        {row.band !== null && row.band.stale ? <span className="erb-chip stale">{t("erDesk.bandStale")}</span> : null}
      </div>
      {open ? (
        <div className="erd-row">
          {row.band === null ? <button type="button" className="erx-btn sm" onClick={() => void run(async () => setBand(await printBandApi(row.episodeId)))}>{t("erDesk.printBand")}</button>
            : <button type="button" className={`erx-btn sm${row.band.stale ? " pri" : ""}`} onClick={() => void run(async () => setBand(await reprintBandApi(row.episodeId, row.band!.stale ? "identity_linked" : "damaged")))}>{t("erDesk.reprintBand")}</button>}
          {row.unidentified && row.identity?.stage !== "waiting" && row.identity?.stage !== "granted" && mayLink ? (
            <button type="button" className="erx-btn sm" onClick={() => setIdentify(!identify)} aria-expanded={identify}>{t("erDesk.identify")}</button>
          ) : null}
        </div>
      ) : null}
      {band !== null ? <p className="erd-hint" role="status">{t("erDesk.bandPrinted", { serial: band.bandSerial })}</p> : null}
      {identify ? (
        <div className="erd-identify" data-testid="er-desk-identify">
          <label className="erd-field"><span>{t("erDesk.identifyFind")}</span><input value={q} onChange={(e) => { setQ(e.target.value); setTruth(null); }} /></label>
          {truth === null ? (
            <ul className="erd-hits">{hits.map((h) => (
              <li key={h.patientId}><button type="button" onClick={() => setTruth(h)}><b>{h.name}</b><span className="mono">{h.uhid}</span></button></li>
            ))}</ul>
          ) : <div className="erd-picked"><b>{truth.name}</b><span className="mono">{truth.uhid}</span></div>}
          <div className="erd-opts">
            {(["family", "id_document", "police", "abha", "other"] as const).map((h) => (
              <button key={h} type="button" className={`erd-opt sm${how === h ? " on" : ""}`} aria-pressed={how === h} onClick={() => setHow(h)}>{t(`erDesk.how.${h}`)}</button>
            ))}
          </div>
          <label className="erd-field"><span>{t("erDesk.identifyNote")}</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <button type="button" className="erx-btn pri" disabled={truth === null || why.trim() === ""}
            onClick={() => void run(async () => { await linkIdentityApi({ episodeId: row.episodeId, truePatientId: truth!.patientId, how, note: why.trim() }); setIdentify(false); })}>
            {t("erDesk.identifySend")}
          </button>
          <p className="erd-hint">{t("erDesk.identifyHint")}</p>
        </div>
      ) : null}
      {msg !== null ? <Refusal r={msg} t={t} /> : null}
    </article>
  );
}
