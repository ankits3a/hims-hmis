import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { ApiError, NetworkError } from "../api";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, Note } from "../ui";
import { attendanceApi, type MarkPlace, type SelfMark } from "./api";
import { neverAsked, readOnce, type Reading } from "./location";
import type { T } from "./views";
import type { Call } from "../doctor/api";

/** Server's cap (`MAX_MARKS_PER_DAY`): past it the button is not drawn. */
export const MAX_MARKS_PER_DAY = 6;
export const MARK_COLOR: Record<MarkPlace, string> = { inside: color.green, outside: color.red, not_shared: color.dim, doubtful: "#8a5a10" };

/** "Marked in · inside premises" — what a person sees of their own mark. Words only: no time, no metres. */
export function markWords(t: T, m: Pick<SelfMark, "kind" | "place">): string {
  return `${t(`attendance.mark.done.${m.kind}`)} · ${t(`attendance.mark.place.${m.place}`)}`;
}
export function MarkLine({ t, mark, testID }: { t: T; mark: SelfMark; testID: string }) {
  return <Text testID={testID} numberOfLines={1} style={[type.small, { color: MARK_COLOR[mark.place], fontWeight: "600" }]}>{markWords(t, mark)}</Text>;
}

/**
 * ═══ "MARK ATTENDANCE" — A BACKUP TO THE MACHINE (owner 2026-10-10, decision 0061) ═══
 *
 * In, or Out after an In. The tap reads the position ONCE (`location.ts`) and sends it; the server
 * answers with a word. The mark is evidence for the Attendance Committee — it never changes the day's
 * word, so this card says only what was marked and where, never "Present".
 *
 * Android's permission prompt cannot carry our sentence, so on Android the first tap shows it first;
 * the iPhone's own prompt carries it (`NSLocationWhenInUseUsageDescription`).
 */
export function MarkAttendance({ t, call, today, marks, onMarked, read = readOnce, firstAsk = neverAsked, os = Platform.OS }: {
  t: T; call: Call; today: string; marks: readonly SelfMark[]; onMarked: () => void;
  read?: () => Promise<Reading | null>; firstAsk?: () => Promise<boolean>; os?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The answer to a tap, shown at once — until the screen's re-read brings the marks, which then include it.
  const [made, setMade] = useState<{ mark: SelfMark; created: boolean } | null>(null);
  useEffect(() => { setMade(null); }, [marks]);
  const todays = marks.filter((m) => m.date === today);
  const last = made?.mark ?? todays[todays.length - 1] ?? null;
  const count = todays.length + (made?.created === true ? 1 : 0);
  const next = count % 2 === 0 ? "in" : "out";

  const send = async (): Promise<void> => {
    setExplain(false); setBusy(true); setError(null);
    try {
      const reading = await read();
      const r = await attendanceApi(call).mark(reading);
      setMade(r);
      onMarked();
    } catch (e) {
      setError(t(e instanceof NetworkError ? "attendance.mark.offline" : e instanceof ApiError && e.status === 429 ? "attendance.mark.tooMany" : "attendance.mark.failed"));
      onMarked(); // a lost answer may have landed: re-read, never resend by itself
    } finally { setBusy(false); }
  };
  const tap = async (): Promise<void> => {
    if (os === "android" && await firstAsk()) { setExplain(true); return; }
    await send();
  };

  return (
    <View testID="att-mark" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm }}>
      {last !== null && <MarkLine t={t} mark={last} testID="att-mark-last" />}
      {explain ? (
        <View testID="att-mark-why" style={{ gap: space.sm }}>
          <Text testID="att-mark-why-text" style={[type.small, { color: color.ink }]}>{t("mobile.location.why")}</Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}><Button testID="att-mark-continue" label={t("attendance.mark.continue")} onPress={() => { void send(); }} /></View>
            <View style={{ flex: 1 }}><Button testID="att-mark-cancel" kind="secondary" label={t("attendance.mark.cancel")} onPress={() => setExplain(false)} /></View>
          </View>
        </View>
      ) : count < MAX_MARKS_PER_DAY && (
        <Button testID="att-mark-button" busy={busy} label={busy ? t("attendance.mark.checking") : t(`attendance.mark.${next}`)} onPress={() => { void tap(); }} />
      )}
      {error !== null && <Note tone="warn" testID="att-mark-error">{error}</Note>}
    </View>
  );
}
