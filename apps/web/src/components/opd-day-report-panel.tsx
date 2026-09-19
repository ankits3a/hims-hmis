import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { todayIst } from "../lib/desk-api";
import { downloadDayReportCsv, fetchDayReport, openReportPdf } from "../lib/opd-reports-api";
import type { DayCounts, OpdDayReport } from "../lib/opd-reports-api";
import "../screens/opd-day-report.css";

/**
 * ═══ THE OPD DAY REPORT, WHERE THE DAY IS ALREADY OPEN ═══
 *
 * Owner, 2026-09-19: *"give me an option in the dashboard to download the day report"*. So the
 * dashboard carries it whole — the day's four figures and both downloads — rather than a link to a
 * screen that has them. Today is chosen before anyone touches it; yesterday is one tap, because the
 * report is most often pulled the morning after. The department-wise screen is one more tap for
 * whoever wants to look before they download.
 */

export function yesterdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** `19 Sep 2026, Saturday` — the day in words, so a picked date is never read wrong. */
export function longDay(date: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function DayPicker({ date, onChange }: { date: string; onChange: (d: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst();
  const yesterday = yesterdayOf(today);
  return (
    <div className="odr-days" role="group" aria-label={t("dayReport.pickDay")}>
      <button type="button" className={date === today ? "odr-chip on" : "odr-chip"} aria-pressed={date === today}
        onClick={() => onChange(today)} data-testid="odr-today">{t("dayReport.today")}</button>
      <button type="button" className={date === yesterday ? "odr-chip on" : "odr-chip"} aria-pressed={date === yesterday}
        onClick={() => onChange(yesterday)} data-testid="odr-yesterday">{t("dayReport.yesterday")}</button>
      <input type="date" className="odr-date mo" value={date} max={today} aria-label={t("dayReport.otherDay")}
        onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value); }}
        data-testid="odr-date" />
    </div>
  );
}

export function DayFigures({ counts, testId }: { counts: DayCounts; testId?: string }): React.ReactElement {
  const { t } = useTranslation();
  const fig = (n: number, label: string, hint: string, key: string, main = false) => (
    <div className={main ? "fig odr-main" : "fig"} title={hint} data-testid={`odr-fig-${key}`}>
      <span className="n mo">{n}</span>
      <span className="l">{label}</span>
    </div>
  );
  return (
    <div className="figs odr-figs" data-testid={testId}>
      {fig(counts.consulted, t("dayReport.consulted"), t("dayReport.consultedHint"), "consulted", true)}
      {fig(counts.new, t("dayReport.new"), t("dayReport.newHint"), "new")}
      {fig(counts.revisit, t("dayReport.revisit"), t("dayReport.revisitHint"), "revisit")}
      {fig(counts.renewal, t("dayReport.renewal"), t("dayReport.renewalHint"), "renewal")}
      {fig(counts.booked, t("dayReport.booked"), t("dayReport.bookedHint"), "booked")}
    </div>
  );
}

/** The day is not over, or visits are still open: say so beside the numbers, never under them. */
export function ProvisionalPill({ report }: { report: OpdDayReport }): React.ReactElement | null {
  const { t } = useTranslation();
  if (!report.provisional && report.totals.stillOpen === 0) return null;
  return (
    <span className="pill gd" data-testid="odr-provisional">
      {report.totals.stillOpen > 0
        ? t("dayReport.stillOpen", { count: report.totals.stillOpen })
        : t("dayReport.inProgress")}
    </span>
  );
}

/**
 * The two downloads, with the three things a button owes the person who pressed it: that it is
 * working, that it worked, and — in words — why it did not.
 */
export function useReportDownloads(): {
  busy: string | null;
  error: string | null;
  pdf: (key: string, target: "day" | { departmentId: string }, date: string) => void;
  csv: (key: string, run: () => Promise<void>) => void;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pdf = (key: string, target: "day" | { departmentId: string }, date: string): void => {
    setError(null);
    setBusy(key);
    openReportPdf(target, date)
      .then((outcome) => { if (outcome === "blocked") setError(t("dayReport.popupBlocked")); })
      .catch(() => setError(t("dayReport.failed")))
      .finally(() => setBusy(null));
  };
  const csv = (key: string, run: () => Promise<void>): void => {
    setError(null);
    setBusy(key);
    run().catch(() => setError(t("dayReport.failed"))).finally(() => setBusy(null));
  };
  return { busy, error, pdf, csv };
}

export function DownloadButtons({
  busy, onPdf, onCsv, pdfKey, csvKey, compact = false, label,
}: {
  busy: string | null; onPdf: () => void; onCsv: () => void; pdfKey: string; csvKey: string; compact?: boolean; label?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const icon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" />
    </svg>
  );
  return (
    <>
      {/*
        A department row carries its downloads quietly — outlined and short — so twelve rows read as
        numbers first. The hospital's own PDF is the one loud button on the screen.
      */}
      <button type="button" className={compact ? "odr-btn sm" : "odr-btn pri"} disabled={busy !== null}
        onClick={onPdf} data-testid={pdfKey} aria-label={label === undefined ? undefined : `${t("dayReport.pdf")} — ${label}`}>
        {icon}{busy === pdfKey ? t("dayReport.preparing") : compact ? "PDF" : t("dayReport.pdf")}
      </button>
      <button type="button" className={compact ? "odr-btn sm" : "odr-btn"} disabled={busy !== null}
        onClick={onCsv} data-testid={csvKey} aria-label={label === undefined ? undefined : `${t("dayReport.csv")} — ${label}`}>
        {icon}{busy === csvKey ? t("dayReport.preparing") : compact ? "CSV" : t("dayReport.csv")}
      </button>
    </>
  );
}

export function OpdDayReportPanel(): React.ReactElement {
  const { t } = useTranslation();
  const [date, setDate] = useState(todayIst());
  const report = useQuery({ queryKey: ["opd-day-report", date], queryFn: () => fetchDayReport(date) });
  const dl = useReportDownloads();

  return (
    <div className="band" data-testid="odr-panel">
      <div className="bandhd">
        <span className="tag">{t("dayReport.band")}</span>
        <span className="bandnote">{t("dayReport.bandNote")}</span>
      </div>
      <div className="box odr-box">
        <div className="odr-top">
          <DayPicker date={date} onChange={setDate} />
          <span className="odr-long">{longDay(date)}</span>
          {report.data === undefined ? null : <ProvisionalPill report={report.data} />}
          <Link to="/reports/opd-day" search={{ date }} className="odr-more" data-testid="odr-open">
            {t("dayReport.byDepartment")} →
          </Link>
        </div>

        {report.isPending ? <p className="bandnote">{t("app.loading")}</p> : null}
        {report.isError ? <p role="alert" className="odr-err">{t("dayReport.loadFailed")}</p> : null}
        {report.data === undefined ? null : <DayFigures counts={report.data.totals} testId="odr-figs" />}

        <div className="odr-actions">
          <DownloadButtons busy={dl.busy} pdfKey="odr-pdf" csvKey="odr-csv"
            onPdf={() => dl.pdf("odr-pdf", "day", date)} onCsv={() => dl.csv("odr-csv", () => downloadDayReportCsv(date))} />
          <span className="odr-hint">{t("dayReport.pdfHint")}</span>
        </div>
        {dl.error === null ? null : <p role="alert" className="odr-err">{dl.error}</p>}
      </div>
    </div>
  );
}

