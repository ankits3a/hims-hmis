import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { BRIEF_PERIODS, downloadReportCsv, fetchBrief, fetchReport, todayIst } from "../lib/desk-api";
import type { WireBriefPeriod, WireReportSection } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";

/**
 * PLAN 07c T2/T3/T5 — MY DAY: ONE MODEL, RENDERED THREE WAYS.
 *
 * The screen below, the `.print-doc` it prints, and the CSV the button downloads are the SAME
 * server-computed `DailyReport` (DD5). That is the whole reason the model is a list of sections of
 * string rows rather than three shaped payloads: screen, paper and spreadsheet cannot disagree
 * about a number, because there is one number. A second query for the file — the obvious, faster
 * thing to write — would let the paper in the ward file and the CSV in the accountant's inbox drift
 * apart while both looked authoritative.
 *
 * ═══ THERE IS NO `userId` ON THIS SCREEN, AND THERE IS NONE ON THE ROUTE (DD4) ═══
 *
 * `GET /me/report` takes a date and nothing else. Self-scoping is structural rather than a check
 * somebody can forget: there is no parameter to tamper with, so there is no version of this screen
 * that reads a colleague's day. A supervisor's view of a named staff member is a different route
 * behind a different permission (T9), not an argument added here.
 *
 * ═══ PRINT IS NOT THE AFTERTHOUGHT ═══
 *
 * A shift report is printed, signed and filed — that is what "close" means at an Indian hospital
 * counter, and the signature line is part of the document rather than a nicety. `.print-doc` is
 * `position: fixed` at the origin, so exactly ONE printable node may exist on a screen at a time
 * (07a/07b finding: two of them OVERPRINT rather than making two pages). This screen therefore has
 * one printable node containing every section, never one per section.
 */
export function SectionTable({ section }: { section: WireReportSection }): React.ReactElement {
  const { t } = useTranslation();
  return (
    /*
      RESTYLED FOR PAPER FIRST. This node is INSIDE `.print-doc` — it is the document that gets
      printed, signed and filed — so its colours are the ink ones and never the faint ones: a
      `--dim` column heading that reads correctly on a monitor is a grey smudge from a laser printer,
      and `--faint` is worse. The design system supplies the type and the rules; the contrast here is
      chosen for the paper, which is the harder of the two surfaces.
    */
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{t(section.titleKey)}</h2>
      <table className="mo" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {section.columnKeys.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "0 14px 5px 0", borderBottom: "1px solid var(--ink)", fontWeight: 700, whiteSpace: "nowrap" }}>{t(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.length === 0 ? (
            /* E-4 — a day before this person existed, or a day they did nothing, is ZEROES. */
            <tr>
              <td style={{ padding: "9px 0", color: "var(--dim)" }} colSpan={section.columnKeys.length}>
                {t("myDay.noRows")}
              </td>
            </tr>
          ) : (
            section.rows.map((row, i) => (
              <tr key={`${section.key}-${String(i)}`}>
                {row.map((cell, j) => (
                  <td key={`${section.key}-${String(i)}-${String(j)}`} style={{ padding: "5px 14px 5px 0", borderBottom: "1px solid var(--line)" }}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {section.totals === undefined ? null : (
          <tfoot>
            <tr>
              {section.totals.map((cell, j) => (
                <td key={`${section.key}-total-${String(j)}`} style={{ padding: "6px 14px 5px 0", borderTop: "1px solid var(--ink)", fontWeight: 700 }}>{cell}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * PLAN 07c T8 / DD12 — THE BRIEF, WHICH IS A PARAGRAPH AND NOT A DASHBOARD.
 *
 * Five periods, one deterministic sentence each, every clause generated on the SERVER from typed
 * facts. This component renders keys and never composes prose, which is what keeps DD12's promise
 * enforceable: a clause that could not be made honestly does not arrive, so there is no branch here
 * that could invent one.
 *
 * ═══ A SHORT BRIEF IS A CORRECT BRIEF ═══
 *
 * On somebody's first week most comparison clauses are absent (DD8), so this panel is nearly empty
 * — and it says so in a sentence rather than showing a spinner or a row of zeroes. A person whose
 * history is thin should be able to see that that is what they are looking at.
 */
export function BriefPanel({ date }: { date: string }): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const [period, setPeriod] = useState<WireBriefPeriod>("week");
  // FD-1 CLOSE pass 1 — the actor is in the key: the cache outlives a logout (see counter-figures.tsx)
  const who = actor?.id ?? "";
  const brief = useQuery({ queryKey: ["me", "brief", who, period, date], queryFn: () => fetchBrief(period, date), enabled: who !== "" });

  return (
    <section className="no-print box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 11 }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("brief.title")}</h2>
        <div style={{ display: "flex", gap: 5 }} role="group" aria-label={t("brief.periodLabel")}>
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
        {brief.data === undefined ? null : (
          <span className="mo" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>
            {t("brief.range", { from: brief.data.from, to: brief.data.to })}
          </span>
        )}
      </div>

      {brief.isPending ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p> : null}
      {brief.isError ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{t("brief.failed")}</p> : null}

      {brief.data !== undefined && brief.data.clauses.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("brief.nothingToSay")}</p>
      ) : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5, fontSize: 13, lineHeight: 1.5 }}>
        {(brief.data?.clauses ?? []).map((c) => (
          <li key={c.key}>{t(c.key, c.values)}</li>
        ))}
      </ul>
    </section>
  );
}

export function MyDay(): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const [date, setDate] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const who = actor?.id ?? "";
  const report = useQuery({ queryKey: ["me", "report", who, date], queryFn: () => fetchReport(date), enabled: who !== "" });

  const sections = report.data?.sections ?? [];
  const provisional = report.data?.provisional ?? false;

  /*
    THE ONE THING THIS DOCK EXISTS TO SAY OUT LOUD is whether the day is closed. The stamp is on the
    screen and on the paper already, but "is this the close or a draft" is the question somebody asks
    at 21:00 with a printout in their hand, and it deserves a sentence rather than a badge.
  */
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const ask = (question: string): void => {
    const q = question.toLowerCase();
    const answer = /closed|provisional|final|draft|lock/.test(q)
      ? t(provisional ? "myDay.agent.provisional" : "myDay.agent.closed")
      : /sign|print|paper|document|hand ?over/.test(q)
        ? t("myDay.agent.signature")
        : /section|report|day|figure|what|how many|total/.test(q)
          ? (sections.length === 0 ? t("myDay.agent.empty") : t("myDay.agent.sections", { n: sections.length, date }))
          : t("myDay.agent.cannot");
    setAgentAnswer(answer);
    setAgentLog((l) => logged(l, question));
  };

  return (
    <PaperScreen testId="my-day" style={{ padding: "18px 22px", gap: 14 }}>
      <div className="no-print">
        <ScreenTitle
          title={t("myDay.title")} route="/my-day"
          actions={
            <>
              {/*
                E-5 / T2 A4 — the day is not closed, and the document says so on the screen AND on
                the paper. The flag comes from the server so that the file, the print and this line
                cannot disagree about whether what is being filed is the close.
              */}
              {provisional ? <span className="stamp un">{t("myDay.provisional")}</span> : null}
              <button type="button" className="sec" onClick={() => { window.print(); }}>{t("myDay.print")}</button>
              <button
                type="button" className="pri" style={{ padding: "5px 14px" }}
                disabled={downloading}
                onClick={() => {
                  setError(null);
                  setDownloading(true);
                  downloadReportCsv(date)
                    .catch(() => { setError(t("myDay.exportFailed")); })
                    .finally(() => { setDownloading(false); });
                }}
              >
                {t("myDay.export")}
              </button>
            </>
          }
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          <span className="sr-only">{t("myDay.date")}</span>
          <input
            type="date"
            className="in mo" style={{ height: 34, fontSize: 12.5 }}
            value={date}
            aria-label={t("myDay.date")}
            onChange={(e) => { setDate(e.target.value); }}
          />
        </label>
      </div>
      {error === null ? null : <p role="alert" className="no-print" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}

      {report.isPending ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p> : null}

      <BriefPanel date={date} />

      {/*
        ONE printable node holding every section — see the header. It is also the SCREEN rendering:
        a second copy for the screen would be the two-source failure this whole model exists to
        prevent, one level down.
      */}
      <div className="print-doc" style={{ display: "flex", flexDirection: "column", gap: 17 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--ink)", paddingBottom: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{t("myDay.docTitle")}</span>
          <span style={{ fontSize: 12.5 }}>{t("myDay.docFor", { date })}</span>
          <span className="mo" style={{ fontSize: 12 }}>{actor === null ? "" : actor.id}</span>
          {provisional ? <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("myDay.provisionalNote")}</span> : null}
        </div>

        {!report.isPending && sections.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("myDay.empty")}</p>
        ) : null}

        {sections.map((s) => (
          <SectionTable key={s.key} section={s} />
        ))}

        {/*
          THE SIGNATURE LINE IS PART OF THE DOCUMENT. A shift report that is printed and filed is
          signed by the person whose day it is and countersigned by whoever received the handover;
          a printout with nowhere to sign gets a line drawn on it in biro, which is the same
          document with worse provenance.
        */}
        <div style={{ marginTop: 34, display: "flex", gap: 48, fontSize: 12.5 }}>
          <div style={{ flex: 1, borderTop: "1px solid var(--ink)", paddingTop: 5 }}>{t("myDay.signedBy")}</div>
          <div style={{ flex: 1, borderTop: "1px solid var(--ink)", paddingTop: 5 }}>{t("myDay.receivedBy")}</div>
        </div>
      </div>

      {/* `no-print` on the dock: the agent is not part of the document being filed. */}
      <div className="no-print">
        <AgentDock
          answer={agentAnswer} log={agentLog} onAsk={ask}
          placeholder={t("myDay.askPlaceholder")} idle={t("myDay.agentIdle")}
        />
      </div>
    </PaperScreen>
  );
}
