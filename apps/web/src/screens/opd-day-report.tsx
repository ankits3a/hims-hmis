import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { todayIst } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import {
  downloadDayReportCsv, downloadDepartmentCsv, fetchDayReport, fetchDepartmentDayReport,
} from "../lib/opd-reports-api";
import type { DayCounts, DayDepartment, PatientType } from "../lib/opd-reports-api";
import {
  DayFigures, DayPicker, DownloadButtons, ProvisionalPill, longDay, useReportDownloads,
} from "../components/opd-day-report-panel";
import "../styles/paper-pine.css";
import "./dashboard.css";
import "./opd-day-report.css";

/**
 * ═══ THE OPD DAY REPORT, DEPARTMENT BY DEPARTMENT ═══
 *
 * The dashboard panel's second door: the same day, one row per clinical department, each row with
 * its own PDF and CSV, and — one tap — the patients behind the row. Nothing here is computed: every
 * figure is the server's, which also builds the files, so the table and the sheet cannot disagree.
 *
 * Opening a department's patients is a read of names and addresses, and the server logs it
 * (`day_report.patients_listed`), so the list is fetched when asked for and not before.
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

function Patients({ department, date, span }: { department: DayDepartment; date: string; span: number }): React.ReactElement {
  const { t } = useTranslation();
  const list = useQuery({
    queryKey: ["opd-day-report", date, "department", department.departmentId],
    queryFn: () => fetchDepartmentDayReport(department.departmentId, date),
  });
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
                  <th>#</th><th>{t("dayReport.col.time")}</th><th>{t("dayReport.col.patient")}</th><th>{t("dayReport.col.uhid")}</th>
                  <th>{t("dayReport.col.age")}</th><th>{t("dayReport.col.sex")}</th><th>{t("dayReport.col.address")}</th>
                  <th>{t("dayReport.col.type")}</th><th>{t("dayReport.col.doctor")}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((p, i) => (
                  <tr key={p.visitNo}>
                    <td className="mo">{i + 1}</td>
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

export function OpdDayReportScreen({ initialDate }: { initialDate?: string }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [date, setDate] = useState(initialDate ?? todayIst());
  const [open, setOpen] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ["opd-day-report", date],
    queryFn: () => fetchDayReport(date),
    enabled: can("opd.reports.read"),
  });
  const dl = useReportDownloads();

  if (!can("opd.reports.read")) {
    return <div className="dash"><p className="bandnote" data-testid="odr-forbidden">{t("dayReport.forbidden")}</p></div>;
  }

  const r = report.data;
  const showOpen = r !== undefined && r.totals.stillOpen > 0;
  const span = showOpen ? 8 : 7;
  const pick = (d: string): void => { setDate(d); setOpen(null); };

  return (
    <div className="dash odr-screen" data-testid="odr-screen">
      <div className="band">
        <div className="bandhd">
          <Link to="/" className="odr-back">← {t("dayReport.backToDesk")}</Link>
        </div>
        <div className="odr-head">
          <div>
            <h1 className="odr-title">{t("dayReport.title")}</h1>
            <div className="odr-long">{longDay(date)}{r === undefined ? null : <> · {r.hospital.name}</>}</div>
          </div>
          <div className="odr-head-actions">
            <DownloadButtons busy={dl.busy} pdfKey="odr-pdf" csvKey="odr-csv"
              onPdf={() => dl.pdf("odr-pdf", "day", date)} onCsv={() => dl.csv("odr-csv", () => downloadDayReportCsv(date))} />
          </div>
        </div>
        <div className="odr-top">
          <DayPicker date={date} onChange={pick} />
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
                                  onPdf={() => dl.pdf(`odr-pdf-${d.code}`, { departmentId: d.departmentId }, date)}
                                  onCsv={() => dl.csv(`odr-csv-${d.code}`, () => downloadDepartmentCsv(d.departmentId, d.code, date))} />
                              </div>
                            </td>
                          </tr>
                          {isOpen ? <Patients department={d} date={date} span={span} /> : null}
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
          </div>
        </>
      )}
    </div>
  );
}
