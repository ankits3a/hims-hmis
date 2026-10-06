import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { DoctorDeskFrame } from "../components/doctor-desk/frame";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import {
  answerCover, askCover, fetchCoverOptions, fetchMyDuties, rosterErrorText, withdrawCover,
} from "../lib/roster-api";
import type {
  WireCoverCandidate, WireCoverOptions, WireCoverReason, WireCoverRefusal, WireCoverRequest, WireDutyRef, WireMyDuties, WireMyDuty,
} from "../lib/roster-api";
import { shortUnit, whoFrom } from "./roster-on-now";
import { coverBuckets, dutyWhatKey, greetingKey, greetingName, requestTone, weekOf } from "../../../../packages/contracts/src/roster-board";
import { useAuth } from "../lib/auth";
import "./roster.css";

/**
 * ═══ 20-U U5c — MY DUTIES (`docs/design/2026-09-20-roster/MyDuties.dc.html`) ═══
 *
 * The board the owner approved on 2026-09-20 — a resident's phone — ported into the Doctor Desk frame:
 * a greeting, TODAY on the one dark card, the rest of the week one card per day, and on each duty
 * still ahead *"I can't do this"*. That opens the duty's own page: who CAN take it without breaking a
 * rule, and for everybody else WHY NOT, in a sentence (`unavailable` for leave — never its kind). Ask
 * one person (or offer them a swap); **the duty stays yours until it is approved**, and the card on
 * the home page says where the request stands. A request somebody makes OF you is on the same page,
 * with Yes and No. Desktop draws the same column, with the requests beside the week.
 *
 * DECIDED where the board promises what the system does not do (U6 close, plan §11): "Sent on the app
 * and on WhatsApp" and the 19:00 WhatsApp line are not drawn — no message template exists for them
 * (kernel/notify is shared); the card says where the person asked will see it. "Call my SR" is a
 * `tel:` link only when the unit's SR is on duty NOW and has a number (D6); otherwise it is not drawn.
 */

type T = (k: string, o?: Record<string, unknown>) => string;
type Props = { at?: string };

const loc = (lang: string): string => (lang.startsWith("hi") ? "hi-IN" : "en-GB");
const dayAt = (istDate: string): Date => new Date(`${istDate}T12:00:00Z`);
const fmtDay = (istDate: string, lang: string, o: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(loc(lang), { timeZone: "UTC", ...o }).format(dayAt(istDate)).replace(",", "");
/** "WED" — the board's three-letter day. */
export const dowShort = (istDate: string, lang: string): string => fmtDay(istDate, lang, { weekday: "short" }).toUpperCase();
/** "Saturday" */
export const dowLong = (istDate: string, lang: string): string => fmtDay(istDate, lang, { weekday: "long" });
/** "Saturday 10 Oct" */
export const dayLong = (istDate: string, lang: string): string => fmtDay(istDate, lang, { weekday: "long", day: "numeric", month: "short" });
const hoursOf = (d: { startsAt: string; endsAt: string }, t: T): string => t("rosterMyDuties.hours", { from: fmtIst(d.startsAt), to: fmtIst(d.endsAt) });

/** What a duty IS, in one or two words: "Ward night", "OPD", "Theatre", "Take · 24 hours". */
export function dutyWhat(d: WireDutyRef & { activities?: string[] }, t: T): string {
  const what = dutyWhatKey(d);
  return what.fallback === undefined ? t(what.key) : t(what.key, { defaultValue: t(what.fallback) });
}

/** "Saturday night" / "Saturday's duty" — how a request names the duty, as the board does. */
export function dutyName(d: WireDutyRef, t: T, lang: string): string {
  return t(d.night ? "rosterMyDuties.dutyNight" : "rosterMyDuties.dutyDay", { day: dowLong(d.istDate, lang) });
}

/** Why a person cannot take a duty — "Has Sunday night. This would be a second night in three." */
export function whyNot(r: Pick<WireCoverRefusal, "reason" | "near">, t: T, lang: string): string {
  const why = reasonText(r.reason, t);
  if (r.near === null || r.reason.ruleKey === "unavailable") return why;
  const near = t(r.near.night ? "rosterMyDuties.nearNight" : "rosterMyDuties.nearDay", { day: dowLong(r.near.istDate, lang) });
  return `${near} ${why}`;
}
export function reasonText(r: WireCoverReason, t: T): string {
  return t(`rosterMyDuties.why.${r.ruleKey}`, { defaultValue: t("rosterMyDuties.why.other", { rule: r.ruleKey }) });
}

function greeting(at: string, name: string | null, t: T): string {
  // "Dr. Meena Joshi" → "Dr. Meena": the board greets a colleague by first name.
  return t(`rosterMyDuties.greeting.${greetingKey(at)}`, { name: greetingName(name) });
}

/** One entry per day of the week — the shared reading rule (`roster-board.ts`). */
export { weekOf };

export function RosterMyDuties({ at }: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { username } = useAuth();
  const qc = useQueryClient();
  const [picking, setPicking] = useState<WireMyDuty | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["roster", "my-duties", at ?? "now"], queryFn: () => fetchMyDuties(at), refetchInterval: at === undefined ? 60_000 : false });
  const m = q.data;
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["roster", "my-duties"] }); };
  const answer = useMutation({ mutationFn: (v: { id: string; yes: boolean }) => answerCover(v.id, v.yes), onSuccess: () => { setRefusal(null); refresh(); }, onError: (e) => setRefusal(rosterErrorText(e, t)) });
  const withdraw = useMutation({ mutationFn: (id: string) => withdrawCover(id), onSuccess: () => { setRefusal(null); refresh(); }, onError: (e) => setRefusal(rosterErrorText(e, t)) });

  return (
    <DoctorDeskFrame
      active="myDuties" testId="roster-my-duties"
      context={t("rosterMyDuties.context")}
      who={whoFrom(m?.you, username, t)}
    >
      {q.isError && <p role="alert" className="ro-alert">{rosterErrorText(q.error, t)}</p>}
      {q.isPending && <p className="ddf-dim">{t("rosterOnNow.loading")}</p>}
      {refusal !== null && <p role="alert" className="ro-alert" data-testid="my-duties-error">{refusal}</p>}
      {m !== undefined && picking === null && (
        <Home
          m={m} lang={lang} busy={answer.isPending || withdraw.isPending}
          onPick={(d) => { setRefusal(null); setPicking(d); }}
          onAnswer={(id, yes) => answer.mutate({ id, yes })}
          onWithdraw={(id) => withdraw.mutate(id)}
        />
      )}
      {m !== undefined && picking !== null && (
        <CoverPicker
          duty={picking}
          onBack={() => setPicking(null)}
          onAsked={() => { setPicking(null); refresh(); }}
        />
      )}
    </DoctorDeskFrame>
  );
}

function Home({ m, lang, busy, onPick, onAnswer, onWithdraw }: {
  m: WireMyDuties; lang: string; busy: boolean;
  onPick: (d: WireMyDuty) => void; onAnswer: (id: string, yes: boolean) => void; onWithdraw: (id: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const { actor } = useAuth();
  const week = weekOf(m);
  const today = week[0]!;
  const tonight = m.duties.find((d) => d.istDate === today.istDate && d.night);
  const me = m.you;
  const sub = [me.departmentName, me.unitName === null ? null : shortUnit(me.unitName, me.departmentName ?? ""), me.grade === null ? null : t(`doctorDesk.grade.${me.grade}`, { defaultValue: me.grade })]
    .filter((x): x is string => x !== null && x !== "").join(" · ");
  const meId = actor?.id ?? null;
  // Requests about MY duty (I asked, or my SR asked for me), and ones I have already answered.
  const { mine, answered, ofMe, asked } = coverBuckets(m.requests, meId);
  const go = (e: React.MouseEvent, to: string): void => {
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to });
  };

  return (
    <div className="md-home" data-testid="my-duties-home">
      <div className="md-col md-col-main">
        <div className="md-hello">
          <h1 className="md-h1" data-testid="my-duties-greeting">{greeting(m.at, me.name, t)}</h1>
          {sub !== "" && <span className="md-sub">{sub}</span>}
        </div>

        <section className="md-today" data-testid="my-duties-today">
          <span className="md-today-cap">{t("rosterMyDuties.today")}</span>
          <span className="md-today-what">{today.duty === null ? (today.rest !== null ? t("rosterMyDuties.rest") : t("rosterMyDuties.todayNone")) : dutyWhat(today.duty, t)}</span>
          <span className="md-today-text">
            {today.duty !== null
              ? [hoursOf(today.duty, t), today.duty.teamName === null ? null : shortUnit(today.duty.teamName, me.departmentName ?? "")].filter((x) => x !== null).join(" · ")
              : today.rest !== null ? t("rosterMyDuties.restDetail", { time: fmtIst(today.rest.until) }) : t("rosterMyDuties.todayNoneSub")}
          </span>
          <div className="md-chips">
            <span className="md-chip" data-testid="my-duties-tonight">{tonight === undefined ? t("rosterMyDuties.tonightFree") : t("rosterMyDuties.tonightDuty", { what: dutyWhat(tonight, t) })}</span>
            {m.onTake !== null && <span className="md-chip">{t("rosterMyDuties.onTake", { unit: shortUnit(m.onTake.name, me.departmentName ?? "") })}</span>}
          </div>
        </section>

        {ofMe.length > 0 && (
          <section className="md-ofme" data-testid="asked-of-you">
            <h2 className="md-cap">{t("rosterMyDuties.askedOfYou")}</h2>
            {ofMe.map((r) => (
              <div key={r.requestId} className="md-ofme-card" data-testid={`asked-of-you-${r.requestId}`}>
                <span className="md-ofme-text">
                  {r.give === null
                    ? t("rosterMyDuties.ofMe.cover", { name: r.owner.name, duty: dayLong(r.duty.istDate, lang), part: t(r.duty.night ? "rosterMyDuties.partNight" : "rosterMyDuties.partDay"), hours: hoursOf(r.duty, t) })
                    : t("rosterMyDuties.ofMe.swap", { name: r.owner.name, duty: dutyName(r.duty, t, lang), give: dutyName(r.give, t, lang) })}
                </span>
                {r.check === null
                  ? <span className="md-check-ok">{t("rosterMyDuties.ofMe.checkOk")}</span>
                  : <span className={r.check.severity === "warn" ? "md-check-warn" : "md-check-bad"}>{reasonText(r.check, t)}</span>}
                <div className="md-ofme-acts">
                  <button type="button" className="md-btn-pri" disabled={busy} onClick={() => onAnswer(r.requestId, true)} data-testid="answer-yes">{t("rosterMyDuties.ofMe.yes")}</button>
                  <button type="button" className="md-btn" disabled={busy} onClick={() => onAnswer(r.requestId, false)} data-testid="answer-no">{t("rosterMyDuties.ofMe.no")}</button>
                </div>
              </div>
            ))}
          </section>
        )}
        {mine.map((r) => <MyRequestCard key={r.requestId} r={r} lang={lang} busy={busy} onWithdraw={onWithdraw} />)}
        {answered.map((r) => (
          <section key={r.requestId} className={r.status === "approved" ? "md-asked-ok" : r.status === "refused" ? "md-asked-bad" : "md-asked"} data-testid={`answered-${r.requestId}`}>
            <span className="md-asked-title">{t(`rosterMyDuties.theirs.title_${r.status}`, { name: r.owner.name, duty: dutyName(r.duty, t, lang) })}</span>
          </section>
        ))}

        <section className="md-week" aria-labelledby="md-week-h">
          <h2 id="md-week-h" className="md-cap">{t("rosterMyDuties.restOfWeek")}</h2>
          {week.slice(1).map((d) => {
            const duty = d.duty;
            const canAsk = duty !== null && duty.upcoming && !asked.has(duty.assignmentId);
            return (
              <div key={d.istDate} className="md-day" data-testid={`my-day-${d.istDate}`}>
                <div className="md-day-date">
                  <span className="md-dow">{dowShort(d.istDate, lang)}</span>
                  <span className="md-date mo">{Number(d.istDate.slice(8, 10))}</span>
                </div>
                <div className="md-day-body">
                  <span className="md-what">{duty !== null ? dutyWhat(duty, t) : d.rest !== null ? t("rosterMyDuties.rest") : t("rosterMyDuties.off")}</span>
                  <span className="md-detail">
                    {duty !== null
                      ? [hoursOf(duty, t), duty.teamName === null || duty.teamName === me.unitName ? null : shortUnit(duty.teamName, me.departmentName ?? "")].filter((x) => x !== null).join(" · ")
                      : d.rest !== null
                        ? (todayIst(new Date(d.rest.until)) === d.istDate ? t("rosterMyDuties.restDetail", { time: fmtIst(d.rest.until) }) : t("rosterMyDuties.restDetailShort"))
                        : t("rosterMyDuties.offDetail")}
                  </span>
                </div>
                {canAsk && (
                  <button type="button" className="md-cant" onClick={() => onPick(duty)} data-testid={`cant-${duty.assignmentId}`}>
                    <span>{t("rosterMyDuties.cant1")}</span><span>{t("rosterMyDuties.cant2")}</span>
                  </button>
                )}
              </div>
            );
          })}
        </section>
      </div>

      <div className="md-col md-col-side">
        <div className="md-spacer" />
        <div className="md-links">
          <a href="/roster/on-now" className="md-link" onClick={(e) => go(e, "/roster/on-now")}>{t("rosterMyDuties.whoIsOn")}</a>
          {m.mySr !== null && m.mySr.phone !== null && m.mySr.phone !== "" && (
            <a href={`tel:${m.mySr.phone}`} className="md-link md-link-pri" title={t("rosterMyDuties.callSrName", { name: m.mySr.name })} data-testid="call-my-sr">{t("rosterMyDuties.callSr")}</a>
          )}
        </div>
      </div>
    </div>
  );
}

function MyRequestCard({ r, lang, busy, onWithdraw }: { r: WireCoverRequest; lang: string; busy: boolean; onWithdraw: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const duty = dutyName(r.duty, t, lang);
  const name = r.counterpart.name;
  const tone = { ok: "md-asked-ok", bad: "md-asked-bad", open: "md-asked" }[requestTone(r.status)];
  const title = r.kind === "swap" && (r.status === "asked")
    ? t("rosterMyDuties.asked.titleSwap", { name, duty, give: dutyName(r.give!, t, lang) })
    : t(`rosterMyDuties.asked.title_${r.status}`, { name, duty });
  return (
    <section className={tone} data-testid={`my-request-${r.requestId}`} data-status={r.status}>
      <span className="md-asked-title">{title}</span>
      <span className="md-asked-body">
        {r.status === "asked" && (
          <>{t(r.crossUnit ? "rosterMyDuties.asked.bodyCross" : "rosterMyDuties.asked.bodySame")} <strong>{t("rosterMyDuties.asked.stillYours", { duty })}</strong></>
        )}
        {r.status === "accepted" && <>{t(r.crossUnit ? "rosterMyDuties.asked.waitingHod" : "rosterMyDuties.asked.waiting")} <strong>{t("rosterMyDuties.asked.stillYours", { duty })}</strong></>}
        {r.status === "approved" && t("rosterMyDuties.asked.approvedBody", { by: r.decidedBy?.name ?? "" })}
        {r.status === "refused" && (r.refusedRule !== null
          ? <>{t("rosterMyDuties.asked.refusedRule", { why: reasonText({ ruleKey: r.refusedRule, severity: "block", params: {} }, t) })} <strong>{t("rosterMyDuties.asked.stillYoursNow", { duty })}</strong></>
          : <>{t("rosterMyDuties.asked.refusedBy", { by: r.decidedBy?.name ?? "" })} <strong>{t("rosterMyDuties.asked.stillYoursNow", { duty })}</strong></>)}
        {r.status === "declined" && t("rosterMyDuties.asked.declinedBody")}
      </span>
      {r.youMay.withdraw && (
        <button type="button" className="md-withdraw" disabled={busy} onClick={() => onWithdraw(r.requestId)} data-testid="withdraw">{t("rosterMyDuties.asked.withdraw")}</button>
      )}
    </section>
  );
}

/**
 * "I CAN'T DO THIS" — the duty's own page: who can take it, who cannot and why. Exported because the
 * unit's month offers the same page for a published duty (its SR asks on somebody's behalf).
 */
export function CoverPicker({ duty, onBack, onAsked, embedded = false }: {
  duty: WireDutyRef; onBack: () => void; onAsked: () => void;
  /** Drawn inside another screen (the unit's month): no page height, and "Close" for "Back". */
  embedded?: boolean;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [error, setError] = useState<string | null>(null);
  const o = useQuery({ queryKey: ["roster", "cover-options", duty.assignmentId], queryFn: () => fetchCoverOptions(duty.assignmentId) });
  const ask = useMutation({
    mutationFn: (v: { counterpartId: string; counterpartAssignmentId?: string }) => askCover({ assignmentId: duty.assignmentId, ...v }),
    onSuccess: () => { setError(null); onAsked(); },
    onError: (e) => setError(rosterErrorText(e, t)),
  });
  const d = o.data;
  return (
    <div className={`md-pick${embedded ? " md-pick-embedded" : ""}`} data-testid="cover-picker">
      <button type="button" className="md-back" onClick={onBack} data-testid="cover-back">{t(embedded ? "rosterMyDuties.pick.close" : "rosterMyDuties.pick.back")}</button>
      <div className="md-hello">
        <h1 className="md-h1">{t("rosterMyDuties.pick.title", { day: dayLong(duty.istDate, lang), part: t(duty.night ? "rosterMyDuties.partNight" : "rosterMyDuties.partDay") })}</h1>
        <span className="md-intro">{t("rosterMyDuties.pick.intro", { what: dutyWhat(duty, t), hours: hoursOf(duty, t) })}</span>
      </div>
      {o.isPending && <p className="ddf-dim">{t("rosterMyDuties.pick.looking")}</p>}
      {o.isError && <p role="alert" className="ro-alert">{rosterErrorText(o.error, t)}</p>}
      {error !== null && <p role="alert" className="ro-alert" data-testid="cover-error">{error}</p>}
      {d !== undefined && <Options d={d} lang={lang} busy={ask.isPending} onAsk={(v) => ask.mutate(v)} />}
      <div className="md-spacer" />
      <span className="md-foot">{t("rosterMyDuties.pick.whatsapp")}</span>
    </div>
  );
}

function Options({ d, lang, busy, onAsk }: {
  d: WireCoverOptions; lang: string; busy: boolean; onAsk: (v: { counterpartId: string; counterpartAssignmentId?: string }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  if (d.openRequestId !== null) return <p className="md-note" role="status">{t("rosterMyDuties.pick.already")}</p>;
  return (
    <>
      <section className="md-list" aria-labelledby="md-can-h">
        <h2 id="md-can-h" className="md-cap md-cap-acc">{t("rosterMyDuties.pick.canTake")}</h2>
        {d.canTake.length === 0 && <p className="md-nobody" data-testid="nobody-can">{t("rosterMyDuties.pick.nobody")}</p>}
        {d.canTake.map((c) => <Candidate key={c.userId} c={c} duty={d.duty} lang={lang} busy={busy} onAsk={onAsk} />)}
      </section>
      {d.cannot.length > 0 && (
        <section className="md-list" aria-labelledby="md-cannot-h">
          <h2 id="md-cannot-h" className="md-cap">{t("rosterMyDuties.pick.cannot")}</h2>
          {d.cannot.map((c) => (
            <div key={c.userId} className="md-cannot" data-testid={`cannot-${c.userId}`}>
              <span className="md-cannot-name">{`${c.name} · ${shortUnit(c.teamName, d.duty.teamName?.replace(/ Unit .*$/, "") ?? "")}`}</span>
              <span className="md-cannot-why">{whyNot(c, t, lang)}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Candidate({ c, duty, lang, busy, onAsk }: {
  c: WireCoverCandidate; duty: WireDutyRef; lang: string; busy: boolean;
  onAsk: (v: { counterpartId: string; counterpartAssignmentId?: string }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const next = c.nextDay.duty === null
    ? t("rosterMyDuties.pick.nextOff", { day: dowLong(c.nextDay.istDate, lang) })
    : t(c.nextDay.duty.night ? "rosterMyDuties.pick.nextNight" : "rosterMyDuties.pick.nextDuty", { day: dowLong(c.nextDay.istDate, lang) });
  const dept = duty.teamName?.replace(/ Unit .*$/, "") ?? "";
  const swap = c.swaps[0];
  return (
    <div className="md-can" data-testid={`can-${c.userId}`}>
      <div className="md-can-body">
        <span className="md-can-name">{c.name}</span>
        <span className="md-can-line">{[t(`doctorDesk.grade.${c.grade}`, { defaultValue: c.grade }), shortUnit(c.teamName, dept), t("rosterMyDuties.pick.free", { day: dowLong(duty.istDate, lang) }) + ", " + next].join(" · ")}</span>
        {c.crossUnit && <span className="md-can-hod">{t("rosterMyDuties.pick.crossUnit")}</span>}
        {swap !== undefined && (
          <span className="md-can-swap">
            {t("rosterMyDuties.pick.swapLine", { duty: dutyName(swap, t, lang) })}{" "}
            <button type="button" className="md-swap" disabled={busy} onClick={() => onAsk({ counterpartId: c.userId, counterpartAssignmentId: swap.assignmentId })} data-testid={`swap-${c.userId}`}>{t("rosterMyDuties.pick.swap")}</button>
          </span>
        )}
      </div>
      <button type="button" className="md-ask" disabled={busy} onClick={() => onAsk({ counterpartId: c.userId })} data-testid={`ask-${c.userId}`}>{t("rosterMyDuties.pick.ask")}</button>
    </div>
  );
}
