import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { focusHome } from "../home/focus";
import { useI18n } from "../i18n";
import { seatsFor, type Seat } from "../seats";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, MONO, Note } from "../ui";

/**
 * THE BELL (app home round 2 — the board's header carries one). The same rows the web bell shows:
 * what the server has told THIS person, newest first, unread marked. A tap marks it read and goes
 * where the row points — a duty request to My duties, the doctor's line to the queue, an approval
 * past its time to its card on the home screen. Titles and bodies are the server's own sentences;
 * they name staff, counts and times, never a patient (the bell's rule since it was built).
 */
type Alert = { id: string; kind: string; title: string; body: string; createdAt: string; readAt: string | null };
const SEAT_OF: Record<string, Seat["key"]> = {
  roster_flag: "onNow", roster_cover_asked: "myDuties", roster_cover_answered: "myDuties", roster_cover_decided: "myDuties",
  roster_duty_changed: "myDuties", roster_month_published: "myDuties", roster_duty_reminder: "myDuties", opd_not_in: "consult", opd_long_wait: "consult",
};
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function AlertsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { state, call } = useSession();
  const [items, setItems] = useState<Alert[] | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const load = useCallback(async () => {
    try { setItems((await call<{ items: Alert[] }>("GET", "/alerts")).items); setFailed(null); } catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);
  if (state.status !== "signedIn") return null;
  const mine = seatsFor(state.me.permissions).map((s) => s.key);
  const open = (a: Alert): void => {
    if (a.readAt === null) {
      setItems((prev) => (prev ?? []).map((x) => (x.id === a.id ? { ...x, readAt: new Date().toISOString() } : x)));
      void call("POST", `/alerts/${encodeURIComponent(a.id)}/read`).catch(() => undefined);
    }
    if (a.kind === "approval_overdue") { focusHome("approval"); router.push("/"); return; }
    const seat = SEAT_OF[a.kind];
    if (seat !== undefined && mine.includes(seat)) router.push({ pathname: "/seat/[key]", params: { key: seat } });
  };
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="back" style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
          <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
        </Pressable>
      } />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.sm }} testID="alerts">
        <Text style={[type.title, { color: color.ink }]}>{t("mobile.alerts.title")}</Text>
        {failed !== null && <Note tone="warn" testID="alerts-failed">{t(failed === "offline" ? "mobile.alerts.offline" : "mobile.alerts.cannotRead")}</Note>}
        {items !== null && items.length === 0 && <Note tone="info" testID="alerts-empty">{t("mobile.alerts.empty")}</Note>}
        {(items ?? []).map((a) => (
          <Pressable key={a.id} testID={`alert-${a.id}`} accessibilityRole="button" onPress={() => open(a)}
            style={({ pressed }) => ({ backgroundColor: pressed ? color.wash : color.card, borderWidth: 1, borderColor: color.line, borderLeftWidth: 4, borderLeftColor: a.readAt === null ? color.green : color.line, borderRadius: radius.lg, padding: space.md, gap: 2 })}>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "baseline" }}>
              <Text style={{ flex: 1, fontSize: 14.5, fontWeight: a.readAt === null ? "700" : "500", color: color.ink }}>{a.title}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 11, color: color.faint }}>{when(a.createdAt)}</Text>
            </View>
            <Text style={[type.small, { color: color.dim }]}>{a.body}</Text>
            {a.readAt === null && <Text testID={`alert-unread-${a.id}`} style={{ fontSize: 11.5, fontWeight: "700", color: color.green }}>{t("mobile.alerts.unread")}</Text>}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
