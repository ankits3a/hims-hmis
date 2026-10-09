import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { istDay } from "../doctor/rules";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { attendanceApi, homeRange, type Me } from "./api";
import { TODAY_TONE, confirmSummary, type TodayState } from "./rules";
import { TONE, dayLabel, wordText, type T } from "./views";
import type { Call } from "../doctor/api";

/**
 * ═══ THE HOME CARD — "Attendance" (board frame 1) ═══
 *
 * One small card under the greeting: grey "Not checked in", green "✓ Checked in", grey "Checked out"
 * with the day's word beneath. No time — the server sends none to a person about their own day. When
 * a past day needs "Confirm" an amber row names the most recent one.
 *
 * ONE request (`/attendance/me`, today and the 31 days behind it), failing soft: an unlinked person
 * gets one quiet line, a hospital whose machine is not connected gets nothing, and a failed read
 * shows nothing new. What is kept across a restart is ONLY today's state word — no day, no history.
 */
const KEY = "hmis.attendance";
let memory: string | null = null;
type Cold = { user: string; date: string; state: TodayState };
const STATES: readonly TodayState[] = ["not_checked_in", "checked_in", "checked_out"];

export const attendanceCache = {
  async save(c: Cold): Promise<void> {
    const raw = JSON.stringify(c);
    try { if (Platform.OS === "web") memory = raw; else await SecureStore.setItemAsync(KEY, raw); } catch { /* a cache that cannot be written is not there */ }
  },
  async load(user: string, date: string): Promise<Cold | null> {
    try {
      const raw = Platform.OS === "web" ? memory : await SecureStore.getItemAsync(KEY);
      if (raw === null) return null;
      const v = JSON.parse(raw) as Partial<Cold>;
      return v.user === user && v.date === date && STATES.includes(v.state as TodayState) ? { user, date, state: v.state as TodayState } : null;
    } catch { return null; }
  },
  async clear(): Promise<void> {
    memory = null;
    try { if (Platform.OS !== "web") await SecureStore.deleteItemAsync(KEY); } catch { /* nothing to clear */ }
  },
};

export type AttendanceHome = { me: Me | null; cold: TodayState | null };

/** The home screen's read of the caller's own attendance; `tick` re-reads it (the home's own refresh). */
export function useAttendanceHome(call: Call, user: string, tick: number, nowMs: () => number = Date.now): AttendanceHome {
  const [me, setMe] = useState<Me | null>(null);
  const [cold, setCold] = useState<TodayState | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (user === "") return;
    const today = istDay(new Date(nowMs()).toISOString());
    try {
      const r = homeRange(today);
      const got = await attendanceApi(call).me(r.from, r.to);
      if (!alive.current) return;
      setMe(got);
      if (got.linked && got.configured) void attendanceCache.save({ user, date: got.today.date, state: got.today.state });
    } catch {
      const kept = await attendanceCache.load(user, today);
      if (alive.current) setCold(kept?.state ?? null);
    }
  }, [call, user, nowMs]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Read once when the screen opens; after that, whenever the home re-reads (its tick moves on).
  // The home's FIRST tick is the same moment as the opening read, so it is not a second request.
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    const prev = lastTick.current;
    lastTick.current = tick;
    if (prev === null) { void load(); return; }
    if (prev !== tick && prev !== 0) void load();
  }, [load, tick]);
  return { me, cold };
}

export function AttendanceCard({ t, home, onOpen, onConfirm }: { t: T; home: AttendanceHome; onOpen: () => void; onConfirm: (date: string) => void }) {
  const { me, cold } = home;
  // Not connected: nothing at all. Not read and nothing kept: nothing.
  if (me !== null && !me.configured) return null;
  if (me !== null && !me.linked) {
    return <Text testID="attendance-not-linked" numberOfLines={1} style={[type.small, { color: color.faint, marginTop: space.sm }]}>{t("attendance.notLinked")}</Text>;
  }
  const state = me !== null ? me.today.state : cold;
  if (state === null) return null;
  const tone = TONE[TODAY_TONE[state]];
  const word = me !== null && me.linked ? me.today.status : null;
  const warn = me !== null && me.linked ? confirmSummary(me.needsConfirm) : null;
  return (
    <View testID="attendance-card" style={{ marginTop: space.md, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, overflow: "hidden" }}>
      <Pressable testID="attendance-open" accessibilityRole="button" onPress={onOpen} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, backgroundColor: pressed ? color.wash : color.card })}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={[type.tag, { color: color.faint }]}>{t("attendance.title")}</Text>
          <Text testID="attendance-state" numberOfLines={1} style={{ fontSize: 17, fontWeight: "700", color: state === "checked_in" ? tone.fg : color.dim }}>{t(`attendance.state.${state}`)}</Text>
          {word !== null && <Text testID="attendance-word" numberOfLines={1} style={{ fontSize: 13, fontWeight: "600", color: color.ink }}>{wordText(t, word)}</Text>}
        </View>
        <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
      </Pressable>
      {warn !== null && (
        <Pressable testID="attendance-confirm" accessibilityRole="button" onPress={() => onConfirm(warn.date)}
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md, backgroundColor: color.goldSoft, borderTopWidth: 1, borderTopColor: color.goldLine }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: "700", color: "#8a5a10" }}>{t("attendance.confirmRow", { day: dayLabel(t, warn.date) })}</Text>
          {warn.more > 0 && <Text testID="attendance-confirm-more" numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: "#8a5a10" }}>{t("attendance.confirmMore", { n: warn.more })}</Text>}
          <Text style={{ color: "#8a5a10", fontSize: 20 }}>›</Text>
        </Pressable>
      )}
    </View>
  );
}
