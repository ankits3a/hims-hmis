import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Text } from "../text";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { color, space, type } from "../theme";
import { Band, Button, Field, Note, Tag } from "../ui";

/** The models of the phones that hold the places, as the refusal carries them (untrusted text). */
function phoneLimit(body: unknown): (string | null)[] {
  const phones = body !== null && typeof body === "object" ? (body as { phones?: unknown }).phones : undefined;
  if (!Array.isArray(phones)) return [];
  return phones.map((p) => (p !== null && typeof p === "object" && typeof (p as { model?: unknown }).model === "string" ? ((p as { model: string }).model).slice(0, 80) : null));
}

/** The web sign-in's human half, on a phone: same words, same palette, same refusals. */
export function LoginScreen({ expired }: { expired?: boolean }) {
  const { t } = useI18n();
  const { login } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (username.trim() === "" || password === "") return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (e) {
      // 401 and 429 both mean "not with these" to the person at the counter; the server keeps
      // the difference (throttle) to itself on purpose.
      // M6a — the one refusal that is NOT "wrong password": the password was right, and other phones
      // hold every place. Only the server says so, and only after it has verified the password.
      const limit = e instanceof ApiError && e.status === 409 && e.code === "phone_limit_reached" ? phoneLimit(e.body) : null;
      setError(limit !== null
        ? t("mobile.phoneLimit", { count: limit.length, phones: limit.map((m) => m ?? t("mobile.phoneLimitUnknown")).join(", ") })
        : e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? t("login.failed") : t("mobile.network"));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.paper }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Band />
      <ScrollView contentContainerStyle={{ padding: space.xl, paddingTop: space.xxl }} keyboardShouldPersistTaps="handled">
        <Tag tone="faint">{t("login.welcome")}</Tag>
        <Text style={[type.title, { color: color.ink, marginTop: space.sm }]}>{t("login.title")}</Text>
        <Text style={[type.small, { color: color.dim, marginTop: 6, marginBottom: space.xl }]}>{t("login.issued")}</Text>

        {expired === true && <Note tone="warn" testID="expired">{t("mobile.expired")}</Note>}
        {error !== null && <Note tone="bad" testID="login-error">{error}</Note>}

        <Field
          label={t("login.username")}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          returnKeyType="next"
          testID="username"
        />
        <Field
          label={t("login.password")}
          value={password}
          onChangeText={setPassword}
          secure
          revealLabel={t("login.reveal")}
          hideLabel={t("login.hide")}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          testID="password"
        />
        <Button
          testID="sign-in"
          label={busy ? t("login.signingIn") : t("login.submit")}
          busy={busy}
          disabled={username.trim() === "" || password === ""}
          onPress={() => void submit()}
        />

        <View style={{ marginTop: space.xxl, borderTopWidth: 1, borderTopColor: color.line, paddingTop: space.lg }}>
          <Text style={[type.small, { color: color.ink, fontWeight: "700" }]}>{t("login.helpTitle")}</Text>
          <Text style={[type.small, { color: color.dim, marginTop: 4 }]}>{t("login.help")}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
