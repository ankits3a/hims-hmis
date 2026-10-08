import { useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { API_BASE, APP_VERSION, APP_VERSION_CODE } from "../config";
import { describePhone } from "../device";
import { useI18n } from "../i18n";
import { useNotifications } from "../notifications";
import { SCREENSHOTS_BLOCKED } from "../privacy";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";
import { checkForUpdate, type UpdateAnswer } from "../update";
import { clockLine } from "../roster/words";

/**
 * THIS PHONE (plan M6a; owner 2026-10-06: staff use personal phones). Who is signed in on it and
 * since when, what the phone told the server it is, which build this is, the update check, and
 * logging out. It also says the one thing a person with a lost phone needs to know: an
 * administrator can sign THIS phone out without touching their password (`/admin/users` → Phones).
 *
 * Nothing here decides anything. "Since" is when this phone signed in, kept beside the session on
 * the phone; the server's own record of this phone is what the administrator sees.
 */
export function AccountScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { state, logout, fetcher } = useSession();
  const push = useNotifications();
  const [update, setUpdate] = useState<UpdateAnswer | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    setUpdate(await checkForUpdate(fetcher));
    setChecking(false);
  }, [fetcher]);
  if (state.status !== "signedIn") return null;
  const phone = describePhone();
  const said = [phone.model, phone.os].filter((x): x is string => x !== undefined).join(" · ");
  const server = API_BASE.replace(/^https?:\/\//, "").replace(/\/api$/, "");

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* No patient work here: the header's scan button is left off (owner 2026-10-08). */}
      <Band scan={false}
        right={
          <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="back"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="account">
        <Text style={[type.title, { color: color.ink }]}>{t("mobile.account.title")}</Text>

        <View style={s.card}>
          <Text style={s.big} testID="account-who">{t("mobile.account.signedInAs", { name: state.username || state.me.actor.id })}</Text>
          <Text style={s.dim} testID="account-since">
            {state.since === null ? t("mobile.account.sinceUnknown") : t("mobile.account.since", { when: clockLine(state.since, t) })}
          </Text>
        </View>

        <View style={s.card}>
          <Row label={t("mobile.account.phone")} value={said === "" ? t("mobile.account.phoneUnknown") : said} testID="account-phone" />
          <Row label={t("mobile.account.app")} value={t("mobile.account.appLine", { version: APP_VERSION, code: APP_VERSION_CODE })} testID="account-app" />
          <Row label={t("mobile.account.server")} value={server} testID="account-server" />
          <Row label={t("mobile.account.screenshots")} value={t(SCREENSHOTS_BLOCKED ? "mobile.account.screenshotsBlocked" : "mobile.account.screenshotsAllowed")} testID="account-screenshots" last />
        </View>

        <Pressable
          testID="account-notifications" accessibilityRole="button" onPress={() => router.push("/notifications")}
          style={({ pressed }) => [s.card, { flexDirection: "row", alignItems: "center", gap: space.md }, pressed && { backgroundColor: color.wash }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.label}>{t("mobile.push.title")}</Text>
            <Text style={s.value} testID="account-notifications-status">{t(`mobile.push.status.${push.status}`)}</Text>
          </View>
          <Text style={{ fontSize: 22, color: color.faint }}>›</Text>
        </Pressable>

        <Note tone="info" testID="account-lost">{`${t("mobile.account.lost")} ${t("mobile.account.limit")}`}</Note>

        <Button kind="secondary" testID="account-update-check" busy={checking} label={t("mobile.update.check")} onPress={() => { void check(); }} />
        {update?.kind === "latest" && <Text style={s.dim} testID="account-update-latest">{t("mobile.update.latest", { version: APP_VERSION })}</Text>}
        {update?.kind === "unknown" && <Text style={s.dim} testID="account-update-unknown">{t("mobile.update.failed")}</Text>}
        {update?.kind === "update" && (
          <View style={[s.card, { borderColor: color.green, borderWidth: 2, gap: space.sm }]} testID="account-update-offer">
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.update.title")}</Text>
            <Text style={s.dim}>{t("mobile.update.body", { version: update.latest.versionName, current: APP_VERSION })}</Text>
            {update.latest.notes !== undefined && <Text style={[type.body, { color: color.ink }]}>{update.latest.notes}</Text>}
            <Button testID="account-update-get" label={t("mobile.update.get")} onPress={() => { void Linking.openURL(update.url).catch(() => undefined); }} />
          </View>
        )}

        <Button testID="account-logout" label={t("mobile.account.logout")} onPress={() => { void logout(); }} />
      </ScrollView>
    </View>
  );
}

function Row({ label, value, testID, last }: { label: string; value: string; testID: string; last?: boolean }) {
  return (
    <View style={[s.row, last === true && { borderBottomWidth: 0 }]}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value} testID={testID}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg, gap: 2 },
  big: { fontSize: 18, lineHeight: 24, fontWeight: "700", color: color.ink },
  dim: { fontSize: 14, lineHeight: 20, color: color.dim },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: color.line2, gap: 2 },
  label: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: color.faint },
  value: { fontSize: 15.5, lineHeight: 21, color: color.ink },
});
