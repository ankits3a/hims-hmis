import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchUnitReports } from "../lib/doctor-desk-api";
import type { WireDepartmentReport, WireHospitalReport, WireUnitReport } from "../lib/doctor-desk-api";
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

type Kind = "unit" | "department" | "hospital";

export function DoctorDeskReport(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const q = useQuery({ queryKey: ["doctor-desk", "reports"], queryFn: fetchUnitReports });
  const [kind, setKind] = useState<Kind | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const d = q.data;
  const kinds: Kind[] = d === undefined ? [] : [
    ...(d.hospital.length > 0 ? ["hospital" as const] : []), ...(d.departments.length > 0 ? ["department" as const] : []),
    ...(d.reports.length > 0 ? ["unit" as const] : []),
  ];
  const k = kind !== null && kinds.includes(kind) ? kind : kinds[0];
  const list: { id: string; label: string }[] = d === undefined || k === undefined ? []
    : k === "unit" ? d.reports.map((r) => ({ id: r.id, label: d.reports.some((x) => x.teamId !== r.teamId) ? `${r.short} · ${r.reportDate}` : r.reportDate }))
      : k === "department" ? d.departments.map((r) => ({ id: r.id, label: d.departments.some((x) => x.departmentId !== r.departmentId) ? `${r.departmentName} · ${r.reportDate}` : r.reportDate }))
        : d.hospital.map((r) => ({ id: r.id, label: r.reportDate }));
  const id = list.some((x) => x.id === pick) ? pick : (list[0]?.id ?? null);
  return (
    <DoctorDeskFrame
      active="unitReport" testId="doctor-desk-report" context={t("doctorDesk.report.context")}
      who={{ name: username ?? "", role: null }}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {d !== undefined && kinds.length === 0 && (
        <section className="dd-card" data-testid="dd-report-none"><div className="dd-empty">{t("doctorDesk.report.none")}</div></section>
      )}
      {kinds.length > 1 && (
        <div className="dd-tabs dd-noprint" role="tablist" data-testid="dd-report-kinds">
          {kinds.map((x) => (
            <button key={x} type="button" role="tab" aria-selected={x === k} className={`dd-tab${x === k ? " dd-tab-on" : ""}`} data-testid={`dd-report-kind-${x}`} onClick={() => { setKind(x); setPick(null); }}>
              {t(`doctorDesk.report.kind.${x}`)}
            </button>
          ))}
        </div>
      )}
      {list.length > 1 && (
        <div className="dd-tabs dd-noprint" role="tablist" data-testid="dd-report-days">
          {list.map((r) => (
            <button
              key={r.id} type="button" role="tab" aria-selected={r.id === id} className={`dd-tab${r.id === id ? " dd-tab-on" : ""}`}
              data-testid={`dd-report-tab-${r.id}`} onClick={() => setPick(r.id)}
            >{r.label}</button>
          ))}
        </div>
      )}
      {d !== undefined && k === "unit" && d.reports.find((r) => r.id === id) !== undefined && <Report r={d.reports.find((r) => r.id === id)!} />}
      {d !== undefined && k === "department" && d.departments.find((r) => r.id === id) !== undefined && <DeptReport r={d.departments.find((r) => r.id === id)!} />}
      {d !== undefined && k === "hospital" && d.hospital.find((r) => r.id === id) !== undefined && <HospReport r={d.hospital.find((r) => r.id === id)!} />}
    </DoctorDeskFrame>
  );
}

const mins = (n: number | null, t: T): string => (n === null ? "—" : spanText(n, t));

function Foot(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="dd-card-head dd-noprint">
      <span className="dd-note">{t("doctorDesk.report.footAll")}</span>
      <button type="button" className="dd-clock-btn" data-testid="dd-report-print" onClick={() => window.print()}>{t("doctorDesk.report.print")}</button>
    </div>
  );
}

function DeptReport({ r }: { r: WireDepartmentReport }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="dd-card" data-testid="dd-dept-report">
      <div className="dd-card-head">
        <h1 className="dd-h1" style={{ fontSize: 20 }}>{t("doctorDesk.report.deptTitle", { dept: r.departmentName, date: r.reportDate })}</h1>
        <span className="dd-mono">{t("doctorDesk.report.sent", { at: fmtIst(r.sentAt) })}</span>
      </div>
      <div className="dd-note">{t("doctorDesk.report.window", { from: `${r.windowFrom.slice(0, 10)} 08:00`, to: `${r.reportDate} 08:00` })}</div>
      <div className="dd-grid dd-grid-side dd-grid-head">
        <span>{t("doctorDesk.unit.col.unit")}</span><span>{t("doctorDesk.report.col.acts")}</span><span>{t("doctorDesk.report.col.median")}</span>
        <span>{t("doctorDesk.report.col.over")}</span><span>{t("doctorDesk.report.col.open")}</span><span>{t("doctorDesk.report.col.past")}</span><span>{t("doctorDesk.report.col.opd")}</span>
      </div>
      {r.units.map((u) => (
        <div key={u.teamId} className="dd-grid dd-grid-side" data-testid={`dd-dept-unit-${u.teamId}`}>
          <span className="dd-strong">{u.short}</span><span className="dd-mono">{u.acts}</span><span className="dd-mono">{mins(u.median, t)}</span>
          <span className="dd-mono">{u.over}</span><span className="dd-mono">{u.owedOpen}</span><span className="dd-mono">{u.owedPast}</span><span className="dd-mono">{u.opdSeen}</span>
        </div>
      ))}
      <div className="dd-grid dd-grid-report" data-testid="dd-dept-median">
        <span>{t("doctorDesk.report.compare")}</span>
        <span className="dd-mono dd-strong">{`${mins(r.median, t)} · ${mins(r.hospital, t)}`}</span>
        <span className="dd-note">{r.median === null || r.hospital === null ? t("doctorDesk.report.compareNote") : ""}</span>
      </div>
      <Foot />
    </section>
  );
}

function HospReport({ r }: { r: WireHospitalReport }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="dd-card" data-testid="dd-hosp-report">
      <div className="dd-card-head">
        <h1 className="dd-h1" style={{ fontSize: 20 }}>{t("doctorDesk.report.hospTitle", { date: r.reportDate })}</h1>
        <span className="dd-mono">{t("doctorDesk.report.sent", { at: fmtIst(r.sentAt) })}</span>
      </div>
      <div className="dd-note">{t("doctorDesk.report.weekWindow", { n: r.days, from: `${r.windowFrom.slice(0, 10)} 08:00`, to: `${r.reportDate} 08:00` })}</div>
      <div className="dd-grid dd-grid-side dd-grid-head">
        <span>{t("doctorDesk.report.col.dept")}</span><span>{t("doctorDesk.report.col.acts")}</span><span>{t("doctorDesk.report.col.median")}</span>
        <span>{t("doctorDesk.report.col.over")}</span><span>{t("doctorDesk.report.col.open")}</span><span>{t("doctorDesk.report.col.past")}</span><span>{t("doctorDesk.report.col.opdWeek")}</span>
      </div>
      {r.departments.map((x) => (
        <div key={x.departmentId} className="dd-grid dd-grid-side" data-testid={`dd-hosp-dept-${x.departmentId}`}>
          <span className="dd-owe-what"><span className="dd-strong">{x.departmentName}</span><span className="dd-note">{t("doctorDesk.report.unitsN", { count: x.units })}</span></span>
          <span className="dd-mono">{x.acts}</span><span className="dd-mono">{mins(x.median, t)}</span>
          <span className="dd-mono">{x.over}</span><span className="dd-mono">{x.owedOpen}</span><span className="dd-mono">{x.owedPast}</span><span className="dd-mono">{x.opdSeen}</span>
        </div>
      ))}
      <div className="dd-grid dd-grid-report" data-testid="dd-hosp-median">
        <span>{t("doctorDesk.report.hospMedian")}</span>
        <span className="dd-mono dd-strong">{mins(r.median, t)}</span>
        <span className="dd-note">{r.median === null ? t("doctorDesk.report.compareNote") : ""}</span>
      </div>
      <Foot />
    </section>
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
