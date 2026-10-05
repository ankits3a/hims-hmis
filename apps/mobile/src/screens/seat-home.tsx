import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, MONO, Note, Tag } from "../ui";

/** After sign-in: the phone screens this person's role allows, and nothing else. */
export function SeatHome() {
  const { t } = useI18n();
  const router = useRouter();
  const { state, logout } = useSession();
  if (state.status !== "signedIn") return null;
  const seats = seatsFor(state.me.permissions);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band
        right={
          <Pressable onPress={() => void logout()} accessibilityRole="button" hitSlop={8} testID="logout"
            style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("app.logout")}</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}>
        <Text style={[type.small, { color: color.dim, fontFamily: MONO }]} testID="signed-in-as">
          {t("mobile.signedInAs", { name: state.username || state.me.actor.id })}
        </Text>
        <Text style={[type.title, { color: color.ink, marginTop: space.sm }]}>{t("mobile.seatTitle")}</Text>
        <Text style={[type.small, { color: color.dim, marginTop: 4, marginBottom: space.lg }]}>{t("mobile.seatHint")}</Text>
        {seats.length === 0 && <Note tone="info" testID="no-seats">{t("mobile.none")}</Note>}
        {seats.map((seat) => (
          <Pressable
            key={seat.key}
            testID={`seat-${seat.key}`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/seat/[key]", params: { key: seat.key } })}
            style={({ pressed }) => ({
              minHeight: TOUCH + 24,
              backgroundColor: pressed ? color.wash : color.card,
              borderWidth: 1,
              borderColor: color.line,
              borderRadius: radius.lg,
              padding: space.lg,
              marginBottom: space.md,
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
            })}
          >
            <View style={{ width: 8, alignSelf: "stretch", borderRadius: 4, backgroundColor: color.green }} />
            <View style={{ flex: 1 }}>
              <Text style={[type.heading, { color: color.ink }]}>{t(`screen.${seat.key}.title`)}</Text>
              <Text style={[type.small, { color: color.dim, marginTop: 2 }]}>{t(`screen.${seat.key}.hint`)}</Text>
            </View>
            <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
          </Pressable>
        ))}
        <View style={{ marginTop: space.md }}>
          <Tag tone="faint">{`HMIS ${t("login.product")}`}</Tag>
        </View>
      </ScrollView>
    </View>
  );
}
