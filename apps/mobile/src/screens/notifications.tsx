import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { useNotifications, type PushDiagnosis } from "../notifications";
import { clockLine } from "../roster/words";
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
        {/*
          BLOCKED IN THE PHONE'S SETTINGS. Two buttons, in the order the person uses them: go and
          allow it, then come back — the app re-reads the permission by itself when it returns to the
          front, and "I have allowed it" does the same by hand for a phone that does not tell us.
        */}
        {n.status === "denied" && (
          <>
            <Button testID="push-settings" label={t("mobile.push.openSettings")} onPress={() => { n.wantOn(); void Linking.openSettings().catch(() => undefined); }} />
            <Button testID="push-allowed" kind="secondary" busy={n.busy} label={t("mobile.push.haveAllowed")} onPress={() => { void n.enable(); }} />
          </>
        )}
        {(n.status === "unreachable" || n.status === "serverError" || n.status === "notLinked" || n.status === "unknown") && (
          <Button testID="push-retry" kind="secondary" busy={n.busy} label={t("mobile.push.checkAgain")} onPress={() => { void n.retry(); }} />
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

        <Diagnosis d={n.diagnosis} />
        {n.status !== "unknown" && n.status !== "unreachable" && n.status !== "serverError" && n.status !== "notLinked" && n.status !== "notInBuild" && (
          <Button testID="push-recheck" kind="secondary" busy={n.busy} label={t("mobile.push.checkAgain")} onPress={() => { void n.retry(); }} />
        )}
      </ScrollView>
    </View>
  );
}

/**
 * THE CHAIN, LINK BY LINK, so that "it does not work" can be read out over the phone: the first line
 * that does not say Yes is the fault. Every answer is a word; the mark only repeats it.
 */
export function diagnosisLines(d: PushDiagnosis, t: (k: string, v?: Record<string, string | number>) => string): { key: string; label: string; value: string; ok: boolean | null }[] {
  const yn = (v: boolean | null): string => (v === null ? t("mobile.push.diag.unknown") : t(v ? "mobile.push.diag.yes" : "mobile.push.diag.no"));
  const when = (iso: string | null): string => (iso === null ? t("mobile.push.diag.never") : clockLine(iso, t));
  return [
    { key: "build", label: t("mobile.push.diag.build"), value: yn(d.inBuild), ok: d.inBuild },
    { key: "server", label: t("mobile.push.diag.server"), value: t(`mobile.push.diag.reach.${d.server}`), ok: d.server === "checking" ? null : d.server === "ok" || d.server === "notLinked" },
    { key: "linked", label: t("mobile.push.diag.linked"), value: yn(d.linked), ok: d.linked },
    { key: "canSend", label: t("mobile.push.diag.canSend"), value: yn(d.serverCanSend), ok: d.serverCanSend },
    { key: "permission", label: t("mobile.push.diag.permission"), value: t(`mobile.push.diag.perm.${d.permission}`), ok: d.permission === "granted" ? true : d.permission === "denied" ? false : null },
    { key: "address", label: t("mobile.push.diag.address"), value: t(`mobile.push.diag.addr.${d.address}`), ok: d.address === "yes" ? true : d.address === "no" ? false : null },
    { key: "serverHasIt", label: t("mobile.push.diag.serverHasIt"), value: yn(d.serverHasIt), ok: d.serverHasIt },
    { key: "lastTest", label: t("mobile.push.diag.lastTest"), value: when(d.lastTestAt), ok: null },
    { key: "lastSent", label: t("mobile.push.diag.lastSent"), value: when(d.lastSentAt), ok: null },
    { key: "lastReceived", label: t("mobile.push.diag.lastReceived"), value: when(d.lastReceivedAt), ok: null },
  ];
}

function Diagnosis({ d }: { d: PushDiagnosis }) {
  const { t } = useI18n();
  const lines = diagnosisLines(d, t);
  return (
    <View style={s.card} testID="push-diagnosis">
      <Text style={s.label}>{t("mobile.push.diag.title")}</Text>
      <Text style={s.dim}>{t("mobile.push.diag.how")}</Text>
      {lines.map((l, i) => (
        <View key={l.key} style={[s.diagRow, i === lines.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={s.diagLabel}>{l.label}</Text>
          <Text testID={`push-diag-${l.key}`} style={[s.diagValue, l.ok === false && { color: color.red }, l.ok === true && { color: color.green }]}>{l.value}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  diagRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.line2 },
  diagLabel: { flex: 1, fontSize: 14, lineHeight: 20, color: color.dim },
  diagValue: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: color.ink, textAlign: "right", flexShrink: 1, maxWidth: "50%" },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 4 },
  state: { fontSize: 20, lineHeight: 26, fontWeight: "700", color: color.ink },
  dim: { fontSize: 14, lineHeight: 20, color: color.dim },
  label: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: color.faint },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.line2 },
  kind: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: color.ink },
});
