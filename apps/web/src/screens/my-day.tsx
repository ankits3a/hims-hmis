import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { downloadReportCsv, fetchBrief, fetchDesk, fetchReport, periodsFor, todayIst } from "../lib/desk-api";
import type { WireBriefPeriod, WireReportSection } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { PaperScreen } from "../components/paper-screen";
import {
  COL, deskStat, hasCard, longDate, matchesFilter, metricsOf, outcomeTone, rowsOf, shiftDate, statusTone, summariseVisits,
} from "./my-day-model";
import type { Metric, ReportRow, StatusTone, VisitFilter } from "./my-day-model";
import "./my-day.css";
import { useCopilot } from "../lib/use-copilot";
import { CopilotReport } from "../components/copilot-report";
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
/**
 * MY DAY REDESIGN (2026-10-05) — A CELL IS DATA, A KEY, OR A CODE, AND EACH IS WORDED ITS OWN WAY.
 *
 * The collections section sends `report.mode.cash` and `report.col.total` as KEYS, and this table
 * printed them raw — on the screen and on the filed paper. A cell that is a `report.` key is
 * translated; a status, type or outcome CODE (`in_consultation`, `revisit`, `referred`) is worded
 * from `report.value.*`; everything else (names, numbers, visit numbers) is data and printed as is.
 */
const CODED = new Set(["report.col.type", "report.col.status", "report.col.outcome"]);
export function cellText(t: (key: string, o?: Record<string, unknown>) => string, columnKey: string | undefined, cell: string): string {
  if (columnKey === "report.col.patient") return cell; // a name is data, whatever it looks like
  if (cell.startsWith("report.")) return t(cell);
  if (columnKey !== undefined && CODED.has(columnKey) && cell !== "") return t(`report.value.${cell}`, { defaultValue: cell });
  return cell;
}

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
      {/*
        The table scrolls inside its own box. Its mono columns (visit no., UHID) cannot break, so at a
        390px phone it was 452px wide and took the whole page 84px sideways (measured 2026-09-30).
        On paper the page is wide enough and this box never scrolls.
      */}
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
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
                  <td key={`${section.key}-${String(i)}-${String(j)}`} style={{ padding: "5px 14px 5px 0", borderBottom: "1px solid var(--line)" }}>{cellText(t, section.columnKeys[j], cell)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {section.totals === undefined ? null : (
          <tfoot>
            <tr>
              {section.totals.map((cell, j) => (
                <td key={`${section.key}-total-${String(j)}`} style={{ padding: "6px 14px 5px 0", borderTop: "1px solid var(--ink)", fontWeight: 700 }}>{cellText(t, section.columnKeys[j], cell)}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      </div>
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
  const { actor, can } = useAuth();
  const [period, setPeriod] = useState<WireBriefPeriod>("week");
  /*
   * T0 — THE HORIZON APPLIES TO YOUR OWN BRIEF TOO, and this is the one place in the phase where an
   * existing capability NARROWS: this picker offered all five periods to everyone, so a front-desk
   * clerk could pull six months of their own day and after the owner's 2026-09-14 ruling stops at
   * three. The release note says so; a clerk who could do it last week must find the reason written
   * down rather than meet it as a bug.
   */
  const periods = periodsFor(can);
  // FD-1 CLOSE pass 1 — the actor is in the key: the cache outlives a logout (see counter-figures.tsx)
  const who = actor?.id ?? "";
  const brief = useQuery({ queryKey: ["me", "brief", who, period, date], queryFn: () => fetchBrief(period, date), enabled: who !== "" });

  return (
    <section className="no-print box" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 11 }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("brief.title")}</h2>
        <div style={{ display: "flex", gap: 5 }} role="group" aria-label={t("brief.periodLabel")}>
          {periods.map((p) => (
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

/**
 * ═══ MY DAY — THE OWNER'S 2026-10-05 REDESIGN ═══
 *
 * The board (published as "My Day redesign", approved "go ahead and get this screen live") reads in
 * one order: WHAT NEEDS ME NOW, then HOW IS TODAY GOING (four big numbers), then the day's rows and
 * money, then HOW WAS MY WEEK (a scoreboard, not sentences). Every figure is a reading of the three
 * payloads the server already sends — `/me/report`, `/me/brief`, `/me/desk` — and nothing here
 * computes a number the server did not.
 *
 * THE PAPER DID NOT CHANGE. The `.print-doc` below is the same document as before (every section,
 * the totals, "Signed" and "Received by"), now `.print-only`: the screen draws the redesign and the
 * printer draws the shift report, both from the ONE report response (DD5).
 *
 * Owner rulings carried: blind count (no collections section ⇒ "shown after you count your drawer",
 * and no figure is derived around it); self-scoped (`/me/*`, no user id anywhere); history periods
 * gated by role (`periodsFor`).
 */
const PREVIEW_ROWS = 7;

function Pill({ tone, children }: { tone: StatusTone; children: React.ReactNode }): React.ReactElement {
  return <span className={`myd-pill ${tone}`}><i aria-hidden="true" />{children}</span>;
}

function DateStepper({ date, today, onChange }: { date: string; today: string; onChange: (d: string) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <div className="myd-date">
      <button type="button" aria-label={t("myDay.prevDay")} onClick={() => { onChange(shiftDate(date, -1)); }}>‹</button>
      <label className="myd-date-label">
        <span className="myd-date-long">{longDate(date, i18n.language)}</span>
        <span className="myd-date-short">{longDate(date, i18n.language, false)}</span>
        <input
          type="date" className="myd-date-input" value={date} max={today} aria-label={t("myDay.date")}
          onChange={(e) => { if (e.target.value !== "") onChange(e.target.value); }}
        />
      </label>
      <button type="button" aria-label={t("myDay.nextDay")} disabled={date >= today} onClick={() => { onChange(shiftDate(date, 1)); }}>›</button>
    </div>
  );
}

function VisitsCard({ rows, kind }: { rows: ReportRow[]; kind: "visits" | "consults" }): React.ReactElement {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<VisitFilter>("all");
  const [all, setAll] = useState(false);
  const toneOf = (r: ReportRow): StatusTone => (kind === "visits" ? statusTone(r[COL.status] ?? "") : outcomeTone(r[COL.outcome] ?? ""));
  const labelOf = (r: ReportRow): string => (kind === "visits"
    ? t(`report.value.${r[COL.status] ?? ""}`, { defaultValue: r[COL.status] ?? "" })
    : t(`report.value.${r[COL.outcome] ?? ""}`, { defaultValue: r[COL.outcome] ?? "" }));
  const newestFirst = useMemo(() => [...rows].reverse(), [rows]);
  const filtered = newestFirst.filter((r) => kind === "consults" || matchesFilter(filter, toneOf(r)));
  const shown = all ? filtered : filtered.slice(0, PREVIEW_ROWS);
  const count = (f: VisitFilter): number => newestFirst.filter((r) => matchesFilter(f, toneOf(r))).length;
  const filters: VisitFilter[] = ["all", "waiting", "doctor", "done", "left"];
  const title = kind === "visits" ? t("report.opd.myVisits") : t("report.opd.myConsults");
  const typeOf = (r: ReportRow): string => t(`report.value.${r[COL.type] ?? ""}`, { defaultValue: r[COL.type] ?? "" });

  return (
    <section className="myd-card" data-testid={`myd-${kind}`}>
      <div className="myd-card-h"><h3>{title}</h3><span className="myd-count">{rows.length}</span></div>
      {kind === "visits" && rows.length > 0 ? (
        <div className="myd-filters" role="group" aria-label={t("myDay.filterLabel")}>
          {filters.filter((f) => f === "all" || count(f) > 0).map((f) => (
            <button key={f} type="button" className={filter === f ? "myd-f on" : "myd-f"} aria-pressed={filter === f}
              onClick={() => { setFilter(f); setAll(false); }}>
              {t(`myDay.filter.${f}`)} <b>{count(f)}</b>
            </button>
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? <p className="myd-empty">{t("myDay.noRows")}</p> : (
        <>
          <table className="myd-table">
            <thead>
              <tr>
                <th>{t("report.col.time")}</th><th>{t("report.col.patient")}</th><th>{t("myDay.col.visit")}</th>
                <th>{t("report.col.type")}</th><th>{kind === "visits" ? t("report.col.status") : t("report.col.outcome")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r[COL.visitNo]}>
                  <td className="mono dim">{r[COL.time]}</td>
                  <td><b>{r[COL.patient]}</b><small className="mono">{r[COL.uhid]}</small></td>
                  <td className="mono dim">{r[COL.visitNo]}</td>
                  <td className="dim">{typeOf(r)}</td>
                  <td><Pill tone={toneOf(r)}>{labelOf(r)}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="myd-rows">
            {shown.map((r) => (
              <li key={r[COL.visitNo]}>
                <span className="mono dim">{r[COL.time]}</span>
                <span className="myd-name">{r[COL.patient]}</span>
                <Pill tone={toneOf(r)}>{labelOf(r)}</Pill>
                <span className="myd-meta mono">{typeOf(r)} · {r[COL.visitNo]} · {r[COL.uhid]}</span>
              </li>
            ))}
          </ul>
          <div className="myd-foot">
            <span>{t("myDay.shownOf", { shown: shown.length, total: filtered.length })}</span>
            {filtered.length > PREVIEW_ROWS ? (
              <button type="button" className="myd-link" onClick={() => { setAll(!all); }}>
                {all ? t("myDay.showFewer") : t("myDay.showAll", { count: filtered.length })}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function CollectionsCard({ section, blind, receipts }: { section: WireReportSection | undefined; blind: boolean; receipts: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (section === undefined && !blind) return null;
  return (
    <section className="myd-card" data-testid="myd-collections">
      <div className="myd-card-h"><h3>{t("report.billing.myCollections")}</h3><span className="myd-grow" /><span className="myd-count">{t("myDay.today")}</span></div>
      {section === undefined ? (
        <div className="myd-blind">
          <b>{t("myDay.blind.title")}</b>
          <span>{t("myDay.blind.body")}</span>
          {receipts === null ? null : <span>{t("myDay.blind.receipts", { count: Number(receipts) })}</span>}
        </div>
      ) : (
        <div className="myd-money">
          {section.rows.map((r) => (
            <div className="myd-money-r" key={r[0]}><span>{cellText(t, section.columnKeys[0], r[0] ?? "")}</span><span className="mono">{r[1]}</span></div>
          ))}
          {section.totals === undefined ? null : (
            <div className="myd-money-r tot"><span>{cellText(t, section.columnKeys[0], section.totals[0] ?? "")}</span><span className="mono">{section.totals[1]}</span></div>
          )}
        </div>
      )}
    </section>
  );
}

function MetricRow({ m, uncountedToday = false }: { m: Metric; uncountedToday?: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const drift = m.first !== undefined && m.second !== undefined;
  return (
    <>
      <div className="myd-metric">
        <span className="myd-metric-name">{t(`myDay.metric.${m.fact}`, { defaultValue: m.fact })}</span>
        <span className="myd-metric-num">{m.total}</span>
        <span className="myd-metric-cmp">
          {m.median === undefined ? (drift ? null : <span>{t("myDay.noCompare")}</span>) : (
            <>
              {m.deltaPct === undefined ? null : (
                <span className={`myd-delta ${m.deltaPct > 0 ? "up" : m.deltaPct < 0 ? "dn" : "eq"}`}>
                  {m.deltaPct > 0 ? "▲" : m.deltaPct < 0 ? "▼" : "="} {t(m.deltaPct > 0 ? "myDay.above" : m.deltaPct < 0 ? "myDay.below" : "myDay.same", { pct: Math.abs(m.deltaPct) })}
                </span>
              )}
              <span>{t("myDay.usual", { median: m.median })}</span>
            </>
          )}
          {uncountedToday && m.fact === "collected" ? <span data-testid="myd-collected-uncounted">{t("myDay.blind.weekNote")}</span> : null}
        </span>
      </div>
      {drift ? (
        <div className="myd-metric">
          <span className="myd-metric-name">{t("myDay.halves")}</span>
          <span className="myd-metric-num">{m.first} → {m.second}</span>
          <span className="myd-metric-cmp"><span>{t(Number(m.second) > Number(m.first) ? "myDay.busierLater" : Number(m.second) < Number(m.first) ? "myDay.busierEarlier" : "myDay.evenHalves")}</span></span>
        </div>
      ) : null}
    </>
  );
}

/**
 * `blind` — today's drawer is not counted yet, so the server left this day's money out of the window
 * (blind count, owner 2026-09-28). The "Collected" line then says so instead of reading as a short week
 * (owner 2026-10-05).
 */
function WeekCard({ date, blind }: { date: string; blind: boolean }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { actor, can } = useAuth();
  const [period, setPeriod] = useState<WireBriefPeriod>("week");
  const periods = periodsFor(can);
  const who = actor?.id ?? "";
  const brief = useQuery({ queryKey: ["me", "brief", who, period, date], queryFn: () => fetchBrief(period, date), enabled: who !== "" });
  const metrics = metricsOf(brief.data);
  return (
    <section className="myd-card" data-testid="myd-brief">
      <div className="myd-card-h">
        <h3>{t(`myDay.periodTitle.${period}`)}</h3><span className="myd-grow" />
        <div className="myd-seg" role="group" aria-label={t("brief.periodLabel")}>
          {periods.map((p) => (
            <button key={p} type="button" aria-pressed={p === period} className={p === period ? "on" : ""} onClick={() => { setPeriod(p); }}>
              {t(`brief.period.${p}`)}
            </button>
          ))}
        </div>
      </div>
      {brief.isPending ? <p className="myd-empty">{t("app.loading")}</p> : null}
      {brief.isError ? <p role="alert" className="myd-empty err">{t("brief.failed")}</p> : null}
      {brief.data !== undefined && metrics.length === 0 ? <p className="myd-empty">{t("brief.nothingToSay")}</p> : null}
      {metrics.map((m) => <MetricRow key={m.fact} m={m} uncountedToday={blind && brief.data?.to === date} />)}
      {brief.data === undefined ? null : (
        <div className="myd-range mono">{t("brief.range", { from: longDate(brief.data.from, i18n.language, false), to: longDate(brief.data.to, i18n.language) })}</div>
      )}
    </section>
  );
}

type NowItem = { n: string; label: string };

export function MyDay(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { actor, username } = useAuth();
  const today = todayIst();
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const who = actor?.id ?? "";
  const report = useQuery({ queryKey: ["me", "report", who, date], queryFn: () => fetchReport(date), enabled: who !== "" });
  // The desk's live counts (queue, re-bookings, receipts) — the same cards the home desk shows.
  const desk = useQuery({ queryKey: ["me", "desk", who, date], queryFn: () => fetchDesk(date), enabled: who !== "" });

  const sections = report.data?.sections ?? [];
  const provisional = report.data?.provisional ?? false;
  const visitsSection = sections.find((s) => s.key === "opd.myVisits");
  const consultsSection = sections.find((s) => s.key === "opd.myConsults");
  const moneySection = sections.find((s) => s.key === "billing.myCollections");
  const otherSections = sections.filter((s) => s !== visitsSection && s !== consultsSection && s !== moneySection);
  const visits = rowsOf(visitsSection);
  const consults = rowsOf(consultsSection);
  const v = summariseVisits(visits);
  const isDoctor = consultsSection !== undefined || hasCard(desk.data, "opd.myQueue");
  // Blind count (owner 2026-09-28): the cashier has a collections card but the server sent no section.
  const cashier = hasCard(desk.data, "billing.myCollections") || moneySection !== undefined;
  const blind = cashier && moneySection === undefined;
  const receipts = deskStat(desk.data, "billing.myCollections", "desk.billing.receipts");
  const isToday = date === today;

  const nowItems: NowItem[] = [];
  if (isToday) {
    if (isDoctor) {
      const waiting = deskStat(desk.data, "opd.myQueue", "desk.opd.waiting");
      const serving = deskStat(desk.data, "opd.myQueue", "desk.opd.nowServing");
      if (waiting !== null && waiting !== "0") nowItems.push({ n: waiting, label: t("myDay.now.queueWaiting") });
      if (serving !== null && serving !== "—") nowItems.push({ n: `T-${serving}`, label: t("myDay.now.nowServing") });
    } else {
      if (v.registered + v.waiting > 0) nowItems.push({ n: String(v.registered + v.waiting), label: t("myDay.now.stillWaiting") });
      if (v.withDoctor > 0) nowItems.push({ n: String(v.withDoctor), label: t("myDay.now.withDoctor") });
      const rebook = deskStat(desk.data, "opd.appointments", "desk.appointments.needsRebooking");
      if (rebook !== null && rebook !== "0") nowItems.push({ n: rebook, label: t("myDay.now.rebook") });
    }
  }
  const nowHref = isDoctor ? "/opd/consult" : "/counter";

  const prescribed = consults.filter((r) => r[COL.outcome] === "prescribed").length;
  const referred = consults.filter((r) => r[COL.outcome] === "referred").length;
  const consultTimes = consults.map((r) => r[COL.time] ?? "").filter((x) => x !== "").sort();
  const total = moneySection?.totals?.[1];
  const byMode = (code: string): string | undefined => moneySection?.rows.find((r) => r[0] === `report.mode.${code}`)?.[1];

  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const localAnswer = (question: string): string | null => {
    const q = question.toLowerCase();
    if (/closed|provisional|final|draft|lock/.test(q)) return t(provisional ? "myDay.agent.provisional" : "myDay.agent.closed");
    if (/sign|print|paper|document|hand ?over/.test(q)) return t("myDay.agent.signature");
    if (/section|report|day|figure|what|how many|total/.test(q)) {
      return sections.length === 0 ? t("myDay.agent.empty") : t("myDay.agent.sections", { count: sections.length, date });
    }
    return null;
  };
  const copilot = useCopilot({ fallback: localAnswer, onNote: (text) => { setAgentLog((l) => logged(l, text)); }, date });

  const exportCsv = (): void => {
    setError(null);
    setDownloading(true);
    downloadReportCsv(date)
      .catch(() => { setError(t("myDay.exportFailed")); })
      .finally(() => { setDownloading(false); });
  };
  const actions = (
    <>
      <button type="button" className="myd-btn" onClick={() => { window.print(); }}>{t("myDay.print")}</button>
      <button type="button" className="myd-btn" disabled={downloading} onClick={exportCsv}>{t("myDay.export")}</button>
    </>
  );

  return (
    <PaperScreen testId="my-day" style={{ padding: 0 }}>
      <div className="myd no-print" data-testid="my-day-screen">
        <header className="myd-hdr">
          <div className="myd-who">
            <h1>{t("myDay.title")}</h1>
            <span>{username ?? ""}{isDoctor ? ` · ${t("myDay.role.doctor")}` : cashier ? ` · ${t("myDay.role.deskCash")}` : ""}</span>
          </div>
          <DateStepper date={date} today={today} onChange={setDate} />
          {report.data === undefined ? null : provisional
            ? <span className="myd-chip open"><i aria-hidden="true" /><span className="myd-chip-long">{t("myDay.dayOpen")}</span><span className="myd-chip-short">{t("myDay.dayOpenShort")}</span></span>
            : <span className="myd-chip closed"><i aria-hidden="true" />{t("myDay.dayClosed")}</span>}
          <span className="myd-grow" />
          <div className="myd-acts myd-acts-top">{actions}</div>
        </header>
        {error === null ? null : <p role="alert" className="myd-error">{error}</p>}
        {report.isPending ? <p className="myd-empty">{t("app.loading")}</p> : null}

        {isToday && (isDoctor || visitsSection !== undefined) ? (
          <div className="myd-now" data-testid="myd-now">
            <span className="myd-now-lead">{t("myDay.now.title")}</span>
            <div className="myd-now-items">
              {nowItems.length === 0 ? <span className="myd-now-calm">{t("myDay.now.nothing")}</span> : nowItems.map((it) => (
                <div className="myd-now-it" key={it.label}><b>{it.n}</b><span>{it.label}</span></div>
              ))}
            </div>
            <a className="myd-btn pri" href={nowHref}>{isDoctor ? t("myDay.now.openConsult") : t("myDay.now.openDesk")}</a>
          </div>
        ) : null}

        <div className="myd-tiles">
          {isDoctor ? (
            <>
              <div className="myd-tile"><span className="k">{t("myDay.tile.seenToday")}</span><span className="v">{consults.length}</span><span className="s">{consultTimes[0] === undefined ? "—" : t("myDay.tile.since", { time: consultTimes[0] })}</span></div>
              <div className="myd-tile"><span className="k">{t("myDay.tile.queueWaiting")}</span><span className="v">{deskStat(desk.data, "opd.myQueue", "desk.opd.waiting") ?? "—"}</span><span className="s">{t("myDay.tile.queueNow")}</span></div>
              <div className="myd-tile"><span className="k">{t("myDay.tile.prescribed")}</span><span className="v">{prescribed}</span><span className="s">{t("myDay.tile.ofSeen", { count: consults.length })}</span></div>
              <div className="myd-tile"><span className="k">{t("myDay.tile.referred")}</span><span className="v">{referred}</span><span className="s">{t("myDay.tile.ofSeen", { count: consults.length })}</span></div>
            </>
          ) : null}
          {!isDoctor && visitsSection !== undefined ? (
            <>
              <div className="myd-tile"><span className="k">{t("myDay.tile.visitsOpened")}</span><span className="v">{v.total}</span><span className="s">{v.first === null ? "—" : t("myDay.tile.span", { first: v.first, last: v.last })}</span></div>
              <div className="myd-tile"><span className="k">{t("myDay.tile.seen")}</span><span className="v">{v.done}</span><span className="s">{v.left > 0 ? t("myDay.tile.leftUnseen", { count: v.left }) : t("myDay.tile.ofOpened", { count: v.total })}</span></div>
              <div className="myd-tile"><span className="k">{t("myDay.tile.stillHere")}</span><span className="v">{v.registered + v.waiting + v.withDoctor}</span><span className="s">{t("myDay.tile.stillHereSplit", { waiting: v.registered + v.waiting, doctor: v.withDoctor })}</span></div>
            </>
          ) : null}
          {cashier ? (
            blind ? (
              <div className="myd-tile locked"><span className="k">{t("myDay.tile.collected")}</span><span className="v">{t("myDay.tile.afterCount")}</span><span className="s">{receipts === null ? "" : t("myDay.blind.receipts", { count: Number(receipts) })}</span></div>
            ) : (
              <div className="myd-tile"><span className="k">{t("myDay.tile.collected")}</span><span className="v">{(total ?? "—").replace(/\.00$/, "")}</span><span className="s">{t("myDay.tile.modes", { cash: (byMode("cash") ?? "—").replace(/\.00$/, ""), upi: (byMode("upi") ?? "—").replace(/\.00$/, "") })}</span></div>
            )
          ) : null}
        </div>

        <div className="myd-cols">
          <div className="myd-stack">
            {isDoctor ? <VisitsCard rows={consults} kind="consults" /> : null}
            {visitsSection !== undefined && (!isDoctor || visits.length > 0) ? <VisitsCard rows={visits} kind="visits" /> : null}
            {otherSections.map((s) => (
              <section className="myd-card myd-generic" key={s.key}><SectionTable section={s} /></section>
            ))}
            {!report.isPending && sections.length === 0 ? <p className="myd-empty">{t("myDay.empty")}</p> : null}
          </div>
          <div className="myd-stack">
            <CollectionsCard section={moneySection} blind={blind} receipts={receipts} />
            <WeekCard date={date} blind={blind} />
          </div>
        </div>

        <div className="myd-acts myd-acts-bottom">{actions}</div>
        <p className="myd-paper">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L12 4v10.5H4z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          {t("myDay.paperNote")}
        </p>
      </div>

      {/*
        ONE printable node holding every section (07a/07b: two `.print-doc`s overprint). It is the same
        shift report as before the redesign — now `.print-only`, so the screen draws the board and the
        printer draws the paper, both from the one report response.
      */}
      <div className="print-doc print-only" style={{ display: "flex", flexDirection: "column", gap: 17 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--ink)", paddingBottom: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{t("myDay.docTitle")}</span>
          <span style={{ fontSize: 12.5 }}>{t("myDay.docFor", { date: longDate(date, i18n.language) })}</span>
          <span className="mo" style={{ fontSize: 12 }}>{username ?? (actor === null ? "" : actor.id)}</span>
          {provisional ? <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("myDay.provisionalNote")}</span> : null}
        </div>
        {!report.isPending && sections.length === 0 ? <p style={{ margin: 0, fontSize: 12.5 }}>{t("myDay.empty")}</p> : null}
        {sections.map((s) => <SectionTable key={s.key} section={s} />)}
        <div style={{ marginTop: 34, display: "flex", gap: 48, fontSize: 12.5 }}>
          <div style={{ flex: 1, borderTop: "1px solid var(--ink)", paddingTop: 5 }}>{t("myDay.signedBy")}</div>
          <div style={{ flex: 1, borderTop: "1px solid var(--ink)", paddingTop: 5 }}>{t("myDay.receivedBy")}</div>
        </div>
      </div>

      <div className="no-print myd-dock">
        <AgentDock
          answer={copilot.answer} log={agentLog} onAsk={copilot.ask}
          placeholder={t("myDay.askPlaceholder")} idle={t("myDay.agentIdle")}
          panel={copilot.report === null ? undefined : <CopilotReport report={copilot.report} onDismiss={copilot.dismissReport} />}
        />
      </div>
    </PaperScreen>
  );
}
