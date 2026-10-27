import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdFamilyBillDetails, IpdFamilyGate, IpdFamilyView } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst, fmtRupees } from "../lib/format";
import {
  getFamilyBillDetails, getFamilyGate, getFamilyView, requestFamilyCallback, sendFamilyOtp, verifyFamilyOtp,
} from "../lib/ipd-family-api";
import { FAMILY_TOKEN_KEY } from "../lib/canteen-api";
import "./ipd-family.css";

/*
 * E3.3 (#731) — THE FAMILY PAGE at `/family#<token>` (design board G, "Family discharge tracker"; spec §4.9 F/G). Opened from the link the ward
 * desk hands the registered attendant. A 390 px phone first: one column, 48 px targets, Hindi by default with an English
 * switch, never night mode (§4.10 edge 30). Before the OTP it shows only the masked phone and why the page exists (DPDP
 * notice); after it: the patient's first name (alias for a confidential patient), ward, day of stay, the condition word
 * the treating team set, today's totals (no lines), the discharge steps, what to do, "Show bill details" (a second,
 * logged step) and "Request a callback" — the ward calls back; nothing here answers a question.
 */

type Lang = "hi" | "en";
const LANG_KEY = "hmis.family.lang";
function storedLang(): Lang {
  try { return localStorage.getItem(LANG_KEY) === "en" ? "en" : "hi"; } catch { return "hi"; }
}

function codeOf(e: unknown): string | null {
  if (e instanceof ApiError) return (e.body as { code?: string } | null)?.code ?? `http_${String(e.status)}`;
  return null;
}

/** The link is `/family#<token>`: the fragment never leaves the browser, so no server or edge log can keep it (#764). */
function tokenFromLocation(): string {
  return typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

export function FamilyPage({ token: given }: { token?: string } = {}): React.ReactElement {
  const [token] = useState(() => given ?? tokenFromLocation());
  const { i18n } = useTranslation();
  const [lang, setLang] = useState<Lang>(storedLang);
  const t = useMemo(() => i18n.getFixedT(lang), [i18n, lang]);
  const pick = (l: Lang) => { setLang(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* private window */ } };

  const [gate, setGate] = useState<IpdFamilyGate | null>(null);
  const [view, setView] = useState<IpdFamilyView | null>(null);
  const [failed, setFailed] = useState(false);

  const loadView = useCallback(() => {
    getFamilyView(token).then((v) => {
      setView(v);
      // CN-1 (#977): the bed's canteen page may put meals on the hospital bill only with this verified link.
      try { localStorage.setItem(FAMILY_TOKEN_KEY, token); } catch { /* private window: the bed page offers UPI only */ }
    }, (e: unknown) => {
      const c = codeOf(e);
      if (c === "family_link_closed") setGate({ status: "closed", phoneMasked: null, purpose: "inpatient_updates" });
      else if (c === "family_session_required") { setView(null); setGate((g) => (g === null ? g : { ...g, status: "needs_otp" })); }
      else setFailed(true);
    });
  }, [token]);

  useEffect(() => {
    getFamilyGate(token).then((g) => { setGate(g); if (g.status === "verified") loadView(); }, () => setFailed(true));
  }, [token, loadView]);

  return (
    <div className="fam" lang={lang} data-testid="family-page">
      <header className="fam-head">
        <div className="who">
          <span className="name">{view?.name ?? t("ipdFamily.brand")}</span>
          <span className="where">{view === null ? t("ipdFamily.subtitle") : [view.ward, t("ipdFamily.day", { n: view.dayOfStay })].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="lang" role="group" aria-label="Language">
          <button type="button" aria-pressed={lang === "hi"} className={lang === "hi" ? "on" : ""} onClick={() => pick("hi")}>हिंदी</button>
          <button type="button" aria-pressed={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => pick("en")}>English</button>
        </div>
      </header>
      <main className="fam-main">
        {failed ? <section className="fam-card warn" role="alert">{t("ipdFamily.loadFailed")}</section> : null}
        {gate === null && !failed ? <section className="fam-card">{t("ipdFamily.loading")}</section> : null}
        {gate?.status === "closed" ? <Closed t={t} /> : null}
        {gate?.status === "needs_otp" ? <Otp token={token} phone={gate.phoneMasked ?? ""} t={t} onVerified={loadView} /> : null}
        {view !== null && gate?.status !== "closed" ? <Verified token={token} v={view} t={t} phone={gate?.phoneMasked ?? ""} /> : null}
      </main>
      <footer className="fam-foot">{t("ipdFamily.footer")}</footer>
    </div>
  );
}

type T = (k: string, o?: Record<string, unknown>) => string;

function Closed({ t }: { t: T }): React.ReactElement {
  return (
    <section className="fam-card" data-testid="family-closed">
      <span className="h">{t("ipdFamily.closed.title")}</span>
      <span>{t("ipdFamily.closed.body")}</span>
    </section>
  );
}

function Otp({ token, phone, t, onVerified }: { token: string; phone: string; t: T; onVerified: () => void }): React.ReactElement {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = () => {
    setBusy(true); setErr(null);
    sendFamilyOtp(token).then(() => { setBusy(false); setSent(true); }, (e: unknown) => { setBusy(false); setErr(codeOf(e) ?? "failed"); });
  };
  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) { setErr("family_otp_format"); return; }
    setBusy(true); setErr(null);
    verifyFamilyOtp(token, code).then(() => { setBusy(false); onVerified(); }, (x: unknown) => { setBusy(false); setErr(codeOf(x) ?? "failed"); });
  };
  return (
    <>
      <section className="fam-card" aria-label={t("ipdFamily.purpose.title")}>
        <span className="h">{t("ipdFamily.purpose.title")}</span>
        <span className="body">{t("ipdFamily.purpose.body")}</span>
      </section>
      <section className="fam-card">
        <span className="h">{t("ipdFamily.otp.title")}</span>
        <span className="body">{t("ipdFamily.otp.to", { phone })}</span>
        {!sent ? (
          <button type="button" className="fam-btn primary" disabled={busy} onClick={send}>{t("ipdFamily.otp.send")}</button>
        ) : (
          <form className="fam-otp" onSubmit={verify}>
            <label htmlFor="fam-code">{t("ipdFamily.otp.label")}</label>
            <input id="fam-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <button type="submit" className="fam-btn primary" disabled={busy}>{t("ipdFamily.otp.verify")}</button>
            <button type="button" className="fam-link" disabled={busy} onClick={send}>{t("ipdFamily.otp.resend")}</button>
          </form>
        )}
        {err !== null ? <span className="fam-err" role="alert">{t(`ipdFamily.err.${err}`, { defaultValue: t("ipdFamily.err.failed") })}</span> : null}
      </section>
    </>
  );
}

const STEP_ORDER = ["fit", "departments", "summary", "bill", "gate_pass", "exit"] as const;

function Verified({ token, v, t, phone }: { token: string; v: IpdFamilyView; t: T; phone: string }): React.ReactElement {
  const word = v.condition.word;
  const steps = v.tracker === null ? [] : STEP_ORDER.map((k) => v.tracker!.steps.find((s) => s.key === k)).filter((s) => s !== undefined);
  return (
    <>
      <section className="fam-hero" data-testid="family-hero">
        {v.status === "discharged" ? (
          <>
            <span className="label">{t("ipdFamily.discharged.label")}</span>
            <span className="big">{t("ipdFamily.discharged.big")}</span>
            <span className="sub">{t("ipdFamily.discharged.sub")}</span>
          </>
        ) : v.tracker?.expectedAt ? (
          <>
            <span className="label">{t("ipdFamily.eta.label")}</span>
            <span className="big">{fmtIst(v.tracker.expectedAt)}</span>
            <span className="sub">{conditionLine(t, word, v.condition.setAt)}</span>
          </>
        ) : (
          <>
            <span className="label">{t("ipdFamily.condition.label")}</span>
            <span className="big">{word === null ? t("ipdFamily.condition.ask") : t(`ipdFamily.condition.${word}`)}</span>
            <span className="sub">{word === null ? t("ipdFamily.condition.notSet") : t("ipdFamily.condition.setAt", { time: v.condition.setAt === null ? "" : fmtIst(v.condition.setAt) })}</span>
          </>
        )}
      </section>

      {steps.length > 0 ? (
        <section className="fam-card" aria-label={t("ipdFamily.steps.title")}>
          <span className="h">{t("ipdFamily.steps.title")}</span>
          <ol className="fam-steps">
            {steps.map((s, i) => (
              <li key={s.key} className={`st-${s.state}${i === steps.length - 1 ? " last" : ""}`}>
                <span className="dot" aria-hidden="true">{s.state === "done" ? "✓" : ""}</span>
                <span className="txt">
                  <span className="lbl">{t(`ipdFamily.step.${s.key}`)}</span>
                  <span className="when">{s.state === "done" && s.at !== null ? fmtIst(s.at) : t(`ipdFamily.stepState.${s.state}`)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {v.tracker !== null ? (
        <section className="fam-card">
          <span className="h">{t("ipdFamily.todo.title")}</span>
          <span className="body">{t(`ipdFamily.todo.${v.tracker.todo}`)}</span>
        </section>
      ) : null}

      <Totals token={token} v={v} t={t} />
      <Callback token={token} t={t} phone={phone} />
    </>
  );
}

function conditionLine(t: T, word: IpdFamilyView["condition"]["word"], setAt: string | null): string {
  if (word === null) return t("ipdFamily.condition.lineAsk");
  return t("ipdFamily.condition.line", { word: t(`ipdFamily.condition.${word}`), time: setAt === null ? "" : fmtIst(setAt) });
}

function Totals({ token, v, t }: { token: string; v: IpdFamilyView; t: T }): React.ReactElement {
  const [details, setDetails] = useState<IpdFamilyBillDetails | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const owe = v.totals.balancePaise < 0;
  const show = () => {
    setBusy(true);
    getFamilyBillDetails(token).then((d) => { setBusy(false); setDetails(d); setAsking(false); }, () => setBusy(false));
  };
  return (
    <section className="fam-card" aria-label={t("ipdFamily.totals.title")}>
      <div className="row"><span className="k">{t("ipdFamily.totals.bill")}</span><span className="v mono">{fmtRupees(v.totals.billPaise)}</span></div>
      <div className="row"><span className="k">{t("ipdFamily.totals.deposit")}</span><span className="v mono">{fmtRupees(v.totals.depositPaise)}</span></div>
      <div className="row total">
        <span>{owe ? t("ipdFamily.totals.due") : t("ipdFamily.totals.left")}</span>
        <span className={`v mono${owe ? " due" : " ok"}`}>{fmtRupees(Math.abs(v.totals.balancePaise))}</span>
      </div>
      <span className="note">{t("ipdFamily.totals.asOf", { time: fmtIst(v.totals.asOf) })}</span>
      {details === null ? (
        asking ? (
          <div className="fam-confirm">
            <span>{t("ipdFamily.details.confirm")}</span>
            <button type="button" className="fam-btn" disabled={busy} onClick={show}>{t("ipdFamily.details.yes")}</button>
            <button type="button" className="fam-link" onClick={() => setAsking(false)}>{t("ipdFamily.details.no")}</button>
          </div>
        ) : (
          <button type="button" className="fam-link" onClick={() => setAsking(true)}>{t("ipdFamily.details.show")}</button>
        )
      ) : (
        <div className="fam-lines" data-testid="family-lines">
          <span className="h">{t("ipdFamily.details.title")}</span>
          {details.lines.length === 0 ? <span className="note">{t("ipdFamily.details.none")}</span> : null}
          {details.lines.map((l, i) => (
            <div className="row line" key={`${l.serviceDate}-${String(i)}`}>
              <span className="k">{l.serviceName}{l.qty > 1 ? ` × ${String(l.qty)}` : ""}<span className="date">{l.serviceDate}</span></span>
              <span className="v mono">{fmtRupees(l.amountPaise)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Callback({ token, t, phone }: { token: string; t: T; phone: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 2) return;
    setBusy(true); setErr(null);
    requestFamilyCallback(token, text.trim()).then(() => { setBusy(false); setDone(true); setText(""); }, (x: unknown) => { setBusy(false); setErr(codeOf(x) ?? "failed"); });
  };
  if (done) return <section className="fam-card ok" role="status">{t("ipdFamily.callback.done", { phone })}</section>;
  return (
    <>
      {open ? (
        <form className="fam-card" onSubmit={submit}>
          <label className="h" htmlFor="fam-q">{t("ipdFamily.callback.title")}</label>
          <textarea id="fam-q" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("ipdFamily.callback.placeholder")} />
          <button type="submit" className="fam-btn primary" disabled={busy || text.trim().length < 2}>{t("ipdFamily.callback.send")}</button>
          {err !== null ? <span className="fam-err" role="alert">{t(`ipdFamily.err.${err}`, { defaultValue: t("ipdFamily.err.failed") })}</span> : null}
        </form>
      ) : (
        <button type="button" className="fam-ask" onClick={() => setOpen(true)}>{t("ipdFamily.callback.ask")}</button>
      )}
      <span className="fam-note">{t("ipdFamily.callback.note")}</span>
    </>
  );
}
