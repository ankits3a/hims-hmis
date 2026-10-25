import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { fmtPaise } from "../lib/format";
import { listPatientDocuments } from "../lib/patients-api";
import {
  answerQuery, attachDocument, getTpaPanel, recordQuery, rejectClaim, removePackage, searchPackages, selectPackage, settleClaim, submitClaim,
} from "../lib/ipd-tpa-api";
import type React from "react";
import type { TFunction } from "i18next";
import type {
  IpdClaimDeductionReason, IpdSchemePackage, IpdTpaClaim, IpdTpaDocumentKind, IpdTpaPanel, IpdTpaStage,
} from "@hmis/contracts";
import type { WirePatientDocument } from "../lib/patients-api";
import "./ipd-tpa.css";
import { dateLocale } from "../lib/date-locale";

/*
 * #604 (decision 0075) — THE PER-ADMISSION TPA PANEL on the bill page (SPEC-tpa-desk-2026-10-15, surfaces). What the TPA
 * desk works from for one stay: the pre-auth clock, the authorisation record, the payer's queries (answer in place), the
 * documents sent, the scheme packages (payer amount), and each claim with its reconciliation and the next act. Every act
 * calls one intent; a refusal shows the server's rule by its code. `ipd.payer.manage` — the panel hides on 403, so a
 * cashier without the desk's permission sees the bill alone, and no doctor reaches the bill page at all (decision 0058).
 */

/** Copied from the contract (types-only import). */
const STAGES: readonly IpdTpaStage[] = ["preauth", "enhancement", "final", "claim"];
const DOC_KINDS: readonly IpdTpaDocumentKind[] = [
  "preauth_form", "id_proof", "policy_card", "doctor_notes", "investigations", "estimate", "approval_letter",
  "discharge_summary", "final_bill", "pharmacy_bills", "consent", "other",
];
const DEDUCTION_REASONS: readonly IpdClaimDeductionReason[] = [
  "non_payable_items", "room_rent_cap", "proportionate", "co_pay", "tariff_difference", "over_package", "documents_missing",
  "policy_exclusion", "other",
];

/** "10 Mar 14:05" in IST. */
export const tpaWhen = (iso: string): string =>
  new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

/** "1 h 15 min" / "31 days" — the clock in words. */
export function clockWords(t: TFunction, minutes: number): string {
  if (minutes >= 24 * 60 * 2) return t("ipdTpa.clock.days", { count: Math.floor(minutes / (24 * 60)) });
  const h = Math.floor(minutes / 60);
  return h > 0 ? t("ipdTpa.clock.hm", { h, m: minutes % 60 }) : t("ipdTpa.clock.m", { m: minutes });
}

/** A refusal's words by its code (the server's rule as the fallback). */
export function refusalWords(t: TFunction, e: unknown): string {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as { code?: string; message?: string };
    if (body.code !== undefined) return t(`ipdTpa.refused.${body.code}`, body.message ?? t("ipdTpa.failed"));
  }
  return t("ipdTpa.failed");
}

/** Rupees typed → paise; null when not an amount. */
export const toPaise = (s: string): number | null => {
  const v = s.replace(/[,\s₹]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
};
/** "now" for a datetime-local input, in the browser's zone (the desk's PCs run IST). */
const nowLocal = (): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const localToIso = (v: string): string => new Date(v).toISOString();

type Act = (p: Promise<unknown>, ok: string) => void;

function Clock({ panel }: { panel: IpdTpaPanel }): React.ReactElement | null {
  const { t } = useTranslation();
  if (panel.waiting !== null) {
    const w = panel.waiting;
    const sev = w.waitMinutes >= 2 * w.dueMinutes ? "hot" : w.waitMinutes >= w.dueMinutes ? "warn" : "ok";
    return (
      <p className={`tpa-clock ${sev}`} role="status">
        <strong>{t(`ipdTpa.stage.${w.stage}`)}</strong> · {t("ipdTpa.waiting", { clock: clockWords(t, w.waitMinutes) })}
        <span className={`tpa-sev ${sev}`}>{t(`ipdTpa.sev.${sev}`)}</span>
      </p>
    );
  }
  if (panel.enhancementDue) {
    return (
      <p className="tpa-clock warn" role="status">
        <strong>{t("ipdTpa.enhancementDue")}</strong> · {t("ipdTpa.claimableOf", { claimable: fmtPaise(panel.claimablePaise ?? 0), approved: fmtPaise(panel.approvedTotalPaise ?? 0) })}
      </p>
    );
  }
  return null;
}

function Queries({ panel, act }: { panel: IpdTpaPanel; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<IpdTpaStage>(panel.waiting?.stage ?? "preauth");
  const [raisedAt, setRaisedAt] = useState(nowLocal);
  const [text, setText] = useState("");
  const claimId = panel.claims.find((c) => c.state === "with_payer")?.id;
  const open = panel.queries.filter((q) => q.answeredAt === null);
  const answered = panel.queries.filter((q) => q.answeredAt !== null);
  return (
    <section className="tpa-sec" aria-label={t("ipdTpa.queries.title")}>
      <h3>{t("ipdTpa.queries.title")} {open.length > 0 ? <span className="tpa-sev warn">{t("ipdTpa.queries.open", { count: open.length })}</span> : null}</h3>
      {open.map((q) => (
        <div key={q.id} className="tpa-query" data-testid={`tpa-query-${q.id}`}>
          <div className="small"><span className="tpa-chip">{t(`ipdTpa.stage.${q.stage}`)}</span> {tpaWhen(q.raisedAt)} · {t("ipdTpa.withUs", { clock: clockWords(t, q.waitMinutes) })}</div>
          <p>{q.queryText}</p>
          <textarea rows={2} value={answers[q.id] ?? ""} aria-label={t("ipdTpa.queries.answer")} placeholder={t("ipdTpa.queries.answer")}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
          <button type="button" className="ipdb-btn" disabled={(answers[q.id] ?? "").trim() === ""}
            onClick={() => act(answerQuery(q.id, (answers[q.id] ?? "").trim()), t("ipdTpa.queries.answered"))}>{t("ipdTpa.queries.send")}</button>
        </div>
      ))}
      {answered.length === 0 ? null : (
        <details><summary className="small">{t("ipdTpa.queries.history", { count: answered.length })}</summary>
          <ul className="tpa-list">{answered.map((q) => <li key={q.id}><span className="tpa-chip">{t(`ipdTpa.stage.${q.stage}`)}</span> {q.queryText} → <em>{q.responseText}</em></li>)}</ul>
        </details>
      )}
      <form className="tpa-form" onSubmit={(e) => {
        e.preventDefault();
        act(recordQuery({
          admissionId: panel.admissionId, stage, raisedAt: localToIso(raisedAt), queryText: text.trim(),
          ...(stage === "claim" && claimId !== undefined ? { claimId } : {}),
        }), t("ipdTpa.queries.recorded"));
        setText("");
      }}>
        <label>{t("ipdTpa.stageLabel")}
          <select value={stage} onChange={(e) => setStage(e.target.value as IpdTpaStage)}>
            {STAGES.filter((s) => s !== "claim" || claimId !== undefined).map((s) => <option key={s} value={s}>{t(`ipdTpa.stage.${s}`)}</option>)}
          </select>
        </label>
        <label>{t("ipdTpa.queries.raisedAt")}<input type="datetime-local" value={raisedAt} onChange={(e) => setRaisedAt(e.target.value)} /></label>
        <label className="wide">{t("ipdTpa.queries.text")}<input value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button type="submit" className="ipdb-btn" disabled={text.trim() === "" || raisedAt === ""}>{t("ipdTpa.queries.add")}</button>
      </form>
    </section>
  );
}

function Documents({ panel, patientId, act }: { panel: IpdTpaPanel; patientId: string; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<WirePatientDocument[] | null>(null);
  const [stage, setStage] = useState<IpdTpaStage>(panel.claims.length > 0 ? "claim" : "preauth");
  const [kind, setKind] = useState<IpdTpaDocumentKind>(panel.claims.length > 0 ? "discharge_summary" : "preauth_form");
  const [docId, setDocId] = useState("");
  useEffect(() => { listPatientDocuments(patientId).then(setDocs, () => setDocs([])); }, [patientId]);
  const claimId = panel.claims.find((c) => c.state === "to_submit" || c.state === "rejected")?.id;
  return (
    <section className="tpa-sec" aria-label={t("ipdTpa.docs.title")}>
      <h3>{t("ipdTpa.docs.title")}</h3>
      {panel.documents.length === 0 ? <p className="dim small">{t("ipdTpa.docs.none")}</p> : (
        <ul className="tpa-list">{panel.documents.map((d) => <li key={d.id}><span className="tpa-chip">{t(`ipdTpa.stage.${d.stage}`)}</span> {t(`ipdTpa.docKind.${d.kind}`)} <span className="dim small">{tpaWhen(d.attachedAt)}</span></li>)}</ul>
      )}
      <form className="tpa-form" onSubmit={(e) => {
        e.preventDefault();
        act(attachDocument({ admissionId: panel.admissionId, stage, kind, patientDocumentId: docId, ...(stage === "claim" && claimId !== undefined ? { claimId } : {}) }), t("ipdTpa.docs.attached"));
      }}>
        <label>{t("ipdTpa.stageLabel")}
          <select value={stage} onChange={(e) => setStage(e.target.value as IpdTpaStage)}>{STAGES.map((s) => <option key={s} value={s}>{t(`ipdTpa.stage.${s}`)}</option>)}</select>
        </label>
        <label>{t("ipdTpa.docs.kind")}
          <select value={kind} onChange={(e) => setKind(e.target.value as IpdTpaDocumentKind)}>{DOC_KINDS.map((k) => <option key={k} value={k}>{t(`ipdTpa.docKind.${k}`)}</option>)}</select>
        </label>
        <label className="wide">{t("ipdTpa.docs.file")}
          <select value={docId} onChange={(e) => setDocId(e.target.value)}>
            <option value="">{docs === null ? t("ipdTpa.loading") : docs.length === 0 ? t("ipdTpa.docs.noFiles") : t("ipdTpa.docs.pick")}</option>
            {(docs ?? []).map((d) => <option key={d.id} value={d.id}>{`${d.kind} · ${tpaWhen(d.capturedAt)}${d.note === null ? "" : ` · ${d.note}`}`}</option>)}
          </select>
        </label>
        <button type="submit" className="ipdb-btn" disabled={docId === ""}>{t("ipdTpa.docs.attach")}</button>
      </form>
    </section>
  );
}

function Packages({ panel, act }: { panel: IpdTpaPanel; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<IpdSchemePackage[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const scheme = panel.payerKind === "state_scheme" ? "state_scheme" : "pmjay";
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => { searchPackages(scheme, q).then((r) => { if (live) setHits(r); }, () => { if (live) setHits([]); }); }, 250);
    return () => { live = false; clearTimeout(h); };
  }, [q, scheme]);
  return (
    <section className="tpa-sec" aria-label={t("ipdTpa.pkg.title")}>
      <h3>{t("ipdTpa.pkg.title")}</h3>
      {panel.packages.length === 0 ? <p className="dim small">{t("ipdTpa.pkg.none")}</p> : (
        <table className="tpa-table">
          <tbody>
            {panel.packages.map((p) => (
              <tr key={p.id}>
                <td><span className="mono">{p.code}</span><div className="small dim">{p.name}</div></td>
                <td className="num">{fmtPaise(p.ratePaise)}<div className="small dim">{t("ipdTpa.pkg.share", { pct: p.shareBp / 100 })}</div></td>
                <td className="num strong">{fmtPaise(p.amountPaise)}</td>
                <td>
                  {removing === p.id ? (
                    <span className="tpa-inline">
                      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ipdTpa.pkg.reason")} aria-label={t("ipdTpa.pkg.reason")} />
                      <button type="button" className="ipdb-btn" disabled={reason.trim() === ""} onClick={() => { act(removePackage(panel.admissionId, p.id, reason.trim()), t("ipdTpa.pkg.removed")); setRemoving(null); setReason(""); }}>{t("ipdTpa.pkg.remove")}</button>
                    </span>
                  ) : <button type="button" className="ipdb-btn" onClick={() => setRemoving(p.id)}>{t("ipdTpa.pkg.remove")}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="tpa-row total"><span>{t("ipdTpa.pkg.payerAmount")}</span><span className="num">{fmtPaise(panel.packageAmountPaise)}</span></div>
      <p className="small dim">{t("ipdTpa.pkg.rule")}</p>
      <label className="tpa-search">{t("ipdTpa.pkg.search")}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ipdTpa.pkg.searchHint")} /></label>
      <ul className="tpa-hits">
        {hits.filter((h) => !panel.packages.some((p) => p.code === h.code)).slice(0, 6).map((h) => (
          <li key={h.id}>
            <span><span className="mono">{h.code}</span> {h.name} <span className="dim small">· {h.specialty}</span></span>
            <span className="num">{fmtPaise(h.ratePaise)}</span>
            <button type="button" className="ipdb-btn" onClick={() => act(selectPackage(panel.admissionId, h.id), t("ipdTpa.pkg.selected"))}>{t("ipdTpa.pkg.select")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Ded = { reason: IpdClaimDeductionReason; amount: string; note: string };

function Claim({ c, act }: { c: IpdTpaClaim; act: Act }): React.ReactElement {
  const { t } = useTranslation();
  const [submittedAt, setSubmittedAt] = useState(nowLocal);
  const [claimRef, setClaimRef] = useState("");
  const [claimed, setClaimed] = useState(String(c.defaultClaimPaise / 100));
  const [net, setNet] = useState("");
  const [tds, setTds] = useState("0");
  const [utr, setUtr] = useState("");
  const [settledOn, setSettledOn] = useState(() => nowLocal().slice(0, 10));
  const [deds, setDeds] = useState<Ded[]>([]);
  const [rejectReason, setRejectReason] = useState("");
  const dedPaise = deds.reduce((s, d) => s + (toPaise(d.amount) ?? 0), 0);
  const gap = (c.claimedPaise ?? 0) - ((toPaise(net) ?? 0) + (toPaise(tds) ?? 0) + dedPaise);
  const fileable = c.state === "to_submit" || c.state === "rejected";
  return (
    <div className="tpa-claim" data-testid={`tpa-claim-${c.id}`}>
      <div className="tpa-row"><span className={`tpa-state ${c.state}`}>{t(`ipdTpa.claim.state.${c.state}`)}</span>
        {c.claimRef === null ? null : <span className="mono small">{c.claimRef}</span>}
        {c.ageDays === null ? null : <span className={`tpa-sev ${c.ageDays >= 60 ? "hot" : c.ageDays >= 30 ? "warn" : "ok"}`}>{t("ipdTpa.claim.age", { count: c.ageDays })}</span>}
      </div>
      <dl className="tpa-recon">
        <dt>{t("ipdTpa.claim.billPayer")}</dt><dd className="num">{fmtPaise(c.billPayerPaise)}</dd>
        <dt>{t("ipdTpa.claim.claimed")}</dt><dd className="num">{c.claimedPaise === null ? "—" : fmtPaise(c.claimedPaise)}</dd>
        {c.packageVariancePaise === null || c.packageVariancePaise === 0 ? null : <><dt>{t("ipdTpa.claim.variance")}</dt><dd className="num">{fmtPaise(c.packageVariancePaise)}</dd></>}
        {c.netPaidPaise === null ? null : <>
          <dt>{t("ipdTpa.claim.net")}</dt><dd className="num">{fmtPaise(c.netPaidPaise)}</dd>
          <dt>{t("ipdTpa.claim.tds")}</dt><dd className="num">{fmtPaise(c.tdsPaise ?? 0)}</dd>
          <dt>{t("ipdTpa.claim.deductions")}</dt><dd className="num">{fmtPaise(c.deductionsPaise)}</dd>
          <dt>{t("ipdTpa.claim.unexplained")}</dt><dd className="num strong">{fmtPaise(c.unexplainedPaise ?? 0)}</dd>
          <dt>{t("ipdTpa.claim.utr")}</dt><dd className="mono">{c.utrRef} · {c.settledOn}</dd>
        </>}
      </dl>
      {c.deductions.length === 0 ? null : (
        <ul className="tpa-list">{c.deductions.map((d, i) => <li key={i}>{t(`ipdTpa.deduction.${d.reason}`)}{d.note === null ? "" : ` (${d.note})`} <span className="num">{fmtPaise(d.amountPaise)}</span></li>)}</ul>
      )}
      {c.rejectionReason === null ? null : <p className="tpa-clock warn">{t("ipdTpa.claim.rejectedWhy", { reason: c.rejectionReason })}</p>}
      {fileable ? (
        <form className="tpa-form" onSubmit={(e) => {
          e.preventDefault();
          const paise = toPaise(claimed);
          act(submitClaim(c.id, { submittedAt: localToIso(submittedAt), ...(claimRef.trim() === "" ? {} : { claimRef: claimRef.trim() }), ...(paise === null ? {} : { claimedPaise: paise }) }), t("ipdTpa.claim.submitted"));
        }}>
          {c.missingDocuments.length === 0 ? null : <p className="tpa-clock warn wide" role="alert">{t("ipdTpa.claim.missing", { docs: c.missingDocuments.map((k) => t(`ipdTpa.docKind.${k}`)).join(", ") })}</p>}
          <label>{t("ipdTpa.claim.submittedAt")}<input type="datetime-local" value={submittedAt} onChange={(e) => setSubmittedAt(e.target.value)} /></label>
          <label>{t("ipdTpa.claim.ref")}<input value={claimRef} onChange={(e) => setClaimRef(e.target.value)} /></label>
          <label>{t("ipdTpa.claim.amount")}<input inputMode="decimal" value={claimed} onChange={(e) => setClaimed(e.target.value)} /></label>
          <button type="submit" className="ipdb-btn primary" disabled={c.missingDocuments.length > 0 || toPaise(claimed) === null}>{c.state === "rejected" ? t("ipdTpa.claim.resubmit") : t("ipdTpa.claim.submit")}</button>
        </form>
      ) : null}
      {c.state === "with_payer" ? (
        <>
          <form className="tpa-form" onSubmit={(e) => {
            e.preventDefault();
            act(settleClaim(c.id, {
              netPaidPaise: toPaise(net) ?? 0, tdsPaise: toPaise(tds) ?? 0, utrRef: utr.trim(), settledOn,
              deductions: deds.map((d) => ({ reason: d.reason, amountPaise: toPaise(d.amount) ?? 0, ...(d.note.trim() === "" ? {} : { note: d.note.trim() }) })),
            }), t("ipdTpa.claim.settled"));
          }}>
            <label>{t("ipdTpa.claim.net")}<input inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} /></label>
            <label>{t("ipdTpa.claim.tds")}<input inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} /></label>
            <label>{t("ipdTpa.claim.utr")}<input value={utr} onChange={(e) => setUtr(e.target.value)} /></label>
            <label>{t("ipdTpa.claim.settledOn")}<input type="date" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} /></label>
            {deds.map((d, i) => (
              <div key={i} className="tpa-ded wide">
                <select aria-label={t("ipdTpa.claim.dedReason")} value={d.reason} onChange={(e) => setDeds(deds.map((x, j) => (j === i ? { ...x, reason: e.target.value as IpdClaimDeductionReason } : x)))}>
                  {DEDUCTION_REASONS.map((r) => <option key={r} value={r}>{t(`ipdTpa.deduction.${r}`)}</option>)}
                </select>
                <input aria-label={t("ipdTpa.claim.dedAmount")} inputMode="decimal" value={d.amount} placeholder="₹" onChange={(e) => setDeds(deds.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <input aria-label={t("ipdTpa.claim.dedNote")} value={d.note} placeholder={t("ipdTpa.claim.dedNote")} onChange={(e) => setDeds(deds.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
                <button type="button" className="ipdb-btn" onClick={() => setDeds(deds.filter((_, j) => j !== i))} aria-label={t("ipdTpa.claim.dedRemove")}>×</button>
              </div>
            ))}
            <button type="button" className="ipdb-btn" onClick={() => setDeds([...deds, { reason: "non_payable_items", amount: "", note: "" }])}>{t("ipdTpa.claim.dedAdd")}</button>
            <p className={`small wide ${gap === 0 ? "" : "tpa-gap"}`} role="status">{gap === 0 ? t("ipdTpa.claim.addsUp") : t("ipdTpa.claim.gap", { amount: fmtPaise(gap) })}</p>
            <button type="submit" className="ipdb-btn primary" disabled={gap !== 0 || utr.trim() === "" || net === ""}>{t("ipdTpa.claim.settle")}</button>
          </form>
          <form className="tpa-form" onSubmit={(e) => { e.preventDefault(); act(rejectClaim(c.id, { rejectedAt: new Date().toISOString(), reason: rejectReason.trim() }), t("ipdTpa.claim.rejected")); }}>
            <label className="wide">{t("ipdTpa.claim.rejectReason")}<input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /></label>
            <button type="submit" className="ipdb-btn" disabled={rejectReason.trim() === ""}>{t("ipdTpa.claim.reject")}</button>
          </form>
        </>
      ) : null}
    </div>
  );
}

/** The panel. Renders nothing for a cash stay with no payer history, or for a reader without `ipd.payer.manage`. */
export function TpaPanel({ admissionId, patientId }: { admissionId: string; patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<IpdTpaPanel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback((): Promise<void> => getTpaPanel(admissionId).then(setPanel, (e: unknown) => {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setHidden(true);
  }), [admissionId]);
  useEffect(() => { void load(); }, [load]);
  const act: Act = (p, ok) => {
    setNotice(null);
    p.then(() => { setNotice({ ok: true, text: ok }); return load(); }, (e: unknown) => setNotice({ ok: false, text: refusalWords(t, e) }));
  };
  if (hidden || panel === null) return null;
  if ((panel.payerKind === null || panel.payerKind === "cash") && panel.auths.length === 0 && panel.claims.length === 0) return null;
  return (
    <section className="ipdb-card tpa-panel" aria-label={t("ipdTpa.panel.title")} data-testid="tpa-panel">
      <h2>{t("ipdTpa.panel.title")}</h2>
      <div className="tpa-row">
        {panel.payerKind === null ? null : <span className="ipdb-tag">{t(`ipdBill.payerKind.${panel.payerKind}`, panel.payerKind)}</span>}
        {panel.preAuthNumber === null ? null : <span className="mono small">{t("ipdTpa.preAuth", { no: panel.preAuthNumber })}</span>}
        {panel.approvedTotalPaise === null ? null : <span className="small">{t("ipdTpa.approved", { amount: fmtPaise(panel.approvedTotalPaise) })}</span>}
      </div>
      <Clock panel={panel} />
      {notice === null ? null : <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "tpa-ok" : "ipdb-error"}>{notice.text}</p>}
      {panel.auths.length === 0 ? null : (
        <details className="tpa-sec">
          <summary><h3>{t("ipdTpa.auths.title", { count: panel.auths.length })}</h3></summary>
          <ol className="tpa-list">
            {panel.auths.map((a) => (
              <li key={a.id}>{t(`ipdTpa.entry.${a.entry}`, a.entry)} · {t(`ipdTpa.status.${a.status}`, a.status)}
                {a.approvedAmountPaise === null ? null : <span className="num"> {fmtPaise(a.approvedAmountPaise)}</span>}
                <span className="dim small"> · {tpaWhen(a.recordedAt)}</span></li>
            ))}
          </ol>
        </details>
      )}
      <Queries panel={panel} act={act} />
      <Documents panel={panel} patientId={patientId} act={act} />
      {panel.isScheme ? <Packages panel={panel} act={act} /> : null}
      {panel.claims.length === 0 ? null : (
        <section className="tpa-sec" aria-label={t("ipdTpa.claim.title")}>
          <h3>{t("ipdTpa.claim.title")}</h3>
          {panel.claims.map((c) => <Claim key={c.id} c={c} act={act} />)}
        </section>
      )}
    </section>
  );
}
