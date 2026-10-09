import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { attendanceApi, type FullDay, type PersonRange, type SelfDay } from "../attendance/api";
import { WORD_TONE, clampToToday, countWords, managerDay, monthDays, monthOf, weekOf, type SelfWord } from "../attendance/rules";
import {
  BackBand, Chips, Counts, MonthGrid, PeriodNav, TONE, ToneTag, WeekList, canStepForward, periodTitle, step, wordText, type DayCell, type ViewKind,
} from "../attendance/views";
import { istDay } from "../doctor/rules";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, MONO, Note } from "../ui";

/**
 * ═══ ONE PERSON, FOR A MANAGER (board frame 5) ═══
 *
 * The same Day | Week | Month as "My attendance", with the machine's full detail: first in, last out,
 * hours, and "Late". The server decides who may open whom (the owner, the Superintendent, the
 * Committee; a head for their own team) — and when it answers with the words-only shape instead
 * (somebody opening their own pin without the right to see everything), this screen draws words.
 */
export function AttendancePerson({ pin, name, nowMs = Date.now }: { pin: string; name?: string; nowMs?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { state, call } = useSession();
  const today = useMemo(() => istDay(new Date(nowMs()).toISOString()), [nowMs]);
  const [view, setView] = useState<ViewKind>("month");
  const [anchor, setAnchor] = useState(today);
  const [got, setGot] = useState<PersonRange | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const range = useMemo(() => {
    const dates = view === "day" ? [anchor] : view === "week" ? weekOf(anchor) : monthDays(monthOf(anchor));
    return { dates, read: clampToToday(dates[0]!, dates[dates.length - 1]!, today) };
  }, [view, anchor, today]);
  const load = useCallback(async () => {
    if (range.read === null) return;
    try { setGot(await attendanceApi(call).person(pin, range.read.from, range.read.to)); setFailed(null); }
    catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call, pin, range]);
  useEffect(() => { void load(); }, [load]);
  if (state.status !== "signedIn") return null;

  const full = got !== null && got.detail === "full";
  const fullBy = new Map<string, FullDay>(full ? (got.days as FullDay[]).map((d) => [d.date, d] as const) : []);
  const selfBy = new Map<string, SelfDay>(got !== null && !full ? (got.days as SelfDay[]).map((d) => [d.date, d] as const) : []);
  const cells: DayCell[] = range.dates.map((date) => {
    if (date > today) return { date, word: null };
    const f = fullBy.get(date);
    if (f !== undefined) {
      const m = managerDay(f.status, f.firstIn !== null);
      return { date, word: m.word, late: m.late, onePunch: m.onePunch, time: f.firstIn === null ? null : `${f.firstIn}${f.lastOut === null ? "" : `–${f.lastOut}`}` };
    }
    return { date, word: selfBy.get(date)?.status ?? null };
  });
  const counts = countWords(cells.flatMap((c) => (c.word === null ? [] : [c.word])));
  const late = cells.filter((c) => c.late === true).length;
  const pick = (c: DayCell): void => { setAnchor(c.date); setView("day"); };
  const day = view === "day" ? fullBy.get(anchor) ?? null : null;
  const dayCell = view === "day" ? cells[0] ?? null : null;
  const word: SelfWord | null = dayCell?.word ?? null;
  const person = got?.person ?? null;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <BackBand t={t} onBack={() => router.back()} Band={Band} />
      <ScrollView testID="attendance-person" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <View>
          <Text testID="att-person-name" numberOfLines={1} style={[type.title, { color: color.ink }]}>{person?.name ?? name ?? ""}</Text>
          {person !== null && <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{[person.post, person.dept].filter((x) => x !== null && x !== "").join(" · ")}</Text>}
        </View>
        <Chips testID="att-view" value={view} onChange={setView} items={[
          { key: "day", label: t("attendance.view.day") }, { key: "week", label: t("attendance.view.week") }, { key: "month", label: t("attendance.view.month") },
        ]} />
        <PeriodNav t={t} title={periodTitle(t, view, anchor)} onPrev={() => setAnchor(step(view, anchor, -1))} onNext={() => setAnchor(step(view, anchor, 1))} canNext={canStepForward(view, anchor, today)} />
        {failed !== null && <Note tone="warn" testID="att-failed">{t(failed === "offline" ? "attendance.offline" : "attendance.cannotRead")}</Note>}
        {got !== null && view !== "day" && (
          <Counts items={[
            { key: "present", label: t("attendance.word.present"), value: t("attendance.of", { n: counts.present, of: counts.days }), tone: "green", wide: true },
            ...(full ? [{ key: "late", label: t("attendance.manage.late"), value: String(late), tone: "amber" as const }] : []),
            { key: "partial", label: t("attendance.word.partial"), value: String(counts.partial), tone: "amber" },
            { key: "absent", label: t("attendance.word.absent"), value: String(counts.absent), tone: "red" },
            { key: "leave", label: t("attendance.word.leave"), value: String(counts.leave), tone: "blue" },
          ]} />
        )}
        {got !== null && view === "week" && <WeekList t={t} cells={cells} today={today} onPick={pick} />}
        {got !== null && view === "month" && <MonthGrid t={t} month={monthOf(anchor)} cells={cells} today={today} onPick={pick} />}
        {got !== null && view === "day" && (
          <View testID="att-day" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text testID="att-day-word" numberOfLines={1} style={{ flex: 1, fontSize: 24, fontWeight: "700", color: word === null ? color.faint : TONE[WORD_TONE[word]].fg }}>
                {word === null ? t("attendance.noRecord") : wordText(t, word)}
              </Text>
              {dayCell?.late === true && <ToneTag label={t("attendance.manage.late")} tone="amber" />}
              {dayCell?.onePunch === true && <ToneTag label={t("attendance.manage.onePunch")} tone="warn" />}
            </View>
            {day !== null && (
              <View testID="att-day-times" style={{ gap: 6 }}>
                {([["in", day.firstIn], ["out", day.lastOut], ["hours", day.hoursWorked === null ? null : t("attendance.hoursValue", { n: day.hoursWorked })]] as const).map(([k, v]) => (
                  <View key={k} style={{ flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 6 }}>
                    <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t(`attendance.${k}`)}</Text>
                    <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: color.ink }}>{v ?? "—"}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
