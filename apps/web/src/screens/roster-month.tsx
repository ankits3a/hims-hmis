import { useEffect, useMemo, useState } from "react";
import { dayWords } from "../lib/use-copilot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AskBar, DoctorDeskFrame } from "../components/doctor-desk/frame";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import {
  acceptRosterFinding, decideCover, draftUnitMonth, editRosterSlot, fetchCoverRequests, fetchRosterUnits, fetchUnitMonth, isStaleWrite, publishUnitMonth,
  rosterErrorCode, rosterErrorText,
} from "../lib/roster-api";
import type { WireCoverRequest, WireDutyRef, WireMonthAssignment, WireMonthFinding, WireUnitMonth } from "../lib/roster-api";
import { CoverPicker, dutyName, reasonText } from "./roster-my-duties";
import { shortUnit, whoFrom } from "./roster-on-now";
import { useAuth } from "../lib/auth";
import "./roster.css";

/**
 * ═══ 20-U U5b — ROSTER: THE UNIT'S MONTH ═══
 *
 * The board the owner approved on 2026-09-20 (`docs/design/2026-09-20-roster/Main.dc.html`), ported
 * 1:1 into the Doctor Desk frame, for a unit's senior resident and its head. A month the proposer has
 * already drafted, one row per person and one column per day (2 weeks, the month, or one day); the
 * unit's own day above each column (OPD / theatre / ward, and TAKE) from the published cycle; leave,
 * holidays, rest after a night and postings drawn in the grid; and on the right *Before you publish*,
 * where every validator finding is a SENTENCE naming the person and the day, with a one-tap fix where
 * the roster supports one (leave that duty vacant — a declared hole is an honest answer — with Undo),
 * "pick someone else", and, for a warning only, "it's fine, I'll note why". **Publish stays disabled,
 * and says why, while a must-fix item stands** — the server's own gate (`blocked_by_findings`)
 * decides; this mirrors the count the server computed with the gate's own rule. A must-fix cannot be
 * accepted here, and nothing on this screen says it can.
 *
 * NOT DRAWN, because the data does not exist: "Who goes where on an OPD day" (the proposer drafts
 * day and night slots, not rooms), "Asked of you" (swap requests are U6), and the board's "No spare"
 * staffing hint. Write affordances follow `youMay`; hidden here is a courtesy, refused there is the
 * guard. A write refused because the month moved under the reader (409/404) refetches the month and
 * says so rather than leaving a stale grid.
 */

type Props = { team?: string; month?: string };
type T = (k: string, o?: Record<string, unknown>) => string;
type Zoom = "weeks" | "month" | "day";

const thisMonthIst = (): string => todayIst(new Date()).slice(0, 7);
const weekday = (istDate: string): number => new Date(`${istDate}T12:00:00Z`).getUTCDay();
const dayNum = (istDate: string): number => Number(istDate.slice(8, 10));
const VACANT = "__vacant__";

/** Codes that mean "somebody else moved this month" rather than "your edit was refused". */
const MOVED = new Set([
  "version_conflict", "stale_base", "draft_changed_since_review", "period_not_draft", "unknown_assignment",
  "unknown_period", "unknown_finding", "finding_already_accepted",
]);

function locale(lang: string): string { return lang.startsWith("hi") ? "hi-IN" : "en-GB"; }
function monthLong(ym: string, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 15)));
}
/** "Tue 13 Oct" — the board's way of naming a day. */
function dayName(istDate: string, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${istDate}T12:00:00Z`)).replace(",", "");
}
function dayShort(istDate: string, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${istDate}T12:00:00Z`)).replace(",", "");
}

const GRADE_RANK: Record<string, number> = {
  professor: 0, associate_professor: 1, assistant_professor: 2, senior_resident: 3, jr3: 4, jr2: 5, jr1: 6, intern: 7, medical_officer: 8,
};

/** The unit's activity, as the board's one-word column head. */
function actWord(acts: string[], t: T): string {
  for (const a of ["opd", "elective_ot", "minor_ot", "ward_teaching", "special_clinic", "post_take", "backup"]) {
    if (acts.includes(a)) return t(`rosterMonth.act.${a}`);
  }
  return "";
}
function actClass(acts: string[]): string {
  if (acts.includes("opd") || acts.includes("special_clinic")) return "rm-k-opd";
  if (acts.includes("elective_ot") || acts.includes("minor_ot")) return "rm-k-ot";
  return "rm-k-ward";
}

/** What one person's box on one day says. Pure: the screen's whole legend in one function. */
export type Cell = { cls: string; label: string; sub: string; a: WireMonthAssignment | null; title: string };
export function cellFor(d: WireUnitMonth, userId: string, day: string, t: T): Cell | null {
  const person = d.people.find((p) => p.userId === userId);
  if (person !== undefined && ((person.postedFrom !== null && day < person.postedFrom) || (person.postedTo !== null && day > person.postedTo))) {
    return { cls: "rm-k-none", label: "·", sub: "", a: null, title: t("rosterMonth.legend.notPosted") };
  }
  const mine = d.assignments.filter((a) => a.userId === userId && a.istDate === day);
  const away = d.leave.find((l) => l.userId === userId && l.from <= day && day <= l.to);
  const unitDay = d.unitDays.find((u) => u.istDate === day);
  // The duty a must-fix names is the one shown, so the red outline is never hidden under another slot.
  const flagged = new Set(d.findings.filter((f) => f.blocking && f.assignmentId !== null).map((f) => f.assignmentId));
  const duty = mine.find((a) => flagged.has(a.assignmentId))
    ?? mine.find((a) => a.kind === "duty" && a.night) ?? mine.find((a) => a.kind === "duty") ?? mine[0];
  if (duty !== undefined) {
    const hours = (Date.parse(duty.endsAt) - Date.parse(duty.startsAt)) / 3_600_000;
    const span = `${fmtIst(duty.startsAt)}–${fmtIst(duty.endsAt)}`;
    const onLeave = away !== undefined ? t("rosterMonth.cell.onLeave") : "";
    const more = mine.length > 1 ? ` +${String(mine.length - 1)}` : "";
    if (duty.kind === "off") return { cls: "rm-k-off", label: t("rosterMonth.cell.off"), sub: "", a: duty, title: span };
    if (duty.kind === "teaching") return { cls: "rm-k-teach", label: t("rosterMonth.cell.teach"), sub: onLeave || more.trim(), a: duty, title: span };
    if (hours >= 20) return { cls: "rm-k-take", label: t("rosterMonth.cell.take24"), sub: onLeave || t("rosterMonth.cell.takeSub"), a: duty, title: span };
    if (duty.night) {
      return { cls: "rm-k-night", label: t("rosterMonth.cell.night"), sub: onLeave || (unitDay?.take === true ? t("rosterMonth.cell.takeSub") : more.trim()), a: duty, title: span };
    }
    const acts = unitDay?.activities ?? [];
    const word = actWord(acts, t);
    if (word === "" && unitDay?.take === true) {
      return { cls: "rm-k-take", label: t("rosterMonth.act.take"), sub: onLeave || (duty.mode === "call" ? t("rosterMonth.cell.onCall") : more.trim()), a: duty, title: span };
    }
    return {
      cls: word === "" ? "rm-k-day" : actClass(acts), label: word === "" ? t("rosterMonth.cell.day") : word,
      sub: onLeave || (duty.mode === "call" ? t("rosterMonth.cell.onCall") : more.trim()), a: duty, title: span,
    };
  }
  if (away !== undefined) return { cls: "rm-k-leave", label: t(`rosterMonth.absence.${away.kind}`, { defaultValue: t("rosterMonth.absence.other") }), sub: "", a: null, title: t("rosterMonth.legend.leave") };
  const prev = d.assignments.find((a) => a.userId === userId && a.night && a.kind === "duty" && todayIst(new Date(a.endsAt)) === day);
  if (prev !== undefined) return { cls: "rm-k-rest", label: t("rosterMonth.cell.rest"), sub: "", a: null, title: t("rosterMonth.legend.rest") };
  return null;
}

/** The "nobody yet" row: each vacant duty, and which position it is. */
function vacantCell(d: WireUnitMonth, day: string, t: T): Cell | null {
  const holes = d.assignments.filter((a) => a.userId === null && a.istDate === day && a.kind !== "off");
  if (holes.length === 0) return null;
  const a = holes[0]!;
  const pos = t(`rosterMonth.posShort.${a.positionKey}`, { defaultValue: a.positionKey });
  return {
    cls: "rm-k-vacant", label: a.night ? t("rosterMonth.cell.night") : t("rosterMonth.cell.day"),
    sub: holes.length > 1 ? `${pos} +${String(holes.length - 1)}` : pos, a,
    title: t("rosterMonth.vacantTitle", { position: t(`rosterOnNow.position.${a.positionKey}`, { defaultValue: a.positionKey }) }),
  };
}

/** A finding as a sentence: the rule's own template, the person, the day, and the numbers it carries. */
const PLURAL_PARAM: Record<string, string> = {
  rest_after_duty: "restHours", unit_min_jr: "present", requirement_shortfall: "present", night_one_in_three: "gapDays",
};

function sentence(f: WireMonthFinding, t: T, lang: string): string {
  const p = f.params;
  const num = (k: string): string => (typeof p[k] === "number" ? String(p[k]) : "");
  // The number the sentence's noun agrees with ("1 hour's rest", "2 junior residents"): i18next
  // picks `_one`/`_other` from `count`, so no sentence spells a plural by hand.
  const countKey = PLURAL_PARAM[f.ruleKey];
  const count = countKey !== undefined && typeof p[countKey] === "number" ? (p[countKey] as number) : undefined;
  return t(`rosterMonth.rule.${f.ruleKey}`, {
    ...(count === undefined ? {} : { count }),
    defaultValue: t("rosterMonth.rule.other", { rule: f.ruleKey, name: f.name ?? "" }),
    name: f.name ?? t("rosterMonth.someone"),
    day: f.istDate === null ? "" : dayName(f.istDate, lang),
    restHours: num("restHours"), minHours: num("minHours"), hours: num("hours"), maxHours: num("maxHours"),
    present: num("present"), minCount: num("minCount"), oneInN: num("oneInN"), gapDays: num("gapDays"),
  });
}

type Sorted = { key: string; text: string; when: string | null; assignmentId: string; prevUserId: string | null; prevName: string | null };

export function RosterMonth({ team, month }: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const [teamId, setTeamId] = useState<string | undefined>(team);
  const [ym, setYm] = useState<string>(month ?? thisMonthIst());
  const [picked, setPicked] = useState<WireMonthAssignment | null>(null);
  const { username, actor } = useAuth();
  /** 20-U U6 — a published duty picked to be covered or swapped (the month's own "I can't do this"). */
  const [covering, setCovering] = useState<WireMonthAssignment | null>(null);
  /** The cell (or, for a finding about a whole day, the day) a finding was clicked to show. */
  const [focus, setFocus] = useState<{ assignmentId: string | null; day: string; seq: number } | null>(null);
  // A phone opens on one day — a list, one line per person — rather than a grid it must scroll.
  const [zoom, setZoom] = useState<Zoom>(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches ? "day" : "weeks"));
  const [startIdx, setStartIdx] = useState<number | null>(null);
  const [sorted, setSorted] = useState<Sorted[]>([]);
  const [moved, setMoved] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const units = useQuery({ queryKey: ["roster", "units"], queryFn: fetchRosterUnits });
  const firstUnit = units.data?.[0]?.units[0]?.teamId;
  const unitId = teamId ?? firstUnit;
  const key = ["roster", "month", unitId ?? "", ym];
  const m = useQuery({
    queryKey: key,
    queryFn: () => fetchUnitMonth(unitId!, ym),
    enabled: unitId !== undefined && /^\d{4}-\d{2}$/.test(ym),
  });
  useEffect(() => { setStartIdx(null); setSorted([]); setMoved(false); setRefusal(null); setCovering(null); }, [unitId, ym]);

  const settle = (next: WireUnitMonth): void => { qc.setQueryData(key, next); setPicked(null); setMoved(false); setRefusal(null); };
  const onFail = (e: unknown): void => {
    const code = rosterErrorCode(e);
    if (isStaleWrite(e)) {
      void qc.invalidateQueries({ queryKey: key });
      setPicked(null);
      setSorted([]);
      if (code === null || MOVED.has(code)) { setMoved(true); setRefusal(null); return; }
    }
    setMoved(false);
    setRefusal(rosterErrorText(e, t));
  };
  const draft = useMutation({ mutationFn: () => draftUnitMonth(unitId!, ym), onSuccess: settle, onError: onFail });
  const slot = useMutation({
    mutationFn: (v: { assignmentId: string; userId: string | null; sorted?: Sorted; undo?: string }) => editRosterSlot(v.assignmentId, v.userId),
    onSuccess: (next, v) => {
      settle(next);
      if (v.sorted !== undefined) setSorted((s) => [...s.filter((x) => x.key !== v.sorted!.key), v.sorted!]);
      if (v.undo !== undefined) setSorted((s) => s.filter((x) => x.key !== v.undo));
    },
    onError: onFail,
  });
  const accept = useMutation({
    mutationFn: (v: { f: WireMonthFinding; reason: string }) =>
      acceptRosterFinding(m.data!.period!.periodId, { ruleKey: v.f.ruleKey, assignmentId: v.f.assignmentId, userId: v.f.userId }, v.reason),
    onSuccess: settle, onError: onFail,
  });
  const publish = useMutation({
    mutationFn: () => publishUnitMonth(m.data!.period!.periodId, m.data!.period!.contentHash),
    onSuccess: settle, onError: onFail,
  });
  // 20-U U6 — "Asked of you": the unit's requests this reader may answer or approve.
  const covers = useQuery({
    queryKey: ["roster", "covers", unitId ?? ""],
    queryFn: () => fetchCoverRequests(unitId!),
    enabled: unitId !== undefined,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => decideCover(v.id, v.approve),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roster", "covers"] });
      void qc.invalidateQueries({ queryKey: key });
      setRefusal(null);
    },
    onError: onFail,
  });
  const busy = [draft, slot, accept, publish, decide].some((x) => x.isPending);

  const d = m.data;
  const unitShort = d === undefined ? "" : shortUnit(d.unit.name, d.unit.departmentName);
  const mName = d === undefined ? "" : monthLong(d.month, lang);
  const today = todayIst(new Date());

  // The days in view: two weeks from this week's Monday (or the 1st), the whole month, or one day.
  const defaultStart = useMemo(() => {
    if (d === undefined) return 0;
    const i = d.days.indexOf(today);
    if (i < 0) return 0;
    if (zoom === "day") return i;
    return Math.max(0, i - ((weekday(today) + 6) % 7));
  }, [d, today, zoom]);
  const start = startIdx ?? defaultStart;
  const span = zoom === "month" ? (d?.days.length ?? 0) : zoom === "day" ? 1 : 14;
  const first = zoom === "month" ? 0 : Math.min(start, Math.max(0, (d?.days.length ?? 0) - span));
  const shown = d === undefined ? [] : d.days.slice(first, first + span);
  const step = zoom === "day" ? 1 : 7;

  const todayDay = d?.unitDays.find((u) => u.istDate === today);
  const pill = d === undefined || todayDay === undefined ? undefined : {
    tag: t("doctorDesk.today"),
    text: [unitShort, actWord(todayDay.activities, t) === "" ? null : t("rosterMonth.pillDay", { act: actWord(todayDay.activities, t) }), todayDay.take ? t("rosterMonth.pillTake") : null]
      .filter((x) => x !== null).join(" · "),
  };

  /**
   * Who may tap a duty: on a DRAFT, an editor (the slot editor); on a PUBLISHED month, the person
   * whose duty it is or whoever may ask on their behalf (`youMay.cover`) — and the tap opens "who
   * can take it", because a published duty changes hands only by a cover or a swap (20-U U6).
   */
  const pickFor = (x: WireUnitMonth): ((a: WireMonthAssignment) => void) | undefined => {
    if (x.period?.status === "published") {
      return (a: WireMonthAssignment) => {
        if (a.userId === null || !(x.youMay.cover === true || a.userId === actor?.id)) return;
        setPicked(null);
        setCovering(a);
      };
    }
    return x.youMay.edit ? setPicked : undefined;
  };

  const title = d === undefined ? t("rosterMonth.title") : d.period === null
    ? t("rosterMonth.titleEmpty", { month: mName, unit: unitShort })
    : d.period.status === "published"
      ? t("rosterMonth.titlePublished", { month: mName, unit: unitShort })
      : t("rosterMonth.titleDraft", { month: mName, unit: unitShort });

  return (
    <DoctorDeskFrame
      active="roster" testId="roster-month"
      context={d === undefined ? t("doctorDesk.contextBare") : t("doctorDesk.context", { dept: d.unit.departmentName, unit: unitShort })}
      pill={pill}
      who={whoFrom(d?.you, username, t)}
      rail={d === undefined ? undefined : (
        <Rail
          d={d} busy={busy} sorted={sorted} mName={mName} unitShort={unitShort}
          covers={covers.data ?? []} onDecide={(id, approve) => decide.mutate({ id, approve })}
          onVacate={(f, a) => slot.mutate({
            assignmentId: a.assignmentId, userId: null,
            sorted: { key: `${f.ruleKey}|${a.assignmentId}`, text: sentence(f, t, lang), when: f.istDate, assignmentId: a.assignmentId, prevUserId: a.userId, prevName: a.name },
          })}
          onUndo={(s) => slot.mutate({ assignmentId: s.assignmentId, userId: s.prevUserId, undo: s.key })}
          onPick={(a) => { setPicked(a); setZoom("day"); setStartIdx(d.days.indexOf(a.istDate)); }}
          onAccept={(f, reason) => accept.mutate({ f, reason })}
          onPublish={() => publish.mutate()}
          onShow={(f) => {
            if (f.istDate === null) return;
            const i = d.days.indexOf(f.istDate);
            if (i < 0) return;
            // Bring the day into view in the zoom the reader chose: its week for 2 weeks, itself for one day.
            if (zoom === "weeks" && (i < first || i >= first + span)) setStartIdx(Math.max(0, i - ((weekday(f.istDate) + 6) % 7)));
            if (zoom === "day") setStartIdx(i);
            setFocus((x) => ({ assignmentId: f.assignmentId, day: f.istDate!, seq: (x?.seq ?? 0) + 1 }));
          }}
        />
      )}
      ask={d === undefined ? undefined : (
        <AskBar id="ask-roster" placeholder={t("rosterMonth.askPlaceholder")} fallback={(q) => answerFromMonth(q, d, t, lang)} terms={() => d.people.map((p) => p.name)} />
      )}
    >
      <div className="rm-title">
        <div className="rm-title-text">
          <h1 className="ddf-h1">{title}</h1>
          <div className="ddf-dim" data-testid="month-intro">{t(d?.period?.status === "published" ? (d.youMay.cover === true ? "rosterMonth.introPublished" : "rosterMonth.introPublishedRead") : "rosterMonth.intro")}</div>
        </div>
        {d !== undefined && d.period !== null && (
          <div className="ddf-seg rm-zoom" role="group" aria-label={t("rosterMonth.zoom")}>
            {(["weeks", "month", "day"] as const).map((z) => (
              <button key={z} type="button" aria-pressed={zoom === z} className={zoom === z ? "on" : ""} data-testid={`zoom-${z}`}
                onClick={() => { setZoom(z); setStartIdx(null); }}>{t(`rosterMonth.zoomTo.${z}`)}</button>
            ))}
          </div>
        )}
      </div>

      <div className="rm-pick">
        <label>
          {t("rosterMonth.unit")}
          <select
            value={d?.unit.teamId ?? unitId ?? ""} data-testid="unit-picker"
            onChange={(e) => { setTeamId(e.target.value); setPicked(null); }}
          >
            {(units.data ?? []).map((dep) => (
              <optgroup key={dep.departmentId} label={dep.name}>
                {dep.units.map((u) => <option key={u.teamId} value={u.teamId}>{u.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          {t("rosterMonth.month")}
          <input type="month" value={ym} onChange={(e) => { setYm(e.target.value); setPicked(null); }} data-testid="month-picker" />
        </label>
        {d !== undefined && d.period !== null && zoom !== "month" && (
          <span className="rm-pager">
            <button type="button" aria-label={t("rosterMonth.earlier")} disabled={first <= 0} onClick={() => setStartIdx(Math.max(0, first - step))}>‹</button>
            <span data-testid="pager-range">{shown.length === 1 ? dayName(shown[0]!, lang) : shown.length > 0 ? `${dayShort(shown[0]!, lang)} – ${dayName(shown[shown.length - 1]!, lang)}` : ""}</span>
            <button type="button" aria-label={t("rosterMonth.later")} disabled={first + span >= d.days.length} onClick={() => setStartIdx(Math.min(d.days.length - span, first + step))}>›</button>
          </span>
        )}
      </div>

      {(units.isError || m.isError) && <p role="alert" className="ro-alert">{rosterErrorText(units.error ?? m.error, t)}</p>}
      {moved && <p role="status" className="rm-moved" data-testid="month-moved">{t("rosterMonth.moved")}</p>}
      {refusal !== null && <p role="alert" className="ro-alert" data-testid="month-error">{refusal}</p>}
      {units.data !== undefined && units.data.length === 0 && <p className="ddf-dim">{t("rosterMonth.noUnits")}</p>}
      {m.isPending && unitId !== undefined && <p className="ddf-dim">{t("rosterOnNow.loading")}</p>}
      {d !== undefined && !d.unit.confirmed && <p role="note" className="rm-unconfirmed" data-testid="unit-unconfirmed">{t("rosterMonth.unconfirmed")}</p>}

      {d !== undefined && d.period === null && (
        <section className="ddf-card rm-empty" data-testid="no-draft">
          <p style={{ margin: 0 }}>{t("rosterMonth.notDrafted", { month: mName, unit: unitShort })}</p>
          {d.youMay.draft
            ? <button type="button" className="ddf-btn ddf-btn-pri" disabled={busy} onClick={() => draft.mutate()}>{t("rosterMonth.draftIt")}</button>
            : <p className="ddf-dim" style={{ margin: 0 }}>{t("rosterMonth.cannotDraft")}</p>}
        </section>
      )}

      {d !== undefined && d.period !== null && (
        <>
          {/* The list names every duty in words; the colour key is for the grid. */}
          {zoom !== "day" && <Legend />}
          {zoom === "day"
            ? <DayList d={d} day={shown[0]!} picked={picked ?? covering} focus={focus} onPick={pickFor(d)} />
            : <Grid d={d} days={shown} today={today} picked={picked ?? covering} focus={focus} onPick={pickFor(d)} />}
          {covering !== null && d.period.status === "published" && (
            <section className="ddf-card-strong rm-cover" data-testid="month-cover">
              <p className="rm-cover-note">{t("rosterMonth.coverNote")}</p>
              <CoverPicker
                key={covering.assignmentId} duty={asDutyRef(covering, d)} embedded
                onBack={() => setCovering(null)}
                onAsked={() => { setCovering(null); void qc.invalidateQueries({ queryKey: ["roster", "covers"] }); }}
              />
            </section>
          )}
          {picked !== null && d.youMay.edit && (
            <SlotEditor key={picked.assignmentId} d={d} a={picked} busy={busy} onSave={(userId) => slot.mutate({ assignmentId: picked.assignmentId, userId })} onClose={() => setPicked(null)} />
          )}
          <div className="rm-lower">
            <Fairness d={d} mName={mName} />
          </div>
        </>
      )}
    </DoctorDeskFrame>
  );
}

function Legend(): React.ReactElement {
  const { t } = useTranslation();
  const items: [string, string][] = [
    ["rm-k-opd", "opd"], ["rm-k-ot", "ot"], ["rm-k-ward", "ward"], ["rm-k-take", "take24"], ["rm-k-night", "night"],
    ["rm-k-rest", "rest"], ["rm-k-teach", "teach"], ["rm-k-off", "off"], ["rm-k-leave", "leave"], ["rm-k-none", "notPosted"],
    ["rm-k-vacant", "vacant"], ["rm-bad", "needsYou"],
  ];
  return (
    <div className="rm-legend" data-testid="month-legend">
      {items.map(([cls, k]) => (
        <span key={k}><span className={`rm-sw ${cls}`} style={cls === "rm-k-off" || cls === "rm-bad" ? { background: "#ffffff", border: cls === "rm-k-off" ? "1px solid #dfe7e1" : undefined } : undefined} />{t(`rosterMonth.legend.${k}`)}</span>
      ))}
    </div>
  );
}

type Focus = { assignmentId: string | null; day: string; seq: number } | null;

/** Scrolls the focused cell into view when a finding is clicked — each click, not only the first. */
function useFocusScroll(focus: Focus): void {
  useEffect(() => {
    if (focus === null) return;
    const el = document.querySelector(".rm-focus");
    if (el !== null && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }, [focus]);
}

function Grid({ d, days, today, picked, focus, onPick }: {
  d: WireUnitMonth; days: string[]; today: string; picked: WireMonthAssignment | null; focus: Focus; onPick?: (a: WireMonthAssignment) => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  useFocusScroll(focus);
  const flagged = new Set(d.findings.filter((f) => f.blocking && f.assignmentId !== null).map((f) => f.assignmentId));
  const holidays = new Set(d.holidays.map((h) => h.istDate));
  const people = [...d.people].sort((a, b) => (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9) || a.name.localeCompare(b.name));
  const hasVacant = d.assignments.some((a) => a.userId === null && a.kind !== "off");
  const gradeLine = (p: WireUnitMonth["people"][number]): string => {
    const g = p.grade === "" ? "" : t(`rosterMonth.grade.${p.grade}`, { defaultValue: p.grade });
    const posting = p.postedTo !== null ? t("rosterMonth.postedTill", { day: dayShort(p.postedTo, i18n.language) })
      : p.postedFrom !== null ? t("rosterMonth.postedFrom", { day: dayShort(p.postedFrom, i18n.language) }) : "";
    return [g, posting].filter((x) => x !== "").join(" · ");
  };
  const dayCls = (day: string): string => [holidays.has(day) ? "rm-hol" : weekday(day) === 0 ? "rm-sun" : "", day === today ? "rm-today" : ""].join(" ");
  const box = (c: Cell | null, rowKey: string, day: string): React.ReactElement => {
    if (c === null) return <div key={day} className={`rm-cell ${dayCls(day)}`} />;
    const focused = c.a !== null && focus !== null && focus.assignmentId === c.a.assignmentId ? " rm-focus" : "";
    const mark = (c.a !== null && flagged.has(c.a.assignmentId) ? " rm-bad" : c.a !== null && picked?.assignmentId === c.a.assignmentId ? " rm-picked" : "") + focused;
    const inner = (<><span>{c.label}</span>{c.sub !== "" && <span className="rm-box-sub">{c.sub}</span>}</>);
    return (
      <div key={day} className={`rm-cell ${dayCls(day)}`}>
        {onPick !== undefined && c.a !== null && c.a.kind !== "off"
          ? <button type="button" className={`rm-box ${c.cls}${mark}`} title={c.title} onClick={() => onPick(c.a!)} data-testid={`slot-${c.a.assignmentId}`} aria-label={`${c.label} ${c.sub} ${day}`}>{inner}</button>
          : <div className={`rm-box ${c.cls}${mark}`} title={c.title} data-testid={c.a !== null ? `slot-${c.a.assignmentId}` : `cell-${rowKey}-${day}`}>{inner}</div>}
      </div>
    );
  };
  return (
    <section className="ddf-card rm-grid-card" data-testid="month-grid">
      <div className="rm-scroll">
        <div className="rm-grid" role="table" aria-label={t("rosterMonth.gridLabel")}>
          <div className="rm-r rm-r-head" role="row">
            <div className="rm-who" role="columnheader">{t("rosterMonth.unitDay")}</div>
            {days.map((day) => {
              const u = d.unitDays.find((x) => x.istDate === day);
              const acts = u?.activities ?? [];
              const word = holidays.has(day) && acts.length === 0 ? t("rosterMonth.act.holiday") : actWord(acts, t) || (weekday(day) === 0 ? "—" : "");
              return (
                <div key={day} className={`rm-day ${dayCls(day)}${focus !== null && focus.assignmentId === null && focus.day === day ? " rm-focus-day" : ""}`} role="columnheader" data-testid={`day-${day}`}>
                  <span className="rm-day-dow">{t(`rosterMonth.dow.${String(weekday(day))}`).toUpperCase()}</span>
                  <span className="rm-day-date">{dayNum(day)}</span>
                  <span className={`rm-day-act ${acts.includes("opd") ? "rm-act-opd" : ""}`} style={{ color: acts.includes("opd") ? "#0a5039" : acts.some((a) => a.endsWith("_ot")) ? "#23446f" : holidays.has(day) ? "#8a5a0b" : "#5c6f66" }}>{word}</span>
                  <span className="rm-day-take">{u?.take === true ? t("rosterMonth.takeMark") : ""}</span>
                </div>
              );
            })}
          </div>
          {people.map((p) => (
            <div key={p.userId} className={`rm-r${p.grade === "senior_resident" || p.grade === "intern" ? " rm-r-alt" : ""}`} role="row" data-testid={`row-${p.userId}`}>
              <div className="rm-who" role="rowheader">
                <span className="rm-name">{p.name}</span>
                <span className="rm-grade">{gradeLine(p)}</span>
              </div>
              {days.map((day) => box(cellFor(d, p.userId, day, t), p.userId, day))}
            </div>
          ))}
          {hasVacant && (
            <div className="rm-r" role="row" data-testid={`row-${VACANT}`}>
              <div className="rm-who" role="rowheader">
                <span className="rm-name" style={{ color: "#b23a30" }}>{t("rosterMonth.vacantRow")}</span>
                <span className="rm-grade">{t("rosterMonth.vacantRowSub")}</span>
              </div>
              {days.map((day) => box(vacantCell(d, day, t), VACANT, day))}
            </div>
          )}
        </div>
      </div>
      <div className="rm-foot">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 7.2v3.6M8 5v.3" /></svg>
        <span>{t("rosterMonth.gridFoot")}</span>
      </div>
    </section>
  );
}

/**
 * ONE DAY, AS A LIST — the phone's view, and the one-day zoom everywhere: the duties nobody holds on
 * top ("Nobody on it", with the post), then each person · grade · their duty (kind and hours) · tap
 * to change. An off day, rest, leave or a day not posted here shows no working hours.
 */
function DayList({ d, day, picked, focus, onPick }: {
  d: WireUnitMonth; day: string; picked: WireMonthAssignment | null; focus: Focus; onPick?: (a: WireMonthAssignment) => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  useFocusScroll(focus);
  const u = d.unitDays.find((x) => x.istDate === day);
  const holiday = d.holidays.find((h) => h.istDate === day);
  const flagged = new Set(d.findings.filter((f) => f.blocking && f.assignmentId !== null).map((f) => f.assignmentId));
  const people = [...d.people].sort((a, b) => (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9) || a.name.localeCompare(b.name));
  const vacant = d.assignments.filter((a) => a.userId === null && a.istDate === day && a.kind !== "off");
  const hoursOf = (a: WireMonthAssignment): string => `${fmtIst(a.startsAt)}–${fmtIst(a.endsAt)}`;
  const line = (key: string, name: string, sub: string, c: Cell | null, extra?: string): React.ReactElement => {
    const a = c?.a ?? null;
    const working = a !== null && a.kind !== "off";
    const mark = (a !== null && flagged.has(a.assignmentId) ? " rm-bad" : "") + (a !== null && picked?.assignmentId === a.assignmentId ? " rm-picked" : "")
      + (a !== null && focus?.assignmentId === a.assignmentId ? " rm-focus" : "");
    const body = (
      <>
        <span className="rm-dl-who"><span className="rm-name">{name}</span><span className="rm-grade">{sub}</span></span>
        <span className={`rm-dl-duty ${c?.cls ?? "rm-k-free"}`}>
          <span className="rm-dl-kind">{c === null ? t("rosterMonth.free") : c.label}</span>
          {c !== null && c.sub !== "" && <span className="rm-dl-sub">{c.sub}</span>}
        </span>
        <span className="rm-dl-hours mo">{working ? hoursOf(a) : ""}{extra ?? ""}</span>
        {onPick !== undefined && working && <span className="rm-dl-go" aria-hidden="true">›</span>}
      </>
    );
    return onPick !== undefined && working
      ? <button key={key} type="button" className={`rm-dl-row${mark}`} onClick={() => onPick(a)} data-testid={`slot-${a.assignmentId}`}>{body}</button>
      : <div key={key} className={`rm-dl-row${mark}`} data-testid={a !== null ? `slot-${a.assignmentId}` : `cell-${key}-${day}`}>{body}</div>;
  };
  const acts = u?.activities ?? [];
  const head = [actWord(acts, t) === "" ? null : t("rosterMonth.pillDay", { act: actWord(acts, t) }), u?.take === true ? t("rosterMonth.takeMark") : null,
    holiday === undefined ? null : t("rosterMonth.holidayShort", { kind: t(`rosterMonth.holidayKind.${holiday.kind}`, { defaultValue: holiday.kind }) })]
    .filter((x) => x !== null).join(" · ");
  return (
    <section className="ddf-card rm-daylist" data-testid="month-grid">
      <div className="rm-dl-head">
        <span className="rm-dl-day">{dayName(day, i18n.language)}</span>
        {head !== "" && <span className="rm-dl-unitday" data-testid={`day-${day}`}>{head}</span>}
      </div>
      {vacant.map((a) => line(a.assignmentId, t("rosterMonth.nobodyOnIt"), t(`rosterOnNow.position.${a.positionKey}`, { defaultValue: a.positionKey }),
        { cls: "rm-k-vacant", label: a.night ? t("rosterMonth.cell.night") : t("rosterMonth.cell.day"), sub: "", a, title: "" }))}
      {people.map((p) => {
        const c = cellFor(d, p.userId, day, t);
        // In words, not a hatch: a list has room to say "Not posted here".
        const said = c !== null && c.cls === "rm-k-none" ? { ...c, cls: "rm-k-free", label: t("rosterMonth.legend.notPosted") } : c;
        return line(p.userId, p.name, p.grade === "" ? "" : t(`rosterMonth.grade.${p.grade}`, { defaultValue: p.grade }), said);
      })}
      <div className="rm-foot">
        <span>{t("rosterMonth.gridFoot")}</span>
      </div>
    </section>
  );
}

function SlotEditor({ d, a, busy, onSave, onClose }: {
  d: WireUnitMonth; a: WireMonthAssignment; busy: boolean; onSave: (userId: string | null) => void; onClose: () => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [who, setWho] = useState<string>(a.userId ?? VACANT);
  return (
    <section className="ddf-card-strong rm-editor" data-testid="slot-editor">
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t(a.night ? "rosterMonth.editNight" : "rosterMonth.editDay", { day: dayName(a.istDate, i18n.language), from: fmtIst(a.startsAt), to: fmtIst(a.endsAt) })}</div>
        <div className="ddf-dim">{a.name ?? t("rosterMonth.vacantTitle", { position: t(`rosterOnNow.position.${a.positionKey}`, { defaultValue: a.positionKey }) })}</div>
      </div>
      <label>
        {t("rosterMonth.who")}
        <select value={who} onChange={(e) => setWho(e.target.value)} data-testid="slot-who">
          <option value={VACANT}>{t("rosterMonth.leaveVacant")}</option>
          {d.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
        </select>
      </label>
      <button type="button" className="ddf-btn ddf-btn-pri" disabled={busy || who === (a.userId ?? VACANT)} onClick={() => onSave(who === VACANT ? null : who)}>{t("rosterMonth.save")}</button>
      <button type="button" className="ddf-btn" onClick={onClose}>{t("rosterMonth.cancel")}</button>
    </section>
  );
}

function Fairness({ d, mName }: { d: WireUnitMonth; mName: string }): React.ReactElement {
  const { t } = useTranslation();
  // Compared within a grade only: a senior resident's nights are not a junior resident's.
  const gradeOf = (userId: string): string => d.people.find((p) => p.userId === userId)?.positionKey ?? "";
  const fewestOf = (userId: string): number => Math.min(...d.fairness.filter((f) => gradeOf(f.userId) === gradeOf(userId)).map((f) => f.nights));
  return (
    <section className="ddf-card rm-share" data-testid="fairness">
      <h2 className="ddf-cap" style={{ margin: 0 }}>{t("rosterMonth.fairShare", { month: mName })}</h2>
      {d.fairness.length === 0 ? <span className="ddf-dim">—</span> : d.fairness.map((f) => (
        <div key={f.userId} className="rm-share-row">
          <span className="rm-share-name">{f.name}</span>
          <span className="rm-share-line">{t("rosterMonth.shareLine", { nights: f.nights, sundays: f.sundays })}</span>
          {f.nights > fewestOf(f.userId) && <span className="ddf-dim">{t("rosterMonth.shareMore", { count: f.nights - fewestOf(f.userId) })}</span>}
        </div>
      ))}
    </section>
  );
}

function Rail({ d, busy, sorted, mName, unitShort, covers, onDecide, onVacate, onUndo, onPick, onAccept, onPublish, onShow }: {
  d: WireUnitMonth; busy: boolean; sorted: Sorted[]; mName: string; unitShort: string;
  covers: WireCoverRequest[]; onDecide: (requestId: string, approve: boolean) => void;
  onVacate: (f: WireMonthFinding, a: WireMonthAssignment) => void; onUndo: (s: Sorted) => void;
  onPick: (a: WireMonthAssignment) => void; onAccept: (f: WireMonthFinding, reason: string) => void; onPublish: () => void;
  onShow: (f: WireMonthFinding) => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const published = d.period?.status === "published";
  const { blocking, warnings } = d.counts;
  const countLine = blocking > 0
    ? t("rosterMonth.countMustFix", { count: blocking }) + (warnings > 0 ? ` · ${t("rosterMonth.countLook", { count: warnings })}` : "")
    : warnings > 0 ? t("rosterMonth.countLook", { count: warnings }) : t("rosterMonth.allClear");
  const why = published ? null : blocking > 0 ? t("rosterMonth.publishBlocked", { count: blocking }) : !d.youMay.publish ? t("rosterMonth.publishNotYours") : null;
  const care = takenCareOf(d, t, lang, unitShort);
  return (
    <>
      {d.period !== null && (
        <section className="ddf-card-strong rm-pub" data-testid="before-you-publish">
          <div className="rm-pub-head">
            <h2>{t("rosterMonth.beforeYouPublish")}</h2>
            <span className="rm-count" style={{ color: blocking > 0 ? "#b23a30" : warnings > 0 ? "#8a5a0b" : "#0e6b4e" }} data-testid="count-line">{countLine}</span>
          </div>
          {d.findings.length === 0 && sorted.length === 0 && <p className="rm-f-text" style={{ color: "#0e6b4e" }}>{t("rosterMonth.noFindings")}</p>}
          {d.findings.map((f, i) => (
            <FindingCard key={`${f.ruleKey}-${f.assignmentId ?? ""}-${f.userId ?? ""}-${String(i)}`} f={f} d={d} busy={busy} published={published}
              onVacate={onVacate} onPick={onPick} onAccept={onAccept} onShow={onShow} />
          ))}
          {sorted.map((s) => (
            <div key={s.key} className="rm-f rm-f-done" data-testid="finding-sorted">
              <div className="rm-f-top">
                <span className="rm-tag rm-tag-done">{t("rosterMonth.tag.sorted")}</span>
                {s.when !== null && <span className="rm-f-when">{dayName(s.when, lang)}</span>}
              </div>
              <p className="rm-f-text">{s.text}</p>
              <div className="rm-done">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7.5" /></svg>
                <span>{t("rosterMonth.doneVacated", { name: s.prevName ?? t("rosterMonth.someone") })}</span>
                {!published && d.youMay.edit && <button type="button" className="rm-undo" disabled={busy} onClick={() => onUndo(s)} data-testid="undo">{t("rosterMonth.undo")}</button>}
              </div>
            </div>
          ))}
          {published ? (
            <div className="rm-published" data-testid="published">
              <strong>{t("rosterMonth.publishedLine", { month: mName, unit: unitShort, version: d.period.version })}</strong>
              <span>{t("rosterMonth.publishedNote")}</span>
            </div>
          ) : (
            <>
              <button type="button" data-testid="publish" className="rm-publish" disabled={why !== null || busy} aria-describedby="publish-why" onClick={onPublish}>
                {why === null ? t("rosterMonth.publish", { month: mName, unit: unitShort })
                  : blocking > 0 ? t("rosterMonth.stopsPublish", { count: blocking }) : t("rosterMonth.cannotPublish")}
              </button>
              {why !== null && <p id="publish-why" className="rm-why" data-testid="publish-why">{why}</p>}
            </>
          )}
        </section>
      )}
      {(published || covers.length > 0) && <AskedOfYou covers={covers} busy={busy} onDecide={onDecide} />}
      {care.length > 0 && (
        <section className="ddf-card rm-care" data-testid="taken-care-of">
          <h2>{t("rosterMonth.takenCareOf")}</h2>
          <div className="rm-care-list">{care.map((c) => <span key={c}>{c}</span>)}</div>
        </section>
      )}
    </>
  );
}

function FindingCard({ f, d, busy, published, onVacate, onPick, onAccept, onShow }: {
  f: WireMonthFinding; d: WireUnitMonth; busy: boolean; published: boolean;
  onVacate: (f: WireMonthFinding, a: WireMonthAssignment) => void; onPick: (a: WireMonthAssignment) => void;
  onAccept: (f: WireMonthFinding, reason: string) => void; onShow: (f: WireMonthFinding) => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [reasoning, setReasoning] = useState(false);
  const [reason, setReason] = useState("");
  const a = f.assignmentId === null ? undefined : d.assignments.find((x) => x.assignmentId === f.assignmentId);
  const kind = f.accepted !== null ? "done" : f.blocking ? "stop" : f.severity === "warn" ? "look" : "note";
  const tag = f.accepted !== null ? t("rosterMonth.tag.accepted") : f.blocking ? t("rosterMonth.tag.mustFix") : f.severity === "warn" ? t("rosterMonth.tag.look") : t("rosterMonth.tag.note");
  const open = !published && f.accepted === null && f.severity !== "info";
  const canVacate = open && d.youMay.edit && a !== undefined && a.userId !== null;
  const canPick = open && d.youMay.edit && a !== undefined;
  // Only a WARNING is accepted with a reason here; a must-fix is fixed, never signed away on this screen.
  const canAccept = open && d.youMay.acceptWarning && f.severity === "warn" && !f.blocking;
  return (
    <div
      className={`rm-f rm-f-${kind}${f.istDate !== null ? " rm-f-click" : ""}`} data-testid={`finding-${f.ruleKey}`}
      // Clicking the card (not one of its buttons) shows its cell on the grid.
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button, input, label")) onShow(f); }}
    >
      <div className="rm-f-top">
        <span className={`rm-tag rm-tag-${kind}`}>{tag}</span>
        {f.istDate !== null && (
          <button type="button" className="rm-f-when rm-f-show" onClick={() => onShow(f)} title={t("rosterMonth.showOnGrid")} data-testid="finding-show">
            {dayName(f.istDate, i18n.language)} <span aria-hidden="true">↗</span><span className="sr">{t("rosterMonth.showOnGrid")}</span>
          </button>
        )}
      </div>
      <p className="rm-f-text">{sentence(f, t, i18n.language)}</p>
      {f.accepted !== null && <p className="rm-f-text" style={{ fontSize: 12, color: "#0a5039" }}>{t("rosterMonth.acceptedBy", { name: f.accepted.byName, reason: f.accepted.reason })}</p>}
      {(canVacate || canPick || canAccept) && !reasoning && (
        <div className="rm-f-acts">
          {canVacate && <button type="button" className="ddf-btn ddf-btn-pri" disabled={busy} onClick={() => onVacate(f, a)}>{t("rosterMonth.fixVacate", { name: a.name ?? "" })}</button>}
          {canPick && <button type="button" className="ddf-btn" disabled={busy} onClick={() => onPick(a)}>{t("rosterMonth.pickOther")}</button>}
          {canAccept && <button type="button" className="ddf-btn" onClick={() => setReasoning(true)}>{t("rosterMonth.acceptWhy")}</button>}
        </div>
      )}
      {canAccept && reasoning && (
        <div className="rm-f-reason">
          <label className="sr" htmlFor={`reason-${f.ruleKey}-${f.assignmentId ?? f.userId ?? ""}`}>{t("rosterMonth.reason")}</label>
          <input id={`reason-${f.ruleKey}-${f.assignmentId ?? f.userId ?? ""}`} placeholder={t("rosterMonth.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="ddf-btn ddf-btn-pri" disabled={busy || reason.trim() === ""} onClick={() => onAccept(f, reason.trim())}>{t("rosterMonth.accept")}</button>
        </div>
      )}
    </div>
  );
}

/** "Already taken care of" — only what the month's own data says: holidays, Sunday takes, postings. */
export function takenCareOf(d: WireUnitMonth, t: T, lang: string, unitShort: string): string[] {
  const out: string[] = [];
  for (const p of d.people) {
    if (p.postedTo !== null) out.push(t("rosterMonth.care.postingEnds", { name: p.name, day: dayShort(p.postedTo, lang) }));
    if (p.postedFrom !== null) out.push(t("rosterMonth.care.postingStarts", { name: p.name, day: dayShort(p.postedFrom, lang) }));
  }
  for (const h of d.holidays) {
    out.push(t("rosterMonth.care.holiday", {
      day: dayName(h.istDate, lang), kind: t(`rosterMonth.holidayKind.${h.kind}`, { defaultValue: h.kind }),
      pattern: t(`rosterMonth.holidayPattern.${h.pattern}`, { defaultValue: h.pattern }),
    }));
  }
  const sundays = d.unitDays.filter((u) => u.take && weekday(u.istDate) === 0).map((u) => dayShort(u.istDate, lang));
  if (sundays.length > 0) out.push(t("rosterMonth.care.sundayTake", { unit: unitShort, days: sundays.join(", ") }));
  return out;
}

/**
 * THIS SCREEN'S OWN ANSWERER — "who is free on the 14th?", "kal raat kaun hai": the day named by a
 * number (or today / tomorrow / kal), answered from the grid on the screen.
 */
export function answerFromMonth(question: string, d: WireUnitMonth, t: T, lang: string): string | null {
  const q = question.toLowerCase();
  const n = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(q);
  const today = todayIst(new Date());
  let day: string | undefined;
  if (n !== null) day = d.days.find((x) => dayNum(x) === Number(n[1]));
  else if (/\b(tomorrow|kal)\b/.test(q)) day = todayIst(new Date(Date.now() + 86_400_000));
  else if (/\b(today|aaj|tonight)\b/.test(q)) day = today;
  if (day === undefined || !d.days.includes(day)) return null;
  const on = (night: boolean): string => d.assignments.filter((a) => a.istDate === day && a.kind === "duty" && a.night === night)
    .map((a) => a.name ?? t("rosterMonth.vacantRow")).join(", ") || t("copilot.when.nobody");
  const away = d.leave.filter((l) => l.from <= day! && day! <= l.to).map((l) => d.people.find((p) => p.userId === l.userId)?.name ?? l.userId);
  const busy = new Set(d.assignments.filter((a) => a.istDate === day && a.userId !== null).map((a) => a.userId));
  const free = d.people.filter((p) => !busy.has(p.userId) && !away.includes(p.name) && cellFor(d, p.userId, day!, t)?.cls !== "rm-k-rest" && cellFor(d, p.userId, day!, t)?.cls !== "rm-k-none").map((p) => p.name);
  // The boards' voice (review 2026-10-04): the day in words, "nobody" for an empty list — never a dash.
  const list = (names: readonly string[]): string => (names.length === 0 ? t("copilot.when.nobody") : names.join(", "));
  return t("rosterMonth.answerDay", {
    day: dayWords(new Date(`${day}T12:00:00+05:30`), lang), night: on(true), dayDuty: on(false), away: list(away), free: list(free),
  });
}

/** A month's slot as the cover page names a duty. */
function asDutyRef(a: WireMonthAssignment, d: WireUnitMonth): WireDutyRef {
  return {
    assignmentId: a.assignmentId, userId: a.userId, positionKey: a.positionKey, positionLabel: a.positionKey,
    startsAt: a.startsAt, endsAt: a.endsAt, istDate: a.istDate, night: a.night, mode: a.mode, kind: a.kind,
    departmentId: d.unit.departmentId, teamId: d.unit.teamId, teamName: d.unit.name,
  };
}

/**
 * "ASKED OF YOU" — the board's rail card (Main.dc.html): each cover or swap waiting on THIS reader,
 * as a sentence naming both people and both days, what the validator says about it now, and
 * Approve / Not this time. A request waiting on the person asked shows that and no buttons.
 */
function AskedOfYou({ covers, busy, onDecide }: { covers: WireCoverRequest[]; busy: boolean; onDecide: (id: string, approve: boolean) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const open = covers.filter((c) => c.status === "asked" || c.status === "accepted");
  const decided = covers.filter((c) => (c.status === "approved" || c.status === "refused") && c.decidedBy !== null);
  const waiting = open.filter((c) => c.youMay.approve || c.youMay.answer);
  return (
    <section className="ddf-card rm-asked" data-testid="asked-of-you">
      <div className="rm-asked-head">
        <h2>{t("rosterMonth.askedOfYou")}</h2>
        <span className="mo rm-asked-count" data-testid="asked-count">{waiting.length}</span>
      </div>
      {open.length === 0 && decided.length === 0 && <span className="rm-asked-none">{t("rosterMonth.asked.none")}</span>}
      {open.map((c) => (
        <div key={c.requestId} className="rm-asked-item" data-testid={`asked-${c.requestId}`}>
          <div className="rm-asked-text">
            {bolded(
              [
                c.give === null
                  ? t("rosterMonth.asked.cover", { a: c.owner.name, b: c.counterpart.name, day: dutyName(c.duty, t, lang) })
                  : t("rosterMonth.asked.swap", { a: c.owner.name, b: c.counterpart.name, aDay: dutyName(c.duty, t, lang), bDay: dutyName(c.give, t, lang) }),
                c.status === "accepted" ? t("rosterMonth.asked.saidYes", { b: c.counterpart.name }) : t("rosterMonth.asked.waitingYes", { b: c.counterpart.name }),
                c.crossUnit ? t("rosterMonth.asked.crossUnit") : "",
              ].filter((x) => x !== "").join(" "),
              [c.owner.name, c.counterpart.name, dutyName(c.duty, t, lang), ...(c.give === null ? [] : [dutyName(c.give, t, lang)])],
            )}
          </div>
          {c.check === null
            ? <div className="rm-asked-ok">{t(c.give === null ? "rosterMonth.asked.checkedCover" : "rosterMonth.asked.checkedSwap")}</div>
            : <div className={c.check.severity === "warn" ? "rm-asked-warn" : "rm-asked-bad"}>{t("rosterMonth.asked.checkedNot", { why: reasonText(c.check, t) })}</div>}
          {c.youMay.approve && (
            <div className="rm-asked-acts">
              <button type="button" className="rm-asked-yes" disabled={busy} onClick={() => onDecide(c.requestId, true)} data-testid="approve-cover">{t("rosterMonth.asked.approve")}</button>
              <button type="button" className="rm-asked-no" disabled={busy} onClick={() => onDecide(c.requestId, false)} data-testid="refuse-cover">{t("rosterMonth.asked.notThisTime")}</button>
            </div>
          )}
        </div>
      ))}
      {decided.map((c) => (
        <div key={c.requestId} className={c.status === "approved" ? "rm-asked-done" : "rm-asked-refused"} data-testid={`decided-${c.requestId}`}>
          {c.status === "approved"
            ? t("rosterMonth.asked.approved", { a: c.owner.name, b: c.counterpart.name })
            : c.refusedRule !== null
              ? t("rosterMonth.asked.refusedRule", { why: reasonText({ ruleKey: c.refusedRule, severity: "block", params: {} }, t) })
              : t("rosterMonth.asked.refused", { a: c.owner.name, b: c.counterpart.name })}
        </div>
      ))}
    </section>
  );
}

/** The board's sentence with each name and day in bold: `values` are found in `text` and wrapped. */
function bolded(text: string, values: string[]): React.ReactNode[] {
  const want = [...new Set(values.filter((v) => v !== ""))].sort((a, b) => b.length - a.length);
  if (want.length === 0) return [text];
  const re = new RegExp(`(${want.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part, i) => (want.includes(part) ? <b key={i}>{part}</b> : part));
}
