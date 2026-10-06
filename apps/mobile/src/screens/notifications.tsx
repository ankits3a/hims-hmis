import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { useNotifications } from "../notifications";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";

/**
 * NOTIFICATIONS ON THIS PHONE (plan M6b). One sentence says where things stand, one button changes
 * it, and each kind has its own switch. The promise is said before anything is asked: a
 * notification says "open HMIS" — never who, never what.
 */
export function NotificationsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const n = useNotifications();
  const canChange = n.status === "on" || n.status === "off" || n.status === "denied";

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="back"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="notifications">
        <Text style={[type.title, { color: color.ink }]}>{t("mobile.push.title")}</Text>

        <View style={[s.card, n.status === "on" && { borderColor: color.green, borderWidth: 2 }]}>
          <Text style={s.state} testID="push-status">{t(`mobile.push.status.${n.status}`)}</Text>
          <Text style={s.dim} testID="push-status-why">{t(`mobile.push.why.${n.status}`)}</Text>
        </View>

        <Note tone="info" testID="push-promise">{t("mobile.push.promise")}</Note>

        {n.problem !== null && <Note tone="bad" testID="push-problem">{t(n.problem)}</Note>}

        {n.status === "off" && <Button testID="push-enable" busy={n.busy} label={t("mobile.push.turnOn")} onPress={() => { void n.enable(); }} />}
        {n.status === "denied" && (
          <Button testID="push-settings" kind="secondary" label={t("mobile.push.openSettings")} onPress={() => { void Linking.openSettings().catch(() => undefined); }} />
        )}

        {n.status === "on" && n.categories.length > 0 && (
          <View style={s.card} testID="push-categories">
            <Text style={s.label}>{t("mobile.push.kinds")}</Text>
            {n.categories.map((c, i) => {
              const on = !n.muted.includes(c);
              return (
                <View key={c} style={[s.row, i === n.categories.length - 1 && { borderBottomWidth: 0 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.kind}>{t(`mobile.push.category.${c}`)}</Text>
                    <Text style={s.dim}>{t(`mobile.push.categoryHint.${c}`)}</Text>
                  </View>
                  <Switch
                    testID={`push-category-${c}`} value={on} accessibilityLabel={t(`mobile.push.category.${c}`)}
                    onValueChange={(v) => { void n.setMuted(c, !v); }}
                    trackColor={{ true: color.green, false: color.line }} thumbColor="#ffffff"
                  />
                </View>
              );
            })}
          </View>
        )}

        {canChange && <Text style={s.dim} testID="push-quiet">{t("mobile.push.quiet")}</Text>}

        {n.status === "on" && <Button testID="push-disable" kind="secondary" busy={n.busy} label={t("mobile.push.turnOff")} onPress={() => { void n.disable(); }} />}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  state: { fontSize: 20, lineHeight: 26, fontWeight: "700", color: color.ink },
  dim: { fontSize: 14, lineHeight: 20, color: color.dim },
  label: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: color.faint },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.line2 },
  kind: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: color.ink },
});
