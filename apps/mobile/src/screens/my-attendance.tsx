import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { attendanceApi, type Me, type Punch, type SelfDay } from "../attendance/api";
import { ConfirmSheet } from "../attendance/confirm-sheet";
import { WORD_TONE, clampToToday, countWords, monthDays, monthOf, weekOf, type SelfWord } from "../attendance/rules";
import {
  BackBand, Chips, Counts, MonthGrid, PeriodNav, TONE, WeekList, canStepForward, periodTitle, step, wordText, type DayCell, type ViewKind,
} from "../attendance/views";
import { istDay } from "../doctor/rules";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";

/**
 * ═══ MY ATTENDANCE (board frames 2 and 3) ═══
 *
 * Day | Week | Month. A person's OWN days, as the owner ruled on 2026-10-09: one word a day —
 * Present, Absent, Leave, Off, Partial — and "Confirm" for a past day with a single punch. NO TIMES:
 * the server leaves them out of the answer, and this screen draws an in / out / punches block only
 * when those keys are actually there (the hospital switches them on later, with no new app).
 *
 * Nothing ahead of today is drawn, and "next" stops at the period today is in.
 */
export function MyAttendance({ openDay, openRequest, nowMs = Date.now }: { openDay?: string; openRequest?: string; nowMs?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { state, call } = useSession();
  const today = useMemo(() => istDay(new Date(nowMs()).toISOString()), [nowMs]);
  const [view, setView] = useState<ViewKind>(openDay !== undefined ? "day" : "week");
  const [anchor, setAnchor] = useState(openDay !== undefined && openDay <= today ? openDay : today);
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const [punches, setPunches] = useState<Punch[] | null>(null);
  const [sheet, setSheet] = useState<{ date: string; reason: string | null } | null>(openDay !== undefined ? { date: openDay, reason: null } : null);

  const range = useMemo(() => {
    const dates = view === "day" ? [anchor] : view === "week" ? weekOf(anchor) : monthDays(monthOf(anchor));
    return { dates, read: clampToToday(dates[0]!, dates[dates.length - 1]!, today) };
  }, [view, anchor, today]);

  const load = useCallback(async () => {
    if (range.read === null) return;
    try { setMe(await attendanceApi(call).me(range.read.from, range.read.to)); setFailed(null); }
    catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call, range]);
  useEffect(() => { void load(); }, [load]);

  const linked = me !== null && me.linked ? me : null;
  const showsTimes = linked?.showsTimes === true;
  // The day's punches are asked for ONLY when the server said times are on.
  useEffect(() => {
    setPunches(null);
    if (view !== "day" || !showsTimes) return;
    let gone = false;
    void attendanceApi(call).myPunches(anchor).then((r) => { if (!gone) setPunches(r.punches ?? null); }, () => undefined);
    return () => { gone = true; };
  }, [view, anchor, showsTimes, call]);

  // A "Request closed" notice names the request, not the day: find the day and open its sheet.
  useEffect(() => {
    if (openRequest === undefined) return;
    let gone = false;
    void attendanceApi(call).myRequests().then((r) => {
      const found = r.requests.find((x) => x.id === openRequest) ?? r.requests[0];
      if (!gone && found !== undefined) setSheet({ date: found.date, reason: found.reasonCode });
    }, () => undefined);
    return () => { gone = true; };
  }, [openRequest, call]);

  if (state.status !== "signedIn") return null;
  const byDate = new Map((linked?.days ?? []).map((d) => [d.date, d] as const));
  const cells: DayCell[] = range.dates.map((date) => ({ date, word: date > today ? null : byDate.get(date)?.status ?? null }));
  const counts = countWords(cells.flatMap((c) => (c.word === null ? [] : [c.word])));
  const pick = (c: DayCell): void => {
    const d = byDate.get(c.date);
    if (d?.status === "confirm") { setSheet({ date: c.date, reason: d.reason ?? null }); return; }
    setAnchor(c.date); setView("day");
  };
  const day: SelfDay | null = view === "day" ? byDate.get(anchor) ?? null : null;
  const word: SelfWord | null = day?.status ?? null;
  // Present ONLY when the server sent the keys: `in` is the test, so a null time still counts as "times are on".
  const hasTimes = day !== null && "firstIn" in day;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <BackBand t={t} onBack={() => router.back()} Band={Band} />
      <ScrollView testID="my-attendance" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Text numberOfLines={1} style={[type.title, { color: color.ink }]}>{t("attendance.mine")}</Text>
        <Chips testID="att-view" value={view} onChange={setView} items={[
          { key: "day", label: t("attendance.view.day") }, { key: "week", label: t("attendance.view.week") }, { key: "month", label: t("attendance.view.month") },
        ]} />
        <PeriodNav t={t} title={periodTitle(t, view, anchor)} onPrev={() => setAnchor(step(view, anchor, -1))} onNext={() => setAnchor(step(view, anchor, 1))} canNext={canStepForward(view, anchor, today)} />
        {failed !== null && <Note tone="warn" testID="att-failed">{t(failed === "offline" ? "attendance.offline" : "attendance.cannotRead")}</Note>}
        {me !== null && !me.linked && <Note tone="info" testID="att-not-linked">{t("attendance.notLinked")}</Note>}

        {linked !== null && view === "week" && (
          <>
            <Counts items={[
              { key: "present", label: t("attendance.word.present"), value: t("attendance.of", { n: counts.present, of: counts.days }), tone: "green", wide: true },
              { key: "partial", label: t("attendance.word.partial"), value: String(counts.partial), tone: "amber" },
              ...(counts.confirm > 0 ? [{ key: "confirm", label: t("attendance.word.confirm"), value: String(counts.confirm), tone: "warn" as const }] : []),
            ]} />
            <WeekList t={t} cells={cells} today={today} onPick={pick} />
          </>
        )}
        {linked !== null && view === "month" && (
          <>
            <MonthGrid t={t} month={monthOf(anchor)} cells={cells} today={today} onPick={pick} />
            <Counts items={(["present", "partial", "absent", "leave", "off"] as const).map((w) => ({ key: w, label: t(`attendance.word.${w}`), value: String(counts[w]), tone: WORD_TONE[w] }))} />
          </>
        )}
        {linked !== null && view === "day" && (
          <View testID="att-day" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>
            <Text testID="att-day-word" numberOfLines={1} style={{ fontSize: 24, fontWeight: "700", color: word === null ? color.faint : TONE[WORD_TONE[word]].fg }}>
              {word === null ? t("attendance.noRecord") : wordText(t, word)}
            </Text>
            {word === "confirm" && <Button testID="att-day-confirm" label={t("attendance.word.confirm")} onPress={() => setSheet({ date: anchor, reason: day?.reason ?? null })} />}
            {hasTimes && (
              <View testID="att-day-times" style={{ gap: 6 }}>
                {([["in", day?.firstIn ?? null], ["out", day?.lastOut ?? null], ["hours", day?.hoursWorked == null ? null : t("attendance.hoursValue", { n: day.hoursWorked })]] as const).map(([k, v]) => (
                  <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 6 }}>
                    <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t(`attendance.${k}`)}</Text>
                    <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: color.ink }}>{v ?? "—"}</Text>
                  </View>
                ))}
              </View>
            )}
            {showsTimes && punches !== null && (
              <View testID="att-day-punches" style={{ gap: 4 }}>
                <Text numberOfLines={1} style={[type.tag, { color: color.faint }]}>{t("attendance.punches")}</Text>
                {punches.length === 0 && <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("attendance.noPunches")}</Text>}
                {punches.map((p, i) => (
                  <Text key={`${p.time}-${String(i)}`} numberOfLines={1} style={{ fontFamily: MONO, fontSize: 13, color: color.ink }}>{[p.time.slice(0, 5), p.device].filter((x) => x !== null && x !== "").join(" · ")}</Text>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
      {sheet !== null && <ConfirmSheet t={t} call={call} date={sheet.date} reason={sheet.reason ?? byDate.get(sheet.date)?.reason ?? "one_punch_only"} onClose={() => setSheet(null)} onChanged={() => { void load(); }} />}
    </View>
  );
}
