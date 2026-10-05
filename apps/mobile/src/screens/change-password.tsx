import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { color, space, type } from "../theme";
import { Band, Button, Field, Note } from "../ui";

/**
 * The forced reset (server 403 `password_change_required`). The rule shown is the server's
 * rule; the server checks it again and its refusal is what counts.
 */
export function ChangePasswordScreen() {
  const { t } = useI18n();
  const { changePassword, logout } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (next !== again) {
      setError(t("changePassword.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
    } catch (e) {
      if (e instanceof ApiError && e.code === "current_password_incorrect") setError(t("mobile.wrongCurrent"));
      else if (e instanceof ApiError && e.code === "password_policy") setError(t("mobile.policy"));
      else setError(e instanceof NetworkError ? t("mobile.network") : t("mobile.network"));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band />
      <ScrollView contentContainerStyle={{ padding: space.xl }} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: color.ink }]}>{t("changePassword.title")}</Text>
        <Text style={[type.small, { color: color.dim, marginTop: 6, marginBottom: space.lg }]}>{t("changePassword.why")}</Text>
        <Note tone="info">{t("changePassword.rule")}</Note>
        {error !== null && <Note tone="bad" testID="change-error">{error}</Note>}
        <Field label={t("changePassword.current")} value={current} onChangeText={setCurrent} secure revealLabel={t("login.reveal")} hideLabel={t("login.hide")} autoCapitalize="none" testID="current" />
        <Field label={t("changePassword.next")} value={next} onChangeText={setNext} secure revealLabel={t("login.reveal")} hideLabel={t("login.hide")} autoCapitalize="none" testID="next" />
        <Field label={t("changePassword.confirm")} value={again} onChangeText={setAgain} secure revealLabel={t("login.reveal")} hideLabel={t("login.hide")} autoCapitalize="none" testID="again" />
        <Button testID="change" label={t("mobile.submitChange")} busy={busy} disabled={current === "" || next === "" || again === ""} onPress={() => void submit()} />
        <Text style={{ height: space.md }} />
        <Button kind="secondary" label={t("app.logout")} onPress={() => void logout()} />
      </ScrollView>
    </View>
  );
}
