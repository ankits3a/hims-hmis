import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { fmtIst, fmtPaise } from "../lib/format";
import { getInterimBill, printInterimBill } from "../lib/ipd-bill-api";
import { AttendantMessagesCard } from "./ipd-attendant-card";
import { TpaPanel } from "./ipd-tpa-panel";
import type React from "react";
import type {
  IpdBedClass, IpdBillDay, IpdChargeLineView, IpdInterimBill, IpdPayerSplit, IpdSplitLine, IpdSplitSnapshot,
} from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./ipd-bill.css";
import { dateLocale } from "../lib/date-locale";

/*
 * E2.1 (#725) — THE INTERIM BILL (spec §4.3 "interim bill on screen any time", §4.9 H). Read-only: the lines the nightly
 * job and the rounds taps posted, by IST day; each class move with its hour; what could not be posted (a missing rate is
 * shown, never guessed); totals, deposit paid and the balance. Billing and front office only (`ipd.bill.view`) — a doctor
 * never reaches this screen (decision 0058). 1920×1080 first, fits 1366×768; prints as the downtime paper copy.
 *
 * E2.2 (#726) — insured and scheme stays add Payer and Patient columns per line (reason chips in words) and a Payer split
 * card: authorisation state, the room-rent cap deduction in words, payer and patient totals, the patient's balance.
 * Printing keeps the split as printed (`POST …/interim-bill/print`) before the browser prints.
 */

/** "10 Mar" — an IST calendar date (`YYYY-MM-DD`) as the bill prints it. */
const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "UTC", day: "2-digit", month: "short", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
/** "10 Mar 23:00" — an instant in IST. */
const dayTime = (iso: string): string =>
  `${new Intl.DateTimeFormat(dateLocale(undefined, "en-GB"), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(iso))} ${fmtIst(iso)}`;

function ClassName({ cls }: { cls: IpdBedClass | null }): React.ReactElement {
  const { t } = useTranslation();
  return <>{cls === null ? "—" : t(`ipdBill.class.${cls}`)}</>;
}

/** Insured and scheme stays show the split per line; a cash stay is all the patient's and keeps the plain table. */
const showsSplit = (split: IpdPayerSplit): boolean => split.mode === "insured" || split.mode === "scheme";

function SplitCells({ s }: { s: IpdSplitLine | undefined }): React.ReactElement {
  const { t } = useTranslation();
  if (s === undefined) return <><td className="num">—</td><td className="num">—</td></>;
  const why = s.reasons.filter((r) => r !== "scheme");
  return (
    <>
      <td className="num">{fmtPaise(s.payerPaise)}</td>
      <td className="num">
        {fmtPaise(s.patientPaise)}
        {why.length === 0 ? null : <div className="ipdb-why">{why.map((r) => <span key={r} className="ipdb-tag">{t(`ipdBill.split.why.${r}`)}</span>)}</div>}
      </td>
    </>
  );
}

function Line({ l, split }: { l: IpdChargeLineView; split: Map<string, IpdSplitLine> | null }): React.ReactElement {
  const { t } = useTranslation();
  const cls = `ipdb-line${l.reversed ? " reversed" : ""}${l.reversalOf !== null ? " reversal" : ""}`;
  return (
    <tr className={cls}>
      <td>{t(`ipdBill.component.${l.component}`)}{l.consultantName === null ? null : <span className="dim"> · {l.consultantName}</span>}</td>
      <td className="mono dim">{l.serviceCode}</td>
      <td>
        {l.reversalOf !== null ? <span className="ipdb-tag">{t("ipdBill.reversal")}</span> : null}
        {l.reversed ? <span className="ipdb-tag">{t("ipdBill.reversed")}</span> : null}
        {l.reason === null ? null : <span className="dim small"> {l.reason}</span>}
      </td>
      <td className="num">{l.qty}</td>
      <td className="num">{fmtPaise(l.unitPaise)}</td>
      <td className="num">{l.gstPaise === 0 ? <span className="dim">{t("ipdBill.exempt")}</span> : fmtPaise(l.gstPaise)}</td>
      <td className="num strong">{fmtPaise(l.netPaise)}</td>
      {split === null ? null : <SplitCells s={split.get(l.id)} />}
    </tr>
  );
}

function Day({ d, split }: { d: IpdBillDay; split: Map<string, IpdSplitLine> | null }): React.ReactElement {
  return (
    <tbody className="ipdb-day">
      <tr className="ipdb-dayhead">
        <th colSpan={6} scope="rowgroup">
          <span className="strong">{dayLabel(d.date)}</span>
          <span className="ipdb-class"><ClassName cls={d.billedClass} /></span>
        </th>
        <th className="num">{fmtPaise(d.totalPaise)}</th>
        {split === null ? null : <><th /><th /></>}
      </tr>
      {d.lines.map((l) => <Line key={l.id} l={l} split={split} />)}
    </tbody>
  );
}

/** The routed screen: `/ipd/admissions/$admissionId/bill`. */
export function IpdBill(): React.ReactElement {
  const { admissionId } = useParams({ strict: false }) as { admissionId?: string };
  return <IpdBillScreen admissionId={admissionId ?? ""} />;
}

export function IpdBillScreen({ admissionId }: { admissionId: string }): React.ReactElement {
  const { t } = useTranslation();
  const [loaded, setBill] = useState<IpdInterimBill | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Review 5: the paper prints the split the server KEPT (the snapshot's answer), and only once it is kept.
  const [printed, setPrinted] = useState<IpdSplitSnapshot | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  useEffect(() => {
    if (printed === null) return;
    window.print();
  }, [printed]);

  useEffect(() => {
    let live = true;
    getInterimBill(admissionId).then(
      (b) => { if (live) setBill(b); },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 403 ? t("ipdBill.forbidden") : e instanceof ApiError && e.status === 404 ? t("ipdBill.notFound") : t("ipdBill.loadFailed"));
      },
    );
    return () => { live = false; };
  }, [admissionId, t]);

  if (error !== null) return <main className="ipdb"><p role="alert" className="ipdb-error">{error}</p></main>;
  if (loaded === null) return <main className="ipdb"><p className="dim">{t("ipdBill.loading")}</p></main>;
  const bill: IpdInterimBill = printed === null ? loaded
    : { ...loaded, payerSplit: printed.payerSplit, patientBalancePaise: printed.patientBalancePaise };
  const due = bill.balancePaise < 0;
  const split = showsSplit(bill.payerSplit) ? new Map(bill.payerSplit.lines.map((l) => [l.lineId, l] as const)) : null;
  // The split is kept first; the paper then prints exactly that. A failed keep blocks printing (review 5).
  const print = (): void => {
    setPrintError(null);
    printInterimBill(admissionId).then((snap) => setPrinted(snap), () => setPrintError(t("ipdBill.split.printFailed")));
  };

  return (
    <main className="ipdb" aria-labelledby="ipdb-title">
      <header className="ipdb-head">
        <div className="ipdb-title">
          <h1 id="ipdb-title">{t("ipdBill.title")}</h1>
          <span>{bill.patient.name ?? bill.patient.uhid}</span>
          <span className="mono">{bill.patient.uhid}</span>
          {bill.admissionNo === null ? null : <span className="mono">{bill.admissionNo}</span>}
        </div>
        <div className="ipdb-actions">
          <Link to="/ipd/beds" className="ipdb-btn">{t("ipdBill.backToBeds")}</Link>
          <button type="button" className="ipdb-btn" onClick={print}>{t("ipdBill.print")}</button>
        </div>
      </header>

      {printError === null ? null : <p role="alert" className="ipdb-error">{printError}</p>}

      <section className="ipdb-facts" aria-label={t("ipdBill.factsLabel")}>
        <div><span className="dim small">{t("ipdBill.admitted")}</span><span>{bill.admittedAt === null ? "—" : dayTime(bill.admittedAt)}</span></div>
        <div><span className="dim small">{t("ipdBill.discharged")}</span><span>{bill.dischargedAt === null ? t("ipdBill.inBed") : dayTime(bill.dischargedAt)}</span></div>
        <div><span className="dim small">{t("ipdBill.payer")}</span><span>{bill.payerKind === null ? "—" : t(`ipdBill.payerKind.${bill.payerKind}`, bill.payerKind)}</span></div>
        <div><span className="dim small">{t("ipdBill.tariff")}</span><span>{bill.tariffVersionNo === null ? "—" : t("ipdBill.tariffVersion", { no: bill.tariffVersionNo })}</span></div>
        <div><span className="dim small">{t("ipdBill.postedThrough")}</span><span>{bill.postedThrough === null ? "—" : dayLabel(bill.postedThrough)}</span></div>
      </section>

      <div className="ipdb-grid">
        <section className="ipdb-card ipdb-lines" aria-label={t("ipdBill.linesLabel")}>
          {bill.days.length === 0 ? <p className="dim">{t("ipdBill.noLines")}</p> : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("ipdBill.col.item")}</th><th scope="col">{t("ipdBill.col.code")}</th><th scope="col" />
                  <th scope="col" className="num">{t("ipdBill.col.qty")}</th><th scope="col" className="num">{t("ipdBill.col.rate")}</th>
                  <th scope="col" className="num">{t("ipdBill.col.gst")}</th><th scope="col" className="num">{t("ipdBill.col.amount")}</th>
                  {split === null ? null : <><th scope="col" className="num">{t("ipdBill.split.colPayer")}</th><th scope="col" className="num">{t("ipdBill.split.colPatient")}</th></>}
                </tr>
              </thead>
              {bill.days.map((d) => <Day key={d.date} d={d} split={split} />)}
            </table>
          )}
          <p className="dim small">{t("ipdBill.todayNote")}</p>
        </section>

        <aside className="ipdb-side">
          <section className="ipdb-card ipdb-totals" aria-label={t("ipdBill.totalsLabel")}>
            <div className="row"><span>{t("ipdBill.gross")}</span><span className="num">{fmtPaise(bill.totals.grossPaise)}</span></div>
            {bill.totals.discountPaise === 0 ? null : <div className="row"><span>{t("ipdBill.discount")}</span><span className="num">-{fmtPaise(bill.totals.discountPaise)}</span></div>}
            <div className="row"><span>{t("ipdBill.gst")}</span><span className="num">{fmtPaise(bill.totals.gstPaise)}</span></div>
            <div className="row total"><span>{t("ipdBill.total")}</span><span className="num">{fmtPaise(bill.totals.roundedPaise)}</span></div>
            <div className="row"><span>{t("ipdBill.deposit")}</span><span className="num">{fmtPaise(bill.depositPaidPaise)}</span></div>
            <div className={`row balance ${due ? "due" : "left"}`}>
              <span>{due ? t("ipdBill.due") : t("ipdBill.depositLeft")}</span>
              <span className="num">{fmtPaise(Math.abs(bill.balancePaise))}</span>
            </div>
            <ul className="ipdb-bycomp">
              {bill.byComponent.map((c) => (
                <li key={c.component}><span>{t(`ipdBill.component.${c.component}`)}</span><span className="num">{fmtPaise(c.netPaise)}</span></li>
              ))}
            </ul>
          </section>

          <SplitCard bill={bill} />

          <AttendantMessagesCard admissionId={admissionId} />

          {/* #604 — the TPA desk's panel for this stay (hidden without `ipd.payer.manage`, and for a plain cash stay). */}
          <TpaPanel admissionId={admissionId} patientId={bill.patient.id} />

          {bill.exceptions.length === 0 ? null : (
            <section className="ipdb-card ipdb-ex" aria-label={t("ipdBill.exceptionsLabel")}>
              <h2>{t("ipdBill.exceptionsTitle", { count: bill.exceptions.length })}</h2>
              <ul>
                {bill.exceptions.map((x) => (
                  <li key={`${x.reason}:${x.serviceDate ?? ""}:${x.component ?? ""}:${x.serviceCode ?? ""}`}>
                    <span className="ipdb-tag warn">{t(`ipdBill.reason.${x.reason}`)}</span>
                    {x.serviceDate === null || x.component === null
                      ? <span>{t("ipdBill.postingFailed", { count: x.failCount })}{x.errorCode === null ? null : <span className="mono dim small"> {x.errorCode}</span>}</span>
                      : <>{dayLabel(x.serviceDate)} · {t(`ipdBill.component.${x.component}`)} · <ClassName cls={x.billedClass} /></>}
                    {x.serviceCode === null ? null : <span className="mono dim small"> {x.serviceCode}</span>}
                  </li>
                ))}
              </ul>
              <p className="small dim">{t("ipdBill.exceptionsFix")}</p>
            </section>
          )}

          <section className="ipdb-card ipdb-moves" aria-label={t("ipdBill.movesLabel")}>
            <h2>{t("ipdBill.movesTitle")}</h2>
            <ol>
              {bill.stays.map((s) => (
                <li key={`${s.bedCode}:${s.startedAt}`}>
                  <span className="mono strong">{s.bedCode}</span> <ClassName cls={s.bedClass} />
                  {s.billedClass === s.bedClass ? null : <span className="dim"> · {t("ipdBill.billsAs")} <ClassName cls={s.billedClass} /></span>}
                  <div className="small dim">{dayTime(s.startedAt)} → {s.endedAt === null ? t("ipdBill.now") : dayTime(s.endedAt)}</div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </main>
  );
}

/** E2.2 (#726) — the payer split: who pays what, the deductions in words, and the patient's balance. */
function SplitCard({ bill }: { bill: IpdInterimBill }): React.ReactElement | null {
  const { t } = useTranslation();
  const sp = bill.payerSplit;
  if (sp.mode === "cash" && sp.exceptions.length === 0 && !sp.lines.some((l) => l.reasons.includes("denied"))) return null;
  const due = bill.patientBalancePaise < 0;
  return (
    <section className="ipdb-card ipdb-split" aria-label={t("ipdBill.split.label")}>
      <h2>{t("ipdBill.split.title")}</h2>
      <div className="row"><span className="ipdb-tag">{t(`ipdBill.split.mode.${sp.mode}`)}</span>
        {sp.mode === "insured" ? <span className="ipdb-tag">{t(`ipdBill.split.state.${sp.authState}`)}</span> : null}
        {sp.preAuthNumber === null ? null : <span className="mono small">{t("ipdBill.split.preAuth", { no: sp.preAuthNumber })}</span>}
      </div>
      {sp.exceptions.map((x) => <p key={x} role="alert" className="ipdb-tag warn">{t(`ipdBill.split.exception.${x}`)}</p>)}
      {sp.approvedTotalPaise === null ? null : <div className="row small"><span>{t("ipdBill.split.approved", { amount: fmtPaise(sp.approvedTotalPaise) })}</span></div>}
      <ul className="ipdb-words">{sp.words.map((w) => <li key={w}>{w}</li>)}</ul>
      <div className="row"><span>{t("ipdBill.split.payer")}</span><span className="num">{fmtPaise(sp.totals.payerPaise)}</span></div>
      <div className="row total"><span>{t("ipdBill.split.patient")}</span><span className="num">{fmtPaise(sp.totals.patientPaise)}</span></div>
      <div className={`row balance ${due ? "due" : "left"}`}>
        <span>{due ? t("ipdBill.split.patientDue") : t("ipdBill.split.patientLeft")}</span>
        <span className="num">{fmtPaise(Math.abs(bill.patientBalancePaise))}</span>
      </div>
    </section>
  );
}
