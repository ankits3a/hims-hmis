import { useState } from "react";
import { useTranslation } from "react-i18next";
import { dmy, groupByDay } from "./patient-profile-model";
import type { Source, TimelineRow } from "./patient-profile-model";

/**
 * OWNER 2026-10-11 — THE PROFILE'S MIDDLE COLUMN, THREE WAYS. *"I want all 3. Let the staff choose
 * according to their screen resolution and whatever seems most accessible to them. Keep the
 * recommended as the default view."*
 *
 *   overview (default) — a tab bar with counts; Overview is one card per category with its latest
 *                        three rows and "View all", which opens that tab as a full list by month.
 *   cards              — one card per category, stacked, each expanding in place with View more.
 *   timeline           — the one dated timeline, as before, with filter chips.
 *
 * The rows are the same rows everywhere (`renderRow`, the profile's own row), so a visit, a bill or
 * a document opens the same way in every view. The choice is the viewer's own and lives in this
 * browser (a convenience, not a record): an unreadable store simply gives the default.
 */
export type HistoryView = "overview" | "cards" | "timeline";
export type HistoryCategory = "visits" | "lab" | "imaging" | "medicines" | "bills" | "appointments" | "documents";

const VIEW_KEY = "hmis.profile.historyView";
const VIEWS: readonly HistoryView[] = ["overview", "cards", "timeline"];
const ICON: Record<HistoryView, string> = { overview: "▦", cards: "☰", timeline: "⋮" };
const ORDER: readonly HistoryCategory[] = ["visits", "lab", "imaging", "medicines", "bills", "appointments", "documents"];
const OF_SOURCE: Record<Source, HistoryCategory> = {
  OPD: "visits", LAB: "lab", RAD: "imaging", PHAR: "medicines", BILL: "bills", DOC: "documents",
};
const DAYS_SHOWN = 6;
const PREVIEW_ROWS = 3;

function readView(): HistoryView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v !== null && (VIEWS as readonly string[]).includes(v) ? (v as HistoryView) : "overview";
  } catch { return "overview"; }
}
function writeView(v: HistoryView): void {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* a blocked store keeps the choice for this visit only */ }
}

/** `YYYY-MM` of a row's day — the month a full list groups under. */
const monthOf = (day: string): string => day.slice(0, 7);

export function PatientHistory({ rows, renderRow, appointments, quickLab, showQuickLab, note }: {
  rows: TimelineRow[];
  renderRow: (r: TimelineRow) => React.ReactNode;
  /** Upcoming appointments and their history, as the profile draws them; null for a seat that may not read them. */
  appointments: React.ReactNode | null;
  /** The quick lab reports (decision 0061): `compact` in a card, full in a tab. */
  quickLab: (compact: boolean) => React.ReactNode;
  showQuickLab: boolean;
  note: React.ReactNode;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [view, setViewState] = useState<HistoryView>(readView);
  const [tab, setTab] = useState<"overview" | HistoryCategory>("overview");
  const [open, setOpen] = useState<HistoryCategory[]>([]);
  const [filter, setFilter] = useState<HistoryCategory | "all">("all");
  const [showAllDays, setShowAllDays] = useState(false);
  const setView = (v: HistoryView): void => { setViewState(v); writeView(v); setTab("overview"); };

  const byCat = new Map<HistoryCategory, TimelineRow[]>();
  for (const r of rows) byCat.set(OF_SOURCE[r.source], [...(byCat.get(OF_SOURCE[r.source]) ?? []), r]);
  const cats = ORDER.filter((c) => (c === "appointments" ? appointments !== null
    : c === "lab" ? showQuickLab || (byCat.get(c) ?? []).length > 0
    : (byCat.get(c) ?? []).length > 0));
  /** No count where it would mislead: appointments are drawn elsewhere, and the lab's quick reports are not counted here. */
  const count = (c: HistoryCategory): number | null => (c === "appointments" || (c === "lab" && showQuickLab) ? null : (byCat.get(c) ?? []).length);
  const monthName = (ym: string): string => new Date(`${ym}-01T00:00:00Z`)
    .toLocaleDateString(i18n.language.startsWith("hi") ? "hi-IN" : "en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  const rowsBox = (rs: TimelineRow[]): React.ReactNode => (
    <div className="box" style={{ overflow: "hidden" }}>{rs.map((r) => renderRow(r))}</div>
  );
  const byMonth = (rs: TimelineRow[]): React.ReactNode => {
    const months: { ym: string; rows: TimelineRow[] }[] = [];
    for (const r of rs) {
      const last = months.at(-1);
      if (last !== undefined && last.ym === monthOf(r.day)) last.rows.push(r);
      else months.push({ ym: monthOf(r.day), rows: [r] });
    }
    return months.map((m) => (
      <div key={m.ym}>
        <div className="day"><span className="d">{monthName(m.ym)}</span><span className="ln" /></div>
        {rowsBox(m.rows)}
      </div>
    ));
  };
  const catBody = (c: HistoryCategory, compact: boolean): React.ReactNode => {
    if (c === "appointments") return appointments;
    const rs = byCat.get(c) ?? [];
    const shown = compact ? rs.slice(0, PREVIEW_ROWS) : rs;
    return (
      <>
        {c === "lab" && showQuickLab && <div className="hv-ql" style={{ marginBottom: rs.length > 0 ? 10 : 0 }}>{quickLab(compact)}</div>}
        {shown.length > 0 && (compact ? rowsBox(shown) : byMonth(shown))}
      </>
    );
  };
  const catTitle = (c: HistoryCategory): string => t(`profile.hv.cat.${c}`);

  const switcher = (
    <div role="group" aria-label={t("profile.hv.choose")} style={{ display: "flex", gap: 4, marginLeft: "auto" }} data-testid="history-view-switch">
      {VIEWS.map((v) => (
        <button key={v} type="button" className={view === v ? "pill on" : "pill"} aria-pressed={view === v}
          aria-label={t(`profile.hv.view.${v}`)} title={t(`profile.hv.view.${v}`)}
          style={{ height: 28, minWidth: 32, justifyContent: "center", fontSize: 14 }} onClick={() => setView(v)}>
          <span aria-hidden>{ICON[v]}</span>
        </button>
      ))}
    </div>
  );

  return (
    <section data-testid={`history-${view}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 8px" }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("profile.history")}</h3>
        {switcher}
      </div>

      {view === "overview" && (
        <>
          <div role="tablist" aria-label={t("profile.hv.categories")} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {(["overview", ...cats] as const).map((c) => (
              <button key={c} type="button" role="tab" aria-selected={tab === c} className={tab === c ? "pill on" : "pill"}
                style={{ height: 28, fontSize: 12 }} data-testid={`history-tab-${c}`} onClick={() => setTab(c)}>
                {c === "overview" ? t("profile.hv.overview") : catTitle(c)}
                {c !== "overview" && count(c) !== null && <span style={{ color: "var(--faint)" }}>{count(c)}</span>}
              </button>
            ))}
          </div>
          {tab === "overview" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12 }} data-testid="history-cards">
              {cats.map((c) => (
                <div key={c} className="box hv-card" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }} data-testid={`history-card-${c}`}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <b style={{ fontSize: 13.5 }}>{catTitle(c)}</b>
                    {count(c) !== null && <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{count(c)}</span>}
                    <button type="button" className="lnk" style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => setTab(c)}>
                      {t("profile.hv.viewAll")} ›
                    </button>
                  </div>
                  {catBody(c, true)}
                </div>
              ))}
              {cats.length === 0 && <p style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="timeline-empty">{t("profile.noHistory")}</p>}
            </div>
          ) : (
            <div data-testid={`history-list-${tab}`}>{catBody(tab, false)}</div>
          )}
        </>
      )}

      {view === "cards" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="history-stack">
          {cats.map((c) => {
            const all = (byCat.get(c) ?? []).length;
            const expanded = open.includes(c);
            return (
              <div key={c} className="box hv-card" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }} data-testid={`history-card-${c}`}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <b style={{ fontSize: 13.5 }}>{catTitle(c)}</b>
                  {count(c) !== null && <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{count(c)}</span>}
                </div>
                {catBody(c, !expanded)}
                {c !== "appointments" && all > PREVIEW_ROWS && (
                  <button type="button" className="sec" style={{ alignSelf: "flex-start", height: 28 }}
                    onClick={() => setOpen((o) => (expanded ? o.filter((x) => x !== c) : [...o, c]))}>
                    {expanded ? t("profile.hv.showLess") : t("profile.hv.viewMore", { count: all - PREVIEW_ROWS })}
                  </button>
                )}
              </div>
            );
          })}
          {cats.length === 0 && <p style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="timeline-empty">{t("profile.noHistory")}</p>}
        </div>
      )}

      {view === "timeline" && (() => {
        const shownRows = filter === "all" ? rows : rows.filter((r) => OF_SOURCE[r.source] === filter);
        const days = groupByDay(shownRows);
        const shownDays = showAllDays ? days : days.slice(0, DAYS_SHOWN);
        const hidden = days.slice(DAYS_SHOWN).reduce((s, d) => s + d.rows.length, 0);
        return (
          <>
            {appointments}
            {showQuickLab && <div style={{ marginTop: 18 }}>{quickLab(false)}</div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0 0" }} data-testid="history-filters">
              {(["all", ...cats.filter((c) => c !== "appointments")] as const).map((c) => (
                <button key={c} type="button" className={filter === c ? "pill on" : "pill"} aria-pressed={filter === c}
                  style={{ height: 26, fontSize: 12 }} onClick={() => setFilter(c)}>
                  {c === "all" ? t("profile.hv.all") : catTitle(c)}
                </button>
              ))}
            </div>
            {days.length === 0 && <p style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="timeline-empty">{t("profile.noHistory")}</p>}
            <div data-testid="timeline">
              {shownDays.map((d) => (
                <div key={d.day}>
                  <div className="day"><span className="d">{dmy(d.day)}</span><span className="ln" /></div>
                  {rowsBox(d.rows)}
                </div>
              ))}
            </div>
            {!showAllDays && hidden > 0 && (
              <div className="day">
                <span className="d">{t("profile.earlier", { count: hidden })}</span><span className="ln" />
                <button type="button" className="lnk" onClick={() => setShowAllDays(true)}>{t("profile.showMore")}</button>
              </div>
            )}
          </>
        );
      })()}
      {note}
    </section>
  );
}
