import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, NetworkError, codeOf } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, Field, KeyboardScrollView, Note } from "../ui";
import { useReminders } from "../reminders/card";
import { REPEAT_CHOICES, TEXT_MAX, dayChoices, dayLabel, formInstant, whenText, type ReminderRepeat, type ReminderRow } from "../reminders/model";

/**
 * E1.2 — "REMINDERS" (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md). A person's
 * own reminders: the list (next time, repeat, Cancel) and the add form — a few words, a day, a time,
 * and how often. At the time, the phone says only "You have a reminder"; the words are read here and
 * on the bell. Few words per line, one line at 390 px (owner 2026-10-09).
 */
export function RemindersScreen({ nowMs = Date.now }: { nowMs?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const { items, failed: loaded, reload } = useReminders(call, true);
  useEffect(() => { void reload(); }, [reload]);

  const days = useMemo(() => dayChoices(nowMs()), [nowMs]);
  const [text, setText] = useState("");
  const [day, setDay] = useState(days[0]!.day);
  const [time, setTime] = useState("");
  const [repeat, setRepeat] = useState<ReminderRepeat>("none");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const f = formInstant(text, day, time, nowMs());
    if ("problem" in f) { setProblem(t(`reminders.problem.${f.problem}`)); return; }
    setProblem(null); setBusy(true);
    try {
      const made = await call<ReminderRow>("POST", "/reminders", { text: text.trim(), at: f.at, repeat });
      setText(""); setTime(""); setRepeat("none");
      setSaid(t("reminders.saved", { when: whenText(t, made.dueAt, nowMs()) }));
      await reload();
    } catch (e) {
      const code = e instanceof ApiError ? codeOf(e.body) : "";
      setProblem(t(e instanceof NetworkError ? "reminders.offline" : code === "reminder_limit" ? "reminders.problem.limit" : "reminders.problem.refused"));
    } finally { setBusy(false); }
  };
  const cancel = async (id: string): Promise<void> => {
    try { await call("POST", `/reminders/${encodeURIComponent(id)}/cancel`); } catch { setProblem(t("reminders.offline")); }
    await reload();
  };

  const chip = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable key={key} testID={key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: on ? 2 : 1, borderColor: on ? color.ink : color.line, backgroundColor: on ? color.wash : color.card }}>
      <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "700", color: on ? color.ink : color.dim }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("reminders.back")} onPress={() => router.back()} testID="reminders-back" />} />
      <KeyboardScrollView testID="reminders" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("reminders.title")}</Text>
        {loaded === "offline" && <Note tone="warn" testID="reminders-offline">{t("reminders.offline")}</Note>}
        {loaded === "refused" && <Note tone="warn" testID="reminders-refused">{t("reminders.problem.refused")}</Note>}
        {items !== null && items.length === 0 && <Text testID="reminders-none" style={[type.small, { color: color.dim }]} numberOfLines={1}>{t("reminders.none")}</Text>}
        {items !== null && items.map((r) => (
          <View key={r.id} testID={`reminder-${r.id}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{r.text}</Text>
              <Text numberOfLines={1} testID={`reminder-${r.id}-when`} style={[type.small, { color: color.dim }]}>
                {r.repeat === "none" ? whenText(t, r.dueAt, nowMs()) : `${whenText(t, r.dueAt, nowMs())} · ${t(`reminders.repeat.${r.repeat}`)}`}
              </Text>
            </View>
            <Pressable testID={`reminder-${r.id}-cancel`} accessibilityRole="button" hitSlop={8} onPress={() => { void cancel(r.id); }}
              style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line }}>
              <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.red }}>{t("reminders.cancel")}</Text>
            </Pressable>
          </View>
        ))}

        <View style={{ borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.md }}>
          <Text style={[type.tag, { color: color.faint, marginBottom: space.sm }]} numberOfLines={1}>{t("reminders.add")}</Text>
          <Field label={t("reminders.what")} value={text} onChangeText={(v) => { setText(v); setProblem(null); setSaid(null); }} maxLength={TEXT_MAX} testID="reminder-text" />
          <Text style={[type.small, { color: color.faint, marginTop: -space.md, marginBottom: space.md }]} numberOfLines={1}>{t("reminders.hint")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
            {days.map((d) => chip(`reminder-day-${String(d.offset)}`, dayLabel(t, d), d.day === day, () => setDay(d.day)))}
          </View>
          <Field label={t("reminders.time")} value={time} onChangeText={(v) => { setTime(v); setProblem(null); }} placeholder="16:00" keyboardType="numbers-and-punctuation" maxLength={5} testID="reminder-time" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
            {REPEAT_CHOICES.map((c) => chip(`reminder-repeat-${c}`, t(`reminders.repeat.${c}`), c === repeat, () => setRepeat(c)))}
          </View>
          {problem !== null && <View style={{ marginBottom: space.sm }}><Note tone="bad" testID="reminder-problem">{problem}</Note></View>}
          {said !== null && <View style={{ marginBottom: space.sm }}><Note tone="info" testID="reminder-saved">{said}</Note></View>}
          <Button label={t("reminders.save")} onPress={() => { void save(); }} busy={busy} testID="reminder-save" />
        </View>
      </KeyboardScrollView>
    </View>
  );
}
