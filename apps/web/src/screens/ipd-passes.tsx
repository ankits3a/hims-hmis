import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import type React from "react";
import type { IpdAdmissionView, PassAdmissionView, PassCard, PassHolder, PassIssueKind } from "@hmis/contracts";
import { useAuth } from "../lib/auth";
import { listAdmissions } from "../lib/ipd-admit-api";
import {
  getAdmissionPasses, issuePasses, issueVisitorPass, passRefusalOf, pausePasses, reissuePass, resumePasses, setPoliceCustody,
} from "../lib/passes-api";
import "../styles/paper-pine.css";
import "./passes.css";
import { dateLocale } from "../lib/date-locale";

/**
 * E1.3 (#720) — PASSES AT THE ADMISSION DESK (SPEC-ipd-companions §8, §10). Left: the admitted patients (bed, ward).
 * Right: the chosen admission — what its bed class entitles, the passes issued with Print and Lost buttons, the
 * visitor pass (live only in visiting hours), and for those who hold them, a doctor's visitor ban and police custody.
 * Every refusal shows its rule and its fix. Print renders the pass card with its QR (the opaque token, never a name)
 * and opens the browser's print dialog (decision 0045's fallback).
 *
 * Designed for 1366 × 768 first; at 1920 × 1080 the two columns widen; under 900 px they stack.
 */

const PLACED = new Set(["admitted", "transferring", "fit_declared", "discharging"]);
type Refusal = { rule: string; fix?: string };

const refusalText = (e: unknown): Refusal => {
  const r = passRefusalOf(e);
  return r !== null ? { rule: r.rule, fix: r.fix } : { rule: e instanceof Error ? e.message : String(e) };
};
const timeIst = (iso: string): string =>
  new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** The paper pass: who it is for, whom it lets in, where, until when — and the QR of the token. */
export function PassCardPrint({ card }: { card: PassCard }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="psd-card-print" data-testid="pass-card">
      <div className="psd-card-top">
        <b>{t(`passes.kind.${card.kind}`)}</b>
        <span className="mono">{card.admissionNo ?? ""}</span>
      </div>
      <div className="psd-card-body">
        <div className="psd-card-lines">
          <div className="psd-card-holder">{card.holderName}</div>
          <div>{card.holderRelation}</div>
          <div>{t("passes.card.patient")}: <b>{card.patientLabel}</b></div>
          <div>{card.wardName ?? ""}{card.bedCode ? ` · ${card.bedCode}` : ""}</div>
          <div className="small">{card.validTo === null ? t("passes.card.untilDischarge") : `${t("passes.card.until")} ${timeIst(card.validTo)}`}</div>
          {card.visitingHours ? <div className="small">{t("passes.card.hours", { hours: card.visitingHours })}</div> : null}
        </div>
        {card.token === null ? null : <QRCodeSVG value={card.token} size={96} level="M" />}
      </div>
      <div className="psd-card-foot small">{t("passes.card.foot")}</div>
    </div>
  );
}

function RefusalNote({ r }: { r: Refusal | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (r === null) return null;
  return (
    <div className="psd-refusal" role="alert">
      <b>{r.rule}</b>
      {r.fix ? <span>{t("passes.fix")}: {r.fix}</span> : null}
    </div>
  );
}

function HolderForm({ onSubmit, busy, label, withRelation = true }: {
  onSubmit: (h: PassHolder) => void; busy: boolean; label: string; withRelation?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [relation, setRelation] = useState("");
  const ok = name.trim().length > 0 && (!withRelation || relation.trim().length > 0) && (phone === "" || /^[6-9]\d{9}$/.test(phone));
  return (
    <form className="psd-form" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit({ name: name.trim(), relation: relation.trim() || "visitor", ...(phone ? { phone } : {}) }); }}>
      <label>{t("passes.holder.name")}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
      <label>{t("passes.holder.phone")}<input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} inputMode="numeric" /></label>
      {withRelation ? <label>{t("passes.holder.relation")}<input value={relation} onChange={(e) => setRelation(e.target.value)} maxLength={40} /></label> : null}
      <button type="submit" className="psd-btn pri" disabled={!ok || busy}>{label}</button>
    </form>
  );
}

export function IpdPasses(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const search = useSearch({ strict: false }) as { admission?: string };
  const navigate = useNavigate();
  const [list, setList] = useState<IpdAdmissionView[]>([]);
  const [view, setView] = useState<PassAdmissionView | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [printCard, setPrintCard] = useState<PassCard | null>(null);
  const [kind, setKind] = useState<PassIssueKind | "">("");
  const [baby, setBaby] = useState("");
  const [reason, setReason] = useState("");
  const selectedId = search.admission ?? null;

  useEffect(() => {
    if (!can("ipd.admit")) return;
    listAdmissions().then((xs) => setList(xs.filter((a) => PLACED.has(a.state)))).catch(() => setList([]));
  }, [can]);

  const load = useCallback((id: string) => {
    getAdmissionPasses(id).then(setView).catch((e: unknown) => { setView(null); setRefusal(refusalText(e)); });
  }, []);
  useEffect(() => { setRefusal(null); if (selectedId !== null) load(selectedId); else setView(null); }, [selectedId, load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (selectedId === null) return;
    setBusy(true); setRefusal(null);
    try { await fn(); load(selectedId); } catch (e) { setRefusal(refusalText(e)); } finally { setBusy(false); }
  };
  const doPrint = (card: PassCard): void => {
    setPrintCard(card);
    window.setTimeout(() => {
      // The last @page in the document wins: this one, for as long as the dialog is open.
      const page = document.createElement("style");
      page.textContent = "@page { size: A6 portrait; margin: 6mm; }";
      document.head.appendChild(page);
      try { window.print(); } catch { /* the desk prints with Ctrl+P */ } finally { page.remove(); }
    }, 50);
  };

  const live = useMemo(() => (view?.passes ?? []).filter((p) => p.state === "active" || p.state === "paused"), [view]);
  const ended = useMemo(() => (view?.passes ?? []).filter((p) => p.state !== "active" && p.state !== "paused"), [view]);

  return (
    <div className="psd">
      <header className="psd-head">
        <div className="psd-title"><h1>{t("passes.title")}</h1><span>{t("passes.subtitle")}</span></div>
        {can("passes.scan") ? <Link className="psd-btn" to="/passes/scan">{t("passes.toScan")}</Link> : null}
      </header>
      <div className="psd-grid">
        <aside className="psd-card psd-list" aria-label={t("passes.admitted")}>
          <h2>{t("passes.admitted")} <span className="dim">({list.length})</span></h2>
          {list.length === 0 ? <p className="dim small">{t("passes.noneAdmitted")}</p> : null}
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <button type="button" className={`psd-pick${a.id === selectedId ? " on" : ""}`} onClick={() => { void navigate({ to: "/ipd/passes", search: { admission: a.id } }); }}>
                  <b>{a.patient.name ?? a.patient.initials}</b>
                  <span className="mono small">{a.bed?.code ?? ""} · {a.admissionNo ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="psd-main">
          <RefusalNote r={refusal} />
          {view === null ? <div className="psd-card dim">{t("passes.pick")}</div> : (
            <>
              <section className="psd-card psd-who">
                <div>
                  <div className="psd-patient">{view.patientLabel}</div>
                  <div className="dim small mono">{view.uhid ?? ""} · {view.admissionNo ?? ""}</div>
                </div>
                <div className="psd-place">
                  <span>{view.wardName ?? "—"}</span><span className="mono">{view.bedCode ?? ""}</span>
                </div>
                <div className="psd-ent" data-testid="entitlement">
                  <b>{view.entitlement.basis}</b>
                  <span>{t("passes.issuedOf", { live: view.entitlement.live, max: view.entitlement.max })}</span>
                </div>
                {view.policeCustody ? <div className="psd-flag red">{t("passes.custodyOn")}</div> : null}
                {view.visitorBan ? <div className="psd-flag gold">{t("passes.banOn", { reason: view.visitorBan.reason })}</div> : null}
              </section>

              <div className="psd-cols">
                {can("passes.issue") ? (
                  <section className="psd-card">
                    <h2>{t("passes.issueTitle")}</h2>
                    <label className="psd-kind">{t("passes.kindLabel")}
                      <select value={kind} onChange={(e) => setKind(e.target.value as PassIssueKind | "")}>
                        <option value="">{t(`passes.kind.${view.entitlement.kind}`)} · {t("passes.entitled")}</option>
                        <option value="nicu_mother">{t("passes.kind.nicu_mother")}</option>
                      </select>
                    </label>
                    {kind === "nicu_mother" ? (
                      <label className="psd-kind">{t("passes.babyAdmission")}<input value={baby} onChange={(e) => setBaby(e.target.value.trim().toUpperCase())} className="mono" /></label>
                    ) : null}
                    <HolderForm busy={busy} label={t("passes.issue")} onSubmit={(h) => { void act(() => issuePasses(view.admissionId, [h], kind === "" ? undefined : kind, kind === "nicu_mother" ? baby : undefined)); }} />
                  </section>
                ) : null}
                {can("passes.issue") ? (
                  <section className="psd-card">
                    <h2>{t("passes.visitorTitle")}</h2>
                    <p className={`small ${view.visitors.open ? "" : "dim"}`}>
                      {t("passes.visitorHours", { hours: view.visitors.hours, live: view.visitors.live, max: view.visitors.max })}
                      {view.visitors.open ? "" : ` · ${t("passes.visitorClosed")}`}
                    </p>
                    <HolderForm busy={busy || !view.visitors.open} label={t("passes.issueVisitor")} withRelation={false} onSubmit={(h) => { void act(() => issueVisitorPass(view.admissionId, h)); }} />
                  </section>
                ) : null}
              </div>

              <section className="psd-card">
                <h2>{t("passes.live")} <span className="dim">({live.length})</span></h2>
                {live.length === 0 ? <p className="dim small">{t("passes.noneLive")}</p> : (
                  <table className="psd-table">
                    <thead><tr><th>{t("passes.col.kind")}</th><th>{t("passes.col.holder")}</th><th>{t("passes.col.state")}</th><th>{t("passes.col.until")}</th><th /></tr></thead>
                    <tbody>
                      {live.map((p) => (
                        <tr key={p.passId}>
                          <td>{t(`passes.kind.${p.kind}`)}</td>
                          <td><b>{p.holderName}</b> <span className="dim small">{p.holderRelation}</span></td>
                          <td><span className={`psd-state ${p.state}`}>{t(`passes.state.${p.state}`)}</span></td>
                          <td className="small">{p.validTo === null ? t("passes.card.untilDischarge") : timeIst(p.validTo)}</td>
                          <td className="psd-row-acts">
                            {p.token === null ? null : <button type="button" className="psd-btn sm" onClick={() => doPrint(p)}>{t("passes.print")}</button>}
                            {can("passes.issue") ? <button type="button" className="psd-btn sm" disabled={busy} onClick={() => { void act(() => reissuePass(p.passId, "lost")); }}>{t("passes.lost")}</button> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {ended.length > 0 ? <p className="dim small">{t("passes.endedCount", { n: ended.length })}</p> : null}
              </section>

              {can("passes.pause") || can("passes.manage") ? (
                <section className="psd-card psd-manage">
                  <h2>{t("passes.manageTitle")}</h2>
                  <label className="psd-kind">{t("passes.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></label>
                  <div className="psd-row-acts">
                    <button type="button" className="psd-btn" disabled={busy || reason.trim() === ""} onClick={() => { void act(() => pausePasses(view.admissionId, reason.trim(), "visitors")); }}>{t("passes.stopVisitors")}</button>
                    <button type="button" className="psd-btn" disabled={busy || (view.visitorBan === null && !live.some((p) => p.state === "paused"))} onClick={() => { void act(() => resumePasses(view.admissionId)); }}>{t("passes.resume")}</button>
                    {can("passes.manage") ? (
                      <button type="button" className="psd-btn danger" disabled={busy || reason.trim() === ""} onClick={() => { void act(() => setPoliceCustody(view.admissionId, !view.policeCustody, reason.trim())); }}>
                        {view.policeCustody ? t("passes.custodyClear") : t("passes.custodySet")}
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </main>
      </div>
      {printCard ? <div className="psd-print-only"><PassCardPrint card={printCard} /></div> : null}
    </div>
  );
}
