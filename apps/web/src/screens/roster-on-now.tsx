import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { fmtIst } from "../lib/format";
import { sayParams } from "../lib/use-copilot";
import { todayIst } from "../lib/opd-api";
import {
  declareHoliday, declareSkeleton, fetchAsItStood, fetchBoardPrintDocument, fetchDeclarations, fetchOnNowBoard, raiseRosterFlag, resolveRosterFlag, rosterErrorText, withdrawSkeleton,
} from "../lib/roster-api";
import { useAuth } from "../lib/auth";
import { openDocumentForPrinting } from "../lib/print-api";
import { DmyDateInput } from "../components/dmy-date-input";
import type {
  HolidayKind, HolidayPattern, WireAsItStoodBoard, WireAsItStoodChange, WireBoardDepartment, WireBoardHole, WireBoardService,
  WireDeclarationsView, WireOnNowBoard, WireRosterFlag, WireRosterSelf,
} from "../lib/roster-api";
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

/** `stood` — 20-U I23: open the board as it stood at that instant (a link an inspection can carry). */
type Props = { at?: string; stood?: string };
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

export function RosterOnNow({ at, stood }: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { username } = useAuth();
  const [ahead, setAhead] = useState(false);
  // 20-U I23 — the inspection: `stoodAt` is the instant asked about; `picking` shows the picker.
  const [stoodAt, setStoodAt] = useState<string | null>(stood ?? null);
  const [picking, setPicking] = useState(stood !== undefined);
  const pinned = at !== undefined;
  const live = useQuery({
    queryKey: ["roster", "on-now", at ?? (ahead ? "ahead" : "now")],
    queryFn: () => fetchOnNowBoard(at ?? (ahead ? new Date(Date.now() + AHEAD_MS).toISOString() : undefined)),
    refetchInterval: pinned ? false : REFRESH_MS,
    enabled: stoodAt === null,
  });
  const past = useQuery({
    queryKey: ["roster", "as-it-stood", stoodAt],
    queryFn: () => fetchAsItStood(stoodAt!),
    enabled: stoodAt !== null,
  });
  const q = stoodAt === null ? live : past;
  const b: WireOnNowBoard | undefined = q.data;
  const history = stoodAt === null ? undefined : past.data;
  const lang = i18n.language;
  const showNow = (): void => { setStoodAt(null); setPicking(false); };
  // HISTORY IS READ-ONLY. The "This is wrong" button and the open flags (U6, I22) live on the holes
  // card (`Rail`), which is about the board NOW; the historical view (I23) swaps in `HistoryRail`,
  // which carries neither — even if a board as it stood ever came back carrying `flags`. A skeleton
  // day is a live board, so its flags and the button still show.
  const readOnly = stoodAt !== null;

  return (
    <DoctorDeskFrame
      active="onNow" testId="roster-on-now" menuDefault="closed" railWidth={340}
      context={t("rosterOnNow.context")}
      who={whoFrom(b?.you, username, t)}
      rail={b === undefined ? undefined : readOnly ? (history === undefined ? undefined : <HistoryRail h={history} />) : <Rail b={b} />}
      ask={b === undefined ? undefined : (
        <AskBar
          id="ask-on" placeholder={t("rosterOnNow.askPlaceholder")}
          fallback={(question) => answerFromBoard(question, b, t, lang, stoodAt === null && at === undefined && !ahead)}
          terms={() => boardNames(b)}
        />
      )}
    >
      <div className="ro-title">
        <div className="ro-title-text">
          <h1 className="ddf-h1" data-testid="on-now-clock">
            {history !== undefined ? t("rosterOnNow.stood.title", { when: clockLine(history.at, lang) })
              : b === undefined ? t("rosterOnNow.title") : clockLine(b.at, lang)}
          </h1>
          <div className="ddf-dim" data-testid="on-now-note">
            {history !== undefined ? t("rosterOnNow.stood.intro") : b === undefined ? t("rosterOnNow.intro") : clockNote(b, t, lang)}
          </div>
        </div>
        {!pinned && (
          <div className="ddf-seg ro-times" role="group" aria-label={t("rosterOnNow.when")}>
            <button type="button" aria-pressed={!picking && !ahead} className={!picking && !ahead ? "on" : ""} onClick={() => { showNow(); setAhead(false); }}>{t("rosterOnNow.now")}</button>
            <button type="button" aria-pressed={!picking && ahead} className={!picking && ahead ? "on" : ""} onClick={() => { showNow(); setAhead(true); }}>{t("rosterOnNow.ahead")}</button>
            <button type="button" aria-pressed={picking} className={picking ? "on" : ""} data-testid="stood-open" onClick={() => setPicking(true)}>{t("rosterOnNow.stood.button")}</button>
          </div>
        )}
      </div>

      {picking && <StoodPicker initial={stoodAt} onShow={setStoodAt} />}
      {history !== undefined && (
        <div role="status" className="ro-history" data-testid="stood-banner">
          <span className="ro-history-tag">{t("rosterOnNow.stood.tag")}</span>
          <span className="ro-history-text">
            {t("rosterOnNow.stood.banner", { when: clockLine(history.at, lang), count: history.changes.length })}
            {history.changes.length > 0 && <> <a href="#stood-changes" className="ro-history-jump">{t("rosterOnNow.stood.jump")}</a></>}
          </span>
          <button type="button" className="ddf-btn" onClick={showNow} data-testid="stood-close">{t("rosterOnNow.stood.back")}</button>
        </div>
      )}

      {q.isError && <p role="alert" className="ro-alert">{rosterErrorText(q.error, t)}</p>}
      {q.isPending && <p className="ddf-dim">{t("rosterOnNow.loading")}</p>}
      {b !== undefined && (
        <>
          {history === undefined && !b.resolverEnabled && <p role="status" className="ro-note-amber" data-testid="resolver-off">{t("rosterOnNow.resolverOff")}</p>}
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
  if (h.kind === "skeleton_short") {
    return t("rosterOnNow.hole.skeleton_short", { dept: h.departmentName, count: h.count ?? 0, from: fmtIst(h.from), to: fmtIst(h.to) });
  }
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
          <div key={`${h.kind}-${h.departmentId}-${h.userId ?? ""}-${h.from}-${String(i)}`} className={h.kind === "skeleton_short" ? "ro-hole ro-hole-skeleton" : "ro-hole"}>
            <span className="ro-hole-when">{holeWhen(h, i18n.language)}</span>
            <span className="ro-hole-text">{holeText(h, t)}</span>
          </div>
        ))}
        <WrongFlag b={b} />
      </section>
      <DarkCard b={b} />
      <section className="ddf-card ro-rail-card ddf-noprint">
        <h2 className="ro-rail-h">{t("rosterOnNow.arrivingTitle")}</h2>
        <span className="ro-rail-p">{t("rosterOnNow.arrivingText")}</span>
      </section>
      <DeclareCard />
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

/* ═══════════════ 20-U I23 — THE BOARD AS IT STOOD ═══════════════ */

/** IST wall-clock parts of an instant: `["2026-09-29", "03:10"]`. */
function istParts(iso: string): [string, string] {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000).toISOString();
  return [d.slice(0, 10), d.slice(11, 16)];
}

/**
 * The picker: a day and a time, read as IST (the hospital's wall), never the browser's zone. The
 * instant is sent as `…+05:30`, so a laptop set to UTC asks the same question as the ward's PC.
 */
function StoodPicker({ initial, onShow }: { initial: string | null; onShow: (iso: string) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [day0, time0] = istParts(initial ?? new Date(Date.now() - 86_400_000).toISOString());
  const [day, setDay] = useState(day0);
  const [time, setTime] = useState(initial === null ? "10:00" : time0);
  const goodDay = /^\d{4}-\d{2}-\d{2}$/.test(day);
  const goodTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const iso = goodDay && goodTime ? `${day}T${time}:00+05:30` : null;
  const future = iso !== null && Date.parse(iso) > Date.now();
  return (
    <form
      className="ddf-card ro-stood-pick" data-testid="stood-picker"
      onSubmit={(e) => { e.preventDefault(); if (iso !== null && !future) onShow(iso); }}
    >
      <span className="ro-stood-label">{t("rosterOnNow.stood.ask")}</span>
      <label>
        <span>{t("rosterOnNow.stood.day")}</span>
        {/* Owner 2026-10-03: DD-MM-YYYY, never the browser's locale; the API gets YYYY-MM-DD. */}
        <DmyDateInput className="ro-in-day" value={day} onChange={setDay} data-testid="stood-day" aria-label={t("rosterOnNow.stood.day")} />
      </label>
      <label>
        <span>{t("rosterOnNow.stood.time")}</span>
        <input
          type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5} className="ro-in-time" autoComplete="off"
          value={time} onChange={(e) => setTime(e.target.value)} data-testid="stood-time"
        />
      </label>
      <button type="submit" className="ddf-btn ddf-btn-pri" disabled={iso === null || future} data-testid="stood-show">{t("rosterOnNow.stood.show")}</button>
      {future && <span className="ro-small ro-red">{t("rosterOnNow.stood.future")}</span>}
      {((day !== "" && !goodDay) || (time !== "" && !goodTime)) && <span className="ro-small ro-red" data-testid="stood-bad">{t("rosterOnNow.stood.bad")}</span>}
      {goodDay && <b className="ro-day-words ro-stood-words">{dayLabel(day, i18n.language)}</b>}
    </form>
  );
}

function changeWindow(c: { startsAt: string; endsAt: string }): string {
  return `${fmtIst(c.startsAt)}\u2060–\u2060${fmtIst(c.endsAt)}`; // a window never breaks at its dash
}

function ChangeItem({ c }: { c: WireAsItStoodChange }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [d, tm] = istParts(c.at);
  const when = `${new Intl.DateTimeFormat(i18n.language.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00+05:30`))}, ${tm}`;
  const slot = (x: WireAsItStoodChange["added"][number]): string =>
    `${x.name ?? t("rosterOnNow.vacant")} · ${t(`rosterOnNow.position.${x.positionKey}`, { defaultValue: x.positionLabel })} · ${changeWindow(x)}`;
  return (
    <div className={`ro-change${c.afterTheFact ? " ro-change-late" : ""}`} data-testid="stood-change">
      <div className="ro-change-top">
        <span className="ro-change-kind">{t(`rosterOnNow.change.${c.kind}`, { defaultValue: c.kind, version: c.version ?? "" })}</span>
        {c.afterTheFact && <span className="ro-tag-late">{t("rosterOnNow.change.afterTheFact")}</span>}
      </div>
      <span className="ro-hole-when">{t("rosterOnNow.change.when", { when, dept: c.departmentName ?? t("rosterOnNow.change.hospital") })}</span>
      {c.removed.map((x) => <span key={`r-${x.startsAt}-${x.userId ?? ""}`} className="ro-change-line"><b>{t("rosterOnNow.change.off")}</b> {slot(x)}</span>)}
      {c.added.map((x) => <span key={`a-${x.startsAt}-${x.userId ?? ""}`} className="ro-change-line"><b>{t("rosterOnNow.change.on")}</b> {slot(x)}</span>)}
      {c.byName !== null && <span className="ro-small">{t(c.kind === "new_version" ? "rosterOnNow.change.publishedBy" : "rosterOnNow.change.approvedBy", { name: c.byName })}</span>}
    </div>
  );
}

function HistoryRail({ h }: { h: WireAsItStoodBoard }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="ddf-card-strong ro-rail-card" data-testid="stood-changes" id="stood-changes">
      <h2 className="ro-rail-h ro-rail-h-big">{t("rosterOnNow.stood.changesTitle")}</h2>
      <span className="ro-rail-p ddf-dim">{t("rosterOnNow.stood.changesIntro")}</span>
      {h.changes.length === 0
        ? <div className="ro-hole ro-hole-ok"><span>{t("rosterOnNow.stood.noChanges")}</span></div>
        : h.changes.map((c, i) => <ChangeItem key={`${c.periodId}-${c.at}-${String(i)}`} c={c} />)}
    </section>
  );
}

/* ═══════════════ 20-U I1 / I5 — HOLIDAY OR STRIKE DAY (the medical superintendent's card) ═══════════════ */

const HOLIDAY_KINDS: readonly HolidayKind[] = ["declared", "gazetted", "restricted", "local"];
const HOLIDAY_PATTERNS: readonly HolidayPattern[] = ["opd_off_ot_proceeds", "as_sunday", "opd_short"];

function dayLabel(istDate: string, lang: string): string {
  return new Intl.DateTimeFormat(lang.startsWith("hi") ? "hi-IN" : "en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${istDate}T12:00:00+05:30`)).replace(",", "");
}

/**
 * Shown only to a reader who may declare (`youMay`, probed through the same `requireRosterAct` the
 * act calls). Collapsed it is one line and what is already declared; open it is two short forms.
 * Every act answers with the declarations as they now stand, and the board re-reads (the SKELETON
 * badge and the grouped holes are the board's, not this card's).
 */
function DeclareCard(): React.ReactElement | null {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["roster", "declarations"], queryFn: fetchDeclarations });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"holiday" | "skeleton">("holiday");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const v = q.data;
  const settle = (next: WireDeclarationsView, said: string): void => {
    qc.setQueryData(["roster", "declarations"], next);
    void qc.invalidateQueries({ queryKey: ["roster", "on-now"] });
    setRefusal(null); setDone(said);
  };
  const onFail = (e: unknown): void => { setDone(null); setRefusal(rosterErrorText(e, t)); };
  const holiday = useMutation({
    mutationFn: (x: { day: string; kind: HolidayKind; pattern: HolidayPattern }) => declareHoliday(x.day, x.kind, x.pattern),
    onSuccess: (next, x) => settle(next, t("rosterOnNow.declare.holidayDone", { day: dayLabel(x.day, i18n.language) })),
    onError: onFail,
  });
  const skeleton = useMutation({
    mutationFn: (x: { dept: string | null; day: string; reason: string }) => declareSkeleton(x.dept, x.day, x.reason),
    onSuccess: (next, x) => settle(next, t("rosterOnNow.declare.skeletonDone", { day: dayLabel(x.day, i18n.language) })),
    onError: onFail,
  });
  const withdraw = useMutation({
    mutationFn: (x: { id: string; reason: string }) => withdrawSkeleton(x.id, x.reason),
    onSuccess: (next) => settle(next, t("rosterOnNow.declare.withdrawn")),
    onError: onFail,
  });
  if (v === undefined) return null;
  const may = v.youMay.holiday || v.youMay.hospitalSkeleton || v.youMay.departmentSkeleton;
  if (!may) return null;
  const busy = holiday.isPending || skeleton.isPending || withdraw.isPending;
  const live = v.modes.filter((m) => m.withdrawnAt === null);

  return (
    <section className="ddf-card ro-rail-card ddf-noprint ro-declare" data-testid="declare-card">
      <div className="ro-declare-head">
        <h2 className="ro-rail-h">{t("rosterOnNow.declare.title")}</h2>
        {!open && <button type="button" className="ddf-btn ddf-btn-pri" onClick={() => setOpen(true)} data-testid="declare-open">{t("rosterOnNow.declare.open")}</button>}
      </div>
      {!open && <span className="ro-rail-p ddf-dim">{t("rosterOnNow.declare.intro")}</span>}

      {open && (
        <>
          <div className="ddf-seg ro-declare-tabs" role="tablist">
            {v.youMay.holiday && <button type="button" role="tab" aria-selected={tab === "holiday"} className={tab === "holiday" ? "on" : ""} onClick={() => setTab("holiday")} data-testid="declare-tab-holiday">{t("rosterOnNow.declare.tabHoliday")}</button>}
            {(v.youMay.hospitalSkeleton || v.youMay.departmentSkeleton) && <button type="button" role="tab" aria-selected={tab === "skeleton" || !v.youMay.holiday} className={tab === "skeleton" || !v.youMay.holiday ? "on" : ""} onClick={() => setTab("skeleton")} data-testid="declare-tab-skeleton">{t("rosterOnNow.declare.tabSkeleton")}</button>}
          </div>
          {tab === "holiday" && v.youMay.holiday
            ? <HolidayForm busy={busy} onDeclare={(x) => holiday.mutate(x)} />
            : <SkeletonForm v={v} busy={busy} onDeclare={(x) => skeleton.mutate(x)} />}
          {refusal !== null && <p role="alert" className="ro-alert ro-declare-msg" data-testid="declare-error">{refusal}</p>}
          {done !== null && refusal === null && <p role="status" className="ro-declare-done" data-testid="declare-done">{done}</p>}
          <button type="button" className="rm-undo ro-declare-close" onClick={() => { setOpen(false); setRefusal(null); setDone(null); }}>{t("rosterOnNow.declare.close")}</button>
        </>
      )}

      {(v.holidays.length > 0 || v.modes.length > 0) && (
        <div className="ro-declared" data-testid="declared-list">
          <span className="ro-declared-cap">{t("rosterOnNow.declare.already")}</span>
          {live.map((m) => <ModeRow key={m.declarationId} m={m} busy={busy} onWithdraw={(reason) => withdraw.mutate({ id: m.declarationId, reason })} />)}
          {v.holidays.map((h) => (
            <div key={h.istDate} className="ro-declared-row">
              <span className="ro-declared-day">{dayLabel(h.istDate, i18n.language)}</span>
              <span className="ro-declared-what">
                <span className="ro-declared-line">
                  <span className="ro-tag-hol">{t(`rosterOnNow.declare.kind.${h.kind}`, { defaultValue: h.kind })}</span>
                  {" "}{t(`rosterOnNow.declare.patternShort.${h.pattern}`, { defaultValue: h.pattern })}
                </span>
              </span>
            </div>
          ))}
          {v.modes.filter((m) => m.withdrawnAt !== null).map((m) => (
            <div key={m.declarationId} className="ro-declared-row ro-declared-off">
              <span className="ro-declared-day">{dayLabel(m.istDate, i18n.language)}</span>
              <span className="ro-declared-what">{t("rosterOnNow.declare.withdrawnLine", { scope: m.departmentName ?? t("rosterOnNow.declare.wholeHospital"), name: m.withdrawnByName ?? "" })}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HolidayForm({ busy, onDeclare }: { busy: boolean; onDeclare: (x: { day: string; kind: HolidayKind; pattern: HolidayPattern }) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const today = todayIst(new Date());
  const tomorrow = todayIst(new Date(Date.now() + 86_400_000));
  const [day, setDay] = useState(tomorrow);
  const [kind, setKind] = useState<HolidayKind>("declared");
  const [pattern, setPattern] = useState<HolidayPattern>("opd_off_ot_proceeds");
  return (
    <form className="ro-declare-form" data-testid="holiday-form" onSubmit={(e) => { e.preventDefault(); onDeclare({ day, kind, pattern }); }}>
      <div className="ro-declare-pair">
        <label>
          <span>{t("rosterOnNow.declare.day")}</span>
          <span className="ro-day-in">
            <DmyDateInput className="ro-in-day" value={day} onChange={setDay} required data-testid="holiday-day" aria-label={t("rosterOnNow.declare.day")} />
            {/^\d{4}-\d{2}-\d{2}$/.test(day) && <b className="ro-day-words" data-testid="holiday-day-words">{dayLabel(day, i18n.language)}</b>}
          </span>
        </label>
        <label>
          <span>{t("rosterOnNow.declare.kindLabel")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as HolidayKind)} data-testid="holiday-kind">
            {HOLIDAY_KINDS.map((k) => <option key={k} value={k}>{t(`rosterOnNow.declare.kind.${k}`)}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="ro-declare-patterns">
        <legend>{t("rosterOnNow.declare.patternLabel")}</legend>
        {HOLIDAY_PATTERNS.map((p) => (
          <label key={p} className={`ro-pattern${pattern === p ? " on" : ""}`}>
            <input type="radio" name="holiday-pattern" value={p} checked={pattern === p} onChange={() => setPattern(p)} data-testid={`holiday-pattern-${p}`} />
            <span className="ro-pattern-text">
              <b>{t(`rosterOnNow.declare.pattern.${p}`)}</b>
              <span className="ro-small">{t(`rosterOnNow.declare.patternHint.${p}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="ddf-btn ddf-btn-pri" disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today} data-testid="holiday-declare">{t("rosterOnNow.declare.declareHoliday")}</button>
    </form>
  );
}

function SkeletonForm({ v, busy, onDeclare }: {
  v: WireDeclarationsView; busy: boolean; onDeclare: (x: { dept: string | null; day: string; reason: string }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst(new Date());
  const tomorrow = todayIst(new Date(Date.now() + 86_400_000));
  const HOSPITAL = "__hospital__";
  // No default: a strike is declared for the department somebody chose, never the first in a list.
  const [dept, setDept] = useState("");
  const [day, setDay] = useState(today);
  const [reason, setReason] = useState("");
  return (
    <form
      className="ro-declare-form" data-testid="skeleton-form"
      onSubmit={(e) => { e.preventDefault(); if (reason.trim() !== "" && dept !== "") onDeclare({ dept: dept === HOSPITAL ? null : dept, day, reason: reason.trim() }); }}
    >
      <label>
        <span>{t("rosterOnNow.declare.department")}</span>
        <select value={dept} onChange={(e) => setDept(e.target.value)} data-testid="skeleton-dept">
          <option value="" disabled>{t("rosterOnNow.declare.choose")}</option>
          {v.youMay.hospitalSkeleton && <option value={HOSPITAL}>{t("rosterOnNow.declare.wholeHospital")}</option>}
          {v.departments.map((d) => <option key={d.departmentId} value={d.departmentId}>{d.name}</option>)}
        </select>
      </label>
      <div className="ddf-seg ro-declare-days" role="group" aria-label={t("rosterOnNow.declare.day")}>
        <button type="button" aria-pressed={day === today} className={day === today ? "on" : ""} onClick={() => setDay(today)}>{t("rosterOnNow.declare.today")}</button>
        <button type="button" aria-pressed={day === tomorrow} className={day === tomorrow ? "on" : ""} onClick={() => setDay(tomorrow)} data-testid="skeleton-tomorrow">{t("rosterOnNow.declare.tomorrow")}</button>
      </div>
      <label>
        <span>{t("rosterOnNow.declare.reason")}</span>
        <input type="text" value={reason} maxLength={500} placeholder={t("rosterOnNow.declare.reasonHint")} onChange={(e) => setReason(e.target.value)} data-testid="skeleton-reason" />
      </label>
      <span className="ro-small">{t("rosterOnNow.declare.skeletonRules")}</span>
      <button type="submit" className="ddf-btn ro-btn-red" disabled={busy || reason.trim() === "" || dept === ""} data-testid="skeleton-declare">{t("rosterOnNow.declare.declareSkeleton")}</button>
    </form>
  );
}

function ModeRow({ m, busy, onWithdraw }: { m: WireDeclarationsView["modes"][number]; busy: boolean; onWithdraw: (reason: string) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="ro-declared-row ro-declared-mode" data-testid={`mode-${m.declarationId}`}>
      <span className="ro-declared-day">{dayLabel(m.istDate, i18n.language)}</span>
      <span className="ro-declared-what">
        <span className="ro-declared-line"><span className="ro-skeleton">{t("rosterOnNow.skeleton")}</span> <b>{m.departmentName ?? t("rosterOnNow.declare.wholeHospital")}</b></span>
        <span className="ro-small ro-block">{t("rosterOnNow.declare.modeLine", { reason: m.reason, name: m.declaredByName ?? "" })}</span>
        {!asking && <button type="button" className="rm-f-show ro-declared-act" onClick={() => setAsking(true)} data-testid={`withdraw-${m.declarationId}`}>{t("rosterOnNow.declare.withdraw")}</button>}
      </span>
      {asking && (
          <div className="rm-f-reason ro-declared-why">
            <input placeholder={t("rosterOnNow.declare.withdrawWhy")} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t("rosterOnNow.declare.withdrawWhy")} />
            <button type="button" className="ddf-btn ddf-btn-pri" disabled={busy} onClick={() => onWithdraw(reason.trim())} data-testid={`withdraw-yes-${m.declarationId}`}>{t("rosterOnNow.declare.withdrawYes")}</button>
          </div>
      )}
    </div>
  );
}

/**
 * 20-U infra (owner 2026-10-04) — **"WHEN THE SCREENS ARE DARK"**, read off the RECORD of the last
 * scheduled print (`lastPrint`), never off the schedule: "Last printed 20:00 · 1 copy" only when a
 * relay reported paper; "Generated 20:00 — no printer is connected" when nothing was queued; the
 * recorded sheet is always offered for download (the browser's Save as PDF), and the hand print
 * stays for a handover in between.
 */
function DarkCard({ b }: { b: WireOnNowBoard }): React.ReactElement {
  const { t } = useTranslation();
  const [blocked, setBlocked] = useState(false);
  const p = b.lastPrint ?? null;
  const time = p === null ? "" : fmtIst(p.slotAt);
  const status = p === null ? null
    : p.outcome === "no_printer" ? t("rosterOnNow.printNoPrinter", { time })
      : p.copies.printed > 0 ? t("rosterOnNow.printDone", { time, count: p.copies.printed })
        : p.copies.waiting > 0 ? t("rosterOnNow.printWaiting", { time })
          : t("rosterOnNow.printFailed", { time });
  const download = async (): Promise<void> => {
    if (p === null) return;
    setBlocked(!openDocumentForPrinting(await fetchBoardPrintDocument(p.printId)));
  };
  return (
    <section className="ddf-card ro-rail-card ddf-noprint" data-testid="on-now-dark">
      <h2 className="ro-rail-h">{t("rosterOnNow.darkTitle")}</h2>
      <span className="ro-rail-p">{t("rosterOnNow.darkText")}</span>
      <span className="ro-small" data-testid="board-print-status">
        {status ?? t("rosterOnNow.printNone", { next: "20:00 / 08:00" })}
      </span>
      {p !== null && (
        <button type="button" className="ddf-btn" data-testid="board-print-download" onClick={() => { void download(); }}>
          {t("rosterOnNow.printDownload", { time: fmtIst(p.slotAt) })}
        </button>
      )}
      {blocked && <span className="ro-small" role="alert">{t("rosterOnNow.printBlocked")}</span>}
      <button type="button" className="ddf-btn ddf-btn-pri ro-print" data-testid="print-board" onClick={() => window.print()}>{t("rosterOnNow.printIt")}</button>
    </section>
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
export function answerFromBoard(question: string, b: WireOnNowBoard, t: T, lang = "en", isNow = true): string | null {
  const ws = words(question);
  const hit = (name: string): boolean => words(name).some((n) => ws.some((w) => n.startsWith(w) || w.startsWith(n)));
  /*
    THE SAME SENTENCES AS THE SERVER'S `roster.who_is_on` (review 2026-10-04): one voice whichever of
    the two answers. The params take the server's shape — "now" or an instant, ISO handover, "" for
    nobody — and `sayParams` says them in the reader's language.
  */
  const say = (key: string, params: Record<string, string>): string => t(key, sayParams(key, params, t, lang));
  const when = isNow ? "now" : b.at;
  const d = b.departments.find((x) => hit(x.name) || ws.includes(x.code.toLowerCase()));
  if (d !== undefined) {
    if (d.source !== "published") return say("copilot.answer.rosterWhoUnpublished", { dept: d.name, when });
    const here = d.inTheBuilding.map((p) => `${t(`rosterOnNow.grade.${p.cadre}`, { defaultValue: p.cadre })} ${p.name}`).join(", ");
    const fac = d.facultyOnCall.flatMap((r) => (r.name === null ? [] : [r.name])).join(", ");
    return d.unitOnTake === null
      ? say("copilot.answer.rosterWhoNoTake", { dept: d.name, when, here, fac })
      : say("copilot.answer.rosterWhoIsOn", { dept: d.name, when, unit: shortUnit(d.unitOnTake.name, d.name), till: new Date(d.unitOnTake.endsAt).toISOString(), here, fac });
  }
  const s = b.services.find((x) => hit(t(`rosterOnNow.position.${x.positionKey}`, { defaultValue: x.positionLabel })) || hit(x.positionLabel));
  if (s !== undefined) {
    const role = t(`rosterOnNow.position.${s.positionKey}`, { defaultValue: s.positionLabel });
    if (s.source !== "published") return say("copilot.answer.rosterWhoServiceUnpublished", { role });
    return s.people.length === 0 ? say("copilot.answer.rosterWhoServiceNobody", { role, when })
      : say("copilot.answer.rosterWhoService", { role, when, who: s.people.map((p) => p.name).join(", ") });
  }
  return null;
}
