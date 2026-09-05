import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { BRIEF_PERIODS, todayIst } from "../lib/desk-api";
import type { WireBrief, WireBriefPeriod, WireReportSection } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";

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

  /*
    THE CO-PILOT HERE IS BOUND BY DD14 EXACTLY AS THE SCREEN IS. It can describe the brief and it can
    explain what drilling costs; it cannot see a patient row, because this screen cannot either until
    somebody types a reason that goes into the audit log under their own name. An agent that summarised
    patient rows would be the drill without the reason.
  */
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const ask = (question: string): void => {
    const q = question.toLowerCase();
    const b = brief.data;
    const answer = subject === ""
      ? t("staffReports.agent.noSubject")
      : /drill|patient|row|detail|behind/.test(q)
        ? t("staffReports.agent.drill")
        : /brief|figure|summary|say|period|week/.test(q)
          ? (b === undefined || b.clauses.length === 0
            ? t("staffReports.agent.empty")
            : t("staffReports.agent.brief", { count: b.clauses.length, from: b.from, to: b.to }))
          : t("staffReports.agent.cannot");
    setAgentAnswer(answer);
    setAgentLog((l) => logged(l, question));
  };

  return (
    <PaperScreen testId="staff-reports" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("staffReports.title")} route="/staff" />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
          <span className="tag">{t("staffReports.person")}</span>
          <select
            className="in" style={{ height: 34, fontSize: 12.5, minWidth: 220 }}
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
        <div style={{ display: "flex", gap: 6 }} role="group" aria-label={t("brief.periodLabel")}>
          {BRIEF_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === period}
              className={p === period ? "pill on" : "pill"}
              onClick={() => { setPeriod(p); }}
            >
              {t(`brief.period.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {subject === "" ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("staffReports.pickFirst")}</p> : null}

      {brief.data === undefined ? null : (
        <section className="box" style={{ display: "flex", flexDirection: "column", gap: 7, padding: "13px 15px" }}>
          <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
            {t("brief.range", { from: brief.data.from, to: brief.data.to })}
          </span>
          {brief.data.clauses.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("brief.nothingToSay")}</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }}>
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
        <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("staffReports.whatNotWhom")}</p>
      )}

      {/*
        MARIGOLD, AND ONLY MARIGOLD. The palette's rule is that gold means ATTENTION — this panel
        reads one named person's actual rows and writes a reason to the audit log, so it must not
        look like the rest of the page. It is equally not brick: drilling is permitted, not refused,
        and brick is reserved for refusals.
      */}
      {subject === "" || !canDrill ? null : (
        <section className="box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px", borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
          <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>{t("staffReports.drillTitle")}</h2>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("staffReports.drillWarning")}</p>
          <label>
            <span className="sr-only">{t("staffReports.reason")}</span>
            <input
              className="in" style={{ width: "100%", height: 34, fontSize: 13 }}
              placeholder={t("staffReports.reason")}
              aria-label={t("staffReports.reason")}
              value={reason}
              onChange={(e) => { setReason(e.target.value); }}
            />
          </label>
          <div>
            <button
              type="button" className="pri" style={{ padding: "5px 14px" }}
              disabled={reason.trim().length < 8}
              onClick={() => {
                setError(null);
                api<{ sections: WireReportSection[] }>("POST", `/staff/${subject}/drill`, { date, reason })
                  .then((r) => { setDrill(r.sections); })
                  .catch(() => { setError(t("staffReports.drillFailed")); });
              }}
            >
              {t("staffReports.drillAction")}
            </button>
          </div>
          {error === null ? null : <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
        </section>
      )}

      {drill === null ? null : (
        <section style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {drill.map((s) => (
            <div key={s.key} className="box" style={{ display: "flex", flexDirection: "column", gap: 7, padding: "13px 15px" }}>
              <h3 className="tag" style={{ margin: 0 }}>{t(s.titleKey)}</h3>
              {/* A drilled table scrolls inside itself; the page body never scrolls sideways. */}
              <div style={{ overflowX: "auto" }}>
                <table className="mo" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {s.columnKeys.map((c) => (
                        <th key={c} className="tag" style={{ textAlign: "left", padding: "0 14px 6px 0", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>{t(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((row, i) => (
                      <tr key={`${s.key}-${String(i)}`}>
                        {row.map((cell, j) => (
                          <td key={`${s.key}-${String(i)}-${String(j)}`} style={{ padding: "6px 14px 6px 0", borderBottom: "1px solid var(--line2, var(--line))" }}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}

      <AgentDock
        answer={agentAnswer} log={agentLog} onAsk={ask}
        placeholder={t("staffReports.askPlaceholder")} idle={t("staffReports.agentIdle")}
      />
    </PaperScreen>
  );
}
