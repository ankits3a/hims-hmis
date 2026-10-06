import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { Text } from "../text";
import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { useNotifications } from "../notifications";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { color, radius, space, TOUCH, type } from "../theme";
import { APP_VERSION, APP_VERSION_CODE } from "../config";
import { Band, Button, MONO, Note, Tag } from "../ui";
import { ota, otaStamp } from "../ota";
import { checkForUpdate, type UpdateAnswer } from "../update";

/** After sign-in: the phone screens this person's role allows, and nothing else. */
export function SeatHome() {
  const { t } = useI18n();
  const router = useRouter();
  const { state, logout, fetcher } = useSession();
  const push = useNotifications();
  /*
    THE UPDATE OFFER (no app store, owner 2026-10-05). Asked once when this screen opens, quietly:
    "unknown" — no signal, or the feed is not served — shows nothing at all. Asked again by hand
    from the row at the foot, and THAT answer is always said, whichever it is.
  */
  const [update, setUpdate] = useState<UpdateAnswer | null>(null);
  const [asked, setAsked] = useState<"no" | "checking" | "yes">("no");
  const [later, setLater] = useState(false);
  useEffect(() => {
    let gone = false;
    void checkForUpdate(fetcher).then((a) => { if (!gone) setUpdate(a); });
    return () => { gone = true; };
  }, [fetcher]);
  const checkNow = useCallback(async () => {
    setAsked("checking");
    // Asked by hand: a bundle published a minute ago is fetched and run now (src/ota.ts) — this is the home screen.
    if (await ota.settle(() => true, true)) return;
    setUpdate(await checkForUpdate(fetcher));
    setLater(false);
    setAsked("yes");
  }, [fetcher]);
  const stamp = otaStamp();
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
        {update?.kind === "update" && !later && (
          <View testID="update-offer" style={{ backgroundColor: color.card, borderWidth: 2, borderColor: color.green, borderRadius: radius.lg, padding: space.lg, marginBottom: space.lg, gap: space.sm }}>
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.update.title")}</Text>
            <Text style={[type.small, { color: color.dim }]}>{t("mobile.update.body", { version: update.latest.versionName, current: APP_VERSION })}</Text>
            {update.latest.notes !== undefined && <Text testID="update-notes" style={[type.body, { color: color.ink }]}>{update.latest.notes}</Text>}
            <Text style={[type.small, { color: color.faint }]}>{t("mobile.update.howTo")}</Text>
            <Button testID="update-get" label={t("mobile.update.get")} onPress={() => { void Linking.openURL(update.url).catch(() => undefined); }} />
            <Button testID="update-later" kind="secondary" label={t("mobile.update.later")} onPress={() => setLater(true)} />
          </View>
        )}
        {/*
          M6b — THE ONE TIME NOTIFICATIONS ARE OFFERED UNINVITED: once, here, after sign-in, when they
          could be on and the person has never been asked. It says what a notification will and will
          not contain BEFORE the phone's own prompt can open; "Not now" is remembered.
        */}
        {push.offer && (
          <View testID="push-offer" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.greenLine, borderRadius: radius.lg, padding: space.lg, marginBottom: space.lg, gap: space.sm }}>
            <Text style={[type.heading, { color: color.ink }]}>{t("mobile.push.offerTitle")}</Text>
            <Text style={[type.small, { color: color.dim }]}>{t("mobile.push.promise")}</Text>
            <Button testID="push-offer-on" busy={push.busy} label={t("mobile.push.turnOn")} onPress={() => { void push.enable(); }} />
            <Button testID="push-offer-later" kind="secondary" label={t("mobile.push.notNow")} onPress={push.dismissOffer} />
          </View>
        )}
        {push.problem !== null && !push.offer && push.status !== "on" && <Note tone="warn" testID="push-home-problem">{t(push.problem)}</Note>}
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
        <Pressable testID="account-open" accessibilityRole="button" onPress={() => router.push("/account")}
          style={({ pressed }) => ({ minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, backgroundColor: pressed ? color.wash : color.card })}>
          <Text style={[type.body, { color: color.ink, fontWeight: "600", flex: 1 }]}>{t("mobile.account.open")}</Text>
          <Text style={{ color: color.faint, fontSize: 22 }}>›</Text>
        </Pressable>
        <View style={{ marginTop: space.md, gap: 6 }}>
          <Tag tone="faint">{`HMIS ${t("login.product")}`}</Tag>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.md }}>
            <Text testID="app-version" style={[type.small, { color: color.faint, fontFamily: MONO }]}>{t("mobile.update.version", { version: APP_VERSION, code: APP_VERSION_CODE })}</Text>
            <Pressable testID="update-check" accessibilityRole="button" hitSlop={8} disabled={asked === "checking"} onPress={() => { void checkNow(); }}
              style={{ minHeight: 36, justifyContent: "center" }}>
              <Text style={{ color: color.green, fontSize: 13, fontWeight: "700" }}>{t(asked === "checking" ? "mobile.update.checking" : "mobile.update.check")}</Text>
            </Pressable>
          </View>
          {stamp !== null && <Text testID="ota-stamp" style={[type.small, { color: color.faint, fontFamily: MONO }]}>{t("mobile.update.ota", { when: stamp })}</Text>}
          {asked === "yes" && update?.kind === "latest" && <Text testID="update-latest" style={[type.small, { color: color.dim }]}>{t("mobile.update.latest", { version: APP_VERSION })}</Text>}
          {asked === "yes" && update?.kind === "unknown" && <Text testID="update-unknown" style={[type.small, { color: color.dim }]}>{t("mobile.update.failed")}</Text>}
        </View>
      </ScrollView>
    </View>
  );
}
