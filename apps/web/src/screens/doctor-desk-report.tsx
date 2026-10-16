import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchUnitReports } from "../lib/doctor-desk-api";
import type { WireUnitReport } from "../lib/doctor-desk-api";
import { spanText } from "./doctor-desk-tower";
import "./doctor-desk.css";

/**
 * ═══ DD-report v0 — THE UNIT REPORT (`UnitBoard.dc.html`, right column): sent at 08:00, nobody typed it ═══
 *
 * Counts only (D8): no patient, no person. Neutral: no colour and no rank — a figure, its context, the
 * department's and the hospital's beside it when the pool is large enough (the ratings' floors). The
 * board's census row and ward lines (beds, admitted, summaries, PMJAY, average stay) are ABSENT until
 * DD-IPD; "the one that went late" narrative is absent too (it would name people) — its minutes stay.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export function DoctorDeskReport(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const q = useQuery({ queryKey: ["doctor-desk", "reports"], queryFn: fetchUnitReports });
  const [pick, setPick] = useState<string | null>(null);
  const list = q.data?.reports ?? [];
  const shown = list.find((r) => r.id === pick) ?? list[0];
  return (
    <DoctorDeskFrame
      active="unitReport" testId="doctor-desk-report" context={t("doctorDesk.report.context")}
      who={{ name: username ?? "", role: null }}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {q.data !== undefined && list.length === 0 && (
        <section className="dd-card" data-testid="dd-report-none"><div className="dd-empty">{t("doctorDesk.report.none")}</div></section>
      )}
      {list.length > 1 && (
        <div className="dd-tabs dd-noprint" role="tablist" data-testid="dd-report-days">
          {list.map((r) => (
            <button
              key={r.id} type="button" role="tab" aria-selected={r === shown} className={`dd-tab${r === shown ? " dd-tab-on" : ""}`}
              data-testid={`dd-report-tab-${r.id}`} onClick={() => setPick(r.id)}
            >{list.some((x) => x.teamId !== r.teamId) ? `${r.short} · ${r.reportDate}` : r.reportDate}</button>
          ))}
        </div>
      )}
      {shown !== undefined && <Report r={shown} />}
    </DoctorDeskFrame>
  );
}

export function reportLines(r: WireUnitReport, t: T): { key: string; k: string; v: string; note: string }[] {
  const c = r.critical;
  const min = (n: number | null): string => (n === null ? "—" : spanText(n, t));
  return [
    {
      key: "critical", k: t("doctorDesk.report.critical"),
      v: c.acts === 0 ? t("doctorDesk.report.noActs") : c.median === null ? t("doctorDesk.report.acts", { count: c.acts }) : t("doctorDesk.report.median", { span: min(c.median) }),
      note: c.acts === 0 ? "" : [
        c.median === null ? t("doctorDesk.report.tooFew") : t("doctorDesk.report.acts", { count: c.acts }),
        t("doctorDesk.report.over", { count: c.over, n: c.overMinutes }),
      ].join(" · "),
    },
    { key: "longest", k: t("doctorDesk.report.longest"), v: min(c.longest), note: "" },
    {
      key: "compare", k: t("doctorDesk.report.compare"),
      v: `${min(r.compare.department)} · ${min(r.compare.hospital)}`,
      note: r.compare.department === null || r.compare.hospital === null ? t("doctorDesk.report.compareNote") : "",
    },
    { key: "noAct", k: t("doctorDesk.report.noAct"), v: String(r.owed.criticalsWithoutAct), note: "" },
    { key: "owed", k: t("doctorDesk.report.owed"), v: String(r.owed.open), note: t("doctorDesk.report.past", { count: r.owed.past }) },
    { key: "opd", k: t("doctorDesk.report.opd", { date: r.opd.date }), v: t("doctorDesk.report.seen", { n: r.opd.seen }), note: t("doctorDesk.report.doctors", { count: r.opd.doctors }) },
  ];
}

function Report({ r }: { r: WireUnitReport }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="dd-card" data-testid="dd-report">
      <div className="dd-card-head">
        <h1 className="dd-h1" style={{ fontSize: 20 }}>{t("doctorDesk.report.title", { unit: `${r.departmentName} · ${r.short}`, date: r.reportDate })}</h1>
        <span className="dd-mono">{t("doctorDesk.report.sent", { at: fmtIst(r.sentAt) })}</span>
      </div>
      <div className="dd-note">{t("doctorDesk.report.window", { from: `${r.windowFrom.slice(0, 10)} 08:00`, to: `${r.reportDate} 08:00` })}</div>
      <div>
        {reportLines(r, t).map((l) => (
          <div key={l.key} className="dd-grid dd-grid-report" data-testid={`dd-report-${l.key}`}>
            <span>{l.k}</span>
            <span className="dd-mono dd-strong">{l.v}</span>
            <span className="dd-note">{l.note}</span>
          </div>
        ))}
      </div>
      <div className="dd-card-head dd-noprint">
        <span className="dd-note">{t("doctorDesk.report.foot")}</span>
        <button type="button" className="dd-clock-btn" data-testid="dd-report-print" onClick={() => window.print()}>{t("doctorDesk.report.print")}</button>
      </div>
    </section>
  );
}
