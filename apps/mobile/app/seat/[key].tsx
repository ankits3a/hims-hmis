import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useI18n } from "../../src/i18n";
import { SEATS, seatsFor } from "../../src/seats";
import { useSession } from "../../src/session";
import { color, space, type } from "../../src/theme";
import { Band, Button, Note, Tag } from "../../src/ui";

/** M0 placeholder for each phone screen; the plan's milestones replace these one by one. */
export default function SeatScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  const seat = seatsFor(state.me.permissions).find((s) => s.key === key) ?? null;
  if (seat === null || !SEATS.includes(seat)) return <Redirect href="/" />;
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band />
      <View style={{ padding: space.xl, gap: space.md }}>
        <Tag tone="faint">{seat.milestone}</Tag>
        <Text style={[type.title, { color: color.ink }]}>{t(`screen.${seat.key}.title`)}</Text>
        <Text style={[type.body, { color: color.dim }]}>{t(`screen.${seat.key}.hint`)}</Text>
        <Note tone="info">{t("mobile.soon")}</Note>
        <Button kind="secondary" label={t("mobile.back")} onPress={() => router.back()} />
      </View>
    </View>
  );
}
