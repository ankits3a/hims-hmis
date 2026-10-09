import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { MONO } from "../ui";
import { WORD_TONE, addDays, addMonths, monthGrid, monthOf, weekOf, weekdayOf, wordKey, type AttendanceTone, type SelfWord } from "./rules";

export type T = (key: string, vars?: Record<string, string | number>) => string;
export type ViewKind = "day" | "week" | "month";

/** Leave is blue on the board; the app's palette had no blue until this screen. */
const BLUE = "#2b6cb0";
export const TONE: Record<AttendanceTone, { fg: string; bg: string; line: string }> = {
  green: { fg: color.green, bg: color.greenSoft, line: color.greenLine },
  amber: { fg: "#8a5a10", bg: color.goldSoft, line: color.goldLine },
  red: { fg: color.red, bg: color.redSoft, line: color.redLine },
  blue: { fg: BLUE, bg: "rgba(43, 108, 176, .10)", line: "rgba(43, 108, 176, .40)" },
  grey: { fg: color.dim, bg: color.wash, line: color.line },
  warn: { fg: "#8a5a10", bg: color.goldSoft, line: color.gold },
  none: { fg: color.faint, bg: color.card, line: color.line2 },
};

/** One day as a screen draws it. `word: null` is a day with nothing to say: ahead of today, or no record. */
export type DayCell = { date: string; word: SelfWord | null; late?: boolean; onePunch?: boolean; time?: string | null };

/** "Thu 9" */
export function dayLabel(t: T, date: string): string {
  return t("attendance.dayLabel", { dow: t(`attendance.dow.${String(weekdayOf(date))}`), d: Number(date.slice(8, 10)) });
}
/** "Thu 9 October" */
export function dateLabel(t: T, date: string): string {
  return t("attendance.dateLabel", { dow: t(`attendance.dow.${String(weekdayOf(date))}`), d: Number(date.slice(8, 10)), month: t(`attendance.month.${date.slice(5, 7)}`) });
}
export function wordText(t: T, word: SelfWord | null): string {
  return word === null || word === "unknown" ? "—" : `${word === "confirm" ? "⚠ " : ""}${t(wordKey(word))}`;
}
/** The first date of the period before / after the one `anchor` is in. */
export function step(view: ViewKind, anchor: string, by: -1 | 1): string {
  if (view === "day") return addDays(anchor, by);
  if (view === "week") return addDays(weekOf(anchor)[0]!, by * 7);
  return `${addMonths(monthOf(anchor), by)}-01`;
}
/** Nothing in the future: "next" is offered only while the next period has begun. */
export function canStepForward(view: ViewKind, anchor: string, today: string): boolean {
  return step(view, anchor, 1) <= today;
}
export function periodTitle(t: T, view: ViewKind, anchor: string): string {
  if (view === "day") return dateLabel(t, anchor);
  if (view === "month") return `${t(`attendance.month.${anchor.slice(5, 7)}`)} ${anchor.slice(0, 4)}`;
  const w = weekOf(anchor);
  return `${String(Number(w[0]!.slice(8, 10)))} – ${String(Number(w[6]!.slice(8, 10)))} ${t(`attendance.month.${w[6]!.slice(5, 7)}`)}`;
}

export function Chips<K extends string>({ items, value, onChange, testID }: { items: readonly { key: K; label: string }[]; value: K; onChange: (k: K) => void; testID: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable key={it.key} testID={`${testID}-${it.key}`} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(it.key)}
            style={{ flex: 1, minHeight: 40, borderRadius: 999, borderWidth: 1, borderColor: on ? color.green : color.line, backgroundColor: on ? color.green : color.card, alignItems: "center", justifyContent: "center", paddingHorizontal: space.sm }}>
            <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function PeriodNav({ t, title, onPrev, onNext, canNext }: { t: T; title: string; onPrev: () => void; onNext: () => void; canNext: boolean }) {
  const arrow = (id: string, glyph: string, label: string, onPress: () => void, off: boolean) => (
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off }} disabled={off} onPress={onPress} hitSlop={6}
      style={{ width: TOUCH, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, opacity: off ? 0.35 : 1 }}>
      <Text style={{ fontSize: 20, color: color.ink }}>{glyph}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      {arrow("att-prev", "‹", t("attendance.previous"), onPrev, false)}
      <Text testID="att-period" numberOfLines={1} style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: color.ink }}>{title}</Text>
      {arrow("att-next", "›", t("attendance.next"), onNext, !canNext)}
    </View>
  );
}

export function Counts({ items }: { items: readonly { key: string; label: string; value: string; tone: AttendanceTone }[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {items.map((c) => (
        <View key={c.key} testID={`att-count-${c.key}`} style={{ flexGrow: 1, flexBasis: 56, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.sm }}>
          <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 17, fontWeight: "700", color: TONE[c.tone].fg }}>{c.value}</Text>
          <Text numberOfLines={1} style={{ fontSize: 11.5, color: color.dim }}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

function Tag({ label, tone }: { label: string; tone: AttendanceTone }) {
  return (
    <View style={{ backgroundColor: TONE[tone].bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: "700", color: TONE[tone].fg }}>{label}</Text>
    </View>
  );
}
export { Tag as ToneTag };

/** Monday to Sunday, one coloured word per day. A day with nothing to say reads "—" and cannot be tapped. */
export function WeekList({ t, cells, today, onPick }: { t: T; cells: readonly DayCell[]; today: string; onPick: (c: DayCell) => void }) {
  return (
    <View style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md }}>
      {cells.map((c, i) => {
        const tone = c.word === null ? "none" : WORD_TONE[c.word];
        const live = c.word !== null;
        return (
          <Pressable key={c.date} testID={`att-day-${c.date}`} accessibilityRole="button" disabled={!live} onPress={() => onPick(c)}
            style={{ minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: color.line2 }}>
            <Text numberOfLines={1} style={{ width: 64, fontFamily: MONO, fontSize: 13, fontWeight: c.date === today ? "700" : "400", color: c.date === today ? color.ink : color.dim }}>{dayLabel(t, c.date)}</Text>
            <Text numberOfLines={1} testID={`att-word-${c.date}`} style={{ flex: 1, fontSize: 15, fontWeight: "700", color: TONE[tone].fg }}>{wordText(t, c.word)}</Text>
            {c.time != null && <Text numberOfLines={1} testID={`att-time-${c.date}`} style={{ fontFamily: MONO, fontSize: 13, color: color.ink }}>{c.time}</Text>}
            {c.late === true && <Tag label={t("attendance.manage.late")} tone="amber" />}
            {c.onePunch === true && <Tag label={t("attendance.manage.onePunch")} tone="warn" />}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The month as a calendar, Monday first, coloured like the week. */
export function MonthGrid({ t, month, cells, today, onPick }: { t: T; month: string; cells: readonly DayCell[]; today: string; onPick: (c: DayCell) => void }) {
  const by = new Map(cells.map((c) => [c.date, c] as const));
  return (
    <View testID="att-month" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.sm, gap: 4 }}>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {[0, 1, 2, 3, 4, 5, 6].map((d) => (
          <Text key={d} numberOfLines={1} style={{ flex: 1, textAlign: "center", fontFamily: MONO, fontSize: 11, color: color.faint }}>{t(`attendance.dowLetter.${String(d)}`)}</Text>
        ))}
      </View>
      {monthGrid(month).map((row, r) => (
        <View key={r} style={{ flexDirection: "row", gap: 4 }}>
          {row.map((date, i) => {
            if (date === null) return <View key={`pad-${String(i)}`} style={{ flex: 1, aspectRatio: 1 }} />;
            const c = by.get(date) ?? { date, word: null };
            const tone = c.word === null ? "none" : WORD_TONE[c.word];
            const live = c.word !== null;
            return (
              <Pressable key={date} testID={`att-cell-${date}`} accessibilityRole="button" accessibilityLabel={`${dayLabel(t, date)} ${wordText(t, c.word)}`} disabled={!live} onPress={() => onPick(c)}
                style={{ flex: 1, aspectRatio: 1, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: live ? TONE[tone].bg : "transparent",
                  borderWidth: date === today || c.word === "confirm" ? 2 : 1, borderColor: c.word === "confirm" ? color.gold : date === today ? color.ink : live ? TONE[tone].line : color.line2 }}>
                <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: live ? "700" : "400", color: live ? TONE[tone].fg : date > today ? color.line : color.faint }}>{String(Number(date.slice(8, 10)))}</Text>
                {c.word === "confirm" && <Text style={{ position: "absolute", top: 0, right: 2, fontSize: 9, color: "#8a5a10" }}>⚠</Text>}
                {c.late === true && <View style={{ position: "absolute", bottom: 3, width: 5, height: 5, borderRadius: 3, backgroundColor: color.gold }} />}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export function BackBand({ t, onBack, Band }: { t: T; onBack: () => void; Band: (p: { right?: React.ReactNode }) => React.ReactElement }) {
  return (
    <Band right={
      <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8} testID="back" style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
        <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
      </Pressable>
    } />
  );
}
export const titleStyle = [type.title, { color: color.ink }] as const;
