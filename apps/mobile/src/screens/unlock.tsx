import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "../text";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { color, space, type } from "../theme";
import { Band, Button, Note } from "../ui";

/** A stored session behind the phone's own lock (fingerprint / face / device PIN). */
export function UnlockScreen() {
  const { t } = useI18n();
  const { unlock, forgetAndSignIn } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      setFailed(!(await unlock()));
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };
  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band />
      <View style={{ padding: space.xl, paddingTop: space.xxl, gap: space.lg }}>
        <Text style={[type.title, { color: color.ink }]}>{t("mobile.unlockTitle")}</Text>
        <Text style={[type.body, { color: color.dim }]}>{t("mobile.unlockPrompt")}</Text>
        {failed && <Note tone="warn" testID="unlock-failed">{t("mobile.unlockFailed")}</Note>}
        <Button testID="unlock" label={t("mobile.unlockAgain")} busy={busy} onPress={() => void go()} />
        <Button testID="use-password" kind="secondary" label={t("mobile.usePassword")} onPress={() => void forgetAndSignIn()} />
      </View>
    </View>
  );
}
