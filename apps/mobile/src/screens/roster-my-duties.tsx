import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { rosterApi, rosterRefusal, type RosterApi } from "../roster/api";
import { coverBuckets, greetingKey, greetingName, istDay, requestTone, shortUnit, weekOf } from "../roster/rules";
import type { WireCoverCandidate, WireCoverOptions, WireCoverRequest, WireDutyRef, WireMyDuties, WireMyDuty } from "../roster/rules";
import { dateOfMonth, dayLong, dowLong, dowShort, dutyName, dutyWhat, gradeWord, hm, hoursOf, reasonText, whyNot } from "../roster/words";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";

/**
 * MY DUTIES, ON A PHONE (plan M5; owner 2026-10-06; board `docs/design/2026-09-20-roster/MyDuties.dc.html`
 * — the board WAS drawn as a resident's phone). The web screen's page on the same routes
 * (`GET /roster/my-duties`, `…/duties/:id/cover-options`, `POST /roster/covers…`) and the same
 * reading rules (`../roster/rules`, one file with the web):
 *
 *   today             what today is — a duty, rest after a night, or nothing — on a LIGHT card
 *                     (owner ruling: no dark slabs), with tonight and the unit on take
 *   asked of you      a cover or swap somebody asks of me: the server's own check, then Yes / No
 *   my requests       where each thing I asked stands; the duty stays mine until it is approved
 *   the week          one row per day; on a duty still ahead, "I can't do this"
 *   I can't do this   who CAN take it without breaking a rule, and for everybody else WHY NOT in a
 *                     sentence (`unavailable` for leave — never its kind, D6). Ask one person, or
 *                     offer the swap the server found.
 *
 * Nothing is decided here: who may take a duty, whether a request is still open, who approves — all
 * the server's, and a refusal is its `code` in the web's sentence. A request is never queued on the
 * phone: with no signal the page says nothing was sent and the button is still there.
 *
 * Deferred: the unit's month grid (a 31-column sheet — read on the computer for now); asking for
 * leave (the web has no screen for it either).
 */
export const DUTIES_POLL_MS = 60_000;
type T = ReturnType<typeof useI18n>["t"];

const buzz = (kind: "ok" | "warn"): void => {
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};

const TONE = {
  ok: { bg: color.greenSoft, line: color.greenLine },
  bad: { bg: color.redSoft, line: color.redLine },
  open: { bg: color.goldSoft, line: color.goldLine },
} as const;

function MyRequestCard({ r, t, busy, onWithdraw }: { r: WireCoverRequest; t: T; busy: boolean; onWithdraw: (id: string) => void }) {
  const duty = dutyName(r.duty, t);
  const name = r.counterpart.name;
  const tone = TONE[requestTone(r.status)];
  const title = r.kind === "swap" && r.status === "asked" && r.give !== null
    ? t("rosterMyDuties.asked.titleSwap", { name, duty, give: dutyName(r.give, t) })
    : t(`rosterMyDuties.asked.title_${r.status}`, { name, duty });
  return (
    <View style={[s.req, { backgroundColor: tone.bg, borderColor: tone.line }]} testID={`my-request-${r.requestId}`}>
      <Text style={s.reqTitle}>{title}</Text>
      <Text style={s.reqBody}>
        {r.status === "asked" && <>{t(r.crossUnit ? "rosterMyDuties.asked.bodyCross" : "rosterMyDuties.asked.bodySame")} <Text style={s.strong}>{t("rosterMyDuties.asked.stillYours", { duty })}</Text></>}
        {r.status === "accepted" && <>{t(r.crossUnit ? "rosterMyDuties.asked.waitingHod" : "rosterMyDuties.asked.waiting")} <Text style={s.strong}>{t("rosterMyDuties.asked.stillYours", { duty })}</Text></>}
        {r.status === "approved" && t("rosterMyDuties.asked.approvedBody", { by: r.decidedBy?.name ?? "" })}
        {r.status === "refused" && (r.refusedRule !== null
          ? <>{t("rosterMyDuties.asked.refusedRule", { why: reasonText({ ruleKey: r.refusedRule }, t) })} <Text style={s.strong}>{t("rosterMyDuties.asked.stillYoursNow", { duty })}</Text></>
          : <>{t("rosterMyDuties.asked.refusedBy", { by: r.decidedBy?.name ?? "" })} <Text style={s.strong}>{t("rosterMyDuties.asked.stillYoursNow", { duty })}</Text></>)}
        {r.status === "declined" && t("rosterMyDuties.asked.declinedBody")}
      </Text>
      {r.youMay.withdraw && (
        <Pressable testID={`withdraw-${r.requestId}`} accessibilityRole="button" disabled={busy} hitSlop={6} style={s.linkBtn} onPress={() => onWithdraw(r.requestId)}>
          <Text style={s.link}>{t("rosterMyDuties.asked.withdraw")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Home({ m, meId, t, busy, onPick, onAnswer, onWithdraw, onBoard }: {
  m: WireMyDuties; meId: string | null; t: T; busy: boolean;
  onPick: (d: WireMyDuty) => void; onAnswer: (id: string, yes: boolean) => void; onWithdraw: (id: string) => void; onBoard: () => void;
}) {
  const week = weekOf(m);
  const today = week[0] ?? null;
  const tonight = today === null ? undefined : m.duties.find((d) => d.istDate === today.istDate && d.night);
  const me = m.you;
  const dept = me.departmentName ?? "";
  const sub = [me.departmentName, me.unitName === null ? null : shortUnit(me.unitName, dept), me.grade === null ? null : gradeWord(me.grade, t)]
    .filter((x): x is string => x !== null && x !== "").join(" · ");
  const { mine, answered, ofMe, asked } = coverBuckets(m.requests, meId);

  return (
    <View style={{ gap: space.md }} testID="my-duties-home">
      <View>
        <Text style={[type.title, { color: color.ink }]} testID="my-duties-greeting">{t(`rosterMyDuties.greeting.${greetingKey(m.at)}`, { name: greetingName(me.name) })}</Text>
        {sub !== "" && <Text style={[type.small, { color: color.dim, marginTop: 2 }]}>{sub}</Text>}
      </View>

      {today !== null && (
        <View style={s.today} testID="my-duties-today">
          <Text style={s.cap}>{t("rosterMyDuties.today")}</Text>
          <Text style={s.todayWhat}>{today.duty === null ? (today.rest !== null ? t("rosterMyDuties.rest") : t("rosterMyDuties.todayNone")) : dutyWhat(today.duty, t)}</Text>
          <Text style={s.todayText}>
            {today.duty !== null
              ? [hoursOf(today.duty, t), today.duty.teamName === null ? null : shortUnit(today.duty.teamName, dept)].filter((x) => x !== null).join(" · ")
              : today.rest !== null ? t("rosterMyDuties.restDetail", { time: hm(today.rest.until) }) : t("rosterMyDuties.todayNoneSub")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>
            <Text style={s.chip} testID="my-duties-tonight">{tonight === undefined ? t("rosterMyDuties.tonightFree") : t("rosterMyDuties.tonightDuty", { what: dutyWhat(tonight, t) })}</Text>
            {m.onTake !== null && <Text style={s.chip}>{t("rosterMyDuties.onTake", { unit: shortUnit(m.onTake.name, dept) })}</Text>}
          </View>
        </View>
      )}
      {me.unitName === null && m.duties.length === 0 && <Note tone="info" testID="not-posted">{t("mobile.roster.notPosted")}</Note>}

      {ofMe.length > 0 && (
        <View style={{ gap: space.sm }} testID="asked-of-you">
          <Text style={s.cap}>{t("rosterMyDuties.askedOfYou")}</Text>
          {ofMe.map((r) => (
            <View key={r.requestId} style={[s.card, { borderColor: color.green, borderWidth: 2 }]} testID={`asked-of-you-${r.requestId}`}>
              <Text style={s.reqTitle}>
                {r.give === null
                  ? t("rosterMyDuties.ofMe.cover", { name: r.owner.name, duty: dayLong(r.duty.istDate, t), part: t(r.duty.night ? "rosterMyDuties.partNight" : "rosterMyDuties.partDay"), hours: hoursOf(r.duty, t) })
                  : t("rosterMyDuties.ofMe.swap", { name: r.owner.name, duty: dutyName(r.duty, t), give: dutyName(r.give, t) })}
              </Text>
              {r.check === null
                ? <Text style={[s.reqBody, { color: color.green, fontWeight: "600" }]}>{t("rosterMyDuties.ofMe.checkOk")}</Text>
                : <Text style={[s.reqBody, { color: r.check.severity === "warn" ? "#8a5a10" : color.red, fontWeight: "600" }]} testID={`check-${r.requestId}`}>{reasonText(r.check, t)}</Text>}
              <View style={{ gap: space.sm, marginTop: space.sm }}>
                <Button testID={`answer-yes-${r.requestId}`} label={t("rosterMyDuties.ofMe.yes")} disabled={busy} onPress={() => onAnswer(r.requestId, true)} />
                <Button testID={`answer-no-${r.requestId}`} kind="secondary" label={t("rosterMyDuties.ofMe.no")} disabled={busy} onPress={() => onAnswer(r.requestId, false)} />
              </View>
            </View>
          ))}
        </View>
      )}

      {mine.map((r) => <MyRequestCard key={r.requestId} r={r} t={t} busy={busy} onWithdraw={onWithdraw} />)}
      {answered.map((r) => {
        const tone = TONE[r.status === "approved" ? "ok" : r.status === "refused" ? "bad" : "open"];
        return (
          <View key={r.requestId} style={[s.req, { backgroundColor: tone.bg, borderColor: tone.line }]} testID={`answered-${r.requestId}`}>
            <Text style={s.reqTitle}>{t(`rosterMyDuties.theirs.title_${r.status}`, { name: r.owner.name, duty: dutyName(r.duty, t) })}</Text>
          </View>
        );
      })}

      {week.length > 1 && (
        <View style={{ gap: space.sm }}>
          <Text style={s.cap}>{t("rosterMyDuties.restOfWeek")}</Text>
          {week.slice(1).map((d) => {
            const duty = d.duty;
            const canAsk = duty !== null && duty.upcoming && !asked.has(duty.assignmentId);
            return (
              <View key={d.istDate} style={s.day} testID={`my-day-${d.istDate}`}>
                <View style={s.dayDate}>
                  <Text style={s.dow}>{dowShort(d.istDate, t)}</Text>
                  <Text style={s.date}>{dateOfMonth(d.istDate)}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.what, duty === null && { color: color.dim, fontWeight: "500" }]}>{duty !== null ? dutyWhat(duty, t) : d.rest !== null ? t("rosterMyDuties.rest") : t("rosterMyDuties.off")}</Text>
                  <Text style={s.detail}>
                    {duty !== null
                      ? [hoursOf(duty, t), duty.teamName === null || duty.teamName === me.unitName ? null : shortUnit(duty.teamName, dept)].filter((x) => x !== null).join(" · ")
                      : d.rest !== null
                        ? (istDay(d.rest.until) === d.istDate ? t("rosterMyDuties.restDetail", { time: hm(d.rest.until) }) : t("rosterMyDuties.restDetailShort"))
                        : t("rosterMyDuties.offDetail")}
                  </Text>
                </View>
                {canAsk && duty !== null && (
                  <Pressable testID={`cant-${duty.assignmentId}`} accessibilityRole="button" onPress={() => onPick(duty)} style={({ pressed }) => [s.cant, pressed && { opacity: 0.7 }]}>
                    <Text style={s.cantText}>{t("rosterMyDuties.cant1")}</Text>
                    <Text style={s.cantText}>{t("rosterMyDuties.cant2")}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={{ gap: space.sm, marginTop: space.sm }}>
        {m.mySr !== null && m.mySr.phone !== null && m.mySr.phone !== "" && (
          <Button testID="call-my-sr" label={`${t("rosterMyDuties.callSr")} · ${m.mySr.name}`} onPress={() => { void Linking.openURL(`tel:${m.mySr!.phone!}`).catch(() => undefined); }} />
        )}
        <Button testID="to-on-now" kind="secondary" label={t("rosterMyDuties.whoIsOn")} onPress={onBoard} />
        <Text style={s.detail}>{t("mobile.roster.monthLater")}</Text>
      </View>
    </View>
  );
}

function Candidate({ c, duty, t, busy, onAsk }: {
  c: WireCoverCandidate; duty: WireDutyRef; t: T; busy: boolean; onAsk: (v: { counterpartId: string; counterpartAssignmentId?: string }) => void;
}) {
  const next = c.nextDay.duty === null
    ? t("rosterMyDuties.pick.nextOff", { day: dowLong(c.nextDay.istDate, t) })
    : t(c.nextDay.duty.night ? "rosterMyDuties.pick.nextNight" : "rosterMyDuties.pick.nextDuty", { day: dowLong(c.nextDay.istDate, t) });
  const dept = duty.teamName?.replace(/ Unit .*$/, "") ?? "";
  const swap = c.swaps[0];
  return (
    <View style={s.card} testID={`can-${c.userId}`}>
      <Text style={s.what}>{c.name}</Text>
      <Text style={s.detail}>{[gradeWord(c.grade, t), shortUnit(c.teamName, dept), `${t("rosterMyDuties.pick.free", { day: dowLong(duty.istDate, t) })}, ${next}`].join(" · ")}</Text>
      {c.crossUnit && <Text style={[s.detail, { color: "#8a5a10", fontWeight: "600" }]}>{t("rosterMyDuties.pick.crossUnit")}</Text>}
      <View style={{ gap: space.sm, marginTop: space.sm }}>
        <Button testID={`ask-${c.userId}`} label={`${t("rosterMyDuties.pick.ask")} ${c.name}`} disabled={busy} onPress={() => onAsk({ counterpartId: c.userId })} />
        {swap !== undefined && (
          <>
            <Text style={s.detail}>{t("rosterMyDuties.pick.swapLine", { duty: dutyName(swap, t) })}</Text>
            <Button testID={`swap-${c.userId}`} kind="secondary" label={t("rosterMyDuties.pick.swap")} disabled={busy} onPress={() => onAsk({ counterpartId: c.userId, counterpartAssignmentId: swap.assignmentId })} />
          </>
        )}
      </View>
    </View>
  );
}

/** "I CAN'T DO THIS" — the duty's own page: who can take it, who cannot and why. */
function CoverPicker({ duty, api, t, onBack, onAsked }: { duty: WireMyDuty; api: RosterApi; t: T; onBack: () => void; onAsked: () => void }) {
  const [options, setOptions] = useState<WireCoverOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setLoadError(null);
    api.coverOptions(duty.assignmentId).then(setOptions).catch((e: unknown) => setLoadError(rosterRefusal(e, t)));
  }, [api, duty.assignmentId, t]);
  useEffect(() => { load(); }, [load]);
  const ask = (v: { counterpartId: string; counterpartAssignmentId?: string }): void => {
    setBusy(true); setError(null);
    api.askCover({ assignmentId: duty.assignmentId, ...v })
      .then(() => { buzz("ok"); onAsked(); })
      // Never queued: the page stays as it is and says the request did not go.
      .catch((e: unknown) => { buzz("warn"); setError(rosterRefusal(e, t)); })
      .finally(() => setBusy(false));
  };
  const d = options;
  return (
    <View style={{ gap: space.md }} testID="cover-picker">
      <Pressable testID="cover-back" accessibilityRole="button" hitSlop={8} style={s.linkBtn} onPress={onBack}>
        <Text style={s.link}>{t("rosterMyDuties.pick.back")}</Text>
      </Pressable>
      <View>
        <Text style={[type.title, { color: color.ink }]}>{t("rosterMyDuties.pick.title", { day: dayLong(duty.istDate, t), part: t(duty.night ? "rosterMyDuties.partNight" : "rosterMyDuties.partDay") })}</Text>
        <Text style={[type.small, { color: color.dim, marginTop: 4 }]}>{t("rosterMyDuties.pick.intro", { what: dutyWhat(duty, t), hours: hoursOf(duty, t) })}</Text>
      </View>
      {d === null && loadError === null && <Text style={s.detail} testID="cover-looking">{t("rosterMyDuties.pick.looking")}</Text>}
      {loadError !== null && (
        <View style={{ gap: space.md }}>
          <Note tone="bad" testID="cover-load-error">{loadError}</Note>
          <Button kind="secondary" testID="cover-retry" label={t("mobile.roster.retry")} onPress={load} />
        </View>
      )}
      {error !== null && <Note tone="bad" testID="cover-error">{error}</Note>}
      {d !== null && d.openRequestId !== null && <Note tone="info" testID="cover-already">{t("rosterMyDuties.pick.already")}</Note>}
      {d !== null && d.openRequestId === null && (
        <>
          <View style={{ gap: space.sm }}>
            <Text style={[s.cap, { color: color.green }]}>{t("rosterMyDuties.pick.canTake")}</Text>
            {d.canTake.length === 0 && <Note tone="warn" testID="nobody-can">{t("rosterMyDuties.pick.nobody")}</Note>}
            {d.canTake.map((c) => <Candidate key={c.userId} c={c} duty={d.duty} t={t} busy={busy} onAsk={ask} />)}
          </View>
          {d.cannot.length > 0 && (
            <View style={{ gap: space.sm }}>
              <Text style={s.cap}>{t("rosterMyDuties.pick.cannot")}</Text>
              {d.cannot.map((c) => (
                <View key={c.userId} style={[s.card, { backgroundColor: color.wash }]} testID={`cannot-${c.userId}`}>
                  <Text style={[s.what, { fontSize: 15 }]}>{`${c.name} · ${shortUnit(c.teamName, d.duty.teamName?.replace(/ Unit .*$/, "") ?? "")}`}</Text>
                  <Text style={s.detail}>{whyNot(c, t)}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
      <Text style={s.detail}>{t("rosterMyDuties.pick.whatsapp")}</Text>
    </View>
  );
}

export function RosterMyDuties() {
  const { t } = useI18n();
  const router = useRouter();
  const { call, state } = useSession();
  const api: RosterApi = useMemo(() => rosterApi(call), [call]);
  const meId = state.status === "signedIn" ? state.me.actor.id : null;

  const [m, setM] = useState<WireMyDuties | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [picking, setPicking] = useState<WireMyDuty | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setM(await api.myDuties());
      setAsOf(Date.now()); setStale(false); setRefusal(null);
    } catch (e) {
      if (e instanceof NetworkError) setStale(true);
      else setRefusal(rosterRefusal(e, t));
    }
  }, [api, t]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (AppState.currentState !== "background") void refresh(); }, DUTIES_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  /** One act: said when done, the server's reason when refused, "nothing was changed" with no signal — and the page re-read either way. */
  const act = (run: () => Promise<unknown>, done: string): void => {
    setBusy(true); setError(null); setFlash(null);
    run()
      .then(() => { buzz("ok"); setFlash(done); })
      .catch((e: unknown) => { buzz("warn"); setError(rosterRefusal(e, t)); })
      .finally(() => { setBusy(false); void refresh(); });
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <Pressable onPress={() => (picking !== null ? setPicking(null) : router.back())} accessibilityRole="button" hitSlop={8} testID="back"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="roster-my-duties" keyboardShouldPersistTaps="handled">
        {refusal !== null && <Note tone="bad" testID="my-duties-refusal">{refusal}</Note>}
        {stale && m !== null && asOf !== null && <Note tone="warn" testID="my-duties-stale">{t("mobile.roster.stale", { time: hm(new Date(asOf).toISOString()) })}</Note>}
        {stale && m === null && (
          <View style={{ gap: space.md }}>
            <Note tone="warn" testID="my-duties-offline">{t("mobile.roster.noSignal")}</Note>
            <Button kind="secondary" testID="my-duties-retry" label={t("mobile.roster.retry")} onPress={() => { void refresh(); }} />
          </View>
        )}
        {m === null && !stale && refusal === null && <Text style={s.detail} testID="my-duties-loading">{t("rosterOnNow.loading")}</Text>}
        {picking === null && flash !== null && <Text style={s.flash} testID="my-duties-flash">{flash}</Text>}
        {picking === null && error !== null && <Note tone="bad" testID="my-duties-error">{error}</Note>}
        {m !== null && picking === null && (
          <Home
            m={m} meId={meId} t={t} busy={busy}
            onPick={(d) => { setError(null); setFlash(null); setPicking(d); }}
            onAnswer={(id, yes) => act(() => api.answerCover(id, yes), t(yes ? "mobile.roster.answeredYes" : "mobile.roster.answeredNo"))}
            onWithdraw={(id) => act(() => api.withdrawCover(id), t("mobile.roster.withdrawn"))}
            onBoard={() => router.push({ pathname: "/seat/[key]", params: { key: "onNow" } })}
          />
        )}
        {m !== null && picking !== null && (
          <CoverPicker duty={picking} api={api} t={t} onBack={() => setPicking(null)}
            onAsked={() => { setPicking(null); setFlash(t("mobile.roster.sent")); void refresh(); }} />
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 2 },
  cap: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase", color: color.faint },
  today: { backgroundColor: color.card, borderWidth: 1, borderColor: color.greenLine, borderLeftWidth: 6, borderLeftColor: color.green, borderRadius: radius.lg, padding: space.lg, gap: 2 },
  todayWhat: { fontSize: 26, lineHeight: 32, fontWeight: "700", color: color.ink, marginTop: 2 },
  todayText: { fontSize: 15, lineHeight: 21, color: color.dim },
  chip: { fontSize: 13, fontWeight: "600", color: color.green, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, overflow: "hidden" },
  req: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  reqTitle: { fontSize: 15.5, lineHeight: 21, fontWeight: "700", color: color.ink },
  reqBody: { fontSize: 14, lineHeight: 20, color: color.dim },
  strong: { fontWeight: "700", color: color.ink },
  day: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingVertical: 10, paddingHorizontal: 14, minHeight: TOUCH + 16 },
  dayDate: { width: 40, alignItems: "center" },
  dow: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 0.8, color: color.dim },
  date: { fontFamily: MONO, fontSize: 20, fontWeight: "700", color: color.ink },
  what: { fontSize: 16, lineHeight: 21, fontWeight: "700", color: color.ink },
  detail: { fontSize: 13, lineHeight: 18, color: color.dim },
  cant: { minHeight: TOUCH, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, alignItems: "center", justifyContent: "center" },
  cantText: { fontSize: 12.5, lineHeight: 16, fontWeight: "700", color: color.green },
  flash: { fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.green },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  linkBtn: { minHeight: 40, justifyContent: "center", paddingHorizontal: 4, alignSelf: "flex-start" },
});
