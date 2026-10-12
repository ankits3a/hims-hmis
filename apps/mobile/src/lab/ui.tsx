import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, MONO } from "../ui";
import type { QuickChosenTest, QuickPatient } from "./api";

/** The shared pieces of the three quick-lab screens. */
export type T = ReturnType<typeof useI18n>["t"];

/** The list re-read while the app is in front, as the web's 20-second refetch. */
export const LAB_POLL_MS = 20_000;

export function usePoll<R>(read: () => Promise<R>, ms: number = LAB_POLL_MS) {
  const [data, setData] = useState<R | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reader = useRef(read);
  reader.current = read;
  const refresh = useCallback(async (): Promise<void> => {
    try { setData(await reader.current()); setError(null); } catch (e) { setError(e); }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (AppState.currentState !== "background") void refresh(); }, ms);
    return () => clearInterval(id);
  }, [refresh, ms]);
  return { data, error, refresh };
}

export function sexAge(t: T, gender: string, dob: string | null): string {
  const g = gender === "male" ? t("quickLab.sex.m") : gender === "female" ? t("quickLab.sex.f") : t("quickLab.sex.o");
  if (dob === null) return g;
  const b = new Date(dob);
  const now = new Date();
  let y = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) y -= 1;
  return y >= 1 ? `${g} ${y}${t("quickLab.yearShort")}` : g;
}

export const minutesSince = (iso: string): number => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

/** "14:05" in IST, the hospital's clock. */
export function istTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function Screen({ title, onBack, children }: { title: string; onBack?: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <Pressable onPress={onBack ?? (() => router.back())} accessibilityRole="button" hitSlop={8} testID="back"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
        <Text style={[type.heading, { color: color.ink }]} numberOfLines={1}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** One patient: name, then sex·age·UHID on one line, then whatever the screen adds. */
export function Person({ p, sub, t }: { p: QuickPatient; sub?: string; t: T }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={ls.name} numberOfLines={1}>{p.display}</Text>
      <Text style={ls.ids} numberOfLines={1}>{sexAge(t, p.administrativeGender, p.dob)} · {p.uhid}</Text>
      {sub !== undefined && sub !== "" && <Text style={ls.sub} numberOfLines={1}>{sub}</Text>}
    </View>
  );
}

export function TestChips({ tests, extra }: { tests: readonly QuickChosenTest[]; extra?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
      {extra}
      {tests.map((x) => <Text key={x.serviceId} style={ls.chip}>{x.code}</Text>)}
    </View>
  );
}

/** One line in green: what just happened. */
export function Done({ text, testID }: { text: string; testID: string }) {
  return (
    <View testID={testID} accessibilityRole="alert" style={ls.done}>
      <Text style={ls.doneText} numberOfLines={1}>✓ {text}</Text>
    </View>
  );
}

export function RowCard({ testID, onPress, children, label }: { testID: string; onPress: () => void; children: ReactNode; label: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [ls.row, pressed && { backgroundColor: color.wash }]}>
      {children}
      <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
    </Pressable>
  );
}

export const ls = StyleSheet.create({
  name: { fontSize: 15.5, fontWeight: "700", color: color.ink },
  ids: { fontFamily: MONO, fontSize: 12, color: color.dim },
  sub: { fontSize: 12, color: color.faint },
  chip: { fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: color.green, backgroundColor: color.greenSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  chipWarn: { fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: "#8a5a10", backgroundColor: color.goldSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  chipRed: { fontFamily: MONO, fontSize: 11.5, fontWeight: "700", color: color.red, backgroundColor: color.redSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  done: { backgroundColor: color.greenSoft, borderWidth: 1, borderColor: color.green, borderRadius: radius.md, padding: space.md },
  doneText: { color: color.green, fontWeight: "700", fontSize: 14 },
  row: { minHeight: TOUCH + 16, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, flexDirection: "row", alignItems: "center", gap: space.md },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  empty: { fontSize: 14, color: color.dim, textAlign: "center", padding: space.xl, borderWidth: 1, borderStyle: "dashed", borderColor: color.line, borderRadius: radius.lg },
  cap: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, color: color.faint, textTransform: "uppercase" },
});
