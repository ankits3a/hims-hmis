import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { Text } from "../../src/text";
import { useI18n } from "../../src/i18n";
import { DeskOne } from "../../src/screens/desk-one";
import { DoctorQueue } from "../../src/screens/doctor-queue";
import { RosterMyDuties } from "../../src/screens/roster-my-duties";
import { RosterOnNow } from "../../src/screens/roster-on-now";
import { SlipDesk } from "../../src/screens/slip-desk";
import { VitalsBay } from "../../src/screens/vitals-bay";
import { scannedFrom } from "../../src/scan/card";
import { SEATS, seatsFor } from "../../src/seats";
import { useSession } from "../../src/session";
import { color, space, type } from "../../src/theme";
import { Band, Button, Note, Tag } from "../../src/ui";

/** One route per phone screen. Built ones render; the rest hold the plan's placeholder until their milestone. */
export default function SeatScreen() {
  const params = useLocalSearchParams<{ key: string; act?: string; pid?: string; scan?: string; vno?: string; tno?: string; said?: string }>();
  const { key } = params;
  // Opened by a scan or a held row (owner 2026-10-08): the screen is told which visit, and opens on it.
  const scanned = scannedFrom(params);
  const { t } = useI18n();
  const router = useRouter();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  const seat = seatsFor(state.me.permissions).find((s) => s.key === key) ?? null;
  if (seat === null || !SEATS.includes(seat)) return <Redirect href="/" />;
  if (seat.key === "vitals") return <VitalsBay scanned={scanned} />;
  if (seat.key === "slips") return <SlipDesk scanned={scanned} />;
  if (seat.key === "consult") return <DoctorQueue scanned={scanned} />;
  if (seat.key === "counter") return <DeskOne scanned={scanned} />;
  if (seat.key === "onNow") return <RosterOnNow />;
  if (seat.key === "myDuties") return <RosterMyDuties />;
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
