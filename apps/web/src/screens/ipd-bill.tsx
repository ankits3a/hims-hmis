import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { fmtIst, fmtPaise } from "../lib/format";
import { getInterimBill } from "../lib/ipd-bill-api";
import type React from "react";
import type { IpdBedClass, IpdBillDay, IpdChargeLineView, IpdInterimBill } from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./ipd-bill.css";

/*
 * E2.1 (#725) — THE INTERIM BILL (spec §4.3 "interim bill on screen any time", §4.9 H). Read-only: the lines the nightly
 * job and the rounds taps posted, by IST day; each class move with its hour; what could not be posted (a missing rate is
 * shown, never guessed); totals, deposit paid and the balance. Billing and front office only (`ipd.bill.view`) — a doctor
 * never reaches this screen (decision 0058). 1920×1080 first, fits 1366×768; prints as the downtime paper copy.
 */

/** "10 Mar" — an IST calendar date (`YYYY-MM-DD`) as the bill prints it. */
const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
/** "10 Mar 23:00" — an instant in IST. */
const dayTime = (iso: string): string =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(iso))} ${fmtIst(iso)}`;

function ClassName({ cls }: { cls: IpdBedClass | null }): React.ReactElement {
  const { t } = useTranslation();
  return <>{cls === null ? "—" : t(`ipdBill.class.${cls}`)}</>;
}

function Line({ l }: { l: IpdChargeLineView }): React.ReactElement {
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
    </tr>
  );
}

function Day({ d }: { d: IpdBillDay }): React.ReactElement {
  return (
    <tbody className="ipdb-day">
      <tr className="ipdb-dayhead">
        <th colSpan={6} scope="rowgroup">
          <span className="strong">{dayLabel(d.date)}</span>
          <span className="ipdb-class"><ClassName cls={d.billedClass} /></span>
        </th>
        <th className="num">{fmtPaise(d.totalPaise)}</th>
      </tr>
      {d.lines.map((l) => <Line key={l.id} l={l} />)}
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
  const [bill, setBill] = useState<IpdInterimBill | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  if (bill === null) return <main className="ipdb"><p className="dim">{t("ipdBill.loading")}</p></main>;
  const due = bill.balancePaise < 0;

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
          <button type="button" className="ipdb-btn" onClick={() => window.print()}>{t("ipdBill.print")}</button>
        </div>
      </header>

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
                </tr>
              </thead>
              {bill.days.map((d) => <Day key={d.date} d={d} />)}
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

          {bill.exceptions.length === 0 ? null : (
            <section className="ipdb-card ipdb-ex" aria-label={t("ipdBill.exceptionsLabel")}>
              <h2>{t("ipdBill.exceptionsTitle", { count: bill.exceptions.length })}</h2>
              <ul>
                {bill.exceptions.map((x) => (
                  <li key={`${x.serviceDate}:${x.component}:${x.serviceCode ?? ""}`}>
                    <span className="ipdb-tag warn">{t(`ipdBill.reason.${x.reason}`)}</span>
                    {dayLabel(x.serviceDate)} · {t(`ipdBill.component.${x.component}`)} · <ClassName cls={x.billedClass} />
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
