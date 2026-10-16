import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { useAuth } from "../lib/auth";
import { deskErrorText, fetchBriefs, fetchTower, markBriefSeen } from "../lib/doctor-desk-api";
import type { WireBrief } from "../lib/doctor-desk-api";
import { factText, patientName, whenText } from "./doctor-desk-tower";
import "./doctor-desk.css";

/**
 * ═══ DD-0.7 (#626) — AI BRIEFS (`docs/design/2026-09-18-doctor-desk/AiBriefs.dc.html`) ═══
 *
 * Every brief the desk prepared for this doctor, newest first; nothing is deleted (D12). The list on
 * the left with the board's filters, the chosen brief on the right with each line opening the record
 * it came from, and Print. Opening a brief here counts as seeing it (the menu's count goes down).
 *
 * DECIDED (plan D-B): the filters show only kinds this hospital builds — All and Login briefs in DD-0.
 * Morning briefs arrive with DD-report, round briefs with DD-IPD; their filters appear then.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const FILTERS = ["all", "login"] as const;

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function titleOf(b: WireBrief, today: string, lang: string, t: T): string {
  return t(`doctorDesk.briefs.title.${b.kind}`, { at: whenText(b.windowFrom, today, lang) });
}
function lineOf(b: WireBrief, t: T): string {
  return b.facts.length === 0 ? t("doctorDesk.brief.quiet") : b.facts.slice(0, 3).map((f) => factText(f, t)).join(" · ");
}

export function DoctorDeskBriefs(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { username } = useAuth();
  const router = useRouter({ warn: false });
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["doctor-desk", "briefs"], queryFn: fetchBriefs });
  // The header's name and grade, and the context line, come from the Tower read (cached when the doctor came from it).
  const tw = useQuery({ queryKey: ["doctor-desk", "tower"], queryFn: fetchTower });
  const you = tw.data?.you;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const seen = useMutation({ mutationFn: (id: string) => markBriefSeen(id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["doctor-desk"] }); } });
  const today = istToday();
  const list = (q.data?.briefs ?? []).filter((b) => filter === "all" || b.kind === filter);
  const sel = list.find((b) => b.id === picked) ?? list[0] ?? null;
  useEffect(() => {
    if (sel !== null && sel.seenAt === null && sel.stage === "archived" && !seen.isPending) seen.mutate(sel.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per opened brief
  }, [sel?.id]);
  const go = (e: React.MouseEvent, to: string): void => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to }); };

  return (
    <DoctorDeskFrame
      active="aiBriefs" testId="doctor-desk-briefs" context={t("doctorDesk.briefs.context")}
      who={you === undefined ? (tw.isError ? { name: username ?? "", role: null } : undefined) : { name: you.name || (username ?? ""), role: you.grade === null ? null : t(`doctorDesk.grade.${you.grade}`, { defaultValue: you.grade }) }}
      ask={<AskBar id="ask-briefs" placeholder={t("doctorDesk.briefs.askPlaceholder")} fallback={() => null} terms={() => []} />}
    >
      {q.isPending && <p className="ddf-dim">{t("doctorDesk.loading")}</p>}
      {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
      {q.data !== undefined && (
        <div className="dd-briefs">
          <section className="dd-briefs-list" data-testid="dd-briefs-list">
            <div>
              <h1 className="dd-h1">{t("doctorDesk.briefs.h1")}</h1>
              <span className="dd-note">{t("doctorDesk.briefs.lede")}</span>
            </div>
            <div className="dd-filters">
              {FILTERS.map((f) => (
                <button key={f} type="button" className={`dd-tab${filter === f ? " dd-tab-on" : ""}`} aria-pressed={filter === f} data-testid={`dd-filter-${f}`} onClick={() => { setFilter(f); setPicked(null); }}>
                  {t(`doctorDesk.briefs.filter.${f}`)}
                </button>
              ))}
            </div>
            {list.length === 0 && <div className="dd-empty" data-testid="dd-briefs-empty">{t("doctorDesk.briefs.none")}</div>}
            {list.map((b) => (
              <button key={b.id} type="button" className="dd-brief-row" aria-current={sel?.id === b.id} data-testid={`dd-brief-${b.id}`} onClick={() => setPicked(b.id)}>
                <span className="dd-brief-rowhead">
                  <span className="dd-brief-kind">{t(`doctorDesk.briefs.kind.${b.kind}`)}</span>
                  <span className="dd-brief-when">{whenText(b.createdAt, today, lang)}</span>
                </span>
                <span className="dd-brief-title">{titleOf(b, today, lang, t)}</span>
                <span className="dd-brief-line">{lineOf(b, t)}</span>
              </button>
            ))}
          </section>
          {sel !== null && (
            <section className="dd-brief-sel" data-testid="dd-brief-selected">
              <div className="dd-brief-rowhead">
                <span className="dd-brief-kind">{t(`doctorDesk.briefs.kind.${sel.kind}`)}</span>
                <span className="dd-brief-when">{whenText(sel.createdAt, today, lang)}</span>
              </div>
              <h2 className="dd-h2">{titleOf(sel, today, lang, t)}</h2>
              <div className="dd-note">{t("doctorDesk.briefs.window", { from: whenText(sel.windowFrom, today, lang), to: whenText(sel.windowTo, today, lang) })}</div>
              {sel.shownAt !== null && (
                <div className="dd-note" data-testid="dd-brief-moved">
                  {t("doctorDesk.briefs.moved", { at: whenText(sel.shownAt, today, lang), till: whenText(new Date(Date.parse(sel.shownAt) + 60 * 60_000).toISOString(), today, lang) })}
                </div>
              )}
              <div className="dd-brief-items">
                {sel.facts.length === 0 && <div className="dd-empty">{t("doctorDesk.brief.quiet")}</div>}
                {sel.facts.map((f, i) => {
                  const body = (
                    <>
                      <span className="dd-strong">{f.patient === null ? t("doctorDesk.briefs.countLine") : patientName(f.patient, t)}</span>
                      <span>{f.patient === null ? factText(f, t) : factText(f, t).replace(`${patientName(f.patient, t)}: `, "")}</span>
                      <span className="dd-brief-src">{f.source === null ? "" : t(`doctorDesk.source.${f.source.module}`)}</span>
                    </>
                  );
                  return f.href === null
                    ? <div key={i} className="dd-brief-item">{body}</div>
                    : <a key={i} href={f.href} className="dd-brief-item" data-testid={`dd-fact-${String(i)}`} onClick={(e) => go(e, f.href!)}>{body}</a>;
                })}
              </div>
              <div className="dd-note">{t("doctorDesk.briefs.sources")}</div>
              <div className="dd-brief-foot">
                <a href="/doctor-desk" className="dd-link" onClick={(e) => go(e, "/doctor-desk")}>{t("doctorDesk.briefs.back")}</a>
                <button type="button" className="ddf-btn" data-testid="dd-brief-print" onClick={() => window.print()}>{t("doctorDesk.briefs.print")}</button>
              </div>
            </section>
          )}
        </div>
      )}
    </DoctorDeskFrame>
  );
}
