import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { fetchOnNowBoard, raiseRosterFlag, resolveRosterFlag, rosterErrorText } from "../lib/roster-api";
import { useAuth } from "../lib/auth";
import type { WireBoardDepartment, WireBoardHole, WireBoardService, WireOnNowBoard, WireRosterFlag, WireRosterSelf } from "../lib/roster-api";
import "./roster.css";

/**
 * ═══ 20-U U5a — WHO IS ON NOW, THE HOSPITAL'S UNIT BOARD ═══
 *
 * The board the owner approved on 2026-09-20 (`docs/design/2026-09-20-roster/OnNow.dc.html`), ported
 * 1:1 into the Doctor Desk frame: casualty, the front desk, the duty manager and every ward read this
 * same screen. A clock line and what it means for who is on take; per department the unit on take
 * and till when, who is in the building (with a call button where a number is on file — D6: only
 * here, and only for people on duty now), the faculty on call and who covers an overflow; the
 * hospital-wide services as cards; and on the right the holes in the next 24 hours, the paper copy
 * for when the screens are dark, and the arrival-time rule.
 *
 * **A department with no published roster SAYS SO**, in plain words: no take cycle at all, or a take
 * cycle but no duty roster. The server sends no people for it, and an empty row would look staffed.
 * The design board's three clock buttons were a review device; the real screen shows NOW, refreshes
 * every minute, and offers "In 8 hours" (and `?at=` for a link to an instant).
 *
 * The board's per-hole owner line ("Asked: Dr. Bhavna · waiting for her yes") is not drawn: a U6 cover
 * request is about a FILLED duty and is shown to its parties and approvers, not on this public board.
 *
 * 20-U U6 (register I22) — **"This is wrong"**: on every published department row, any reader may say
 * a name on duty is wrong, in one line. The flag goes on the holes card — the duty manager's to read —
 * until somebody who can fix the roster marks it dealt with. Nothing about anybody's duty changes.
 */
const REFRESH_MS = 60_000;
const AHEAD_MS = 8 * 3_600_000;

type Props = { at?: string };
type T = (k: string, o?: Record<string, unknown>) => string;

/** "General Medicine Unit III" under "General Medicine" reads "Unit III", as the board writes it. */
export function shortUnit(unitName: string, deptName: string): string {
  return unitName.startsWith(`${deptName} `) ? unitName.slice(deptName.length + 1) : unitName;
}

/** Minutes past IST midnight. */
const istMinutes = (iso: string): number => {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

function weekdayOf(iso: string, lang: string, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: style }).format(new Date(iso));
}

/**
 * The header's "Dr. Anand Rao · Assoc. Prof": the full name the roster read carries (`you`), and the
 * grade the reader is posted as now. Falls back to the login name only for a reader with no user row.
 */
export function whoFrom(you: WireRosterSelf | undefined, username: string | null, t: T): { name: string; role: string | null } | undefined {
  if (you === undefined) return undefined;
  const name = you.name ?? username ?? "";
  return { name, role: you.grade === null ? null : t(`doctorDesk.grade.${you.grade}`, { defaultValue: you.grade }) };
}

export function RosterOnNow({ at }: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const [ahead, setAhead] = useState(false);
  const pinned = at !== undefined;
  const q = useQuery({
    queryKey: ["roster", "on-now", at ?? (ahead ? "ahead" : "now")],
    queryFn: () => fetchOnNowBoard(at ?? (ahead ? new Date(Date.now() + AHEAD_MS).toISOString() : undefined)),
    refetchInterval: pinned ? false : REFRESH_MS,
  });
  const b = q.data;
  const lang = i18n.language;

  return (
    <DoctorDeskFrame
      active="onNow" testId="roster-on-now" menuDefault="closed" railWidth={340}
      context={t("rosterOnNow.context")}
      who={whoFrom(b?.you, username, t)}
      rail={b === undefined ? undefined : <Rail b={b} />}
      ask={b === undefined ? undefined : (
        <AskBar
          id="ask-on" placeholder={t("rosterOnNow.askPlaceholder")}
          fallback={(question) => answerFromBoard(question, b, t)}
          terms={() => boardNames(b)}
        />
      )}
    >
      <div className="ro-title">
        <div className="ro-title-text">
          <h1 className="ddf-h1" data-testid="on-now-clock">
            {b === undefined ? t("rosterOnNow.title") : clockLine(b.at, lang)}
          </h1>
          <div className="ddf-dim" data-testid="on-now-note">{b === undefined ? t("rosterOnNow.intro") : clockNote(b, t, lang)}</div>
        </div>
        {!pinned && (
          <div className="ddf-seg ro-times" role="group" aria-label={t("rosterOnNow.when")}>
            <button type="button" aria-pressed={!ahead} className={!ahead ? "on" : ""} onClick={() => setAhead(false)}>{t("rosterOnNow.now")}</button>
            <button type="button" aria-pressed={ahead} className={ahead ? "on" : ""} onClick={() => setAhead(true)}>{t("rosterOnNow.ahead")}</button>
          </div>
        )}
      </div>

      {q.isError && <p role="alert" className="ro-alert">{rosterErrorText(q.error, t)}</p>}
      {q.isPending && <p className="ddf-dim">{t("rosterOnNow.loading")}</p>}
      {b !== undefined && (
        <>
          {!b.resolverEnabled && <p role="status" className="ro-note-amber" data-testid="resolver-off">{t("rosterOnNow.resolverOff")}</p>}
          <section className="ddf-card ro-board" data-testid="on-now-table">
            <div className="ro-board-head" aria-hidden="true">
              <span>{t("rosterOnNow.col.department")}</span>
              <span>{t("rosterOnNow.col.unit")}</span>
              <span>{t("rosterOnNow.col.building")}</span>
              <span>{t("rosterOnNow.col.faculty")}</span>
              <span>{t("rosterOnNow.col.backup")}</span>
            </div>
            {b.departments.map((d) => <DepartmentRow key={d.departmentId} d={d} b={b} />)}
          </section>
          <Services services={b.services} b={b} />
          <PrintSheet b={b} />
        </>
      )}
    </DoctorDeskFrame>
  );
}

/** "Sunday 4 October, 16:39" — the board's clock line, in IST. */
export function clockLine(iso: string, lang: string): string {
  const day = new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }).format(new Date(iso)).replace(",", "");
  return `${day}, ${fmtIst(iso)}`;
}

/** What the clock means for who is on take — the board's three sentences, from the data's own take. */
function clockNote(b: WireOnNowBoard, t: T, lang: string): string {
  const take = b.departments.find((d) => d.unitOnTake !== null)?.unitOnTake ?? null;
  if (take === null) return t("rosterOnNow.intro");
  const handover = fmtIst(take.endsAt);
  const takeDay = weekdayOf(take.startsAt, lang);
  const mins = istMinutes(b.at);
  if (todayIst(new Date(take.startsAt)) !== todayIst(new Date(b.at))) return t("rosterOnNow.noteLate", { day: takeDay, time: handover });
  if (mins >= 20 * 60) return t("rosterOnNow.noteNight", { day: takeDay, time: handover, next: weekdayOf(take.endsAt, lang) });
  return t("rosterOnNow.noteDay", { day: takeDay, time: fmtIst(take.startsAt) });
}

/**
 * "Thursday's take" and "till 08:00" (or "till Sat 08:00" when the handover is another day) — two
 * pieces, each kept whole, so the unit column wraps between them and never inside one: two lines.
 */
function tillParts(d: WireBoardDepartment, b: WireOnNowBoard, t: T, lang: string): string[] {
  const u = d.unitOnTake;
  if (u === null) return [];
  if (d.units === 1) return [t("rosterOnNow.singleUnit")];
  const sameDay = todayIst(new Date(u.endsAt)) === todayIst(new Date(b.at));
  const till = sameDay ? fmtIst(u.endsAt) : `${weekdayOf(u.endsAt, lang, "short")} ${fmtIst(u.endsAt)}`;
  return [`${t("rosterOnNow.takeOf", { day: weekdayOf(u.startsAt, lang) })} ·`, t("rosterOnNow.tillShort", { time: till })];
}

function isDaytime(iso: string): boolean {
  const m = istMinutes(iso);
  return m >= 8 * 60 && m < 20 * 60;
}

function backupLine(d: WireBoardDepartment, b: WireOnNowBoard, t: T): string {
  if (d.backupUnit !== null) return t("rosterOnNow.backup", { unit: shortUnit(d.backupUnit.name, d.name) });
  if (d.units === 1) {
    const med = b.departments.find((x) => x.code === "MED" && x.departmentId !== d.departmentId && x.unitOnTake !== null);
    return med !== undefined ? t("rosterOnNow.coveredBy", { dept: med.name }) : t("rosterOnNow.singleBackup");
  }
  return t("rosterOnNow.noBackup");
}

function DepartmentRow({ d, b }: { d: WireBoardDepartment; b: WireOnNowBoard }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const published = d.source === "published";
  const u = d.unitOnTake;
  const noCycle = b.holes.some((h) => h.kind === "no_take_cycle" && h.departmentId === d.departmentId);
  return (
    <div className="ro-row" data-testid={`dept-${d.code}`}>
      <div className="ro-c-dept">
        <span className="ro-dept">{d.name}</span>
        {d.skeleton && <span className="ro-skeleton">{t("rosterOnNow.skeleton")}</span>}
      </div>
      <div className="ro-c-unit">
        <span className="ro-cap-inline">{t("rosterOnNow.col.unit")}</span>
        {u === null
          ? <span className="ro-unit ro-red">{noCycle ? t("rosterOnNow.noCycle") : t("rosterOnNow.noUnit")}</span>
          : (
            <>
              <span className="ro-unit">{shortUnit(u.name, d.name)}</span>
              <span className="ro-small" data-testid={`till-${d.code}`}>
                {tillParts(d, b, t, i18n.language).map((part, i) => <span key={part} className="ro-nowrap">{i > 0 ? " " : ""}{part}</span>)}
              </span>
            </>
          )}
      </div>
      {published ? (
        <>
          <div className="ro-c-here">
            <span className="ro-cap-inline">{t("rosterOnNow.col.building")}</span>
            {d.inTheBuilding.length === 0 ? <span className="ro-red">{t("rosterOnNow.nobodyIn")}</span> : d.inTheBuilding.map((p) => (
              <div key={p.userId} className="ro-person">
                <span className="ro-grade mo">{t(`rosterOnNow.grade.${p.cadre}`, { defaultValue: p.cadre })}</span>
                <span className="ro-name">{p.name}</span>
                {p.phone !== null && p.phone !== ""
                  ? (
                    <a href={`tel:${p.phone}`} className="ro-call" aria-label={t("rosterOnNow.call", { name: p.name })} title={p.phone} data-testid={`call-${p.userId}`}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 2.5h3l1 3-1.7 1.2a8 8 0 004 4L10.5 9l3 1v3a1 1 0 01-1 1A10.5 10.5 0 012 3.5a1 1 0 011-1z" /></svg>
                    </a>
                  )
                  : <span className="ro-call-none" aria-hidden="true" />}
              </div>
            ))}
          </div>
          <div className="ro-c-fac">
            <span className="ro-cap-inline">{t("rosterOnNow.col.faculty")}</span>
            {d.facultyOnCall.length === 0 ? <span className="ddf-dim">—</span> : d.facultyOnCall.map((r, i) => (
              <span key={r.userId ?? `vacant-${String(i)}`} className="ro-fac">
                {r.name === null ? <span className="ro-red">{t("rosterOnNow.vacant")}</span> : r.name}
              </span>
            ))}
            {d.facultyOnCall.length > 0 && <span className="ro-small">{isDaytime(b.at) ? t("rosterOnNow.facDay") : t("rosterOnNow.facNight")}</span>}
          </div>
        </>
      ) : (
        <div className="ro-c-none">
          <p role="note" className="ro-none" data-testid={`unpublished-${d.code}`}>
            {noCycle ? t("rosterOnNow.notPublishedNoCycle", { dept: d.name }) : t("rosterOnNow.notPublished")}
          </p>
        </div>
      )}
      <div className="ro-c-backup">
        <span className="ro-cap-inline">{t("rosterOnNow.col.backup")}</span>
        <span>{backupLine(d, b, t)}</span>
      </div>
    </div>
  );
}

/**
 * "THIS IS WRONG" (register I22) — one button on the holes card, so the board's rows stay as the owner
 * approved them. Which department, which name, and one line about it; sent as a flag at the instant
 * the board is showing, and the duty manager reads it on this card.
 */
function WrongFlag({ b }: { b: WireOnNowBoard }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const depts = b.departments.filter((d) => d.source === "published");
  const [deptId, setDeptId] = useState<string>(depts[0]?.departmentId ?? "");
  const d = depts.find((x) => x.departmentId === deptId);
  const people = d === undefined ? [] : [
    ...d.inTheBuilding.map((p) => ({ userId: p.userId, name: p.name })),
    ...d.facultyOnCall.flatMap((r) => (r.userId === null || r.name === null ? [] : [{ userId: r.userId, name: r.name }])),
  ].filter((p, i, all) => all.findIndex((x) => x.userId === p.userId) === i);
  const [who, setWho] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const shownWho = who !== null ? who : (people[0]?.userId ?? "");
  const send = useMutation({
    mutationFn: () => raiseRosterFlag({ departmentId: deptId === "" ? null : deptId, userId: shownWho === "" ? null : shownWho, at: b.at, note: note.trim() }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["roster", "on-now"] }); setOpen(false); setSent(true); setNote(""); },
  });
  if (!open) {
    return (
      <div className="ro-wrong-bar">
        {sent && <span className="ro-wrong-done" role="status" data-testid="flag-sent">{t("rosterOnNow.wrong.done")}</span>}
        <button type="button" className="ro-wrong" onClick={() => { setOpen(true); setSent(false); }} data-testid="wrong-open">{t("rosterOnNow.wrong.button")}</button>
      </div>
    );
  }
  return (
    <form className="ro-wrong-form" data-testid="wrong-form" onSubmit={(e) => { e.preventDefault(); if (note.trim() !== "") send.mutate(); }}>
      <span className="ro-wrong-h">{t("rosterOnNow.wrong.title")}</span>
      <label className="ro-wrong-label">
        <span>{t("rosterOnNow.wrong.dept")}</span>
        <select value={deptId} onChange={(e) => { setDeptId(e.target.value); setWho(null); }} data-testid="wrong-dept">
          {depts.map((x) => <option key={x.departmentId} value={x.departmentId}>{x.name}</option>)}
        </select>
      </label>
      <label className="ro-wrong-label">
        <span>{t("rosterOnNow.wrong.who")}</span>
        <select value={shownWho} onChange={(e) => setWho(e.target.value)} data-testid="wrong-who">
          {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
          <option value="">{t("rosterOnNow.wrong.nobodyNamed")}</option>
        </select>
      </label>
      <label className="ro-wrong-label">
        <span>{t("rosterOnNow.wrong.what")}</span>
        <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t("rosterOnNow.wrong.placeholder")} data-testid="wrong-note" />
      </label>
      {send.isError && <span role="alert" className="ro-alert">{rosterErrorText(send.error, t)}</span>}
      <div className="ro-wrong-acts">
        <button type="submit" className="ddf-btn ddf-btn-pri" disabled={send.isPending || note.trim() === ""} data-testid="wrong-send">{t("rosterOnNow.wrong.send")}</button>
        <button type="button" className="ddf-btn" onClick={() => setOpen(false)}>{t("rosterOnNow.wrong.cancel")}</button>
      </div>
      <span className="ro-small">{t("rosterOnNow.wrong.hint")}</span>
    </form>
  );
}

function serviceNote(s: WireBoardService, b: WireOnNowBoard, t: T): string {
  if (s.source !== "published") return t("rosterOnNow.serviceNotPublished");
  if (s.people.length === 0) return "";
  const dept = b.departments.find((d) => d.departmentId === s.people[0]!.departmentId);
  return dept === undefined ? t("rosterOnNow.serviceOn") : dept.name;
}

function Services({ services, b }: { services: WireBoardService[]; b: WireOnNowBoard }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="ro-services" data-testid="on-now-services">
      <h2 className="ddf-cap ro-cap">{t("rosterOnNow.services")}</h2>
      <div className="ro-services-grid">
        {services.map((s) => (
          <div key={s.positionKey} className="ddf-card ro-service" data-testid={`service-${s.positionKey}`}>
            <span className="ro-small">{t(`rosterOnNow.position.${s.positionKey}`, { defaultValue: s.positionLabel })}</span>
            {s.source === "published" && s.people.length === 0
              ? <span className="ro-who ro-red">{t("rosterOnNow.nobodyOn")}</span>
              : s.source === "published"
                ? <span className="ro-who">{s.people.map((p) => p.name).join(", ")}</span>
                : <span className="ro-who ddf-dim">—</span>}
            {serviceNote(s, b, t) !== "" && <span className="ro-small">{serviceNote(s, b, t)}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function holeWhen(h: WireBoardHole, lang: string): string {
  const day = new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(h.from)).replace(",", "");
  return `${day}, ${fmtIst(h.from)}`;
}

function holeText(h: WireBoardHole, t: T): string {
  return t(`rosterOnNow.hole.${h.kind}`, {
    dept: h.departmentName,
    position: h.positionKey === null ? "" : t(`rosterOnNow.position.${h.positionKey}`, { defaultValue: h.positionLabel ?? h.positionKey }),
    name: h.name ?? "",
    from: fmtIst(h.from),
    to: fmtIst(h.to),
  });
}

function Rail({ b }: { b: WireOnNowBoard }): React.ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <>
      <section className="ddf-card-strong ro-rail-card" data-testid="on-now-holes">
        <h2 className="ro-rail-h ro-rail-h-big">{t("rosterOnNow.holes")}</h2>
        {(b.flags ?? []).map((f) => <FlagHole key={f.flagId} f={f} b={b} />)}
        {b.holes.length === 0 ? ((b.flags ?? []).length === 0 && <div className="ro-hole ro-hole-ok"><span>{t("rosterOnNow.noHoles")}</span></div>) : b.holes.map((h, i) => (
          <div key={`${h.kind}-${h.departmentId}-${h.userId ?? ""}-${h.from}-${String(i)}`} className="ro-hole">
            <span className="ro-hole-when">{holeWhen(h, i18n.language)}</span>
            <span className="ro-hole-text">{holeText(h, t)}</span>
          </div>
        ))}
        <WrongFlag b={b} />
      </section>
      <section className="ddf-card ro-rail-card ddf-noprint" data-testid="on-now-dark">
        <h2 className="ro-rail-h">{t("rosterOnNow.darkTitle")}</h2>
        <span className="ro-rail-p">{t("rosterOnNow.darkText")}</span>
        <button type="button" className="ddf-btn ddf-btn-pri ro-print" data-testid="print-board" onClick={() => window.print()}>{t("rosterOnNow.printIt")}</button>
        <span className="ro-small">{t("rosterOnNow.darkNotYet")}</span>
      </section>
      <section className="ddf-card ro-rail-card ddf-noprint">
        <h2 className="ro-rail-h">{t("rosterOnNow.arrivingTitle")}</h2>
        <span className="ro-rail-p">{t("rosterOnNow.arrivingText")}</span>
      </section>
    </>
  );
}

/** A "this is wrong" flag, in the hole's own box: when, who said what about whom, and "Dealt with". */
function FlagHole({ f, b }: { f: WireRosterFlag; b: WireOnNowBoard }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const done = useMutation({
    mutationFn: () => resolveRosterFlag(f.flagId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["roster", "on-now"] }); },
  });
  const dept = b.departments.find((d) => d.departmentId === f.departmentId)?.name ?? "";
  const when = new Intl.DateTimeFormat(i18n.language.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(f.raisedAt)).replace(",", "");
  return (
    <div className="ro-hole" data-testid={`flag-${f.flagId}`}>
      <span className="ro-hole-when">{t("rosterOnNow.flag.when", { day: when, time: fmtIst(f.raisedAt), by: f.raisedBy.name })}</span>
      <span className="ro-hole-text">
        {f.user === null ? t("rosterOnNow.flag.textNobody", { dept, note: f.note }) : t("rosterOnNow.flag.text", { name: f.user.name, dept, note: f.note })}
      </span>
      <span className="ro-hole-own">
        {t("rosterOnNow.flag.own")}
        {f.youMayResolve && <button type="button" className="ro-dealt" disabled={done.isPending} onClick={() => done.mutate()} data-testid="flag-dealt">{t("rosterOnNow.flag.dealt")}</button>}
      </span>
    </div>
  );
}

/**
 * THE PAPER COPY — A4 landscape, one page: every department's unit on take, the people in the
 * building with their grade and number, the faculty on call, who covers, the services, and the
 * instant it was printed. Hidden on screen; `roster.css`'s print rules show only this.
 */
function PrintSheet({ b }: { b: WireOnNowBoard }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const printedAt = clockLine(new Date().toISOString(), i18n.language);
  return (
    <div className="ro-print-sheet" data-testid="on-now-print">
      {/*
        The paper size lives HERE, mounted only while this board is: a global `@page` in a stylesheet
        would be bundled app-wide and turn the e-Rx's A5 (`styles.css`) into A4 landscape.
      */}
      <style>{"@page { size: A4 landscape; margin: 9mm; }"}</style>
      <div className="ro-print-head">
        <strong>{t("rosterOnNow.printTitle", { at: clockLine(b.at, i18n.language) })}</strong>
        <span>{t("rosterOnNow.printedAt", { at: printedAt })}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("rosterOnNow.col.department")}</th><th>{t("rosterOnNow.col.unit")}</th><th>{t("rosterOnNow.col.building")}</th>
            <th>{t("rosterOnNow.col.faculty")}</th><th>{t("rosterOnNow.col.backup")}</th>
          </tr>
        </thead>
        <tbody>
          {b.departments.map((d) => (
            <tr key={d.departmentId}>
              <td>{d.name}</td>
              <td>{d.unitOnTake === null ? (b.holes.some((h) => h.kind === "no_take_cycle" && h.departmentId === d.departmentId) ? t("rosterOnNow.noCycle") : t("rosterOnNow.noUnit")) : `${shortUnit(d.unitOnTake.name, d.name)} · ${t("rosterOnNow.tillShort", { time: fmtIst(d.unitOnTake.endsAt) })}`}</td>
              <td>
                {d.source !== "published" ? t("rosterOnNow.printNoRoster") : d.inTheBuilding.map((p) => (
                  <div key={p.userId}>{t(`rosterOnNow.grade.${p.cadre}`, { defaultValue: p.cadre })} {p.name}{p.phone !== null && p.phone !== "" ? ` · ${p.phone}` : ""}</div>
                ))}
              </td>
              <td>{d.facultyOnCall.map((r) => r.name ?? t("rosterOnNow.vacant")).join(", ")}</td>
              <td>{backupLine(d, b, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ro-print-services">
        {b.services.map((s) => (
          <span key={s.positionKey}>
            <strong>{t(`rosterOnNow.position.${s.positionKey}`, { defaultValue: s.positionLabel })}:</strong>{" "}
            {s.source !== "published" ? "—" : s.people.length === 0 ? t("rosterOnNow.nobodyOn") : s.people.map((p) => p.name).join(", ")}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every name the board shows, so the copilot masks them by value before anything leaves. */
function boardNames(b: WireOnNowBoard): string[] {
  return [
    ...b.departments.flatMap((d) => [...d.inTheBuilding.map((p) => p.name), ...d.facultyOnCall.flatMap((r) => (r.name === null ? [] : [r.name]))]),
    ...b.services.flatMap((s) => s.people.map((p) => p.name)),
  ];
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-zऀ-ॿ]+/).filter((w) => w.length >= 3);

/**
 * THIS SCREEN'S OWN ANSWERER — "ortho mein abhi on call kaun hai?" answered from the board on the
 * screen: a department (or a service) named by any word that starts its name, and who is on for it.
 * Used when the hospital copilot does not understand the question or cannot be reached.
 */
export function answerFromBoard(question: string, b: WireOnNowBoard, t: T): string | null {
  const ws = words(question);
  const hit = (name: string): boolean => words(name).some((n) => ws.some((w) => n.startsWith(w) || w.startsWith(n)));
  const d = b.departments.find((x) => hit(x.name) || ws.includes(x.code.toLowerCase()));
  if (d !== undefined) {
    if (d.source !== "published") return t("rosterOnNow.answer.unpublished", { dept: d.name });
    const unit = d.unitOnTake === null ? t("rosterOnNow.noUnit") : shortUnit(d.unitOnTake.name, d.name);
    const here = d.inTheBuilding.map((p) => `${t(`rosterOnNow.grade.${p.cadre}`, { defaultValue: p.cadre })} ${p.name}`).join(", ");
    const fac = d.facultyOnCall.map((r) => r.name ?? t("rosterOnNow.vacant")).join(", ");
    return t("rosterOnNow.answer.dept", {
      dept: d.name, unit, till: d.unitOnTake === null ? "" : fmtIst(d.unitOnTake.endsAt),
      here: here === "" ? t("rosterOnNow.nobodyIn") : here, fac: fac === "" ? "—" : fac,
    });
  }
  const s = b.services.find((x) => hit(t(`rosterOnNow.position.${x.positionKey}`, { defaultValue: x.positionLabel })) || hit(x.positionLabel));
  if (s !== undefined) {
    const role = t(`rosterOnNow.position.${s.positionKey}`, { defaultValue: s.positionLabel });
    if (s.source !== "published") return t("rosterOnNow.answer.serviceUnpublished", { role });
    return s.people.length === 0 ? t("rosterOnNow.answer.serviceNobody", { role })
      : t("rosterOnNow.answer.service", { role, who: s.people.map((p) => p.name).join(", ") });
  }
  return null;
}
