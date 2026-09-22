import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import {
  downloadDepartmentCsv, downloadReportCsv, fetchDepartmentReport, fetchReport,
} from "../lib/opd-reports-api";
import type { DayCounts, DayDepartment, PatientType, Selection } from "../lib/opd-reports-api";
import {
  DayFigures, DownloadButtons, ExcludedSundayNote, PeriodPicker, ProvisionalPill, rangeText, todaySelection,
  useReportDownloads,
} from "../components/opd-report-panel";
import "../styles/paper-pine.css";
import "./dashboard.css";
import "./opd-report.css";

/**
 * ═══ THE OPD REPORT, DEPARTMENT BY DEPARTMENT ═══
 *
 * The dashboard panel's second door: the same period, one row per clinical department, each row with
 * its own PDF and CSV, and — one tap — the patients behind the row. Nothing here is computed: every
 * figure is the server's, which also builds the files, so the table and the sheet cannot disagree.
 *
 * Opening a department's patients is a read of names and addresses, and the server logs it
 * (`day_report.patients_listed`), so the list is fetched when asked for and not before. Over a week
 * or a month the list carries the DAY of each visit; over a single day that column would be noise.
 */

const TYPE_KEY: Record<PatientType, string> = { new: "dayReport.new", revisit: "dayReport.revisit", renewal: "dayReport.renewal" };

function Counts({ c, showOpen, total = false }: { c: DayCounts; showOpen: boolean; total?: boolean }): React.ReactElement {
  const cell = (n: number) => <td className={!total && n === 0 ? "n mo zero" : "n mo"}>{n}</td>;
  return (
    <>
      {cell(c.booked)}{cell(c.consulted)}{cell(c.new)}{cell(c.revisit)}{cell(c.renewal)}
      {showOpen ? cell(c.stillOpen) : null}
    </>
  );
}

const DAY_IN_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "2-digit", month: "short" });

function Patients({ department, sel, span }: { department: DayDepartment; sel: Selection; span: number }): React.ReactElement {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ["opd-report", sel.period, sel.date, "department", department.departmentId],
    queryFn: () => fetchDepartmentReport(department.departmentId, sel),
  });
  const manyDays = list.data !== undefined && list.data.from !== list.data.to;
  return (
    <tr className="odr-sub">
      <td colSpan={span}>
        {list.isPending ? <p className="bandnote">{t("app.loading")}</p> : null}
        {list.isError ? <p role="alert" className="odr-err">{t("dayReport.loadFailed")}</p> : null}
        {list.data !== undefined && list.data.rows.length === 0
          ? <p className="bandnote" data-testid="odr-no-patients">{t("dayReport.noPatients")}</p> : null}
        {list.data !== undefined && list.data.rows.length > 0 ? (
          <div className="odr-scroll">
            <table className="odr-ptable" data-testid={`odr-patients-${department.code}`}>
              <thead>
                <tr>
                  <th>#</th>
                  {manyDays ? <th>{t("dayReport.col.date")}</th> : null}
                  <th>{t("dayReport.col.time")}</th><th>{t("dayReport.col.patient")}</th><th>{t("dayReport.col.uhid")}</th>
                  <th>{t("dayReport.col.age")}</th><th>{t("dayReport.col.sex")}</th><th>{t("dayReport.col.address")}</th>
                  <th>{t("dayReport.col.type")}</th><th>{t("dayReport.col.doctor")}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((p, i) => (
                  <tr key={p.visitNo}>
                    <td className="mo">{i + 1}</td>
                    {manyDays ? <td className="mo">{DAY_IN_MONTH.format(new Date(`${p.date}T00:00:00Z`))}</td> : null}
                    <td className="mo">{p.time}</td>
                    <td className="nm">{p.name}{p.restricted ? <span className="pill odr-sealed">{t("dayReport.sealed")}</span> : null}</td>
                    <td className="mo">{p.uhid}</td>
                    <td className="mo">{p.age}</td>
                    <td>{p.gender}</td>
                    <td>{p.shortAddress}</td>
                    <td><span className={`odr-type ${p.patientType}`}>{t(TYPE_KEY[p.patientType])}</span></td>
                    <td>{p.doctor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function OpdReportScreen({ initial }: { initial?: Selection }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [sel, setSel] = useState<Selection>(initial ?? todaySelection());
  const [open, setOpen] = useState<string | null>(null);
  /*
    THE URL IS A WAY IN, NOT A ONE-TIME SEED. The dashboard links here with the period it was showing,
    and a reader who follows a second link — or presses Back — must land on THAT period rather than on
    whatever this screen was last set to. `useState` alone captures the first search and ignores every
    later one, which reads as a link that did nothing.
  */
  const wanted = initial === undefined ? null : `${initial.period}|${initial.date}`;
  useEffect(() => {
    if (initial === undefined) return;
    setSel(initial);
    setOpen(null);
    // The identity of `initial` changes on every render; its VALUE is what should re-select.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  const report = useQuery({
    queryKey: ["opd-report", sel.period, sel.date],
    queryFn: () => fetchReport(sel),
    enabled: can("opd.reports.read"),
  });
  const dl = useReportDownloads();

  if (!can("opd.reports.read")) {
    return <div className="dash"><p className="bandnote" data-testid="odr-forbidden">{t("dayReport.forbidden")}</p></div>;
  }

  const r = report.data;
  const showOpen = r !== undefined && r.totals.stillOpen > 0;
  const span = showOpen ? 8 : 7;
  const pick = (s: Selection): void => { setSel(s); setOpen(null); };

  return (
    <div className="dash odr-screen" data-testid="odr-screen">
      <div className="band">
        <div className="bandhd">
          <Link to="/" className="odr-back">← {t("dayReport.backToDesk")}</Link>
        </div>
        <div className="odr-head">
          <div>
            <h1 className="odr-title">{t("dayReport.title")}</h1>
            <div className="odr-long" data-testid="odr-range">
              {r === undefined ? null : <>{rangeText(r)} · {r.hospital.name}</>}
            </div>
          </div>
          <div className="odr-head-actions">
            <DownloadButtons busy={dl.busy} pdfKey="odr-pdf" csvKey="odr-csv"
              onPdf={() => dl.pdf("odr-pdf", "report", sel)} onCsv={() => dl.csv("odr-csv", () => downloadReportCsv(sel))} />
          </div>
        </div>
        <div className="odr-top">
          <PeriodPicker sel={sel} onChange={pick} />
          {r === undefined ? null : <ProvisionalPill report={r} />}
          <span className="odr-hint">{t("dayReport.pdfHint")}</span>
        </div>
        {dl.error === null ? null : <p role="alert" className="odr-err">{dl.error}</p>}
      </div>

      {report.isPending ? <p className="bandnote">{t("app.loading")}</p> : null}
      {report.isError ? <p role="alert" className="odr-err">{t("dayReport.loadFailed")}</p> : null}

      {r === undefined ? null : (
        <>
          <div className="box odr-box">
            <DayFigures counts={r.totals} testId="odr-figs" />
            <p className="odr-people" data-testid="odr-people">
              {t("dayReport.people", { count: r.patientsConsulted, fresh: r.newPatients })}
            </p>
            <ExcludedSundayNote report={r} />
          </div>

          <div className="box odr-tablebox">
            {r.departments.length === 0 ? (
              <p className="bandnote" data-testid="odr-no-departments">{t("dayReport.noDepartments")}</p>
            ) : (
              <div className="odr-scroll">
                <table className="odr-table" data-testid="odr-table">
                  <thead>
                    <tr>
                      <th>{t("dayReport.col.department")}</th>
                      <th className="n">{t("dayReport.booked")}</th>
                      <th className="n">{t("dayReport.consulted")}</th>
                      <th className="n">{t("dayReport.new")}</th>
                      <th className="n">{t("dayReport.revisit")}</th>
                      <th className="n">{t("dayReport.renewal")}</th>
                      {showOpen ? <th className="n">{t("dayReport.col.stillOpen")}</th> : null}
                      <th className="act">{t("dayReport.col.download")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.departments.map((d) => {
                      const isOpen = open === d.departmentId;
                      return (
                        <Fragment key={d.departmentId}>
                          <tr className={isOpen ? "odr-row open" : "odr-row"} data-testid={`odr-row-${d.code}`}>
                            <td>
                              <button type="button" className="odr-dept" aria-expanded={isOpen}
                                onClick={() => setOpen(isOpen ? null : d.departmentId)} data-testid={`odr-toggle-${d.code}`}>
                                <span className="odr-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                                <span className="nm">{d.name}</span>
                                <span className="odr-see">{isOpen ? t("dayReport.hidePatients") : t("dayReport.seePatients")}</span>
                              </button>
                            </td>
                            <Counts c={d} showOpen={showOpen} />
                            <td className="act">
                              <div className="odr-acts">
                                <DownloadButtons compact busy={dl.busy} label={d.name}
                                  pdfKey={`odr-pdf-${d.code}`} csvKey={`odr-csv-${d.code}`}
                                  onPdf={() => dl.pdf(`odr-pdf-${d.code}`, { departmentId: d.departmentId }, sel)}
                                  onCsv={() => dl.csv(`odr-csv-${d.code}`, () => downloadDepartmentCsv(d.departmentId, d.code, sel))} />
                              </div>
                            </td>
                          </tr>
                          {isOpen ? <Patients department={d} sel={sel} span={span} /> : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{t("dayReport.total")}</td>
                      <Counts c={r.totals} showOpen={showOpen} total />
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <div className="odr-notes" data-testid="odr-notes">
            <p><b>{t("dayReport.new")}</b> — {t("dayReport.newHint")}</p>
            <p><b>{t("dayReport.revisit")}</b> — {t("dayReport.revisitHint")}</p>
            <p><b>{t("dayReport.renewal")}</b> — {t("dayReport.renewalHint")}</p>
            <p><b>{t("dayReport.booked")}</b> — {t("dayReport.bookedHint")}</p>
            {sel.period === "week" ? <p data-testid="odr-week-rule"><b>{t("dayReport.thisWeek")}</b> — {t("dayReport.weekRule")}</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
