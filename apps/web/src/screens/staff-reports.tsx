import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { BRIEF_PERIODS, todayIst } from "../lib/desk-api";
import type { WireBrief, WireBriefPeriod, WireReportSection } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { Button } from "@/components/ui/button";

/**
 * PLAN 07c T9 / DD14 — THE SUPERVISOR'S VIEW: **WHAT, NOT WHOM.**
 *
 * Owner ruling O-2 is that a supervisor may see a named staff member's day. This screen is the
 * shape that keeps that both lawful and useful: it shows counts, money and comparisons, and it does
 * not list the patients. That is not restraint on this screen's part — `GET /staff/:id/brief`
 * returns a bag of integers and a list of clause keys, so there is nothing here that COULD be a
 * patient's name.
 *
 * ═══ THE DRILL IS A DELIBERATE, EXPLAINED, LOGGED ACT ═══
 *
 * Opening the rows behind a figure needs a second permission, a typed reason, and it writes
 * `staff_report.drilled` naming the supervisor. The reason box is not a formality and the screen
 * says what happens when it is used — a person should know they are about to be recorded BEFORE
 * they act, not discover it in an audit six weeks later. The audit trail covers the auditor.
 */
type StaffMember = { id: string; username: string; fullName: string };

export function StaffReports(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [subject, setSubject] = useState<string>("");
  const [period, setPeriod] = useState<WireBriefPeriod>("week");
  const [date] = useState(todayIst());
  const [reason, setReason] = useState("");
  const [drill, setDrill] = useState<WireReportSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const staff = useQuery({
    queryKey: ["staff", "list"],
    queryFn: () => api<{ items: StaffMember[] }>("GET", "/staff"),
  });
  const brief = useQuery({
    queryKey: ["staff", subject, "brief", period, date],
    queryFn: () => api<WireBrief & { subjectUserId: string; totalsToday: Record<string, number> }>(
      "GET", `/staff/${subject}/brief?period=${period}&date=${date}`,
    ),
    enabled: subject !== "",
  });

  const canDrill = can("staff.reports.drill");

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">{t("staffReports.title")}</h1>

      <div className="flex flex-wrap items-baseline gap-3">
        <label className="text-sm">
          <span className="mr-2">{t("staffReports.person")}</span>
          <select
            className="rounded border px-2 py-1"
            value={subject}
            aria-label={t("staffReports.person")}
            onChange={(e) => { setSubject(e.target.value); setDrill(null); setError(null); }}
          >
            <option value="">{t("staffReports.pick")}</option>
            {(staff.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.fullName}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-1" role="group" aria-label={t("brief.periodLabel")}>
          {BRIEF_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === period}
              className={`rounded border px-2 py-0.5 text-xs ${p === period ? "bg-accent font-medium" : ""}`}
              onClick={() => { setPeriod(p); }}
            >
              {t(`brief.period.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {subject === "" ? <p className="text-sm text-muted-foreground">{t("staffReports.pickFirst")}</p> : null}

      {brief.data === undefined ? null : (
        <section className="flex flex-col gap-2 rounded border p-3">
          <span className="text-xs text-muted-foreground">
            {t("brief.range", { from: brief.data.from, to: brief.data.to })}
          </span>
          {brief.data.clauses.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("brief.nothingToSay")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {brief.data.clauses.map((c) => <li key={c.key}>{t(c.key, c.values)}</li>)}
            </ul>
          )}
        </section>
      )}

      {/*
        DD14's constraint, said out loud on the screen rather than only in a design document. A
        supervisor who wonders why there are no patients here should find the answer where they
        wondered it.
      */}
      {subject === "" ? null : (
        <p className="text-xs text-muted-foreground">{t("staffReports.whatNotWhom")}</p>
      )}

      {subject === "" || !canDrill ? null : (
        <section className="flex flex-col gap-2 rounded border border-state-waiting p-3">
          <h2 className="text-sm font-semibold">{t("staffReports.drillTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("staffReports.drillWarning")}</p>
          <label className="text-sm">
            <span className="sr-only">{t("staffReports.reason")}</span>
            <input
              className="w-full rounded border px-2 py-1"
              placeholder={t("staffReports.reason")}
              aria-label={t("staffReports.reason")}
              value={reason}
              onChange={(e) => { setReason(e.target.value); }}
            />
          </label>
          <div>
            <Button
              disabled={reason.trim().length < 8}
              onClick={() => {
                setError(null);
                api<{ sections: WireReportSection[] }>("POST", `/staff/${subject}/drill`, { date, reason })
                  .then((r) => { setDrill(r.sections); })
                  .catch(() => { setError(t("staffReports.drillFailed")); });
              }}
            >
              {t("staffReports.drillAction")}
            </Button>
          </div>
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        </section>
      )}

      {drill === null ? null : (
        <section className="flex flex-col gap-3">
          {drill.map((s) => (
            <div key={s.key} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">{t(s.titleKey)}</h3>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left">
                    {s.columnKeys.map((c) => <th key={c} className="py-1 pr-3 font-medium text-muted-foreground">{t(c)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((row, i) => (
                    <tr key={`${s.key}-${String(i)}`} className="border-b last:border-b-0">
                      {row.map((cell, j) => <td key={`${s.key}-${String(i)}-${String(j)}`} className="py-1 pr-3">{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
