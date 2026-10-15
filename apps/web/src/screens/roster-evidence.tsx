import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { DmyDateInput } from "../components/dmy-date-input";
import { useAuth } from "../lib/auth";
import { todayIst } from "../lib/opd-api";
import {
  fetchDutyEvidence, fetchEvidencePeople, printDutyEvidence, rosterErrorText,
} from "../lib/roster-api";
import type { WireDutyEvidence } from "../lib/roster-api";
import { shortUnit, whoFrom } from "./roster-on-now";
import "./roster.css";

/**
 * ═══ 20-U U8 — THE DUTY-EVIDENCE REPORT (owner ruling RU-3) ═══
 *
 * A head of department (or the medical superintendent) picks people and days, reads the sheet, and
 * prints it on the office's A4 — the paper a faculty member attaches to an AEBAS regularisation
 * request. Built inside the Doctor Desk frame: the picker and the sheet in the centre, what the sheet
 * is and which records it read on the rail.
 *
 * **The preview IS the sheet.** The server renders the same HTML the print relay will print
 * (`renderEvidenceHtml`) and the screen shows it in a sandboxed frame scaled to the column, so what
 * a person reads before pressing Print is what comes off the printer — no second layout to drift.
 * Printing is server-side (owner ruling 2026-09-04): no browser print dialog anywhere.
 *
 * The sheet states facts and draws no conclusion; the screen's own words follow the same rule.
 */

const MAX_PEOPLE = 12;
const MAX_DAYS = 31;
const A4_PX = { w: 794, h: 1123 };

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;
const daySpan = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function rangeOk(from: string, to: string): boolean {
  return isDay(from) && isDay(to) && to >= from && daySpan(from, to) <= MAX_DAYS;
}

/**
 * The sheet, scaled to the width it is given; the page's own height follows its content. Never below
 * MIN_SCALE: on a phone a whole A4 at 390 px is unreadable, so the sheet stays legible and the box
 * scrolls sideways instead (measured at 390 px, 2026-10-04).
 */
const MIN_SCALE = 0.62;
function SheetFrame({ html, title }: { html: string; title: string }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(A4_PX.h);
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const fit = (): void => setScale(Math.max(MIN_SCALE, Math.min(1, el.clientWidth / A4_PX.w)));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);
  const measure = (): void => {
    const doc = frame.current?.contentDocument;
    if (doc?.body !== undefined && doc.body !== null) setHeight(Math.max(A4_PX.h, doc.documentElement.scrollHeight));
  };
  return (
    <div className="ev-sheet-box" ref={box}>
      <div className="ev-sheet-size" style={{ width: `${String(Math.ceil(A4_PX.w * scale))}px`, height: `${String(Math.ceil(height * scale))}px` }}>
      <iframe
        ref={frame} className="ev-sheet" title={title} srcDoc={html} sandbox="allow-same-origin" onLoad={measure}
        style={{ width: `${String(A4_PX.w)}px`, height: `${String(height)}px`, transform: `scale(${String(scale)})` }}
        data-testid="evidence-sheet"
      />
      </div>
    </div>
  );
}

export function RosterEvidence(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const today = todayIst();
  const people = useQuery({ queryKey: ["roster", "evidence", "people"], queryFn: fetchEvidencePeople });
  const depts = useMemo(() => people.data?.departments ?? [], [people.data]);
  const [deptId, setDeptId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const lastMonthStart = monthStart(addDays(monthStart(today), -1));
  const [from, setFrom] = useState(lastMonthStart);
  const [to, setTo] = useState(addDays(monthStart(today), -1));
  const [asked, setAsked] = useState<null | { userIds: string[]; from: string; to: string }>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (deptId === "" && depts.length > 0) setDeptId(depts[0]!.departmentId);
  }, [deptId, depts]);
  const dept = depts.find((d) => d.departmentId === deptId);
  const nameOf = useMemo(() => new Map(depts.flatMap((d) => d.people.map((p) => [p.userId, p.name] as const))), [depts]);
  const shown = (dept?.people ?? []).filter((p) => query.trim() === "" || p.name.toLowerCase().includes(query.trim().toLowerCase()));

  const sheet = useQuery({
    queryKey: ["roster", "evidence", asked],
    queryFn: () => fetchDutyEvidence(asked!.userIds, asked!.from, asked!.to),
    enabled: asked !== null,
  });
  const print = useMutation({ mutationFn: () => printDutyEvidence(asked!.userIds, asked!.from, asked!.to) });

  const toggle = (id: string): void => {
    setProblem(null);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_PEOPLE ? c : [...c, id]));
  };
  const show = (): void => {
    if (chosen.length === 0) { setProblem(t("rosterEvidence.pickSomeone")); return; }
    if (!rangeOk(from, to)) { setProblem(t("rosterEvidence.badRange")); return; }
    setProblem(null);
    print.reset();
    setAsked({ userIds: [...chosen], from, to });
  };
  const report: WireDutyEvidence | undefined = sheet.data?.report;

  const rail = (
    <>
      <section className="ddf-card ro-rail-card" data-testid="evidence-rule">
        <h2 className="ro-rail-h">{t("rosterEvidence.ruleTitle")}</h2>
        <p className="ro-rail-p">{t("rosterEvidence.rule1")}</p>
        <p className="ro-rail-p">{t("rosterEvidence.rule2")}</p>
        <p className="ro-rail-p">{t("rosterEvidence.rule3")}</p>
      </section>
      <section className="ddf-card ro-rail-card" data-testid="evidence-sources">
        <h2 className="ro-rail-h">{t("rosterEvidence.sourcesTitle")}</h2>
        <ul className="ev-sources">
          {(report?.sources ?? ["roster", "leave", "holidays", "theatre"]).map((s) => (
            <li key={s}>{t(`rosterEvidence.source.${s}`, { defaultValue: s })}</li>
          ))}
        </ul>
        <p className="ro-rail-p ddf-dim">{t("rosterEvidence.sourcesLater")}</p>
      </section>
    </>
  );

  return (
    <DoctorDeskFrame
      active="evidence" testId="roster-evidence"
      context={t("rosterEvidence.context")}
      who={whoFrom(people.data?.you, username, t)}
      rail={rail}
      ask={<AskBar id="evidence-ask" placeholder={t("rosterEvidence.ask")} fallback={() => null} terms={() => [...nameOf.values()]} />}
    >
      <div className="ro-title">
        <div className="ro-title-text">
          <h1 className="ddf-h1">{t("rosterEvidence.title")}</h1>
          <span className="ddf-dim ev-intro">{t("rosterEvidence.intro")}</span>
        </div>
      </div>

      {people.isPending && <p className="ddf-dim">{t("rosterEvidence.loading")}</p>}
      {people.isError && <p role="alert" className="ro-alert">{rosterErrorText(people.error, t)}</p>}
      {people.isSuccess && depts.length === 0 && <p className="ro-note-amber" data-testid="evidence-none">{t("rosterEvidence.noDepartments")}</p>}

      {depts.length > 0 && (
        <section className="ddf-card ev-pick" aria-labelledby="ev-pick-h" data-testid="evidence-pick">
          <h2 id="ev-pick-h" className="ddf-cap">{t("rosterEvidence.pickTitle")}</h2>
          <div className="ev-pick-row">
            <label className="ev-field">
              <span>{t("rosterEvidence.department")}</span>
              <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setQuery(""); }} data-testid="evidence-dept">
                {depts.map((d) => <option key={d.departmentId} value={d.departmentId}>{d.name}</option>)}
              </select>
            </label>
            <label className="ev-field ev-field-grow">
              <span>{t("rosterEvidence.search")}</span>
              <input type="search" value={query} placeholder={t("rosterEvidence.searchPlaceholder")} onChange={(e) => setQuery(e.target.value)} data-testid="evidence-search" />
            </label>
          </div>
          <div className="ev-people" role="group" aria-label={dept?.name ?? ""}>
            {shown.length === 0 && <span className="ddf-dim">{t("rosterEvidence.nobody")}</span>}
            {shown.map((p) => (
              <label key={p.userId} className={`ev-person${chosen.includes(p.userId) ? " on" : ""}`} data-testid={`evidence-person-${p.userId}`}>
                <input type="checkbox" checked={chosen.includes(p.userId)} onChange={() => toggle(p.userId)} />
                <span className="ev-person-name">{p.name}</span>
                <span className="ev-person-sub">
                  {[t(`doctorDesk.grade.${p.grade}`, { defaultValue: p.grade }), shortUnit(p.unitName, dept?.name ?? "")].join(" · ")}
                </span>
              </label>
            ))}
          </div>
          {chosen.length > 0 && (
            <div className="ev-chosen" data-testid="evidence-chosen">
              <span className="ev-chosen-n">{t("rosterEvidence.chosen", { count: chosen.length })}</span>
              {chosen.map((id) => (
                <button key={id} type="button" className="ev-chip" onClick={() => toggle(id)} aria-label={`${t("rosterEvidence.clear")} ${nameOf.get(id) ?? ""}`}>
                  {nameOf.get(id) ?? id} <span aria-hidden="true">×</span>
                </button>
              ))}
              {chosen.length >= MAX_PEOPLE && <span className="ddf-dim">{t("rosterEvidence.maxPeople", { max: MAX_PEOPLE })}</span>}
            </div>
          )}
          <div className="ev-pick-row ev-days">
            <label className="ev-field">
              <span>{t("rosterEvidence.from")}</span>
              <DmyDateInput className="ro-in-day" value={from} onChange={setFrom} data-testid="evidence-from" />
            </label>
            <label className="ev-field">
              <span>{t("rosterEvidence.to")}</span>
              <DmyDateInput className="ro-in-day" value={to} onChange={setTo} data-testid="evidence-to" />
            </label>
            <div className="ddf-seg ev-quick">
              <button type="button" onClick={() => { setFrom(lastMonthStart); setTo(addDays(monthStart(today), -1)); }}>{t("rosterEvidence.lastMonth")}</button>
              <button type="button" onClick={() => { setFrom(monthStart(today)); setTo(today); }}>{t("rosterEvidence.thisMonth")}</button>
            </div>
            <span className="ddf-grow" />
            <button type="button" className="ddf-btn ddf-btn-pri ev-show" onClick={show} data-testid="evidence-show">{t("rosterEvidence.show")}</button>
          </div>
          {problem !== null && <p role="alert" className="ro-alert" data-testid="evidence-problem">{problem}</p>}
        </section>
      )}

      {depts.length > 0 && (
        <section className="ddf-card ev-preview" aria-labelledby="ev-prev-h">
          <div className="ev-preview-head">
            <h2 id="ev-prev-h" className="ddf-cap">{t("rosterEvidence.previewTitle")}</h2>
            {report !== undefined && (
              <button
                type="button" className="ddf-btn ddf-btn-pri" disabled={print.isPending}
                onClick={() => print.mutate()} data-testid="evidence-print"
              >
                {print.isPending ? t("rosterEvidence.printing") : t("rosterEvidence.print")}
              </button>
            )}
          </div>
          {print.isSuccess && (
            <p role="status" className={print.data.served ? "ro-declare-done" : "ro-note-amber"} data-testid="evidence-printed">
              {!print.data.served
                ? t("rosterEvidence.notServed", { ref: print.data.ref })
                : print.data.queued ? t("rosterEvidence.queued", { ref: print.data.ref }) : t("rosterEvidence.already", { ref: print.data.ref })}
            </p>
          )}
          {print.isError && <p role="alert" className="ro-alert">{rosterErrorText(print.error, t)}</p>}
          {asked === null && <p className="ddf-dim ev-empty">{t("rosterEvidence.previewEmpty")}</p>}
          {asked !== null && sheet.isPending && <p className="ddf-dim">{t("rosterEvidence.loading")}</p>}
          {sheet.isError && <p role="alert" className="ro-alert" data-testid="evidence-error">{rosterErrorText(sheet.error, t)}</p>}
          {sheet.data !== undefined && <SheetFrame html={sheet.data.html} title={t("rosterEvidence.previewFrame")} />}
        </section>
      )}
    </DoctorDeskFrame>
  );
}
