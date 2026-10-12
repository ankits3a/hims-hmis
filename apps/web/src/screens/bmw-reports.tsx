import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { downloadFormIv, downloadMonthly, fetchFormIv, fetchMonthly } from "../lib/bmw-api";
import type { BmwReportLine } from "@hmis/contracts";
import "./bmw.css";

/**
 * ═══ E1.7 BIO-MEDICAL WASTE (issue #724) — THE TWO LEGAL REPORTS ═══
 *
 * The monthly report and the annual Form IV figures, both read off the bag records by the server — nothing on
 * this screen is typed. Each table has its CSV download. "of which cytotoxic" sits inside yellow and is not added
 * to the total.
 */
const kg3 = (g: number): string => (g / 1000).toFixed(1);
const istToday = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function BmwReports(): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => istToday().slice(0, 7));
  const [year, setYear] = useState(() => istToday().slice(0, 4));
  const m = useQuery({ queryKey: ["bmw", "monthly", month], queryFn: () => fetchMonthly(month), enabled: /^\d{4}-\d{2}$/.test(month) });
  const y = useQuery({ queryKey: ["bmw", "form-iv", year], queryFn: () => fetchFormIv(year), enabled: /^\d{4}$/.test(year) });
  const line = (l: BmwReportLine["line"]): string => t(`bmw.reports.line.${l}`);

  return (
    <PaperScreen testId="bmw-reports">
      <div className="bw-reports">
        <section className="box bw-report" data-testid="bmw-monthly">
          <header>
            <b>{t("bmw.reports.monthly")}</b>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t("bmw.reports.month")} data-testid="bmw-month" />
            <button type="button" className="bw-btn" onClick={() => void downloadMonthly(month)} data-testid="bmw-monthly-csv">{t("bmw.reports.csv")}</button>
          </header>
          <table className="bw-table">
            <thead>
              <tr><th>{t("bmw.reports.category")}</th><th>{t("bmw.reports.genBags")}</th><th>{t("bmw.reports.genKg")}</th><th>{t("bmw.reports.outBags")}</th><th>{t("bmw.reports.outKg")}</th><th>{t("bmw.reports.treatedBags")}</th><th>{t("bmw.reports.treatedKg")}</th></tr>
            </thead>
            <tbody>
              {(m.data?.lines ?? []).map((l) => (
                <tr key={l.line} className={l.subsetOf === null ? "" : "sub"} data-testid={`monthly-${l.line}`}>
                  <td>{line(l.line)}</td><td>{l.generatedBags}</td><td>{kg3(l.generatedGrams)}</td><td>{l.handedOverBags}</td><td>{kg3(l.handedOverGrams)}</td><td>{l.treatedBags}</td><td>{kg3(l.treatedGrams)}</td>
                </tr>
              ))}
              {m.data !== undefined && (
                <tr className="tot" data-testid="monthly-total">
                  <td>{t("bmw.reports.total")}</td><td>{m.data.totals.generatedBags}</td><td>{kg3(m.data.totals.generatedGrams)}</td><td>{m.data.totals.handedOverBags}</td>
                  <td>{kg3(m.data.totals.handedOverGrams)}</td><td>{m.data.totals.treatedBags}</td><td>{kg3(m.data.totals.treatedGrams)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {m.data !== undefined && (
            <div className="bw-sub">{t("bmw.reports.footnote", { unweighed: m.data.unweighedBags, disputes: m.data.openDisputes })}</div>
          )}
        </section>

        <section className="box bw-report" data-testid="bmw-form-iv">
          <header>
            <b>{t("bmw.reports.formIv")}</b>
            <input type="number" min={2020} max={2100} value={year} onChange={(e) => setYear(e.target.value)} aria-label={t("bmw.reports.year")} data-testid="bmw-year" />
            <button type="button" className="bw-btn" onClick={() => void downloadFormIv(year)} data-testid="bmw-form-iv-csv">{t("bmw.reports.csv")}</button>
          </header>
          <table className="bw-table wide">
            <thead>
              <tr><th>{t("bmw.reports.categoryKg")}</th>{(y.data?.months ?? []).map((mm) => <th key={mm.month}>{t(`bmw.reports.mon.${mm.month.slice(5)}`)}</th>)}<th>{t("bmw.reports.total")}</th></tr>
            </thead>
            <tbody>
              {y.data !== undefined && (Object.keys(y.data.annualGrams) as BmwReportLine["line"][]).map((l) => (
                <tr key={l} className={l === "yellow_cytotoxic" ? "sub" : ""} data-testid={`form-iv-${l}`}>
                  <td>{line(l)}</td>{y.data.months.map((mm) => <td key={mm.month}>{kg3(mm.grams[l])}</td>)}<td>{kg3(y.data.annualGrams[l])}</td>
                </tr>
              ))}
              {y.data !== undefined && (
                <tr className="tot" data-testid="form-iv-total">
                  <td>{t("bmw.reports.total")}</td>
                  {y.data.months.map((mm) => <td key={mm.month}>{kg3(Object.entries(mm.grams).filter(([k]) => k !== "yellow_cytotoxic").reduce((n, [, v]) => n + v, 0))}</td>)}
                  <td>{kg3(y.data.annualTotalGrams)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {y.data !== undefined && <div className="bw-sub">{t("bmw.reports.perDay", { kg: kg3(y.data.averageGramsPerDay), days: y.data.days })}</div>}
        </section>
      </div>
    </PaperScreen>
  );
}
