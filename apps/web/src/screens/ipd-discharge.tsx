import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type {
  IpdDischargeBoard, IpdDischargeDepartment, IpdDischargeTracker, IpdFinalBill, IpdRefusalBody, IpdSummaryContent, IpdSummaryView,
} from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst, fmtPaise } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import {
  HAND_GATE_ID, askDuesApproval, cancelFit, confirmDepartment, declareFit, getDischargeBoard, getDischargeTracker, getSummary,
  issueGatePass, prepareFinalBill, saveSummary, scanGatePass, settleFinalBill, signSummary,
} from "../lib/ipd-discharge-api";
import { newIdempotencyKey } from "../lib/api";
import { listPatientDocuments } from "../lib/patients-api";
import type { WirePatientDocument } from "../lib/patients-api";
import type { Tender } from "../lib/ipd-discharge-api";
import { FamilyCard } from "./ipd-family-panel";
import "./ipd-discharge.css";

/*
 * E3.2 (#730) — THE DISCHARGE DESK (spec §4.7, §4.9 F, staff view of the family tracker board). Left: every admission in
 * the cascade (fit declared, gate pass out) and the stays ended today, oldest fit first. Right: one admission's steps —
 * fit → departments → summary → bill → gate pass → exit — each with its time or whom it waits for, the 3-hour clock
 * ticking, and the blocker named. The buttons are only the acts the viewer may do now (the server's `can`). Money shows
 * only when the server sent it (`bill` is null for a doctor — decision 0058). Prints: the final bill and the gate pass.
 * 1920×1080 first; fits 1366×768 without the page scrolling sideways. `?admission=<id>` opens one admission (the desk
 * reaches an admitted patient this way to declare fit).
 */

type T = (k: string, o?: Record<string, unknown>) => string;
const POLL_MS = 20_000;

function spanWords(ms: number, t: T): string {
  const min = Math.floor(Math.abs(ms) / 60_000);
  if (min < 1) return t("ipdDischarge.dur.justNow");
  if (min < 60) return t("ipdDischarge.dur.min", { n: min });
  return t("ipdDischarge.dur.hourMin", { h: Math.floor(min / 60), m: min % 60 });
}

function useRefusal(): [IpdRefusalBody | string | null, (e: unknown) => void, () => void] {
  const [r, setR] = useState<IpdRefusalBody | string | null>(null);
  return [r, (e: unknown) => setR(refusalOf(e) ?? (e instanceof ApiError ? String((e.body as { message?: string } | null)?.message ?? e.message) : "failed")), () => setR(null)];
}

function Refusal({ r }: { r: IpdRefusalBody | string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (r === null) return null;
  if (typeof r === "string") return <div className="ipdd-refusal" role="alert">{r === "failed" ? t("ipdDischarge.actFailed") : r}</div>;
  return <div className="ipdd-refusal" role="alert"><b>{r.rule}</b> {r.fix ? <span className="fix">→ {r.fix}</span> : null}</div>;
}

export function IpdDischarge(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { admission?: string };
  const navigate = useNavigate();
  const [board, setBoard] = useState<IpdDischargeBoard | null>(null);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const selected = search.admission ?? null;
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    getDischargeBoard().then(
      (b) => { setBoard(b); setError(null); },
      (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? "forbidden" : "failed"),
    );
  }, []);
  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const open = (id: string) => { void navigate({ to: "/ipd/discharge", search: { admission: id } as never }); };

  return (
    <main className="ipdd" data-testid="ipd-discharge">
      <header className="ipdd-head">
        <h1>{t("ipdDischarge.title")}</h1>
        {board !== null ? <span className="count">{t("ipdDischarge.inCascade", { count: board.rows.filter((r) => r.state === "fit_declared" || r.state === "discharging").length })}</span> : null}
        <ScanBox onDone={load} />
      </header>
      {error === "forbidden" ? <div className="ipdd-empty" role="alert">{t("ipdDischarge.forbidden")}</div> : null}
      {error === "failed" ? <div className="ipdd-refusal" role="alert">{t("ipdDischarge.loadFailed")}</div> : null}
      <div className="ipdd-grid">
        <nav className="ipdd-list" aria-label={t("ipdDischarge.listLabel")}>
          {board === null && error === null ? <div className="ipdd-empty">{t("ipdDischarge.loading")}</div> : null}
          {board !== null && board.rows.length === 0 ? <div className="ipdd-empty">{t("ipdDischarge.empty")}</div> : null}
          {board?.rows.map((r) => {
            const left = r.targetAt === null ? null : new Date(r.targetAt).getTime() - now;
            const late = left !== null && left < 0 && (r.state === "fit_declared");
            return (
              <button key={r.admissionId} type="button" className={`ipdd-row${selected === r.admissionId ? " on" : ""}${late ? " late" : ""}`}
                onClick={() => open(r.admissionId)} data-testid={`ipdd-row-${r.admissionId}`}>
                <span className="who"><b>{r.patientName ?? r.uhid}</b><span className="mono">{r.bedCode ?? "—"}</span></span>
                <span className="meta">
                  <span className={`chip st-${r.state}`}>{t(`ipdDischarge.state.${r.state}`)}</span>
                  {r.nextStep !== null ? <span>{t("ipdDischarge.next", { step: t(`ipdDischarge.step.${r.nextStep}`) })}</span> : null}
                </span>
                {left !== null && r.state === "fit_declared" ? (
                  <span className={`clock${late ? " late" : ""}`}>{late ? `⚠ ${t("ipdDischarge.overBy", { span: spanWords(left, t as T) })}` : `⏱ ${t("ipdDischarge.leftIn", { span: spanWords(left, t as T) })}`}</span>
                ) : null}
                {r.blocker !== null ? <span className="blocker">{r.blocker}</span> : null}
              </button>
            );
          })}
        </nav>
        <section className="ipdd-detail">
          {selected === null ? <div className="ipdd-empty">{t("ipdDischarge.pick")}</div> : <Tracker key={selected} admissionId={selected} now={now} onChanged={load} />}
        </section>
      </div>
    </main>
  );
}

function ScanBox({ onDone }: { onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [r, fail, clear] = useRefusal();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim() === "") return;
    setBusy(true); clear(); setOk(null);
    scanGatePass(code.trim(), HAND_GATE_ID).then(
      () => { setBusy(false); setOk(code.trim()); setCode(""); onDone(); },
      (err: unknown) => { setBusy(false); fail(err); },
    );
  };
  return (
    <form className="ipdd-scan" onSubmit={submit} aria-label={t("ipdDischarge.scan.label")}>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("ipdDischarge.scan.placeholder")} aria-label={t("ipdDischarge.scan.label")} />
      <button type="submit" className="ipdd-btn" disabled={busy}>{t("ipdDischarge.scan.go")}</button>
      {ok !== null ? <span className="ok" role="status">✓ {t("ipdDischarge.scan.ok", { code: ok })}</span> : null}
      <Refusal r={r} />
    </form>
  );
}

function Tracker({ admissionId, now, onChanged }: { admissionId: string; now: number; onChanged: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [tr, setTr] = useState<IpdDischargeTracker | null>(null);
  const [failed, setFailed] = useState(false);
  const [printing, setPrinting] = useState<"bill" | "pass" | null>(null);
  const reload = useCallback(() => {
    getDischargeTracker(admissionId).then((x) => { setTr(x); setFailed(false); }, () => setFailed(true));
  }, [admissionId]);
  useEffect(() => { reload(); const id = setInterval(reload, POLL_MS); return () => clearInterval(id); }, [reload]);
  useEffect(() => {
    if (printing === null) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const id = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(id); window.removeEventListener("afterprint", done); };
  }, [printing]);
  const changed = () => { reload(); onChanged(); };
  if (failed && tr === null) return <div className="ipdd-refusal" role="alert">{t("ipdDischarge.loadFailed")}</div>;
  if (tr === null) return <div className="ipdd-empty">{t("ipdDischarge.loading")}</div>;
  const left = tr.targetAt === null ? null : new Date(tr.targetAt).getTime() - now;
  return (
    <div className="ipdd-tracker" data-print={printing ?? undefined} data-testid="ipdd-tracker">
      <div className="screen-only">
        <header className="ipdd-id">
          <div>
            <b className="name">{tr.patient.name ?? tr.patient.uhid}</b>
            <span>{tr.patient.ageSex}</span>
            <span className="mono">UHID {tr.patient.uhid}</span>
            {tr.admissionNo !== null ? <span className="mono">{tr.admissionNo}</span> : null}
          </div>
          <div className="dim">
            {tr.bedCode !== null ? <span className="mono">{tr.bedCode}</span> : null}{tr.wardName !== null ? ` · ${tr.wardName}` : ""} · {t("ipdDischarge.consultant", { name: tr.consultant.name })}
            {tr.disposition === "transfer_out" ? <span className="chip warn"> {t("ipdDischarge.referOut")}</span> : null}
          </div>
          <div className="clockline">
            <span className={`chip st-${tr.state}`}>{t(`ipdDischarge.state.${tr.state}`)}</span>
            {tr.fitAt !== null ? <span>{t("ipdDischarge.fitAt", { time: fmtIst(tr.fitAt) })}</span> : null}
            {tr.targetAt !== null ? <span>{t("ipdDischarge.targetAt", { time: fmtIst(tr.targetAt) })}</span> : null}
            {left !== null && tr.state === "fit_declared" ? (
              <span className={`clock${left < 0 ? " late" : ""}`} role="timer">{left < 0 ? `⚠ ${t("ipdDischarge.overBy", { span: spanWords(left, t as T) })}` : `⏱ ${t("ipdDischarge.leftIn", { span: spanWords(left, t as T) })}`}</span>
            ) : null}
          </div>
        </header>
        {tr.blocker !== null ? <div className="ipdd-blocker" role="status">⛔ {tr.blocker}</div> : null}
        <div className="ipdd-cols">
          <Steps tr={tr} />
          <div className="ipdd-cards">
            <FitCard tr={tr} onDone={changed} />
            <DepartmentsCard tr={tr} onDone={changed} />
            <SummaryCard tr={tr} onDone={changed} />
            <BillCard tr={tr} onDone={changed} onPrint={() => setPrinting("bill")} />
            <GatePassCard tr={tr} onDone={changed} onPrint={() => setPrinting("pass")} />
            {/* E3.3 (#731) — the family link, the condition word and the family's callbacks. */}
            <FamilyCard admissionId={tr.admissionId} />
          </div>
        </div>
      </div>
      {printing === "bill" && tr.bill !== null ? <BillPrint tr={tr} bill={tr.bill} /> : null}
      {printing === "pass" && tr.gatePass !== null ? <PassPrint tr={tr} /> : null}
    </div>
  );
}

function Steps({ tr }: { tr: IpdDischargeTracker }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <ol className="ipdd-steps" aria-label={t("ipdDischarge.stepsTitle")}>
      {tr.steps.map((s, i) => (
        <li key={s.key} className={`s-${s.state}`} data-testid={`ipdd-step-${s.key}`}>
          <span className="dot" aria-hidden="true">{s.state === "done" ? "✓" : s.state === "skipped" ? "–" : ""}</span>
          {i < tr.steps.length - 1 ? <span className="rail" aria-hidden="true" /> : null}
          <span className="label">{t(`ipdDischarge.step.${s.key}`)}</span>
          <span className="when">
            {s.state === "done" && s.at !== null ? t("ipdDischarge.doneAt", { time: fmtIst(s.at) })
              : s.state === "skipped" ? t("ipdDischarge.skipped")
                : s.waitingFor !== null ? t("ipdDischarge.waitingFor", { who: s.waitingFor })
                  : t(`ipdDischarge.stepState.${s.state}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function FitCard({ tr, onDone }: { tr: IpdDischargeTracker; onDone: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const [disp, setDisp] = useState<"home" | "transfer_out">("home");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, fail, clear] = useRefusal();
  if (!tr.can.declareFit && !tr.can.cancelFit) return null;
  const run = (p: Promise<unknown>) => { setBusy(true); clear(); p.then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); fail(e); }); };
  return (
    <article className="ipdd-card">
      <h2>{t("ipdDischarge.fit.title")}</h2>
      {tr.can.declareFit ? (
        <div className="row">
          <select value={disp} onChange={(e) => setDisp(e.target.value as "home" | "transfer_out")} aria-label={t("ipdDischarge.fit.disposition")}>
            <option value="home">{t("ipdDischarge.fit.home")}</option>
            <option value="transfer_out">{t("ipdDischarge.fit.transferOut")}</option>
          </select>
          <button type="button" className="ipdd-btn pri" disabled={busy} onClick={() => run(declareFit(tr.admissionId, disp))}>{t("ipdDischarge.fit.declare")}</button>
        </div>
      ) : null}
      {tr.can.cancelFit ? (
        <div className="row">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ipdDischarge.fit.cancelReason")} aria-label={t("ipdDischarge.fit.cancelReason")} />
          <button type="button" className="ipdd-btn" disabled={busy || reason.trim() === ""} onClick={() => run(cancelFit(tr.admissionId, reason.trim()))}>{t("ipdDischarge.fit.cancel")}</button>
        </div>
      ) : null}
      <Refusal r={r} />
    </article>
  );
}

function DepartmentsCard({ tr, onDone }: { tr: IpdDischargeTracker; onDone: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [r, fail, clear] = useRefusal();
  if (tr.departments.length === 0) return null;
  const confirm = (d: IpdDischargeDepartment) => {
    setBusy(true); clear();
    confirmDepartment(tr.admissionId, d).then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); fail(e); });
  };
  return (
    <article className="ipdd-card">
      <h2>{t("ipdDischarge.depts.title")}</h2>
      <ul className="ipdd-depts">
        {tr.departments.map((d) => (
          <li key={d.department} className={d.confirmedAt !== null ? "done" : "wait"}>
            <span className="name">{d.confirmedAt !== null ? "✓ " : "○ "}{t(`ipdDischarge.dept.${d.department}`)}</span>
            <span className="dim">
              {d.confirmedAt !== null ? t("ipdDischarge.depts.confirmedBy", { name: d.confirmedBy ?? "", time: fmtIst(d.confirmedAt) }) : t(`ipdDischarge.depts.basis.${d.basis}`)}
            </span>
            {tr.can.confirm.includes(d.department) ? (
              <button type="button" className="ipdd-btn pri" disabled={busy} onClick={() => confirm(d.department)}>{t("ipdDischarge.depts.confirm")}</button>
            ) : null}
          </li>
        ))}
      </ul>
      <Refusal r={r} />
    </article>
  );
}

const EMPTY_SUMMARY: IpdSummaryContent = {
  diagnosis: { text: "" }, course: "", procedures: "", conditionAtDischarge: "", medicines: [], followUp: "", advice: "", warningSigns: "", pendingResults: "",
};

function medsToText(c: IpdSummaryContent): string {
  return c.medicines.map((m) => [m.name, m.dose, m.frequency, m.duration].filter((x) => x !== undefined && x !== "").join(" — ")).join("\n");
}
function textToMeds(s: string): IpdSummaryContent["medicines"] {
  return s.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => {
    const [name, dose, frequency, duration] = l.split("—").map((x) => x.trim());
    return { name: name!, ...(dose ? { dose } : {}), ...(frequency ? { frequency } : {}), ...(duration ? { duration } : {}), source: "typed" as const };
  });
}

function SummaryCard({ tr, onDone }: { tr: IpdDischargeTracker; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [view, setView] = useState<IpdSummaryView | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<IpdSummaryContent>(EMPTY_SUMMARY);
  const [meds, setMeds] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, fail, clear] = useRefusal();
  const status = tr.summary.status;
  useEffect(() => {
    if (status === "none") { setView(null); return; }
    getSummary(tr.admissionId).then(setView, () => setView(null));
  }, [tr.admissionId, status, tr.summary.version]);
  const startEdit = () => {
    const c = view?.content ?? EMPTY_SUMMARY;
    setDraft(c); setMeds(medsToText(c)); setEditing(true); clear();
  };
  const save = () => {
    setBusy(true); clear();
    const content: IpdSummaryContent = { ...draft, medicines: textToMeds(meds) };
    if (content.diagnosis.icd10Code === "") delete content.diagnosis.icd10Code;
    saveSummary(tr.admissionId, view?.version ?? 0, content).then(
      (v) => { setBusy(false); setView(v); setEditing(false); onDone(); },
      (e: unknown) => { setBusy(false); fail(e); },
    );
  };
  const sign = () => {
    if (view === null) return;
    setBusy(true); clear();
    signSummary(tr.admissionId, view.summaryId, view.version).then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); fail(e); });
  };
  const field = (k: Exclude<keyof IpdSummaryContent, "diagnosis" | "medicines">, rows = 2) => (
    <label key={k}>{t(`ipdDischarge.summary.f.${k}`)}
      <textarea rows={rows} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </label>
  );
  return (
    <article className="ipdd-card">
      <h2>{t("ipdDischarge.summary.title")} <span className={`chip sum-${status}`}>{t(`ipdDischarge.summary.status.${status}`)}</span></h2>
      {view !== null && !editing ? (
        <div className="ipdd-sum">
          <p><b>{t("ipdDischarge.summary.f.diagnosis")}:</b> {view.content.diagnosis.text}{view.content.diagnosis.icd10Code ? <span className="mono"> ({view.content.diagnosis.icd10Code})</span> : null}</p>
          {view.content.medicines.length > 0 ? <p><b>{t("ipdDischarge.summary.f.medicines")}:</b> {view.content.medicines.map((m) => m.name).join(", ")}</p> : null}
          <p className="dim">
            {view.signedBy !== null ? t("ipdDischarge.summary.signedBy", { name: view.signedBy.name, time: view.signedAt === null ? "" : fmtIst(view.signedAt) })
              : view.residentSignedBy !== null ? t("ipdDischarge.summary.residentSigned", { name: view.residentSignedBy.name })
                : t("ipdDischarge.summary.draftBy", { name: view.provenance.draftedBy.name })}
          </p>
        </div>
      ) : null}
      {editing ? (
        <div className="ipdd-form">
          <div className="pair">
            <label>{t("ipdDischarge.summary.f.diagnosis")}
              <input value={draft.diagnosis.text} onChange={(e) => setDraft({ ...draft, diagnosis: { ...draft.diagnosis, text: e.target.value } })} />
            </label>
            <label>{t("ipdDischarge.summary.f.icd10")}
              <input value={draft.diagnosis.icd10Code ?? ""} onChange={(e) => setDraft({ ...draft, diagnosis: { ...draft.diagnosis, icd10Code: e.target.value } })} />
            </label>
          </div>
          {field("course", 3)}
          <div className="pair">{field("procedures")}{field("conditionAtDischarge")}</div>
          <label>{t("ipdDischarge.summary.f.medicines")} <span className="dim">{t("ipdDischarge.summary.medsHint")}</span>
            <textarea rows={3} value={meds} onChange={(e) => setMeds(e.target.value)} />
          </label>
          <div className="pair">{field("followUp")}{field("advice")}</div>
          <div className="pair">{field("warningSigns")}{field("pendingResults")}</div>
          <div className="row">
            <button type="button" className="ipdd-btn pri" disabled={busy || draft.diagnosis.text.trim() === ""} onClick={save}>{t("ipdDischarge.summary.save")}</button>
            <button type="button" className="ipdd-btn" onClick={() => setEditing(false)}>{t("ipdDischarge.cancel")}</button>
          </div>
        </div>
      ) : (
        <div className="row">
          {tr.can.editSummary ? <button type="button" className="ipdd-btn" onClick={startEdit}>{status === "none" ? t("ipdDischarge.summary.write") : t("ipdDischarge.summary.edit")}</button> : null}
          {tr.can.signSummary && view !== null ? <button type="button" className="ipdd-btn pri" disabled={busy} onClick={sign}>{t("ipdDischarge.summary.sign")}</button> : null}
        </div>
      )}
      <Refusal r={r} />
    </article>
  );
}

function BillCard({ tr, onDone, onPrint }: { tr: IpdDischargeTracker; onDone: () => void; onPrint: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const [bill, setBill] = useState<IpdFinalBill | null>(null);
  const [tender, setTender] = useState<Tender>("cash");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [docs, setDocs] = useState<WirePatientDocument[] | null>(null);
  const [undertaking, setUndertaking] = useState("");
  const [attempt, setAttempt] = useState<{ sig: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [r, fail, clear] = useRefusal();
  const shown = bill ?? tr.bill;
  if (shown === null) return null;
  const settled = shown.settled;
  const due = Math.max(0, shown.balancePaise);
  const paidPaise = Math.round(Number(amount || "0") * 100);
  const short = Math.max(0, due - paidPaise);
  const prepare = () => {
    setBusy(true); clear();
    prepareFinalBill(tr.admissionId).then((b) => { setBusy(false); setBill(b); setAmount((Math.max(0, b.balancePaise) / 100).toFixed(2)); }, (e: unknown) => { setBusy(false); fail(e); });
    listPatientDocuments(tr.patient.id).then(setDocs, () => setDocs([]));
  };
  const askDues = () => {
    if (settled === null) return;
    setBusy(true); clear();
    askDuesApproval(tr.admissionId, settled.duesPaise, t("ipdDischarge.bill.duesNote")).then((x) => { setBusy(false); setApprovalId(x.approvalId); }, (e: unknown) => { setBusy(false); fail(e); });
  };
  const settle = () => {
    setBusy(true); clear();
    const payments = paidPaise > 0 ? [{ tender, amountPaise: paidPaise, ...(tender !== "cash" && ref.trim() !== "" ? { ref: ref.trim() } : {}) }] : [];
    const withDues = short > 0;
    const body = {
      admissionId: tr.admissionId, billVersion: shown.billVersion, patientPayablePaise: shown.patientPaise,
      settlement: withDues ? "dues_recorded" as const : shown.balancePaise < 0 ? "refund_due" as const : "paid" as const, payments,
      ...(withDues && undertaking !== "" ? { undertakingDocumentId: undertaking } : {}),
    };
    // One key per attempt: a retry of the same form re-sends it; a changed form is a new attempt.
    const sig = JSON.stringify(body);
    const key = attempt?.sig === sig ? attempt.key : newIdempotencyKey();
    setAttempt({ sig, key });
    settleFinalBill(key, body).then(() => { setBusy(false); setBill(null); setAttempt(null); onDone(); }, (e: unknown) => { setBusy(false); fail(e); });
  };
  return (
    <article className="ipdd-card">
      <h2>{t("ipdDischarge.bill.title")} {settled !== null ? <span className="chip ok">{t(`ipdDischarge.bill.settlement.${settled.settlement}`)}</span> : null}</h2>
      <table className="ipdd-money">
        <tbody>
          <tr><td>{t("ipdDischarge.bill.total")}</td><td className="num">{fmtPaise(shown.totalPaise)}</td></tr>
          {shown.payerPaise > 0 ? <tr><td>{t("ipdDischarge.bill.payer")}</td><td className="num">{fmtPaise(shown.payerPaise)}</td></tr> : null}
          <tr><td>{t("ipdDischarge.bill.patient")}</td><td className="num">{fmtPaise(shown.patientRoundedPaise)}</td></tr>
          <tr><td>{t("ipdDischarge.bill.deposit")}</td><td className="num">{fmtPaise(shown.depositHeldPaise)}</td></tr>
          {settled === null ? (
            <tr className="sum"><td>{shown.balancePaise < 0 ? t("ipdDischarge.bill.refund") : t("ipdDischarge.bill.toPay")}</td><td className="num">{fmtPaise(Math.abs(shown.balancePaise))}</td></tr>
          ) : (
            <>
              <tr className="sum"><td>{t("ipdDischarge.print.paid")}</td><td className="num">{fmtPaise(settled.paidPaise)}</td></tr>
              {settled.refundPaise > 0 ? <tr><td>{t("ipdDischarge.bill.refund")}</td><td className="num">{fmtPaise(settled.refundPaise)}</td></tr> : null}
              {settled.duesPaise > 0 ? <tr className="dues"><td>{t("ipdDischarge.bill.dues")}</td><td className="num">{fmtPaise(settled.duesPaise)}</td></tr> : null}
            </>
          )}
        </tbody>
      </table>
      {settled !== null ? (
        <div className="row">
          <span className="dim">{t("ipdDischarge.bill.billNo", { no: settled.billNo ?? "—", time: fmtIst(settled.settledAt) })}</span>
          {settled.refundState === "refund_pending" ? <span className="chip warn">{t("ipdDischarge.bill.refundPending")}</span> : null}
          <button type="button" className="ipdd-btn" onClick={onPrint}>🖶 {t("ipdDischarge.bill.print")}</button>
          {settled.duesPaise > 0 && !settled.duesApproved && approvalId === null ? (
            <button type="button" className="ipdd-btn" disabled={busy} onClick={askDues}>{t("ipdDischarge.bill.askDues")}</button>
          ) : null}
          {approvalId !== null ? <span className="dim">{t("ipdDischarge.bill.duesAsked")}</span> : null}
        </div>
      ) : tr.can.settle ? (
        bill === null ? (
          <div className="row"><button type="button" className="ipdd-btn pri" disabled={busy} onClick={prepare}>{t("ipdDischarge.bill.prepare")}</button></div>
        ) : (
          <div className="ipdd-form">
            <div className="pair">
              <label>{t("ipdDischarge.bill.tender")}
                <select value={tender} onChange={(e) => setTender(e.target.value as Tender)}>
                  <option value="cash">{t("ipdDischarge.bill.cash")}</option><option value="upi">UPI</option><option value="card">{t("ipdDischarge.bill.card")}</option>
                </select>
              </label>
              <label>{t("ipdDischarge.bill.amount")}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            </div>
            {tender !== "cash" ? <label>{t("ipdDischarge.bill.ref")}<input value={ref} onChange={(e) => setRef(e.target.value)} /></label> : null}
            {short > 0 ? (
              <div className="ipdd-dues">
                <span>⚖ {t("ipdDischarge.bill.duesLine", { amount: fmtPaise(short) })}</span>
                <label>{t("ipdDischarge.bill.undertaking")}
                  <select value={undertaking} onChange={(e) => setUndertaking(e.target.value)}>
                    <option value="">{t("ipdDischarge.bill.pickUndertaking")}</option>
                    {(docs ?? []).map((d) => <option key={d.id} value={d.id}>{d.kind} · {fmtIst(d.capturedAt)}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
            <div className="row"><button type="button" className="ipdd-btn pri" disabled={busy || (short > 0 && undertaking === "")} onClick={settle}>{t("ipdDischarge.bill.settle")}</button></div>
          </div>
        )
      ) : null}
      <Refusal r={r} />
    </article>
  );
}

function GatePassCard({ tr, onDone, onPrint }: { tr: IpdDischargeTracker; onDone: () => void; onPrint: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const [hospital, setHospital] = useState("");
  const [confirmedBy, setConfirmedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, fail, clear] = useRefusal();
  if (tr.gatePass === null && !tr.can.issueGatePass && tr.state !== "fit_declared") return null;
  const refer = tr.disposition === "transfer_out";
  const issue = () => {
    setBusy(true); clear();
    issueGatePass(tr.admissionId, refer ? { name: hospital.trim(), confirmedBy: confirmedBy.trim() } : undefined)
      .then(() => { setBusy(false); onDone(); }, (e: unknown) => { setBusy(false); fail(e); });
  };
  const p = tr.gatePass;
  return (
    <article className="ipdd-card">
      <h2>{t("ipdDischarge.pass.title")}</h2>
      {p !== null ? (
        <div className="ipdd-pass">
          <span className="code mono" data-testid="ipdd-pass-code">{p.code}</span>
          <span className={`chip pass-${p.status}`}>{t(`ipdDischarge.pass.status.${p.status}`)}</span>
          {p.duesRecorded ? <span className="chip warn">{t("ipdDischarge.pass.dues")}</span> : null}
          {p.receivingHospital !== null ? <span className="dim">→ {p.receivingHospital}</span> : null}
          <button type="button" className="ipdd-btn" onClick={onPrint}>🖶 {t("ipdDischarge.pass.print")}</button>
        </div>
      ) : tr.can.issueGatePass ? (
        <div className="ipdd-form">
          {refer ? (
            <div className="pair">
              <label>{t("ipdDischarge.pass.hospital")}<input value={hospital} onChange={(e) => setHospital(e.target.value)} /></label>
              <label>{t("ipdDischarge.pass.confirmedBy")}<input value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} /></label>
            </div>
          ) : null}
          <div className="row"><button type="button" className="ipdd-btn pri" disabled={busy || (refer && (hospital.trim() === "" || confirmedBy.trim() === ""))} onClick={issue}>{t("ipdDischarge.pass.issue")}</button></div>
        </div>
      ) : <p className="dim">{t("ipdDischarge.pass.notYet")}</p>}
      <Refusal r={r} />
    </article>
  );
}

function PrintHead({ tr, title }: { tr: IpdDischargeTracker; title: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <header className="ph">
      <h1>{title}</h1>
      <dl>
        <div><dt>{t("ipdDischarge.print.patient")}</dt><dd>{tr.patient.name ?? "—"} · {tr.patient.ageSex}</dd></div>
        <div><dt>UHID</dt><dd className="mono">{tr.patient.uhid}</dd></div>
        <div><dt>{t("ipdDischarge.print.ipNo")}</dt><dd className="mono">{tr.admissionNo ?? "—"}</dd></div>
        <div><dt>{t("ipdDischarge.print.bed")}</dt><dd>{tr.bedCode ?? "—"}{tr.wardName !== null ? ` · ${tr.wardName}` : ""}</dd></div>
        <div><dt>{t("ipdDischarge.print.consultant")}</dt><dd>{tr.consultant.name}</dd></div>
      </dl>
    </header>
  );
}

function BillPrint({ tr, bill }: { tr: IpdDischargeTracker; bill: IpdFinalBill }): React.ReactElement {
  const { t } = useTranslation();
  const s = bill.settled;
  return (
    <section className="ipdd-print" data-testid="ipdd-bill-print">
      <PrintHead tr={tr} title={t("ipdDischarge.print.billTitle")} />
      <p className="mono">{t("ipdDischarge.print.billNo", { no: s?.billNo ?? "—" })}</p>
      <table>
        <thead><tr><th>{t("ipdDischarge.print.date")}</th><th>{t("ipdDischarge.print.item")}</th><th className="num">{t("ipdDischarge.print.qty")}</th><th className="num">{t("ipdDischarge.print.amount")}</th>{bill.payerPaise > 0 ? <><th className="num">{t("ipdDischarge.bill.payer")}</th><th className="num">{t("ipdDischarge.bill.patient")}</th></> : null}</tr></thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.lineId}><td>{l.serviceDate}</td><td>{l.serviceName}</td><td className="num">{l.qty}</td><td className="num">{fmtPaise(l.netPaise)}</td>
              {bill.payerPaise > 0 ? <><td className="num">{fmtPaise(l.payerPaise)}</td><td className="num">{fmtPaise(l.patientPaise)}</td></> : null}</tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>{t("ipdDischarge.bill.total")}</td><td className="num">{fmtPaise(bill.totalPaise)}</td></tr>
          {bill.payerPaise > 0 ? <tr><td colSpan={3}>{t("ipdDischarge.bill.payer")}</td><td className="num">{fmtPaise(bill.payerPaise)}</td></tr> : null}
          <tr><td colSpan={3}>{t("ipdDischarge.bill.patient")}</td><td className="num">{fmtPaise(bill.patientRoundedPaise)}</td></tr>
          <tr><td colSpan={3}>{t("ipdDischarge.bill.deposit")}</td><td className="num">{fmtPaise(bill.depositHeldPaise)}</td></tr>
          {s !== null ? <tr><td colSpan={3}>{t("ipdDischarge.print.paid")}</td><td className="num">{fmtPaise(s.paidPaise)}</td></tr> : null}
          {s !== null && s.refundPaise > 0 ? <tr><td colSpan={3}>{t("ipdDischarge.bill.refund")}</td><td className="num">{fmtPaise(s.refundPaise)}</td></tr> : null}
          {s !== null && s.duesPaise > 0 ? <tr><td colSpan={3}>{t("ipdDischarge.bill.dues")}</td><td className="num">{fmtPaise(s.duesPaise)}</td></tr> : null}
        </tfoot>
      </table>
      <p className="foot">{t("ipdDischarge.print.billFoot")}</p>
    </section>
  );
}

function PassPrint({ tr }: { tr: IpdDischargeTracker }): React.ReactElement {
  const { t } = useTranslation();
  const p = tr.gatePass!;
  return (
    <section className="ipdd-print pass" data-testid="ipdd-pass-print">
      <PrintHead tr={tr} title={p.kind === "transfer_out" ? t("ipdDischarge.print.passReferTitle") : t("ipdDischarge.print.passTitle")} />
      <div className="passcode"><QRCodeSVG value={p.code} size={132} level="M" /><p className="bigcode mono">{p.code}</p></div>
      <p>{t("ipdDischarge.print.issuedAt", { time: fmtIst(p.issuedAt) })}</p>
      {p.receivingHospital !== null ? <p>{t("ipdDischarge.print.to", { hospital: p.receivingHospital })}</p> : null}
      {p.duesRecorded ? <p className="dues">{t("ipdDischarge.print.duesRecorded")}</p> : null}
      <p className="foot">{t("ipdDischarge.print.passFoot")}</p>
    </section>
  );
}
