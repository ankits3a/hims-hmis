import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AskBar, DoctorDeskFrame, initialsOf } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { deskErrorText, fetchTower, markBriefSeen, nudgeRow } from "../lib/doctor-desk-api";
import type {
  AttentionTab, WireAttentionRow, WireBrief, WireBriefFact, WireOwedRow, WireScheduleRow, WireTeamMember, WireTower,
} from "../lib/doctor-desk-api";
import { owedClock } from "../../../../packages/contracts/src/doctor-desk";
import { dutyWhatKey, greetingKey } from "../../../../packages/contracts/src/roster-board";
import "./doctor-desk.css";

/**
 * ═══ DD-0 (#626) — THE TOWER, OPD-DAY MODE (`docs/design/2026-09-18-doctor-desk/Tower.dc.html`) ═══
 *
 * The board the owner approved on 2026-09-18, ported inside `DoctorDeskFrame`: the centre carries the
 * greeting, the login brief (R9), Today's Clinical Summary, Needs Your Attention and the unit's OPD;
 * the right rail carries Clocks Running FIRST (R7), Today's Schedule, the Unit Team (collapsed, R8)
 * and AI Agent Activity (collapsed, R8). Every figure is the server's (`GET /doctor-desk/tower`).
 *
 * What the board draws and DD-0 cannot source is ABSENT, not a zero (plan §3.0): inpatient tiles, the
 * AI round brief and Start Ward Round, bed dots, "Last 7 Days", teaching rows, the PMJAY row. No money
 * anywhere on this screen (decision 0058). Cards are light (R13); the Clocks card keeps an ink edge.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

const TABS: readonly ("all" | AttentionTab)[] = ["all", "critical", "change", "new", "pending"];
const ROWS_SHOWN = 5;

/** "09:14" today, "Sat 16:20" another day — IST. */
export function whenText(iso: string, istDate: string, lang: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  if (day === istDate) return fmtIst(iso);
  const dow = new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
  return `${dow} ${fmtIst(iso)}`;
}

/** "41 min" · "2 h 10" · "26 h" — the board's clock words. */
export function spanText(minutes: number, t: T): string {
  if (minutes < 60) return t("doctorDesk.span.min", { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h >= 10 || m === 0 ? t("doctorDesk.span.h", { n: h }) : t("doctorDesk.span.hm", { h, m: String(m).padStart(2, "0") });
}

export function patientName(p: WireAttentionRow["patient"] | NonNullable<WireBriefFact["patient"]>, t: T): string {
  return p.name ?? t("doctorDesk.patientSealed");
}

/** The row's signal line — the value, the study, the visit — as the board's red/amber second column. */
export function signalText(r: Pick<WireAttentionRow, "kind" | "params">, t: T): string {
  return t(`doctorDesk.signal.${r.kind}`, r.params);
}

function greetingOf(tower: WireTower, t: T): string {
  return t(`rosterMyDuties.greeting.${greetingKey(tower.at)}`, { name: tower.you.name });
}

function gradeText(grade: string | null, t: T): string | null {
  return grade === null ? null : t(`doctorDesk.grade.${grade}`, { defaultValue: grade });
}

export function DoctorDeskTower(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const q = useQuery({ queryKey: ["doctor-desk", "tower"], queryFn: fetchTower, refetchInterval: 60_000 });
  const tower = q.data;
  const unit = tower?.unit ?? null;
  const context = unit === null
    ? t("doctorDesk.contextOwn")
    : t("doctorDesk.context", { dept: unit.departmentName, unit: unit.short });
  return (
    <DoctorDeskFrame
      active="dashboard" testId="doctor-desk-tower" context={context}
      pill={tower === undefined ? undefined : { tag: tower.mode === "opd_day" ? t("doctorDesk.tower.pillOpd") : t("doctorDesk.today"), text: unit === null ? t("doctorDesk.tower.pillNoUnit") : unit.short }}
      who={tower === undefined ? (q.isError ? { name: username ?? "", role: null } : undefined) : { name: tower.you.name || (username ?? ""), role: gradeText(tower.you.grade, t) }}
      counts={tower === undefined ? undefined : { aiBriefs: tower.briefsWaiting }}
      rail={tower === undefined ? undefined : <Rail tower={tower} />}
      ask={<AskBar id="ask-tower" placeholder={t("doctorDesk.tower.askPlaceholder")} fallback={() => null} terms={() => (tower?.attention ?? []).map((r) => r.patient.name ?? "").filter((n) => n !== "")} />}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {tower !== undefined && <Centre tower={tower} lang={i18n.language} />}
    </DoctorDeskFrame>
  );
}

function Centre({ tower, lang }: { tower: WireTower; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const sub = [gradeText(tower.you.grade, t), tower.unit?.departmentName, tower.unit?.short].filter((x): x is string => x !== null && x !== undefined && x !== "");
  return (
    <>
      <div className="dd-hello" data-testid="dd-hello">
        <div className="dd-hello-main">
          <span className="dd-hello-av" aria-hidden="true">{initialsOf(tower.you.name)}</span>
          <div className="dd-hello-text">
            <h1 className="dd-h1">{greetingOf(tower, t)}</h1>
            <div className="dd-hello-sub">{sub.length > 0 ? sub.join(" · ") : t("doctorDesk.tower.noUnitLine")}</div>
          </div>
        </div>
        <div className="dd-hello-band" aria-hidden="true">
          <span className="dd-hello-band-a">{t("doctorDesk.tower.band")}</span>
          <span className="dd-hello-band-b">{t("doctorDesk.tower.bandSub")}</span>
        </div>
      </div>
      {tower.brief !== null && <LoginBrief brief={tower.brief} istDate={tower.istDate} lang={lang} />}
      <Summary tower={tower} />
      <Attention tower={tower} lang={lang} />
      <div className="dd-two">
        {tower.unit !== null && <UnitOverview tower={tower} />}
        <section className="dd-card" data-testid="dd-quick">
          <h2 className="dd-h2">{t("doctorDesk.tower.quick")}</h2>
          <div className="dd-quick">
            {QUICK.filter((a) => can(a.permission)).map((a) => (
              <QuickLink key={a.key} to={a.to} label={t(a.label)} icon={a.icon} testId={`dd-quick-${a.key}`} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/** Quick Actions = only actions whose screen exists (plan DD-0.1, D-B). */
const QUICK = [
  { key: "opd", to: "/opd/consult", label: "doctorDesk.item.myOpd", permission: "opd.consult", icon: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" },
  { key: "duties", to: "/roster/my-duties", label: "doctorDesk.item.myDuties", permission: "roster.read", icon: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3" },
  { key: "onNow", to: "/roster/on-now", label: "doctorDesk.item.onNow", permission: "roster.read", icon: "M6 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 13.5c.4-2.4 2.2-3.5 4.5-3.5s4.1 1.1 4.5 3.5M11 7.3a2.2 2.2 0 000-4.4M12 10.2c1.4.4 2.3 1.5 2.5 3.3" },
  { key: "briefs", to: "/doctor-desk/briefs", label: "doctorDesk.item.aiBriefs", permission: "opd.consult", icon: "M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5 6.4 9.6 1.5 8l4.9-1.6z" },
] as const;

function QuickLink({ to, label, icon, testId }: { to: string; label: string; icon: string; testId: string }): React.ReactElement {
  const router = useRouter({ warn: false });
  return (
    <a href={to} className="dd-quick-a" data-testid={testId} onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to }); }}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg>
      {label}
    </a>
  );
}

/* ═══ the login brief (R9): highlighted 5 min / Got it, on the Tower 60 min, then only on AI Briefs ═══ */

export function factText(f: WireBriefFact, t: T): string {
  const who = f.patient === null ? "" : patientName(f.patient, t);
  return t(`doctorDesk.${f.key}`, { ...f.params, who });
}

function LoginBrief({ brief, istDate, lang }: { brief: WireBrief; istDate: string; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const seen = useMutation({ mutationFn: () => markBriefSeen(brief.id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["doctor-desk"] }); } });
  const since = t("doctorDesk.brief.since", { at: whenText(brief.windowFrom, istDate, lang) });
  const lines = brief.facts.length === 0 ? [t("doctorDesk.brief.quiet")] : brief.facts.map((f) => factText(f, t));
  const movesAt = brief.shownAt === null ? null : fmtIst(new Date(Date.parse(brief.shownAt) + 60 * 60_000).toISOString());
  if (brief.stage === "highlight") {
    return (
      <section className="dd-since dd-since-hot" data-testid="dd-brief" data-stage="highlight">
        <div className="dd-since-body">
          <div className="dd-since-head">
            <span className="dd-since-tag">{t("doctorDesk.brief.tag")}</span>
            <span className="dd-since-title">{since}</span>
            <span className="dd-since-span">{`${whenText(brief.windowFrom, istDate, lang)} → ${whenText(brief.windowTo, istDate, lang)}`}</span>
          </div>
          <ul className="dd-since-lines">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <span className="dd-since-note">{t("doctorDesk.brief.lifecycle")}</span>
        </div>
        <button type="button" className="dd-since-got" data-testid="dd-brief-got" disabled={seen.isPending} onClick={() => seen.mutate()}>{t("doctorDesk.brief.gotIt")}</button>
      </section>
    );
  }
  return (
    <section className="dd-since" data-testid="dd-brief" data-stage="quiet">
      <div className="dd-since-body">
        <div className="dd-since-head">
          <span className="dd-since-title">{since}</span>
          {movesAt !== null && <span className="dd-since-span">{t("doctorDesk.brief.moves", { at: movesAt })}</span>}
        </div>
        <span className="dd-since-quiet">{lines.join(" · ")}</span>
      </div>
      <BriefsLink />
    </section>
  );
}

function BriefsLink(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  return (
    <a href="/doctor-desk/briefs" className="dd-link" onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/doctor-desk/briefs" }); }}>
      {t("doctorDesk.brief.open")}
    </a>
  );
}

/* ═══ Today's Clinical Summary ═══ */

const TILE_ICON = {
  booked: "M8 8a3 3 0 100-6 3 3 0 000 6zM2.5 14c.6-2.8 2.8-4 5.5-4s4.9 1.2 5.5 4",
  seen: "M2.5 2.5h11v11h-11zM5 8l2 2 4-4.5",
  waiting: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.5V8l2.5 1.5",
  results: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5",
  papers: "M8 1.5l5.5 2V8c0 3.2-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11.2 2.5 8V3.5zM5.5 8l1.8 1.8 3.2-3.6",
};

function Summary({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const tl = tower.tiles;
  const tiles: { key: keyof typeof TILE_ICON; v: number; k: string; sub?: string; hot?: boolean }[] = [];
  if (tower.mode === "opd_day" && tl.booked !== null && tl.seen !== null && tl.waiting !== null) {
    tiles.push({ key: "booked", v: tl.booked, k: t("doctorDesk.tile.booked") });
    tiles.push({ key: "seen", v: tl.seen, k: t("doctorDesk.tile.seen") });
    tiles.push({
      key: "waiting", v: tl.waiting, k: t("doctorDesk.tile.waiting"),
      sub: tl.longestWaitMinutes === null ? undefined : t("doctorDesk.tile.longest", { span: spanText(tl.longestWaitMinutes, t) }),
    });
  }
  tiles.push({ key: "results", v: tl.resultsToReview, k: t("doctorDesk.tile.results") });
  tiles.push({ key: "papers", v: tl.papersToSign, k: t("doctorDesk.tile.papers"), hot: tl.papersToSign > 0 });
  return (
    <section className="dd-card" data-testid="dd-summary">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.tower.summary")}</h2></div>
      <div className="dd-tiles" style={{ ["--tiles" as string]: String(tiles.length) }}>
        {tiles.map((x) => (
          <div key={x.key} className="dd-tile" data-testid={`dd-tile-${x.key}`}>
            <span className={`dd-tile-ic${x.hot === true ? " dd-tile-ic-hot" : ""}`} aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={TILE_ICON[x.key]} /></svg>
            </span>
            <span className="dd-tile-txt">
              <span className="dd-tile-v">{x.v}</span>
              <span className="dd-tile-k">{x.k}</span>
              {x.sub !== undefined && <span className="dd-tile-sub">{x.sub}</span>}
            </span>
          </div>
        ))}
      </div>
      {tower.mode !== "opd_day" && <div className="dd-note">{t("doctorDesk.tower.noOpdToday")}</div>}
    </section>
  );
}

/* ═══ Needs Your Attention ═══ */

function rowSub(r: WireAttentionRow, istDate: string, lang: string, t: T): string {
  const at = whenText(r.at, istDate, lang);
  if (r.goneHome) return t("doctorDesk.sub.goneHome", { at });
  return t(`doctorDesk.sub.${r.kind}`, { at, ...r.params });
}

function Attention({ tower, lang }: { tower: WireTower; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const [tab, setTab] = useState<"all" | AttentionTab>("all");
  const [all, setAll] = useState(false);
  const rows = tab === "all" ? tower.attention : tower.attention.filter((r) => r.tab === tab);
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  return (
    <section className="dd-card" data-testid="dd-attention">
      <div className="dd-card-head">
        <h2 className="dd-h2">{t("doctorDesk.tower.attention")}</h2>
        {rows.length > ROWS_SHOWN && (
          <button type="button" className="dd-linkbtn" onClick={() => setAll((a) => !a)}>{all ? t("doctorDesk.tower.fewer") : t("doctorDesk.tower.allRows", { n: rows.length })}</button>
        )}
      </div>
      <div className="dd-tabs" role="tablist">
        {TABS.map((k) => (
          <button
            key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`dd-tab-${k}`}
            className={`dd-tab${tab === k ? " dd-tab-on" : ""}`} onClick={() => { setTab(k); setAll(false); }}
          >
            {t(`doctorDesk.tab.${k}`)}
            <span className={`dd-tab-n dd-tab-n-${k}`}>{tower.tabCounts[k]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="dd-empty" data-testid="dd-attention-empty">{t(`doctorDesk.empty.${tab}`)}</div>}
      <div className="dd-rows">
        {shown.map((r) => (
          <div key={r.key} className="dd-row" data-testid={`dd-row-${r.key}`} data-kind={r.kind}>
            <span className={`dd-chip dd-chip-${r.tab}`}><span className="dd-chip-dot" />{t(`doctorDesk.kind.${r.kind}`)}</span>
            <span className="dd-row-who">
              <span className="dd-row-name">{patientName(r.patient, t)}</span>
              <span className="dd-row-meta">{[r.patient.uhid, t(`doctorDesk.source.${r.source.module}`)].filter((x) => x !== null).join(" · ")}</span>
            </span>
            <span className="dd-row-sig">
              <span className={`dd-row-signal dd-sig-${r.tab}`}>{signalText(r, t)}</span>
              <span className="dd-row-sub">{rowSub(r, tower.istDate, lang, t)}</span>
            </span>
            <a
              href={r.href} className="dd-verb" data-testid={`dd-open-${r.key}`}
              onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: r.href }); }}
            >{t(`doctorDesk.verb.${r.kind}`)}</a>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ Unit Overview — the unit's OPD today ═══ */

function UnitOverview({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const lines = tower.unitOverview;
  const sum = (k: "booked" | "seen" | "waiting"): number => lines.reduce((n, l) => n + l[k], 0);
  return (
    <section className="dd-card" data-testid="dd-overview">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.tower.overview")}</h2><span className="dd-note">{t("doctorDesk.tower.overviewSub")}</span></div>
      {lines.length === 0 ? <div className="dd-empty">{t("doctorDesk.tower.overviewNone", { unit: tower.unit?.short ?? "" })}</div> : (
        <>
          <div className="dd-ov">
            <div><span className="dd-ov-v">{sum("booked")}</span><span className="dd-ov-k">{t("doctorDesk.tile.booked")}</span></div>
            <div><span className="dd-ov-v">{sum("seen")}</span><span className="dd-ov-k">{t("doctorDesk.tile.seen")}</span></div>
            <div><span className="dd-ov-v">{sum("waiting")}</span><span className="dd-ov-k">{t("doctorDesk.tile.waiting")}</span></div>
            <div><span className="dd-ov-v">{lines.length}</span><span className="dd-ov-k">{t("doctorDesk.tower.overviewDoctors")}</span></div>
          </div>
          <div className="dd-ov-lines">
            {lines.map((l) => (
              <div key={l.userId} className="dd-ov-line" data-testid={`dd-ov-${l.userId}`}>
                <span className="dd-ov-name">{l.name}</span>
                <span className="dd-ov-fig">{t("doctorDesk.tower.overviewLine", { booked: l.booked, seen: l.seen, waiting: l.waiting })}</span>
                <span className={`dd-ov-st dd-ov-st-${l.session}`}>{t(`doctorDesk.session.${l.session}`)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ═══ the right rail ═══ */

function Rail({ tower }: { tower: WireTower }): React.ReactElement {
  return (
    <>
      {tower.unit !== null && <Clocks tower={tower} />}
      <Schedule tower={tower} />
      {tower.unit !== null && <Team tower={tower} />}
      <Agents tower={tower} />
    </>
  );
}

export function clockText(r: Pick<WireOwedRow, "dueAt">, at: string, t: T): { text: string; over: boolean } {
  const c = owedClock(r.dueAt, at);
  return c.key === "over"
    ? { text: t("doctorDesk.clock.over", { span: spanText(c.minutes, t) }), over: true }
    : { text: t("doctorDesk.clock.in", { span: spanText(c.minutes, t) }), over: false };
}

function Clocks({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const push = useMutation({
    mutationFn: (key: string) => nudgeRow(key),
    onSuccess: () => { setRefusal(null); void qc.invalidateQueries({ queryKey: ["doctor-desk", "tower"] }); },
    onError: (e) => setRefusal(deskErrorText(e, t)),
  });
  const late = tower.clocks.filter((c) => clockText(c, tower.at, t).over).length;
  return (
    <section className="dd-card dd-clocks" data-testid="dd-clocks">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.clocks.title")}</h2></div>
      <div className="dd-clocks-sub">
        {t("doctorDesk.clocks.sub", { unit: tower.unit?.short ?? "" })}
        {late > 0 && <> · <span className="dd-red" data-testid="dd-clocks-late">{t("doctorDesk.clocks.late", { count: late })}</span></>}
      </div>
      {refusal !== null && <p role="alert" className="dd-alert" data-testid="dd-clocks-error">{refusal}</p>}
      {tower.clocks.length === 0 && <div className="dd-empty" data-testid="dd-clocks-empty">{t("doctorDesk.clocks.none", { unit: tower.unit?.short ?? "" })}</div>}
      {tower.clocks.map((c) => {
        const clock = clockText(c, tower.at, t);
        const mine = c.holder.userId === tower.you.userId;
        const soon = !clock.over && owedClock(c.dueAt, tower.at).minutes <= 30;
        return (
          <div key={c.key} className={`dd-clock ${clock.over ? "dd-clock-late" : soon ? "dd-clock-soon" : ""}`} data-testid={`dd-clock-${c.key}`}>
            <span className={`dd-clock-t ${clock.over ? "dd-red" : soon ? "dd-amber" : ""}`}>{clock.text}</span>
            <span className="dd-clock-what">
              <span className="dd-clock-w">{t(`doctorDesk.owed.${c.what}`, { defaultValue: t("doctorDesk.owed.other") })}</span>
              <span className="dd-clock-who">{mine ? t("doctorDesk.clocks.you") : c.holder.name}</span>
            </span>
            {!mine && (
              <button
                type="button" className={`dd-clock-btn${c.nudgedByMe ? " dd-clock-btn-done" : ""}`} data-testid={`dd-nudge-${c.key}`}
                disabled={c.nudgedByMe || push.isPending} onClick={() => push.mutate(c.key)}
              >{c.nudgedByMe ? t("doctorDesk.clocks.nudged") : t("doctorDesk.clocks.nudge")}</button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function scheduleWhat(s: WireScheduleRow, t: T): { at: string; what: string; note: string } {
  if (s.kind === "opd") {
    return { at: "", what: t("doctorDesk.schedule.opd"), note: t("doctorDesk.schedule.opdNote", { booked: s.booked, waiting: s.waiting }) };
  }
  const what = dutyWhatKey({ kind: s.dutyKind, startsAt: s.startsAt, endsAt: s.endsAt, night: s.night, positionKey: s.positionKey, mode: s.mode, activities: s.activities });
  return {
    at: fmtIst(s.startsAt),
    what: what.fallback === undefined ? t(what.key) : t(what.key, { defaultValue: t(what.fallback) }),
    note: t("doctorDesk.schedule.till", { at: fmtIst(s.endsAt) }),
  };
}

/** An OPD duty and the OPD session are one row: the session's figures become the duty's note. */
export function mergedSchedule(rows: readonly WireScheduleRow[], t: T): { at: string; what: string; note: string; live: boolean }[] {
  const opd = rows.find((r) => r.kind === "opd");
  const opdDuty = rows.find((r) => r.kind === "duty" && r.activities.includes("opd"));
  return rows.filter((r) => !(r.kind === "opd" && opdDuty !== undefined)).map((r) => {
    const w = scheduleWhat(r, t);
    const note = r === opdDuty && opd !== undefined && opd.kind === "opd" ? `${w.note} · ${t("doctorDesk.schedule.opdNote", { booked: opd.booked, waiting: opd.waiting })}` : w.note;
    return { ...w, note, live: false };
  });
}

function Schedule({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const now = Date.parse(tower.at);
  const merged = mergedSchedule(tower.schedule, t);
  return (
    <section className="dd-card" data-testid="dd-schedule">
      <div className="dd-card-head"><h2 className="dd-h2">{t("doctorDesk.schedule.title")}</h2></div>
      {tower.schedule.length === 0 && <div className="dd-empty">{t("doctorDesk.schedule.none")}</div>}
      {tower.schedule.filter((s) => s.kind !== "opd" || !tower.schedule.some((d) => d.kind === "duty" && d.activities.includes("opd"))).map((s, i) => {
        const w = merged[i]!;
        const live = s.kind === "opd" ? s.session === "in" : Date.parse(s.startsAt) <= now && Date.parse(s.endsAt) > now;
        return (
          <div key={i} className="dd-sch" data-testid={`dd-sch-${String(i)}`}>
            <span className="dd-sch-at">{w.at}</span>
            <span className={`dd-sch-dot${live ? " dd-sch-dot-live" : ""}`} />
            <span className="dd-sch-what"><span className={`dd-sch-w${live ? " dd-acc" : ""}`}>{w.what}</span><span className="dd-sch-note">{w.note}</span></span>
          </div>
        );
      })}
    </section>
  );
}

function roleText(m: WireTeamMember, t: T): string {
  const base = t(`doctorDesk.role.${m.role}`, { defaultValue: m.role });
  return m.officiating ? t("doctorDesk.role.officiating", { role: base }) : base;
}

function Team({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const team = tower.team;
  const onDuty = team.filter((m) => m.onDutyUntil !== null).length;
  const top = team.reduce<WireTeamMember | null>((a, m) => (m.holds > 0 && (a === null || m.holds > a.holds) ? m : a), null);
  return (
    <section className="dd-card" data-testid="dd-team">
      <button type="button" className="dd-fold" aria-expanded={open} data-testid="dd-team-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="dd-fold-text">
          <span className="dd-h2">{t("doctorDesk.team.title", { unit: tower.unit?.short ?? "" })}</span>
          <span className="dd-fold-sub" data-testid="dd-team-summary">
            {t("doctorDesk.team.summary", { count: team.length, onDuty })}
            {top !== null && <> · <span className="dd-amber dd-strong">{t("doctorDesk.team.holds", { name: top.name, n: top.holds })}</span></>}
          </span>
        </span>
        <span className="dd-fold-word">{open ? t("doctorDesk.hide") : t("doctorDesk.show")}</span>
      </button>
      {open && (
        <div className="dd-fold-body" data-testid="dd-team-rows">
          {team.map((m) => (
            <div key={m.userId} className="dd-mem">
              <span className="dd-strong">{roleText(m, t)}</span>
              <span className="dd-mem-name">{m.name}</span>
              <span className="dd-mem-where"><span className={`dd-mem-dot${m.onDutyUntil !== null ? " dd-mem-dot-on" : ""}`} />{m.onDutyUntil === null ? t("doctorDesk.team.off") : t("doctorDesk.team.on", { at: fmtIst(m.onDutyUntil) })}</span>
              <span className={`dd-mem-holds${m.holds >= 3 ? " dd-amber" : m.holds === 0 ? " ddf-dim" : ""}`}>{m.holds}</span>
            </div>
          ))}
          <div className="dd-note dd-right">{t("doctorDesk.team.legend")}</div>
        </div>
      )}
    </section>
  );
}

function Agents({ tower }: { tower: WireTower }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const runs = tower.agentRuns;
  const failed = runs.filter((r) => r.outcome === "failed").length;
  const summary = runs.length === 0
    ? t("doctorDesk.agents.none")
    : [
      t("doctorDesk.agents.count", { count: runs.length, since: fmtIst(runs[runs.length - 1]!.ranAt) }),
      t("doctorDesk.agents.last", { at: fmtIst(runs[0]!.ranAt) }),
      failed === 0 ? t("doctorDesk.agents.noneFailed") : t("doctorDesk.agents.failed", { count: failed }),
    ].join(" · ");
  return (
    <section className="dd-card" data-testid="dd-agents">
      <button type="button" className="dd-fold" aria-expanded={open} data-testid="dd-agents-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="dd-fold-text">
          <span className="dd-h2">{t("doctorDesk.agents.title")}</span>
          <span className="dd-fold-sub" data-testid="dd-agents-summary">{summary}</span>
        </span>
        {runs.length > 0 && <span className="dd-fold-word">{open ? t("doctorDesk.hide") : t("doctorDesk.show")}</span>}
      </button>
      {open && runs.length > 0 && (
        <div className="dd-fold-body">
          {runs.map((r) => (
            <div key={r.id} className="dd-run">
              <span className="ddf-dim">{fmtIst(r.ranAt)}</span>
              <span className={`dd-run-dot${r.outcome === "failed" ? " dd-run-dot-bad" : ""}`} aria-hidden="true" />
              <span className="dd-run-what"><span className="dd-strong">{t(`doctorDesk.agents.agent.${r.agent}`, { defaultValue: r.agent })}</span><span className="ddf-dim">{t(`doctorDesk.agents.did.${r.summaryKey}`, r.params)}</span></span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
