import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { draftReport, openImages, publishReport, radiologyErrorCode, radiologyErrorText } from "../lib/radiology-api";
import {
  AMEND_REASONS, amendReading, cosignReading, dryRunChecks, fetchCriticalCalls, fetchReadingStudy, fetchReadingWorklist,
  fetchReportPrint, needsSecondFactor, savePrelim, signReading, verifySecondFactor,
} from "../lib/radiology-reading-api";
import type {
  AmendReason, WireCriticalCall, WirePreSignFinding, WireReadingContext, WireReadingRow, WireReadingTemplate,
} from "../lib/radiology-reading-api";
import { useAuth } from "../lib/auth";
import { AcknowledgedLog, CallCard } from "../components/radiology/critical-calls";
import {
  ASPECTS_REGIONS, CODED_CATEGORIES, CODED_SYSTEM_NAMES, TIRADS_COMPOSITION, TIRADS_ECHOGENICITY, TIRADS_FOCI,
  TIRADS_MARGIN, TIRADS_SHAPE, aspectsScore, fleischnerRecommendation, tiradsScore,
} from "../lib/imaging-coded";
import type { CodedSystem, FleischnerInputs, TiradsInputs } from "../lib/imaging-coded";
import { SeatLink } from "../components/radiology/imaging-counter";
import { ImagingReportPrint } from "../components/radiology/imaging-report-print";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS8a T4 — **THE READING ROOM: one urgency-sorted list, and the study in hand.**
 *
 * The board's `read:worklist` and `read:report`, on the station shell and the owner's layout law:
 * the header carries the menu; the LEFT lane holds the study in hand (clinical question, patient
 * flags, priors, cumulative dose); the CENTRE is the report with ONE next act in a pinned dock
 * (Enter); the RIGHT is one list — sorted, never filtered — and "Clocks running" collapsed.
 *
 * ═══ WHAT THIS SCREEN DECIDES: NOTHING THE SERVER DOES NOT ALSO DECIDE ═══
 *
 * · The checks card is the server's DRY RUN of the pipeline the signature meets
 *   (`POST …/reports/checks`), refreshed as the text changes. The screen does not keep a copy of a
 *   rule; a refusal on the card is the refusal Sign would get.
 * · The calculators (TI-RADS points, ASPECTS, Fleischner) run here live — they are the published
 *   tables, held equal to the server's copy by `imaging-coded.test.ts` — and they SUGGEST: the
 *   category signed is the radiologist's choice.
 * · "Dictation" is a plain box and "Structure it" splits it at the section headings the reader
 *   spoke. It is rule-built (no inference before DPIA v0.2) and it fills only EMPTY sections.
 * · The second factor is the session's: when the sign route answers `second_factor_required`, the
 *   dock asks for the authenticator code, `POST /auth/totp/verify` stamps the session, and the
 *   signature is retried. The code never travels with the report.
 *
 * ═══ THE CLAIM IS DERIVED (presence is derived) ═══
 *
 * Opening the images is what the view log records, and the list shows "Dr X is reading" from it.
 * There is no claim button.
 *
 * Keys (outside a text box): ↑ / ↓ the previous / next study in the list, T the template picker,
 * S sign, Enter the dock's act, Esc back to the list.
 *
 * ═══ 18-S RS8b — CO-SIGN, PRELIM, AMEND, AND THE CRITICAL CALLS VIEW ═══
 *
 * · A RESIDENT's Sign is "Sign for co-sign": the server stores `awaiting_cosign` and publishes
 *   nothing; the study shows "Awaiting consultant" at the top of a consultant's list, and the
 *   consultant's dock is "Co-sign and publish" under their own second factor.
 * · "Issue prelim" is offered on STAT and ER (urgent) studies only, and a prelim carries the banner
 *   "PRELIMINARY — final report follows" until it is signed.
 * · A signed report is changed only by "Amend": a reason code, a one-line note, the corrected text,
 *   and the second factor; the server re-publishes it and tells the original recipients.
 * · The header's second view is Critical calls (`?view=criticals`): the open calls with the ladder,
 *   one call in hand with its one next act in the dock, and the last 48 hours' acknowledged log.
 */

export type ReadView = "list" | "criticals";

type SortKey = "priority" | "due" | "modality";
type CodedEntry = { value: string | number; inputs?: unknown };
type Editor = {
  templateKey: string;
  sections: Record<string, string>;
  impression: string;
  coded: Partial<Record<CodedSystem, CodedEntry>>;
  critical: "" | "red" | "orange" | "yellow";
};

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1 };
/** The modality as a department says it — the same in English and Hindi. */
const MODALITY_WORD: Record<string, string> = { xray: "X-ray", usg: "USG", ct: "CT", mri: "MRI", mammography: "Mammography" };
/** 18-S RS8b — the stored amendment reason is always in these words (the record's language), whatever the screen's. */
const AMEND_REASON_WORDS: Record<AmendReason, string> = {
  addendum: "Addendum", laterality: "Correction of laterality", measurement: "Correction of measurement",
  clinical_information: "Clinical information received", other: "Other",
};

function sortRows(rows: readonly WireReadingRow[], by: SortKey, consultant = false): WireReadingRow[] {
  const due = (r: WireReadingRow) => (r.dueAt === null ? Infinity : new Date(r.dueAt).getTime());
  /** 18-S RS8b — a resident's report waiting for co-sign is the consultant's FIRST job; for the resident it is done. */
  const done = (r: WireReadingRow) => (r.acquiredAt === null ? 2 : r.reportState === "awaiting_cosign" ? (consultant ? -1 : 1) : r.reportState === "signed" ? 1 : 0);
  return [...rows].sort((a, b) => done(a) - done(b) || (
    by === "priority" ? (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || due(a) - due(b)
      : by === "due" ? due(a) - due(b)
        : a.modality.localeCompare(b.modality) || due(a) - due(b)
  ));
}

/** "12 min left" / "8 min over" / "3 h 5 min left" — against the class's target. */
function clockText(t: (k: string, o?: Record<string, unknown>) => string, dueAt: string | null, now: number): { text: string; tone: "" | "warn" | "over" } {
  if (dueAt === null) return { text: t("radiology.read.clock.onTable"), tone: "" };
  const ms = new Date(dueAt).getTime() - now;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const span = mins >= 60 ? t("radiology.read.clock.hm", { h: Math.floor(mins / 60), m: mins % 60 }) : t("radiology.read.clock.m", { m: mins });
  return ms < 0 ? { text: t("radiology.read.clock.over", { span }), tone: "over" } : { text: t("radiology.read.clock.left", { span }), tone: ms < 15 * 60_000 ? "warn" : "" };
}

/** Rule-built dictation structuring: "Findings: … Impression: …" → sections. Only EMPTY sections are filled. */
export function structureDictation(raw: string, keys: readonly string[]): Record<string, string> {
  const words: Record<string, string> = {
    technique: "technique", comparison: "comparison", findings: "findings", impression: "impression",
    recommendation: "recommendation|recommendations|advice|suggest(?:ion)?", indication: "indication|clinical (?:history|question)",
  };
  const wanted = keys.filter((k) => words[k] !== undefined);
  const re = new RegExp(`(?:^|\\n|\\.\\s+)\\s*(${wanted.map((k) => words[k]).join("|")})\\s*[:\\-–]\\s*`, "gi");
  const out: Record<string, string> = {};
  const marks: { key: string; at: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const said = m[1]!.toLowerCase();
    const key = wanted.find((k) => new RegExp(`^(?:${words[k]})$`, "i").test(said)) ?? "findings";
    marks.push({ key, at: m.index, end: m.index + m[0].length });
  }
  if (marks.length === 0) {
    if (raw.trim() !== "") out.findings = raw.trim();
    return out;
  }
  const lead = raw.slice(0, marks[0]!.at).trim();
  if (lead !== "") out.findings = lead;
  marks.forEach((mk, i) => {
    const text = raw.slice(mk.end, i + 1 < marks.length ? marks[i + 1]!.at + (raw[marks[i + 1]!.at] === "." ? 1 : 0) : raw.length).trim();
    if (text !== "") out[mk.key] = out[mk.key] === undefined ? text : `${out[mk.key]!} ${text}`;
  });
  return out;
}

export function RadiologyReading({ studyId: initialStudy, view: initialView = "list" }: { studyId: string | null; view?: ReadView }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const qc = useQueryClient();
  const { can } = useAuth();
  const canCalls = can("radiology.criticals.ack");
  /** A consultant holds the amendment; a resident does not — the list's co-sign order follows it. */
  const consultant = can("radiology.reports.amend");
  const [view, setView] = useState<ReadView>(initialView);
  useEffect(() => { setView(initialView); }, [initialView]);
  const [studyId, setStudyId] = useState<string | null>(initialStudy);
  useEffect(() => { setStudyId(initialStudy); }, [initialStudy]);
  const [sort, setSort] = useState<SortKey>("priority");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(id); }, []);

  const listQ = useQuery({ queryKey: ["radiology", "reading", "worklist"], queryFn: fetchReadingWorklist, refetchInterval: 60_000 });
  const rows = useMemo(() => sortRows(listQ.data?.rows ?? [], sort, consultant), [listQ.data, sort, consultant]);
  const callsQ = useQuery({
    queryKey: ["radiology", "reading", "criticals"], queryFn: fetchCriticalCalls, enabled: canCalls, refetchInterval: 30_000,
  });
  const openCalls = callsQ.data?.open ?? [];

  const open = (id: string | null): void => {
    setStudyId(id);
    setView("list");
    if (router !== undefined) void router.navigate({ to: "/radiology/read", search: id === null ? {} : { study: id } } as never);
  };
  const goView = (v: ReadView): void => {
    setView(v);
    if (router !== undefined) void router.navigate({ to: "/radiology/read", search: v === "criticals" ? { view: v } : {} } as never);
  };
  const views = (["list", "criticals"] as const).filter((v) => v === "list" || canCalls).map((v) => (
    <a
      key={v} href={v === "criticals" ? "/radiology/read?view=criticals" : "/radiology/read"} className="st-nv"
      data-testid={`read-view-${v}`} aria-current={v === view ? "page" : undefined}
      onClick={(e) => { e.preventDefault(); goView(v); }}
    >
      {v === "criticals" ? t("radiology.calls.view", { count: openCalls.length }) : t("radiology.read.viewList")}
    </a>
  ));

  const ctxQ = useQuery({
    queryKey: ["radiology", "reading", "study", studyId],
    queryFn: () => fetchReadingStudy(studyId!),
    enabled: studyId !== null,
  });
  const ctx = ctxQ.data?.study ?? null;

  /* ── keys: ↑ ↓ T S Esc (Enter is the dock's, below) ── */
  const pickerRef = useRef<HTMLDivElement>(null);
  const signRef = useRef<(() => void) | null>(null);
  const dockRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      const readable = rows.filter((r) => r.acquiredAt !== null);
      const at = readable.findIndex((r) => r.studyId === studyId);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = readable[e.key === "ArrowDown" ? at + 1 : at <= 0 ? 0 : at - 1];
        if (next !== undefined) { e.preventDefault(); open(next.studyId); }
      } else if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey) {
        pickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && signRef.current !== null) {
        e.preventDefault(); signRef.current();
      } else if (e.key === "Enter" && !["BUTTON", "A"].includes(tag) && dockRef.current !== null) {
        e.preventDefault(); dockRef.current();
      } else if (e.key === "Escape" && studyId !== null) {
        open(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const overdue = rows.filter((r) => r.reportState !== "signed" && r.dueAt !== null && new Date(r.dueAt).getTime() < now);
  const soon = rows.filter((r) => r.reportState !== "signed" && r.dueAt !== null && new Date(r.dueAt).getTime() >= now
    && new Date(r.dueAt).getTime() - now < r.targetMinutes * 60_000 * 0.3);
  const toRead = rows.filter((r) => r.acquiredAt !== null && r.reportState !== "signed");

  const list = (
    <section aria-label={t("radiology.read.listTitle")}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="tag m-0">{t("radiology.read.listTitle")} · {toRead.length}</h2>
        <SortControl value={sort} onChange={setSort} />
      </div>
      <ul className="m-0 list-none space-y-1 p-0" data-testid="reading-list">
        {rows.map((r) => {
          const c = clockText(t, r.dueAt, now);
          const inHand = r.studyId === studyId;
          return (
            <li key={r.studyId} data-acc={r.accessionNo} data-state={r.reportState}>
              <button
                type="button" data-testid={`read-row-${r.studyId}`} aria-current={inHand ? "true" : undefined}
                className={`w-full rounded border bg-card p-2 text-left text-sm ${inHand ? "border-green-700" : ""} ${r.acquiredAt === null || r.reportState === "signed" ? "opacity-60" : ""}`}
                onClick={() => open(r.studyId)}
              >
                <span className="flex justify-between gap-2">
                  <b className="min-w-0 truncate">{r.patientName}</b>
                  <span className={`mo shrink-0 text-xs ${c.tone === "over" ? "font-bold text-red-700" : c.tone === "warn" ? "text-amber-700" : ""}`}>{r.reportState === "signed" ? t("radiology.read.state.signed") : c.text}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                  {t(`radiology.read.tat.${r.tatClass}`)} · {r.studyTypeName}
                  {r.reportState === "draft" || r.reportState === "prelim" || r.reportState === "awaiting_cosign" ? ` · ${t(`radiology.read.state.${r.reportState}`)}` : ""}
                </span>
                {r.readingBy !== null && (
                  <span className="block text-xs text-amber-800" data-testid={`reading-by-${r.studyId}`}>● {t("radiology.read.readingBy", { name: r.readingBy.name })}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 && !listQ.isPending && <p className="text-sm text-muted-foreground">{t("radiology.read.empty")}</p>}
    </section>
  );

  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="reading-clocks">
      {[...overdue, ...soon].map((r) => (
        <li key={r.studyId}>{t("radiology.read.clockLine", { name: r.patientName, study: r.studyTypeName, target: t(`radiology.read.tat.${r.tatClass}`), clock: clockText(t, r.dueAt, now).text })}</li>
      ))}
      {overdue.length + soon.length === 0 && <li className="text-muted-foreground">{t("radiology.read.clocksQuiet")}</li>}
    </ul>
  );

  const stats = [
    { label: t("radiology.read.stat.toRead"), value: toRead.length },
    { label: t("radiology.read.stat.over"), value: overdue.length, tone: "danger" as const },
    { label: t("radiology.station.stat"), value: toRead.filter((r) => r.priority === "stat").length, tone: "danger" as const },
    ...(canCalls ? [{ label: t("radiology.calls.stat"), value: openCalls.length, tone: "danger" as const }] : []),
  ];

  if (view === "criticals" && canCalls) {
    return <CriticalCallsView views={views} calls={openCalls} log={callsQ.data?.acknowledged ?? []} now={now}
      loading={callsQ.isPending} error={callsQ.isError ? radiologyErrorText(callsQ.error) : null} />;
  }

  return (
    <RadiologyStation
      station="read"
      views={views}
      title={ctx === null ? t("radiology.read.title") : `${ctx.patient.name} · ${ctx.studyTypeName}`}
      place={t("radiology.read.place")}
      stats={stats}
      lane={ctx === null ? <p className="mt-4 text-sm text-muted-foreground" data-testid="nobody-in-hand">{t("radiology.read.nobody")}</p> : <StudyLane ctx={ctx} now={now} />}
      list={studyId === null ? undefined : list}
      listSummary={t("radiology.read.listSummary", { count: toRead.length, next: toRead.find((r) => r.studyId !== studyId)?.patientName ?? "—" })}
      inHand={ctx !== null}
      closeListOn={studyId}
      clocks={clocks}
      clocksAlert={overdue.length > 0}
      clocksSummary={overdue.length > 0 ? t("radiology.read.clocksSummary", { count: overdue.length }) : t("radiology.read.clocksNone")}
    >
      {studyId === null
        ? (
          <WorklistCentre rows={rows} now={now} sort={sort} onSort={setSort} onOpen={open} loading={listQ.isPending}
            error={listQ.isError ? radiologyErrorText(listQ.error) : null} summary={{ toRead: toRead.length, over: overdue.length }} />
        )
        : ctxQ.isPending
          ? <p>{t("common.loading")}</p>
          : ctx === null
            ? <p role="alert">{ctxQ.isError ? radiologyErrorText(ctxQ.error) : t("radiology.study.unknown")}</p>
            : (
              <ReportWorkspace
                key={ctx.studyId} ctx={ctx} now={now} pickerRef={pickerRef} signRef={signRef} dockRef={dockRef}
                onNext={() => {
                  const next = rows.find((r) => r.studyId !== ctx.studyId && r.acquiredAt !== null && r.reportState !== "signed");
                  open(next?.studyId ?? null);
                }}
                onChanged={() => {
                  void qc.invalidateQueries({ queryKey: ["radiology", "reading"] });
                }}
              />
            )}
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ 18-S RS8b — the Critical calls view ═══════════════════════════════ */

function CriticalCallsView({ views, calls, log, now, loading, error }: {
  views: React.ReactNode; calls: WireCriticalCall[]; log: WireCriticalCall[]; now: number; loading: boolean; error: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [inHand, setInHand] = useState<string | null>(null);
  const call = calls.find((c) => c.criticalId === inHand) ?? calls[0] ?? null;
  const overdue = calls.filter((c) => c.overdue);
  const rungWord = (c: WireCriticalCall) => t(`radiology.calls.rung.${c.rungs[c.ladderRung]?.key ?? "treating_doctor"}`);
  const list = (
    <section aria-label={t("radiology.calls.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.calls.listTitle")} · {calls.length}</h2>
      <ul className="m-0 list-none space-y-1 p-0" data-testid="calls-list">
        {calls.map((c) => (
          <li key={c.criticalId}>
            <button
              type="button" aria-current={c.criticalId === call?.criticalId ? "true" : undefined} onClick={() => setInHand(c.criticalId)}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${c.criticalId === call?.criticalId ? "border-green-700" : ""}`}
            >
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{c.patientName}</b>
                <span className={`shrink-0 text-xs font-bold ${c.category === "red" ? "text-red-700" : "text-amber-800"}`}>{c.category.toUpperCase()}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {c.studyTypeName} · {rungWord(c)}{c.overdue ? ` · ${t("radiology.calls.overdueShort")}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {calls.length === 0 && !loading && <p className="text-sm text-muted-foreground">{t("radiology.calls.none")}</p>}
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="calls-clocks">
      {overdue.map((c) => <li key={c.criticalId}>{t("radiology.calls.clockLine", { name: c.patientName, cat: c.category.toUpperCase(), rung: rungWord(c) })}</li>)}
      {overdue.length === 0 && <li className="text-muted-foreground">{t("radiology.calls.clocksQuiet")}</li>}
    </ul>
  );
  return (
    <RadiologyStation
      station="read" views={views}
      title={call === null ? t("radiology.calls.title") : `${call.patientName} · ${call.category.toUpperCase()}`}
      place={t("radiology.calls.place")}
      stats={[
        { label: t("radiology.calls.stat"), value: calls.length, tone: "danger" },
        { label: t("radiology.calls.statOverdue"), value: overdue.length, tone: "danger" },
        { label: t("radiology.calls.statClosed"), value: log.length },
      ]}
      lane={call === null
        ? <p className="mt-4 text-sm text-muted-foreground">{t("radiology.calls.nobody")}</p>
        : (
          <div className="mt-4 space-y-2 text-sm" data-testid="call-in-hand">
            <span className="tag">{t("radiology.calls.inHand")}</span>
            <p className="m-0 text-base font-semibold">{call.patientName}</p>
            <p className="m-0 mo text-xs">{call.patientUhid} · {call.accessionNo}</p>
            <p className="m-0 text-xs">{call.studyTypeName}</p>
            <p className="m-0 text-xs">{t("radiology.calls.flaggedAt", { at: new Date(call.flaggedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) })}</p>
            <RouteLink to="/radiology/read" search={{ study: call.studyId }}>{t("radiology.calls.openStudy")}</RouteLink>
          </div>
        )}
      list={list}
      listSummary={t("radiology.calls.listSummary", { count: calls.length })}
      inHand={call !== null}
      closeListOn={inHand}
      clocks={clocks}
      clocksAlert={overdue.length > 0}
      clocksSummary={overdue.length > 0 ? t("radiology.calls.clocksSummary", { count: overdue.length }) : t("radiology.calls.clocksQuiet")}
    >
      <div className="flex min-h-full flex-col gap-3" data-testid="critical-calls">
        {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {loading && <p>{t("common.loading")}</p>}
        {overdue.length > 0 && (
          <p role="alert" className="m-0 rounded border border-red-400 bg-red-50 p-2 text-sm font-semibold text-red-900" data-testid="calls-overdue-banner">
            {t("radiology.calls.overdueBanner", { count: overdue.length })}
          </p>
        )}
        {call !== null
          ? <CallCard key={`${call.criticalId}:${String(call.ladderRung)}`} call={call} now={now} onDone={() => setInHand(null)} />
          : !loading && <p className="text-sm text-muted-foreground">{t("radiology.calls.none")}</p>}
        <AcknowledgedLog calls={log} />
      </div>
    </RadiologyStation>
  );
}

/** A link that carries a search (SeatLink's `to` is a bare path); plain `href` when no router is mounted. */
function RouteLink({ to, search, children }: { to: string; search: Record<string, string>; children: React.ReactNode }): React.ReactElement {
  const router = useRouter({ warn: false });
  return (
    <a
      href={`${to}?${new URLSearchParams(search).toString()}`} className="text-sm font-medium underline underline-offset-2"
      onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to, search } as never); }}
    >
      {children}
    </a>
  );
}

function SortControl({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">{t("radiology.read.sort.label")}</span>
      <select className="rounded border bg-card px-1 py-0.5 text-xs" value={value} onChange={(e) => onChange(e.target.value as SortKey)} data-testid="reading-sort">
        <option value="priority">{t("radiology.read.sort.priority")}</option>
        <option value="due">{t("radiology.read.sort.due")}</option>
        <option value="modality">{t("radiology.read.sort.modality")}</option>
      </select>
    </label>
  );
}

/* ═══════════════════════════════ the worklist (nothing in hand) ═══════════════════════════════ */

function WorklistCentre({ rows, now, sort, onSort, onOpen, loading, error, summary }: {
  rows: WireReadingRow[]; now: number; sort: SortKey; onSort: (v: SortKey) => void; onOpen: (id: string) => void;
  loading: boolean; error: string | null; summary: { toRead: number; over: number };
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="reading-worklist">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm">{t("radiology.read.summary", summary)}</p>
        <SortControl value={sort} onChange={onSort} />
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.read.targets")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {loading && <p>{t("common.loading")}</p>}
      {!loading && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.read.empty")}</p>}
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((r) => {
          const c = clockText(t, r.dueAt, now);
          const dim = r.acquiredAt === null || r.reportState === "signed";
          return (
            <li key={r.studyId} data-acc={r.accessionNo} data-state={r.reportState}>
              <button
                type="button" onClick={() => onOpen(r.studyId)} data-testid={`wl-row-${r.studyId}`}
                className={`grid w-full grid-cols-1 gap-1 rounded border bg-card p-2 text-left text-sm sm:grid-cols-[1fr_1fr_auto] sm:items-center ${r.priority === "stat" && !dim ? "border-red-400" : ""} ${dim ? "opacity-60" : ""}`}
              >
                <span className="min-w-0">
                  <b>{r.patientName}</b> <span className="text-muted-foreground">{r.patientAge ?? "—"}{r.patientSex.slice(0, 1).toUpperCase()}</span>
                  <span className="mo block truncate text-xs text-muted-foreground">{r.accessionNo}</span>
                </span>
                <span className="min-w-0 text-xs">
                  {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : r.priority === "urgent" ? <b className="text-amber-800">{t("radiology.read.urgent")} · </b> : null}
                  {MODALITY_WORD[r.modality] ?? r.modality} · {r.studyTypeName}
                  <span className="block text-muted-foreground">
                    {r.readingBy !== null ? `● ${t("radiology.read.readingBy", { name: r.readingBy.name })}` : r.acquiredAt === null ? t("radiology.read.clock.onTable") : t(`radiology.read.state.${r.reportState}`)}
                  </span>
                </span>
                <span className={`mo text-xs sm:text-right ${c.tone === "over" ? "font-bold text-red-700" : c.tone === "warn" ? "text-amber-700" : ""}`}>
                  {r.reportState === "signed" ? t("radiology.read.state.signed") : c.text}
                  <span className="block text-muted-foreground">{t(`radiology.read.tat.${r.tatClass}`)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ═══════════════════════════════ the lane: the study in hand ═══════════════════════════════ */

function StudyLane({ ctx, now }: { ctx: WireReadingContext; now: number }): React.ReactElement {
  const { t } = useTranslation();
  const c = clockText(t, ctx.dueAt, now);
  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="study-in-hand">
      <div>
        <span className="tag">{t("radiology.read.inHand")}</span>
        <p className="m-0 mt-1 text-base font-semibold">{ctx.patient.name}</p>
        <p className="m-0 mo text-xs">{ctx.patient.uhid} · {ctx.patient.age ?? "—"} · {ctx.patient.sex}</p>
        {ctx.patient.flags.length > 0 && (
          <p className="m-0 mt-1 flex flex-wrap gap-1">
            {ctx.patient.flags.map((f) => <span key={f} className="rounded bg-amber-100 px-1 text-xs text-amber-950">{t(`radiology.read.flag.${f}`)}</span>)}
          </p>
        )}
      </div>
      <div>
        <span className="tag">{t("radiology.read.question")}</span>
        <p className="m-0 mt-1" data-testid="clinical-question">{ctx.clinicalQuestion ?? t("radiology.read.noQuestion")}</p>
        <p className="m-0 text-xs text-muted-foreground">
          {t("radiology.read.referrer", { doctor: ctx.referrer.doctorCode ?? "—", dept: ctx.referrer.department ?? "—" })}
        </p>
      </div>
      <div>
        <span className="tag">{t("radiology.read.thisStudy")}</span>
        <p className="m-0 mt-1 mo text-xs">{ctx.accessionNo}</p>
        <p className="m-0 text-xs">{t(`radiology.read.tat.${ctx.tatClass}`)} · <span className={c.tone === "over" ? "font-bold text-red-700" : ""}>{c.text}</span></p>
        {ctx.laterality !== "na" && <p className="m-0 text-xs">{t("radiology.read.side", { side: t(`radiology.read.sideWord.${ctx.laterality}`, { defaultValue: ctx.laterality }) })}</p>}
        {ctx.bedsideLocation !== null && <p className="m-0 text-xs">{ctx.bedsideLocation}</p>}
      </div>
      <div>
        <span className="tag">{t("radiology.read.priors", { count: ctx.priors.length })}</span>
        {ctx.priors.length === 0
          ? <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.read.noPriors")}</p>
          : (
            <ul className="m-0 mt-1 list-none space-y-1 p-0" data-testid="priors">
              {ctx.priors.map((p) => (
                <li key={p.studyId} className="rounded border bg-card p-1 text-xs">
                  <b>{new Date(p.signedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })} · {p.studyTypeName}</b>
                  <span className="block">{p.impression ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
      {ctx.cumulativeDlp12m !== null && ctx.cumulativeDlp12m > 0 && (
        <div>
          <span className="tag">{t("radiology.read.dose")}</span>
          <p className="m-0 mt-1 mo text-xs">DLP {ctx.cumulativeDlp12m.toFixed(0)} mGy·cm</p>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════ the report workspace ═══════════════════════════════ */

function seedEditor(ctx: WireReadingContext): Editor {
  const tpl = ctx.templates.find((x) => x.key === ctx.defaultTemplateKey) ?? ctx.templates[0]!;
  const sections: Record<string, string> = {};
  const w = ctx.working;
  for (const s of tpl.sections) if (s.key !== "impression") sections[s.key] = "";
  let coded: Editor["coded"] = {};
  if (w !== null) {
    for (const [k, v] of Object.entries(w.body)) if (typeof v === "string") sections[k] = v;
    if (typeof w.body.coded === "object" && w.body.coded !== null) coded = w.body.coded as Editor["coded"];
  }
  const crit = w?.criticalCategory;
  return {
    templateKey: w?.templateKey ?? tpl.key, sections, impression: w?.impression ?? "", coded,
    critical: crit === "red" || crit === "orange" || crit === "yellow" ? crit : "",
  };
}

function bodyOf(ed: Editor): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ed.sections)) if (k !== "impression") body[k] = v;
  if (Object.keys(ed.coded).length > 0) body.coded = ed.coded;
  return body;
}

function ReportWorkspace({ ctx, now, pickerRef, signRef, dockRef, onNext, onChanged }: {
  ctx: WireReadingContext; now: number;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  signRef: React.MutableRefObject<(() => void) | null>;
  dockRef: React.MutableRefObject<(() => void) | null>;
  onNext: () => void; onChanged: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [ed, setEd] = useState<Editor>(() => seedEditor(ctx));
  const [dictation, setDictation] = useState("");
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ asked: boolean; code: string }>({ asked: false, code: "" });
  /** The working draft the server already holds — signing it unchanged appends no new version. */
  const [saved, setSaved] = useState<{ key: string; reportId: string } | null>(() => {
    if (ctx.working === null) return null;
    const seed = seedEditor(ctx);
    return { key: JSON.stringify({ templateKey: seed.templateKey, body: bodyOf(seed), impression: seed.impression, laterality: ctx.laterality }), reportId: ctx.working.reportId };
  });
  const [signedId, setSignedId] = useState<string | null>(ctx.signed?.reportId ?? null);
  const [published, setPublished] = useState<boolean>(ctx.signed?.publishedAt != null);
  const [printing, setPrinting] = useState(false);
  /** 18-S RS8b — co-sign, prelim and amend. */
  const { can } = useAuth();
  const resident = ctx.viewer?.resident === true;
  const canAmend = can("radiology.reports.amend");
  const [awaitingId, setAwaitingId] = useState<string | null>(ctx.awaitingCosign?.reportId ?? null);
  const [prelim, setPrelim] = useState<boolean>(ctx.working?.status === "prelim");
  const signedText = (key: string): string => {
    const v = ctx.signed?.body?.[key];
    return typeof v === "string" ? v : key === "findings" ? ed.sections.findings ?? "" : "";
  };
  const [amend, setAmend] = useState<{ open: boolean; reason: AmendReason; note: string; findings: string; impression: string }>(
    () => ({ open: false, reason: "addendum", note: "", findings: "", impression: "" }),
  );

  const tpl: WireReadingTemplate = ctx.templates.find((x) => x.key === ed.templateKey) ?? ctx.templates[0]!;
  const content = useMemo(() => ({
    templateKey: ed.templateKey, body: bodyOf(ed), impression: ed.impression, laterality: ctx.laterality,
  }), [ed, ctx.laterality]);
  const contentKey = JSON.stringify(content);

  /**
   * ── the server's dry run, debounced ── of the text the next act will sign: the editor's; the
   * resident's signed text while it waits for a co-sign (18-S RS8b); the amendment's while amending.
   */
  const aw = awaitingId !== null && ctx.awaitingCosign?.reportId === awaitingId ? ctx.awaitingCosign : null;
  const amendBody = useMemo(() => ({ ...(ctx.signed?.body ?? bodyOf(ed)), findings: amend.findings }), [ctx.signed, ed, amend.findings]);
  const checkContent = amend.open
    ? { templateKey: ctx.signed?.templateKey ?? ed.templateKey, body: amendBody, impression: amend.impression, critical: ctx.signed?.criticalCategory ?? null }
    : aw !== null
      ? { templateKey: aw.templateKey, body: aw.body, impression: aw.impression ?? "", critical: aw.criticalCategory }
      : { templateKey: content.templateKey, body: content.body, impression: content.impression, critical: ed.critical === "" ? null : ed.critical };
  const checkContentKey = JSON.stringify(checkContent);
  const [checkKey, setCheckKey] = useState(checkContentKey);
  useEffect(() => { const id = window.setTimeout(() => setCheckKey(checkContentKey), 500); return () => window.clearTimeout(id); }, [checkContentKey]);
  const checksQ = useQuery({
    queryKey: ["radiology", "reading", "checks", ctx.studyId, checkKey],
    queryFn: () => dryRunChecks(ctx.studyId, {
      templateKey: checkContent.templateKey, body: checkContent.body, impression: checkContent.impression,
      criticalCategory: checkContent.critical,
    }),
    enabled: (signedId === null && !(resident && awaitingId !== null)) || amend.open,
    placeholderData: (prev) => prev,
  });
  const findings: WirePreSignFinding[] = checksQ.data?.findings ?? [];
  const refusals = findings.filter((f) => f.level === "refuse");
  const warnings = findings.filter((f) => f.level === "warn");
  const unacked = warnings.filter((w) => !acked.has(w.code));

  const saveDraft = async (): Promise<string> => {
    if (saved !== null && saved.key === contentKey) return saved.reportId;
    const r = await draftReport(ctx.studyId, { ...content, impression: content.impression, laterality: ctx.laterality });
    setSaved({ key: contentKey, reportId: r.reportId });
    return r.reportId;
  };

  const save = useMutation({
    mutationFn: saveDraft,
    onSuccess: () => { setError(null); setNote(t("radiology.read.saved")); onChanged(); },
    onError: (e) => setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }),
  });

  const signAndPublish = useMutation({
    mutationFn: async () => {
      if (totp.asked && totp.code.trim() !== "") await verifySecondFactor(totp.code.trim());
      const reportId = await saveDraft();
      const signed = await signReading(ctx.studyId, {
        reportId, criticalCategory: ed.critical === "" ? null : ed.critical, acknowledgedWarnings: [...acked],
      });
      /** 18-S RS8b — a resident's signature waits for a consultant; nothing is published. */
      if (signed.awaitingCosign === true) { setAwaitingId(signed.reportId); return null; }
      setSignedId(signed.reportId);
      const pub = await publishReport(ctx.studyId);
      setPublished(true);
      return pub;
    },
    onSuccess: (pub) => {
      setError(null); setTotp({ asked: false, code: "" });
      setNote(pub === null ? t("radiology.read.signedForCosign")
        : pub.notified ? t("radiology.read.signedPublishedNotified") : t("radiology.read.signedPublished"));
      onChanged();
    },
    onError: (e) => {
      if (needsSecondFactor(e)) { setTotp((p) => ({ asked: true, code: p.asked ? "" : p.code })); setError(null); return; }
      setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) });
      onChanged();
    },
  });

  /** 18-S RS8b — the consultant's co-signature under their own second factor, then the publish. */
  const cosign = useMutation({
    mutationFn: async () => {
      if (totp.asked && totp.code.trim() !== "") await verifySecondFactor(totp.code.trim());
      const c = await cosignReading(ctx.studyId, { reportId: awaitingId!, acknowledgedWarnings: [...acked] });
      setSignedId(c.reportId); setAwaitingId(null);
      const pub = await publishReport(ctx.studyId);
      setPublished(true);
      return pub;
    },
    onSuccess: (pub) => {
      setError(null); setTotp({ asked: false, code: "" });
      setNote(pub.notified ? t("radiology.read.cosignedNotified") : t("radiology.read.cosigned"));
      onChanged();
    },
    onError: (e) => {
      if (needsSecondFactor(e)) { setTotp((p) => ({ asked: true, code: p.asked ? "" : p.code })); setError(null); return; }
      setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) });
      onChanged();
    },
  });

  /** 18-S RS8b — the PRELIM (ER/STAT): what the treating doctor acts on before the final. */
  const issuePrelim = useMutation({
    mutationFn: () => savePrelim(ctx.studyId, { ...content, impression: content.impression, laterality: ctx.laterality }),
    onSuccess: () => { setPrelim(true); setError(null); setNote(t("radiology.read.prelimIssued")); onChanged(); },
    onError: (e) => setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }),
  });

  /** 18-S RS8b — the AMENDMENT: reason code + one-line note + the corrected text, under the second factor. */
  const amendM = useMutation({
    mutationFn: async () => {
      if (totp.asked && totp.code.trim() !== "") await verifySecondFactor(totp.code.trim());
      return await amendReading(ctx.studyId, {
        templateKey: ctx.signed?.templateKey ?? ed.templateKey, body: amendBody, impression: amend.impression,
        laterality: ctx.signed?.laterality ?? ctx.laterality,
        reason: `${AMEND_REASON_WORDS[amend.reason]}: ${amend.note.trim()}`, acknowledgedWarnings: [...acked],
      });
    },
    onSuccess: (r) => {
      setSignedId(r.reportId); setError(null); setTotp({ asked: false, code: "" });
      setAmend((p) => ({ ...p, open: false }));
      setNote(t(published ? "radiology.read.amend.donePublished" : "radiology.read.amend.done", { version: r.version }));
      onChanged();
    },
    onError: (e) => {
      if (needsSecondFactor(e)) { setTotp((p) => ({ asked: true, code: p.asked ? "" : p.code })); setError(null); return; }
      setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) });
    },
  });

  const publish = useMutation({
    mutationFn: () => publishReport(ctx.studyId),
    onSuccess: (pub) => { setPublished(true); setError(null); setNote(pub.notified ? t("radiology.read.signedPublishedNotified") : t("radiology.read.signedPublished")); onChanged(); },
    onError: (e) => setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }),
  });

  const images = useMutation({
    mutationFn: () => openImages(ctx.studyId),
    onSuccess: (r) => { window.open(r.url, "_blank", "noopener"); },
    onError: (e) => setError({ code: radiologyErrorCode(e), text: radiologyErrorText(e) }),
  });

  const printQ = useQuery({
    queryKey: ["radiology", "reading", "print", signedId],
    queryFn: () => fetchReportPrint(signedId!),
    enabled: printing && signedId !== null,
  });

  /* ── the dock: the ONE next act ── */
  let dock: { label: string; hint: string; run: (() => void) | null };
  const factorReady = !totp.asked || totp.code.trim().length >= 6;
  if (amend.open) {
    dock = {
      label: totp.asked ? t("radiology.read.dock.signWithCode") : t("radiology.read.amend.dock"),
      hint: refusals.length > 0 ? refusals.map((r) => r.code).join(" · ")
        : unacked.length > 0 ? t("radiology.read.dock.ackHint", { count: unacked.length }) : t("radiology.read.amend.dockHint"),
      run: amend.note.trim() !== "" && amend.impression.trim() !== "" && refusals.length === 0 && unacked.length === 0 && factorReady && !amendM.isPending
        ? () => amendM.mutate() : null,
    };
  } else if (awaitingId !== null && signedId === null && resident) {
    dock = { label: t("radiology.read.dock.next"), hint: t("radiology.read.dock.awaitingHint"), run: onNext };
  } else if (awaitingId !== null && signedId === null) {
    dock = refusals.length > 0
      ? { label: t("radiology.read.dock.fix"), hint: refusals.map((r) => r.code).join(" · "), run: null }
      : unacked.length > 0
        ? { label: t("radiology.read.dock.ack"), hint: t("radiology.read.dock.ackHint", { count: unacked.length }), run: null }
        : {
          label: totp.asked ? t("radiology.read.dock.signWithCode") : t("radiology.read.dock.cosign"),
          hint: totp.asked ? t("radiology.read.dock.totpHint") : t("radiology.read.dock.cosignHint", { name: ctx.awaitingCosign?.residentName ?? "—" }),
          run: factorReady && !cosign.isPending && !checksQ.isFetching ? () => cosign.mutate() : null,
        };
  } else if (signedId !== null && !published) {
    dock = { label: t("radiology.read.dock.publish"), hint: t("radiology.read.dock.publishHint"), run: publish.isPending ? null : () => publish.mutate() };
  } else if (signedId !== null) {
    dock = { label: t("radiology.read.dock.next"), hint: t("radiology.read.dock.doneHint"), run: onNext };
  } else if (refusals.length > 0) {
    dock = { label: t("radiology.read.dock.fix"), hint: refusals.map((r) => r.code).join(" · "), run: null };
  } else if (unacked.length > 0) {
    dock = { label: t("radiology.read.dock.ack"), hint: t("radiology.read.dock.ackHint", { count: unacked.length }), run: null };
  } else if (totp.asked) {
    dock = {
      label: t("radiology.read.dock.signWithCode"), hint: t("radiology.read.dock.totpHint"),
      run: totp.code.trim().length >= 6 && !signAndPublish.isPending ? () => signAndPublish.mutate() : null,
    };
  } else {
    dock = {
      label: resident ? t("radiology.read.dock.signForCosign") : t("radiology.read.dock.sign"),
      hint: ed.critical !== "" ? t("radiology.read.dock.signCriticalHint", { category: ed.critical.toUpperCase() })
        : resident ? t("radiology.read.dock.signForCosignHint") : t("radiology.read.dock.signHint"),
      run: signAndPublish.isPending || checksQ.isFetching ? null : () => signAndPublish.mutate(),
    };
  }
  dockRef.current = dock.run;
  signRef.current = signedId === null && awaitingId === null && dock.run !== null && refusals.length === 0 && unacked.length === 0 ? () => signAndPublish.mutate() : null;

  const set = (patch: Partial<Editor>): void => { setEd((p) => ({ ...p, ...patch })); setNote(null); };
  const setSection = (key: string, text: string): void => setEd((p) => (key === "impression" ? { ...p, impression: text } : { ...p, sections: { ...p.sections, [key]: text } }));
  const valueOf = (key: string): string => (key === "impression" ? ed.impression : ed.sections[key] ?? "");
  const locked = signedId !== null;
  const waiting = awaitingId !== null && signedId === null;

  const checksCard = (
    <section className="space-y-1 rounded border bg-card p-3" data-testid="checks" aria-label={t("radiology.read.checks")}>
      <h3 className="m-0 flex justify-between text-sm font-semibold">{t("radiology.read.checks")} <span className="text-xs font-normal text-muted-foreground">{t("radiology.read.rulesNotModel")}</span></h3>
      {checksQ.isError && <p className="m-0 text-xs text-red-700">{radiologyErrorText(checksQ.error)}</p>}
      {findings.length === 0 && !checksQ.isError && <p className="m-0 text-sm text-green-800" data-testid="checks-clear">✓ {t("radiology.read.checksClear")}</p>}
      {refusals.map((f) => (
        <p key={f.code} className="m-0 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-check={f.code}>
          ✕ {f.words} <span className="mo text-xs">{f.code}</span>
        </p>
      ))}
      {warnings.map((f) => (
        <label key={f.code} className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950" data-check={f.code}>
          <input
            type="checkbox" className="mt-1" checked={acked.has(f.code)} data-testid={`ack-${f.code}`}
            onChange={(e) => setAcked((p) => { const n = new Set(p); if (e.target.checked) n.add(f.code); else n.delete(f.code); return n; })}
          />
          <span>{f.words} <span className="mo text-xs">{f.code}</span> — {t("radiology.read.ackLabel")}</span>
        </label>
      ))}
    </section>
  );

  return (
    <div className="flex min-h-full flex-col gap-3" data-testid="report-workspace">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="mo text-xs">{ctx.accessionNo}</span>
        {ctx.priority === "stat" && <b className="text-red-700">STAT</b>}
        <span className="text-muted-foreground">
          {signedId !== null ? t(published ? "radiology.read.releasedLine" : "radiology.read.signedLine") : `${t(`radiology.read.tat.${ctx.tatClass}`)} · ${clockText(t, ctx.dueAt, now).text}`}
        </span>
        <span className="flex-1" />
        <button
          type="button" className="rounded border px-3 py-1 text-sm disabled:opacity-50" data-testid="open-images"
          disabled={!ctx.canOpenImages || images.isPending} onClick={() => images.mutate()}
        >
          {t("radiology.read.openImages")}
        </button>
        <SeatLink to={`/radiology/studies/${ctx.studyId}/report`}>{t("radiology.read.classic")}</SeatLink>
      </div>
      {ctx.readingBy !== null && (
        <p className="m-0 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950" data-testid="reading-lock">
          {t("radiology.read.lockLine", { name: ctx.readingBy.name })}
        </p>
      )}
      {error !== null && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-refusal={error.code ?? "unknown"}>
          <p className="m-0">{error.text}</p>
          {error.code === "signer_credentials_missing" && <p className="m-0 mt-1"><RouteLink to="/radiology/setup" search={{ view: "books" }}>{t("radiology.read.fixSignatories")}</RouteLink></p>}
          {error.code === "sex_organ_mismatch" && <p className="m-0 mt-1"><SeatLink to={`/patients/${ctx.patient.id}`}>{t("radiology.read.fixPatient")}</SeatLink></p>}
        </div>
      )}
      {note !== null && <p role="status" className="m-0 text-sm text-green-800">{note}</p>}
      {prelim && !locked && !waiting && (
        <p className="m-0 rounded border-2 border-amber-500 bg-amber-50 p-2 text-center text-sm font-bold tracking-wide text-amber-950" data-testid="prelim-banner">
          {t("radiology.read.prelimBanner")}
        </p>
      )}

      {waiting
        ? (
          <section className="space-y-2 rounded border bg-card p-3 text-sm" data-testid="cosign-view">
            <p className="m-0 rounded border border-amber-400 bg-amber-50 p-2 font-semibold text-amber-950" data-testid="awaiting-cosign">
              {resident ? t("radiology.read.awaitingMine") : t("radiology.read.awaitingConsultant", { name: ctx.awaitingCosign?.residentName ?? "—" })}
            </p>
            {aw !== null && (
              <>
                {Object.entries(aw.body).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "").map(([k, v]) => (
                  <p key={k} className="m-0"><b>{t(`radiology.read.section.${k}`, { defaultValue: k })}:</b> {v}</p>
                ))}
                <p className="m-0"><b>{t("radiology.read.section.impression", { defaultValue: "Impression" })}:</b> {aw.impression ?? "—"}</p>
                {aw.criticalCategory !== null && <p className="m-0 text-red-800">{t(`radiology.read.cat.${aw.criticalCategory}`)}</p>}
              </>
            )}
            {!resident && checksCard}
          </section>
        )
        : locked
        ? (
          <section className="space-y-2 rounded border bg-card p-3" data-testid="signed-view">
            <p className="m-0 text-sm font-semibold">{published ? t("radiology.read.releasedLine") : t("radiology.read.signedLine")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => setPrinting((p) => !p)} data-testid="print-toggle">
                {printing ? t("radiology.read.hidePrint") : t("radiology.read.printPreview")}
              </button>
              {canAmend && !amend.open && (
                <button
                  type="button" className="rounded border px-3 py-1 text-sm" data-testid="amend-open"
                  onClick={() => { setAcked(new Set()); setAmend({ open: true, reason: "addendum", note: "", findings: signedText("findings"), impression: ctx.signed?.impression ?? ed.impression }); }}
                >
                  {t("radiology.read.amend.open")}
                </button>
              )}
            </div>
            {amend.open && (
              <div className="space-y-2 rounded border border-amber-400 p-3" data-testid="amend-panel">
                <h3 className="m-0 text-sm font-semibold">{t("radiology.read.amend.title")}</h3>
                <label className="flex flex-col gap-1 text-xs">
                  {t("radiology.read.amend.reason")}
                  <select className="rounded border bg-card px-2 py-1 text-sm" value={amend.reason} data-testid="amend-reason"
                    onChange={(e) => setAmend((p) => ({ ...p, reason: e.target.value as AmendReason }))}>
                    {AMEND_REASONS.map((r) => <option key={r} value={r}>{t(`radiology.read.amend.reasons.${r}`)}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("radiology.read.amend.note")}
                  <input className="rounded border px-2 py-1 text-sm" maxLength={300} value={amend.note} data-testid="amend-note"
                    placeholder={t("radiology.read.amend.notePlaceholder")} onChange={(e) => setAmend((p) => ({ ...p, note: e.target.value }))} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("radiology.read.section.findings", { defaultValue: "Findings" })}
                  <textarea className="rounded border px-2 py-1 text-sm" rows={4} value={amend.findings} data-testid="amend-findings"
                    onChange={(e) => setAmend((p) => ({ ...p, findings: e.target.value }))} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("radiology.read.section.impression", { defaultValue: "Impression" })}
                  <textarea className="rounded border px-2 py-1 text-sm" rows={2} value={amend.impression} data-testid="amend-impression"
                    onChange={(e) => setAmend((p) => ({ ...p, impression: e.target.value }))} />
                </label>
                <p className="m-0 text-xs text-muted-foreground">{t(published ? "radiology.read.amend.notifyPublished" : "radiology.read.amend.notifyUnpublished")}</p>
                {checksCard}
                <button type="button" className="rounded border px-3 py-1 text-xs" onClick={() => { setAmend((p) => ({ ...p, open: false })); setTotp({ asked: false, code: "" }); }}>
                  {t("radiology.read.amend.cancel")}
                </button>
              </div>
            )}
            {printing && printQ.data?.report != null && (
              <>
                <ImagingReportPrint report={printQ.data.report} />
                <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => window.print()}>{t("radiology.read.printNow")}</button>
              </>
            )}
          </section>
        )
        : (
          <>
            <section aria-label={t("radiology.read.templates")} className="space-y-2">
              <div ref={pickerRef} className="flex flex-wrap gap-1" role="group" aria-label={t("radiology.read.templates")} data-testid="template-picker">
                {ctx.templates.map((x) => (
                  <button
                    key={x.key} type="button" aria-pressed={x.key === ed.templateKey}
                    className={`rounded border px-2 py-1 text-xs ${x.key === ed.templateKey ? "border-green-700 bg-green-50 font-semibold" : "bg-card"}`}
                    onClick={() => set({ templateKey: x.key })}
                  >
                    {x.name}{x.governed ? "" : ` · ${t("radiology.read.builtIn")}`}
                  </button>
                ))}
              </div>
              {tpl.sections.some((s) => s.normal !== null) && (
                <button
                  type="button" className="rounded border px-2 py-1 text-xs" data-testid="insert-normal"
                  onClick={() => {
                    for (const s of tpl.sections) if (s.normal !== null && valueOf(s.key).trim() === "") setSection(s.key, s.normal);
                  }}
                >
                  {t("radiology.read.insertNormal", { name: tpl.name })}
                </button>
              )}
            </section>

            <details className="rounded border bg-card p-2 text-sm">
              <summary className="cursor-pointer">{t("radiology.read.dictation")}</summary>
              <textarea
                className="mt-2 w-full rounded border px-2 py-1 text-sm" rows={3} value={dictation} aria-label={t("radiology.read.dictation")}
                onChange={(e) => setDictation(e.target.value)} placeholder={t("radiology.read.dictationHint")}
              />
              <button
                type="button" className="mt-1 rounded border px-2 py-1 text-xs" data-testid="structure-dictation"
                onClick={() => {
                  const parts = structureDictation(dictation, [...tpl.sections.map((s) => s.key)]);
                  for (const [k, v] of Object.entries(parts)) if (valueOf(k).trim() === "") setSection(k, v);
                  setNote(t("radiology.read.structured"));
                }}
              >
                {t("radiology.read.structure")}
              </button>
            </details>

            {tpl.sections.map((s) => (
              <label key={s.key} className="flex flex-col gap-1 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <b>{t(`radiology.read.section.${s.key}`, { defaultValue: s.label })}</b>
                  {tpl.macros.filter((m) => m.section === s.key).length > 0 && (
                    <select
                      className="rounded border bg-card px-1 text-xs" value="" aria-label={t("radiology.read.macro")}
                      onChange={(e) => {
                        const m = tpl.macros.find((x) => x.key === e.target.value);
                        if (m !== undefined) setSection(s.key, valueOf(s.key).trim() === "" ? m.text : `${valueOf(s.key)} ${m.text}`);
                      }}
                    >
                      <option value="">{t("radiology.read.macro")}</option>
                      {tpl.macros.filter((m) => m.section === s.key).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  )}
                </span>
                <textarea
                  className="rounded border px-2 py-1" rows={s.key === "findings" ? 6 : s.key === "impression" ? 3 : 2}
                  value={valueOf(s.key)} onChange={(e) => setSection(s.key, e.target.value)} data-testid={`section-${s.key}`}
                />
              </label>
            ))}

            {tpl.coded.map((c) => (
              <CodedWidget key={c.system} system={c.system} required={c.required} entry={ed.coded[c.system]}
                onChange={(entry) => setEd((p) => {
                  const coded = { ...p.coded };
                  if (entry === null) delete coded[c.system]; else coded[c.system] = entry;
                  return { ...p, coded };
                })}
                onRecommend={(text) => setSection("recommendation", valueOf("recommendation").trim() === "" ? text : `${valueOf("recommendation")} ${text}`)}
              />
            ))}

            <label className="flex flex-wrap items-center gap-2 text-sm">
              <b>{t("radiology.read.critical")}</b>
              <select className="rounded border bg-card px-2 py-1" value={ed.critical} data-testid="critical"
                onChange={(e) => set({ critical: e.target.value as Editor["critical"] })}>
                <option value="">{t("radiology.read.notCritical")}</option>
                <option value="red">{t("radiology.read.cat.red")}</option>
                <option value="orange">{t("radiology.read.cat.orange")}</option>
                <option value="yellow">{t("radiology.read.cat.yellow")}</option>
              </select>
            </label>

            {checksCard}

            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid="save-draft">
                {t("radiology.read.saveDraft")}
              </button>
              {ctx.prelimAllowed === true && (
                <button
                  type="button" className="rounded border border-amber-600 px-3 py-1 text-sm disabled:opacity-50" data-testid="issue-prelim"
                  disabled={issuePrelim.isPending || refusals.length > 0} onClick={() => issuePrelim.mutate()} title={t("radiology.read.prelimHint")}
                >
                  {t("radiology.read.issuePrelim")}
                </button>
              )}
            </div>
          </>
        )}

      <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="reading-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
        {totp.asked && (signedId === null || amend.open) && (
          <label className="flex items-center gap-1 text-xs">
            {t("radiology.read.totpLabel")}
            <input
              className="mo w-24 rounded border px-2 py-1 text-sm" inputMode="numeric" autoComplete="one-time-code" data-testid="totp"
              value={totp.code} onChange={(e) => setTotp({ asked: true, code: e.target.value.replace(/\D/g, "").slice(0, 6) })}
            />
          </label>
        )}
        <button
          type="button" data-testid="dock-act"
          className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={dock.run === null} onClick={() => dock.run?.()}
        >
          {dock.label} <span className="kb">{signedId === null && awaitingId === null ? "S" : "Enter"}</span>
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════ the coded widgets ═══════════════════════════════ */

function CodedWidget({ system, required, entry, onChange, onRecommend }: {
  system: CodedSystem; required: boolean; entry: CodedEntry | undefined;
  onChange: (e: CodedEntry | null) => void; onRecommend: (text: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const name = CODED_SYSTEM_NAMES[system];
  return (
    <section className="space-y-2 rounded border bg-card p-3 text-sm" data-testid={`coded-${system}`}>
      <h3 className="m-0 text-sm font-semibold">{name}{required ? ` · ${t("radiology.read.required")}` : ""}</h3>
      {system === "aspects" && <AspectsWidget entry={entry} onChange={onChange} />}
      {system === "fleischner" && <FleischnerWidget entry={entry} onChange={onChange} onRecommend={onRecommend} />}
      {system === "tirads" && <TiradsWidget entry={entry} onChange={onChange} />}
      {system !== "aspects" && system !== "fleischner" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={name}>
          {CODED_CATEGORIES[system].map((c) => (
            <button
              key={c.value} type="button" aria-pressed={entry?.value === c.value} title={c.label}
              className={`rounded border px-2 py-1 text-xs ${entry?.value === c.value ? "border-green-700 bg-green-50 font-semibold" : "bg-card"}`}
              onClick={() => onChange(entry?.value === c.value ? null : { value: c.value, inputs: entry?.inputs })}
            >
              <b>{c.value}</b> <span className="hidden sm:inline">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function AspectsWidget({ entry, onChange }: { entry: CodedEntry | undefined; onChange: (e: CodedEntry) => void }): React.ReactElement {
  const { t } = useTranslation();
  const affected = ((entry?.inputs as { affected?: string[] } | undefined)?.affected) ?? [];
  const score = aspectsScore(affected);
  const toggle = (r: string): void => {
    const next = affected.includes(r) ? affected.filter((x) => x !== r) : [...affected, r];
    onChange({ value: aspectsScore(next), inputs: { affected: next } });
  };
  return (
    <div className="space-y-1">
      <p className="m-0"><b className="mo text-lg" data-testid="aspects-score">{score}</b> / 10 · {t("radiology.read.aspectsHint")}</p>
      <div className="flex flex-wrap gap-1">
        {ASPECTS_REGIONS.map((r) => (
          <button key={r} type="button" aria-pressed={affected.includes(r)} onClick={() => toggle(r)}
            className={`mo rounded border px-2 py-1 text-xs ${affected.includes(r) ? "border-red-600 bg-red-50 font-semibold" : "bg-card"}`}>{r}</button>
        ))}
      </div>
    </div>
  );
}

const TIRADS_DEFAULT: TiradsInputs = { composition: "solid", echogenicity: "hyper_iso", shape: "wider_than_tall", margin: "smooth", foci: [], sizeCm: null };

function TiradsWidget({ entry, onChange }: { entry: CodedEntry | undefined; onChange: (e: CodedEntry | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [inp, setInp] = useState<TiradsInputs>(() => ({ ...TIRADS_DEFAULT, ...(entry?.inputs as Partial<TiradsInputs> | undefined) }));
  const r = tiradsScore(inp);
  const pick = <K extends keyof TiradsInputs>(k: K, options: Record<string, number>) => (
    <label className="flex flex-col text-xs">
      {t(`radiology.read.tirads.${String(k)}`)}
      <select className="rounded border bg-card px-1 py-0.5" value={String(inp[k])} onChange={(e) => setInp((p) => ({ ...p, [k]: e.target.value }))}>
        {Object.entries(options).map(([o, pts]) => <option key={o} value={o}>{t(`radiology.read.tirads.opt.${o}`)} ({pts})</option>)}
      </select>
    </label>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pick("composition", TIRADS_COMPOSITION)}
        {pick("echogenicity", TIRADS_ECHOGENICITY)}
        {pick("shape", TIRADS_SHAPE)}
        {pick("margin", TIRADS_MARGIN)}
      </div>
      <fieldset className="flex flex-wrap gap-2 text-xs">
        <legend>{t("radiology.read.tirads.foci")}</legend>
        {(Object.keys(TIRADS_FOCI) as (keyof typeof TIRADS_FOCI)[]).filter((f) => f !== "none").map((f) => (
          <label key={f} className="flex items-center gap-1">
            <input type="checkbox" checked={inp.foci.includes(f)} onChange={() => setInp((p) => ({ ...p, foci: p.foci.includes(f) ? p.foci.filter((x) => x !== f) : [...p.foci, f] }))} />
            {t(`radiology.read.tirads.opt.${f}`)} ({TIRADS_FOCI[f]})
          </label>
        ))}
        <label className="flex items-center gap-1">
          {t("radiology.read.tirads.size")}
          <input className="w-16 rounded border px-1" inputMode="decimal" value={inp.sizeCm ?? ""}
            onChange={(e) => setInp((p) => ({ ...p, sizeCm: e.target.value === "" ? null : Number(e.target.value) }))} />
        </label>
      </fieldset>
      <p className="m-0" data-testid="tirads-result">
        <b>{t("radiology.read.tirads.result", { points: r.points, level: r.level })}</b>
        {r.advice !== null && ` · ${t(`radiology.read.tirads.advice.${r.advice}`)}`}
      </p>
      <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => onChange({ value: r.level, inputs: inp })} data-testid="tirads-use">
        {t("radiology.read.useCategory", { value: r.level })}
      </button>
      {entry !== undefined && <p className="m-0 text-xs">{t("radiology.read.chosen", { value: String(entry.value) })}</p>}
    </div>
  );
}

function FleischnerWidget({ entry, onChange, onRecommend }: {
  entry: CodedEntry | undefined; onChange: (e: CodedEntry | null) => void; onRecommend: (text: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [inp, setInp] = useState<FleischnerInputs>(() => ({ type: "solid", count: "single", sizeMm: 6, risk: "low", solidComponentMm: null, ...(entry?.inputs as Partial<FleischnerInputs> | undefined) }));
  const r = fleischnerRecommendation(inp);
  return (
    <div className="space-y-2 text-xs">
      <p className="m-0 text-muted-foreground">{t("radiology.read.fleischner.scope")}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col">{t("radiology.read.fleischner.type")}
          <select className="rounded border bg-card px-1" value={inp.type} onChange={(e) => setInp((p) => ({ ...p, type: e.target.value as FleischnerInputs["type"] }))}>
            {(["solid", "ground_glass", "part_solid"] as const).map((o) => <option key={o} value={o}>{t(`radiology.read.fleischner.${o}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col">{t("radiology.read.fleischner.count")}
          <select className="rounded border bg-card px-1" value={inp.count} onChange={(e) => setInp((p) => ({ ...p, count: e.target.value as FleischnerInputs["count"] }))}>
            {(["single", "multiple"] as const).map((o) => <option key={o} value={o}>{t(`radiology.read.fleischner.${o}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col">{t("radiology.read.fleischner.size")}
          <input className="rounded border px-1" inputMode="decimal" value={inp.sizeMm} onChange={(e) => setInp((p) => ({ ...p, sizeMm: Number(e.target.value) || 0 }))} />
        </label>
        <label className="flex flex-col">{t("radiology.read.fleischner.risk")}
          <select className="rounded border bg-card px-1" value={inp.risk} onChange={(e) => setInp((p) => ({ ...p, risk: e.target.value as FleischnerInputs["risk"] }))}>
            {(["low", "high"] as const).map((o) => <option key={o} value={o}>{t(`radiology.read.fleischner.${o}`)}</option>)}
          </select>
        </label>
      </div>
      <p className="m-0 text-sm" data-testid="fleischner-result"><b>{r.recommendation}</b></p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-2 py-1" onClick={() => onChange({ value: r.recommendation, inputs: inp })}>{t("radiology.read.fleischner.use")}</button>
        <button type="button" className="rounded border px-2 py-1" onClick={() => onRecommend(r.recommendation)}>{t("radiology.read.fleischner.toRecommendation")}</button>
      </div>
    </div>
  );
}
