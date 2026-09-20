import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { todayIst } from "../lib/desk-api";
import { downloadReportCsv, fetchReport, openReportPdf } from "../lib/opd-reports-api";
import type { DayCounts, OpdReport, ReportRange, Selection } from "../lib/opd-reports-api";
import "../screens/opd-report.css";

/**
 * ═══ THE OPD REPORT, WHERE THE DAY IS ALREADY OPEN ═══
 *
 * Owner, 2026-09-19: *"give me an option in the dashboard to download the day report"*. So the
 * dashboard carries it whole — the period's figures and both downloads — rather than a link to a
 * screen that has them.
 *
 * Owner, 2026-09-20: *"…the report of 'This Week' (week starts on Monday - Saturday) and 'This
 * Month' as well along with Today and Yesterday."* Four named periods, one tap each, and the days
 * they cover printed beside them — because "this week" is a rule, and a reader who cannot see which
 * days it meant cannot check the number against anything.
 */

export function yesterdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** `Sunday, 20 Sept 2026` — the day in words, so a picked date is never read wrong. */
export function longDay(date: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

const SHORT = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

/** `Mon 14 Sep – Sat 19 Sep 2026 · 6 days`, or the single day in words. */
export function rangeText(range: { from: string; to: string }): string {
  if (range.from === range.to) return longDay(range.from);
  const days = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
  return `${SHORT.format(new Date(`${range.from}T00:00:00Z`))} – ${SHORT.format(new Date(`${range.to}T00:00:00Z`))} ${range.to.slice(0, 4)} · ${String(days)} days`;
}

export function todaySelection(): Selection {
  return { period: "day", date: todayIst() };
}

/**
 * The four named periods and a date box for any other day. A chip is ON when the selection IS it, so
 * picking 12 September from the box leaves no chip lit — the reader is looking at that day, not at
 * "today".
 */
export function PeriodPicker({ sel, onChange }: { sel: Selection; onChange: (s: Selection) => void }): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst();
  const yesterday = yesterdayOf(today);
  const chip = (key: string, label: string, is: boolean, to: Selection) => (
    <button type="button" className={is ? "odr-chip on" : "odr-chip"} aria-pressed={is}
      onClick={() => onChange(to)} data-testid={`odr-${key}`}>{label}</button>
  );
  return (
    <div className="odr-days" role="group" aria-label={t("dayReport.pickPeriod")}>
      {chip("today", t("dayReport.today"), sel.period === "day" && sel.date === today, { period: "day", date: today })}
      {chip("yesterday", t("dayReport.yesterday"), sel.period === "day" && sel.date === yesterday, { period: "day", date: yesterday })}
      {chip("week", t("dayReport.thisWeek"), sel.period === "week", { period: "week", date: today })}
      {chip("month", t("dayReport.thisMonth"), sel.period === "month", { period: "month", date: today })}
      <input type="date" className="odr-date mo" value={sel.date} max={today} aria-label={t("dayReport.otherDay")}
        onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange({ period: "day", date: e.target.value }); }}
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

/** The period is not over, or visits are still open: say so beside the numbers, never under them. */
export function ProvisionalPill({ report }: { report: OpdReport }): React.ReactElement | null {
  const { t } = useTranslation();
  if (!report.provisional && report.totals.stillOpen === 0) return null;
  const inProgress = report.period === "day" ? t("dayReport.inProgress") : t("dayReport.periodInProgress");
  return (
    <span className="pill gd" data-testid="odr-provisional">
      {report.totals.stillOpen > 0 ? t("dayReport.stillOpen", { count: report.totals.stillOpen }) : inProgress}
    </span>
  );
}

/**
 * THE SUNDAY A WEEK LEAVES OUT. The owner's week is Monday to Saturday, so a Sunday's consultations
 * belong to no week at all — and a total that is quietly short of the month is how a hospital stops
 * trusting both numbers. Shown only when that Sunday actually carried work.
 */
export function ExcludedSundayNote({ report }: { report: { excludedSunday: { date: string; consulted: number } | null } }): React.ReactElement | null {
  const { t } = useTranslation();
  if (report.excludedSunday === null) return null;
  return (
    <p className="odr-sunday" data-testid="odr-sunday">
      {t("dayReport.sundayExcluded", { count: report.excludedSunday.consulted, day: longDay(report.excludedSunday.date) })}
    </p>
  );
}

/**
 * The two downloads, with the three things a button owes the person who pressed it: that it is
 * working, that it worked, and — in words — why it did not.
 */
export function useReportDownloads(): {
  busy: string | null;
  error: string | null;
  pdf: (key: string, target: "report" | { departmentId: string }, sel: Selection) => void;
  csv: (key: string, run: () => Promise<void>) => void;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pdf = (key: string, target: "report" | { departmentId: string }, sel: Selection): void => {
    setError(null);
    setBusy(key);
    openReportPdf(target, sel)
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

export function OpdReportPanel(): React.ReactElement {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Selection>(todaySelection);
  const report = useQuery({ queryKey: ["opd-report", sel.period, sel.date], queryFn: () => fetchReport(sel) });
  const dl = useReportDownloads();
  const range: ReportRange | undefined = report.data;

  return (
    <div className="band" data-testid="odr-panel">
      <div className="bandhd">
        <span className="tag">{t("dayReport.band")}</span>
        <span className="bandnote">{t("dayReport.bandNote")}</span>
      </div>
      <div className="box odr-box">
        <div className="odr-top">
          <PeriodPicker sel={sel} onChange={setSel} />
          <span className="odr-long" data-testid="odr-range">{range === undefined ? longDay(sel.date) : rangeText(range)}</span>
          {report.data === undefined ? null : <ProvisionalPill report={report.data} />}
          <Link to="/reports/opd-day" search={{ period: sel.period, date: sel.date }} className="odr-more" data-testid="odr-open">
            {t("dayReport.byDepartment")} →
          </Link>
        </div>

        {report.isPending ? <p className="bandnote">{t("app.loading")}</p> : null}
        {report.isError ? <p role="alert" className="odr-err">{t("dayReport.loadFailed")}</p> : null}
        {report.data === undefined ? null : <DayFigures counts={report.data.totals} testId="odr-figs" />}
        {report.data === undefined ? null : <ExcludedSundayNote report={report.data} />}

        <div className="odr-actions">
          <DownloadButtons busy={dl.busy} pdfKey="odr-pdf" csvKey="odr-csv"
            onPdf={() => dl.pdf("odr-pdf", "report", sel)} onCsv={() => dl.csv("odr-csv", () => downloadReportCsv(sel))} />
          <span className="odr-hint">{t("dayReport.pdfHint")}</span>
        </div>
        {dl.error === null ? null : <p role="alert" className="odr-err">{dl.error}</p>}
      </div>
    </div>
  );
}
