import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { Text } from "../../src/text";
import { useI18n } from "../../src/i18n";
import { DeskOne } from "../../src/screens/desk-one";
import { DoctorQueue } from "../../src/screens/doctor-queue";
import { SlipDesk } from "../../src/screens/slip-desk";
import { VitalsBay } from "../../src/screens/vitals-bay";
import { SEATS, seatsFor } from "../../src/seats";
import { useSession } from "../../src/session";
import { color, space, type } from "../../src/theme";
import { Band, Button, Note, Tag } from "../../src/ui";

/** One route per phone screen. Built ones render; the rest hold the plan's placeholder until their milestone. */
export default function SeatScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  const seat = seatsFor(state.me.permissions).find((s) => s.key === key) ?? null;
  if (seat === null || !SEATS.includes(seat)) return <Redirect href="/" />;
  if (seat.key === "vitals") return <VitalsBay />;
  if (seat.key === "slips") return <SlipDesk />;
  if (seat.key === "consult") return <DoctorQueue />;
  if (seat.key === "counter") return <DeskOne />;
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
