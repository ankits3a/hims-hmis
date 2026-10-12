import { useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, KeyboardScrollView, Note } from "../ui";
import { useCopilotOn } from "../copilot/setting";
import { homeCache } from "../home/cache";
import { attendanceCache } from "../attendance/home-card";

/**
 * PHONE SETTINGS (owner 2026-10-11, spec /opt/hmis-context/SPEC-phone-settings-2026-10-11.md) — behind the
 * gear in the band: the language, Reminders, the copilot switch (off by default, follows the account),
 * This phone and My account, and "Log out of this phone". One short line per row (owner 2026-10-09).
 */
export function SettingsScreen() {
  const { t, lang, toggle } = useI18n();
  const router = useRouter();
  const { logout } = useSession();
  const copilot = useCopilotOn();
  const [problem, setProblem] = useState<string | null>(null);

  const row = (testID: string, label: string, onPress: () => void, right?: React.ReactNode) => (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, backgroundColor: pressed ? color.wash : color.card })}>
      <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "600", flex: 1 }]}>{label}</Text>
      {right ?? <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>}
    </Pressable>
  );
  const head = (key: string) => <Text style={[type.tag, { color: color.faint, marginTop: space.md }]} numberOfLines={1}>{t(key)}</Text>;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band copilot={false} right={<Button kind="secondary" label={t("settings.back")} onPress={() => router.back()} testID="settings-back" />} />
      <KeyboardScrollView testID="settings" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.sm }}>
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("settings.title")}</Text>
        {problem !== null && <Note tone="warn" testID="settings-problem">{problem}</Note>}

        {head("settings.language")}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {(["en", "hi"] as const).map((l) => (
            <Pressable key={l} testID={`settings-lang-${l}`} accessibilityRole="button" accessibilityState={{ selected: lang === l }}
              onPress={() => { if (lang !== l) toggle(); }}
              style={{ flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: lang === l ? 2 : 1, borderColor: lang === l ? color.ink : color.line, backgroundColor: lang === l ? color.wash : color.card }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: lang === l ? color.ink : color.dim }}>{l === "en" ? "English" : "हिंदी"}</Text>
            </Pressable>
          ))}
        </View>

        {head("settings.tools")}
        {row("settings-reminders", t("reminders.title"), () => router.push("/reminders"))}
        {row("settings-copilot", t("settings.copilot"), () => { void flip(!copilot.on); },
          <Switch testID="settings-copilot-switch" value={copilot.on} onValueChange={(v) => { void flip(v); }} />)}
        <Text style={[type.small, { color: color.faint }]} numberOfLines={1}>{t(copilot.on ? "settings.copilotOn" : "settings.copilotOff")}</Text>

        {head("settings.account")}
        {row("settings-account", t("mobile.account.open"), () => router.push("/account"))}

        <View style={{ marginTop: space.lg }}>
          <Button kind="secondary" label={t("settings.logout")} testID="settings-logout"
            onPress={() => { void homeCache.clear(); void attendanceCache.clear(); void logout(); }} />
        </View>
      </KeyboardScrollView>
    </View>
  );

  async function flip(on: boolean): Promise<void> {
    setProblem(null);
    try { await copilot.set(on); } catch { setProblem(t("settings.offline")); }
  }
}
