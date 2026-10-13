import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { fmtPaise } from "../lib/format";
import { getBillDesk, resolveBackdatedVisit, retryPosting } from "../lib/ipd-bill-api";
import { IpdSettledBills } from "./ipd-settled-bills";
import type React from "react";
import type { IpdBillDesk, IpdBillDeskReason, IpdBillDeskRow } from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./ipd-bill.css";
import "./ipd-bill-desk.css";

/*
 * E2.3 (#727) — THE BILL DESK (spec SPEC-ipd-core §4.3 deposit ladder, §4.9 H). EXCEPTIONS ONLY: a row is an admission that
 * needs the desk — deposit 75 % / 90 % used, a day that could not be posted (with Retry for the billing manager), an
 * unchecked downtime deposit, a denied claim waiting for the cash consent, an authorisation waiting over 24 hours, an ICU
 * stay with a day of deposit left, a discharge under way with a balance. A normal running bill makes no row. Counts on
 * top filter the list; each row opens the interim bill. `ipd.billdesk.view` — never a doctor (decision 0058).
 * 1920×1080 first (no page scroll: the list scrolls inside its panel), fits 1366×768.
 */

/** The contract's reasons, in its order (most urgent first). Copied: the web imports the contract for types only. */
const REASONS: readonly IpdBillDeskReason[] = [
  "deposit_90", "deposit_75", "icu_low_days", "posting_failed", "rate_missing", "tariff_missing", "deposit_check_pending",
  "cash_consent_missing", "auth_pending_24h", "discharge_balance", "visit_backdated",
  "order_cancelled_after_bill", "order_cancelled_after_work",
];
const HOT: ReadonlySet<IpdBillDeskReason> = new Set(["deposit_90", "icu_low_days", "posting_failed", "discharge_balance"]);

/** "11 Mar 09:30" — an instant in IST. */
const when = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso));

function Used({ bp }: { bp: number | null }): React.ReactElement {
  const { t } = useTranslation();
  if (bp === null) return <span className="dim">—</span>;
  if (bp >= 1_000_000) return <span className="ipdbd-used hot">{t("ipdBillDesk.noDeposit")}</span>;
  const pct = Math.floor(bp / 100);
  const tone = bp >= 9_000 ? "hot" : bp >= 7_500 ? "warn" : "";
  return (
    <span className={`ipdbd-used ${tone}`}>
      <span className="ipdbd-bar" aria-hidden="true"><span style={{ width: `${String(Math.min(pct, 100))}%` }} /></span>
      {t("ipdBillDesk.usedPct", { pct })}
    </span>
  );
}

/**
 * E4.2 (#734) — a round entered too late to charge (`visit_backdated`): the billing manager charges the visit as of its
 * day or waives it, and either way gives the reason (kept on the exception).
 */
function BackdatedVisit({ v, onDone }: { v: NonNullable<IpdBillDeskRow["backdatedVisits"]>[number]; onDone: (ok: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const go = (decision: "charge" | "waive"): void => {
    setBusy(true);
    resolveBackdatedVisit(v.exceptionId, decision, reason.trim()).then(() => onDone(true), () => onDone(false)).finally(() => setBusy(false));
  };
  return (
    <div className="ipdbd-backdated" data-testid={`backdated-${v.exceptionId}`}>
      <span className="small">{t("ipdBillDesk.backdated.what", { date: v.serviceDate, name: v.consultantName })}</span>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ipdBillDesk.backdated.reason")} aria-label={t("ipdBillDesk.backdated.reason")} />
      <button type="button" className="ipdb-btn" disabled={busy || reason.trim() === ""} onClick={() => go("charge")}>{t("ipdBillDesk.backdated.charge")}</button>
      <button type="button" className="ipdb-btn" disabled={busy || reason.trim() === ""} onClick={() => go("waive")}>{t("ipdBillDesk.backdated.waive")}</button>
    </div>
  );
}

function Row({ r, canRetry, onRetry, busy, onBackdated }: {
  r: IpdBillDeskRow; canRetry: boolean; onRetry: (id: string) => void; busy: boolean; onBackdated: (ok: boolean) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const due = r.balancePaise < 0;
  const retryable = canRetry && (r.reasons.includes("posting_failed") || r.reasons.includes("rate_missing") || r.reasons.includes("tariff_missing"));
  return (
    <tr>
      <td>
        <div className="strong">{r.patient.name ?? r.patient.uhid}</div>
        <div className="mono dim small">{r.patient.uhid}{r.admissionNo === null ? "" : ` · ${r.admissionNo}`}</div>
      </td>
      <td>
        <div className="mono">{r.bedCode ?? "—"}</div>
        <div className="dim small">{r.billedClass === null ? "" : t(`ipdBill.class.${r.billedClass}`)}{r.payerKind === null ? "" : ` · ${t(`ipdBill.payerKind.${r.payerKind}`, r.payerKind)}`}</div>
      </td>
      <td className="ipdbd-why">
        {r.reasons.map((x) => <span key={x} className={`ipdb-tag ${HOT.has(x) ? "hot" : "warn"}`}>{t(`ipdBillDesk.reason.${x}`)}</span>)}
        {canRetry ? (r.backdatedVisits ?? []).map((v) => <BackdatedVisit key={v.exceptionId} v={v} onDone={onBackdated} />) : null}
      </td>
      <td><Used bp={r.usedBp} /></td>
      <td className="num">{fmtPaise(r.patientPayablePaise)}</td>
      <td className="num">{fmtPaise(r.depositHeldPaise)}</td>
      <td className={`num strong ${due ? "ipdbd-due" : ""}`}>
        {due ? t("ipdBillDesk.due", { amount: fmtPaise(-r.balancePaise) }) : fmtPaise(r.balancePaise)}
      </td>
      <td className="small">
        {r.icuBurn === null ? <span className="dim">—</span> : (
          <>
            <div>{t("ipdBillDesk.perDay", { amount: fmtPaise(r.icuBurn.perDayPaise) })}</div>
            <div className="dim">{r.icuBurn.daysLeft === null ? "—" : t("ipdBillDesk.daysLeft", { count: r.icuBurn.daysLeft })}</div>
          </>
        )}
      </td>
      <td className="small dim ipdbd-since">{r.since === null ? "—" : when(r.since)}</td>
      <td className="ipdbd-act">
        <Link to="/ipd/admissions/$admissionId/bill" params={{ admissionId: r.admissionId }} className="ipdb-btn">{t("ipdBillDesk.openBill")}</Link>
        {retryable ? <button type="button" className="ipdb-btn" disabled={busy} onClick={() => onRetry(r.admissionId)}>{t("ipdBillDesk.retry")}</button> : null}
      </td>
    </tr>
  );
}

export function IpdBillDeskScreen(): React.ReactElement {
  const { t } = useTranslation();
  const [desk, setDesk] = useState<IpdBillDesk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IpdBillDeskReason | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): Promise<void> => getBillDesk().then(
    (d) => { setDesk(d); setError(null); },
    (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? t("ipdBillDesk.forbidden") : t("ipdBillDesk.loadFailed")),
  ), [t]);
  useEffect(() => { void load(); }, [load]);

  const retry = (admissionId: string): void => {
    setBusy(admissionId);
    setNotice(null);
    retryPosting(admissionId).then(
      (r) => { setNotice(t("ipdBillDesk.retried", { count: r.posted })); return load(); },
      () => setNotice(t("ipdBillDesk.retryFailed")),
    ).finally(() => setBusy(null));
  };

  const backdatedDone = (ok: boolean): void => {
    setNotice(ok ? t("ipdBillDesk.backdated.done") : t("ipdBillDesk.backdated.failed"));
    if (ok) void load();
  };

  if (error !== null) return <main className="ipdb ipdbd"><p role="alert" className="ipdb-error">{error}</p></main>;
  if (desk === null) return <main className="ipdb ipdbd"><p className="dim">{t("ipdBillDesk.loading")}</p></main>;
  const rows = filter === null ? desk.rows : desk.rows.filter((r) => r.reasons.includes(filter));

  return (
    <main className="ipdb ipdbd" aria-labelledby="ipdbd-title">
      <header className="ipdb-head">
        <div className="ipdb-title">
          <h1 id="ipdbd-title">{t("ipdBillDesk.title")}</h1>
          <span>{t("ipdBillDesk.subtitle")}</span>
          <span className="dim small">{t("ipdBillDesk.asOf", { at: when(desk.asOf) })}</span>
        </div>
        <div className="ipdb-actions">
          <Link to="/ipd/beds" className="ipdb-btn">{t("ipdBill.backToBeds")}</Link>
          <button type="button" className="ipdb-btn" onClick={() => { void load(); }}>{t("ipdBillDesk.refresh")}</button>
        </div>
      </header>

      <nav className="ipdbd-counts" aria-label={t("ipdBillDesk.countsLabel")}>
        <button type="button" className={`ipdbd-count ${filter === null ? "on" : ""}`} aria-pressed={filter === null} onClick={() => setFilter(null)}>
          <span className="n">{desk.rows.length}</span><span>{t("ipdBillDesk.all")}</span>
        </button>
        {REASONS.map((x) => (
          <button
            key={x} type="button" className={`ipdbd-count ${filter === x ? "on" : ""} ${desk.counts[x] > 0 && HOT.has(x) ? "hot" : ""}`}
            aria-pressed={filter === x} disabled={desk.counts[x] === 0} onClick={() => setFilter(filter === x ? null : x)}
          >
            <span className="n">{desk.counts[x]}</span><span>{t(`ipdBillDesk.reason.${x}`)}</span>
          </button>
        ))}
      </nav>

      {notice === null ? null : <p role="status" className="ipdbd-notice">{notice}</p>}

      <section className="ipdb-card ipdbd-list" aria-label={t("ipdBillDesk.listLabel")}>
        {rows.length === 0 ? <p className="ipdbd-empty">{t("ipdBillDesk.empty")}</p> : (
          <table>
            <thead>
              <tr>
                <th scope="col">{t("ipdBillDesk.col.patient")}</th>
                <th scope="col">{t("ipdBillDesk.col.bed")}</th>
                <th scope="col">{t("ipdBillDesk.col.why")}</th>
                <th scope="col">{t("ipdBillDesk.col.used")}</th>
                <th scope="col" className="num">{t("ipdBillDesk.col.payable")}</th>
                <th scope="col" className="num">{t("ipdBillDesk.col.deposit")}</th>
                <th scope="col" className="num">{t("ipdBillDesk.col.balance")}</th>
                <th scope="col">{t("ipdBillDesk.col.icu")}</th>
                <th scope="col">{t("ipdBillDesk.col.since")}</th>
                <th scope="col"><span className="sr">{t("ipdBillDesk.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <Row key={r.admissionId} r={r} canRetry={desk.canRetry} onRetry={retry} busy={busy === r.admissionId} onBackdated={backdatedDone} />)}
            </tbody>
          </table>
        )}
      </section>
      <IpdSettledBills />
      <p className="dim small">{t("ipdBillDesk.careNote")}</p>
    </main>
  );
}

/** The routed screen: `/ipd/bill-desk`. */
export function IpdBillDesk(): React.ReactElement {
  return <IpdBillDeskScreen />;
}
