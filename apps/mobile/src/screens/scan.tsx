import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { scanApi, type ScanSource } from "../scan/api";
import { ActionCard, look, scannedParams, type Looked } from "../scan/card";
import * as model from "../scan/model";
import type { ScanAction, ScanPatient, ScanVisit } from "../scan/model";
import { seatsFor } from "../seats";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Band, MONO } from "../ui";
import { ScanCamera } from "../vitals/scanner";

/**
 * SCAN A PATIENT (owner 2026-10-08; board part "scan" frames B–E). Opened by the scan button in
 * every header. The camera is there at once — no menu first — and under it one box takes the same
 * thing typed: a token (`4`, `ORT-4`), a UHID, a visit number. Both go through the app's one reader
 * (`doorsOf`) and one server read (`GET /opd/scan`).
 *
 * WHAT FOLLOWS IS THE FASTEST ROAD: a patient waiting for exactly this person's job opens that job
 * (`scanPlan`'s `jump`) — nothing is written, the screen simply opens with one green line saying
 * what was scanned. Anything else is ONE card. The camera itself is the scanner the vitals bay and
 * the slip desk already use (`ScanCamera`).
 */
export function ScanScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { call, state } = useSession();
  const api = useMemo(() => scanApi(call), [call]);
  const seats = useMemo(() => (state.status === "signedIn" ? seatsFor(state.me.permissions).map((x) => x.key) : []), [state]);
  const [permission, request] = useCameraPermissions();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [looked, setLooked] = useState<Looked | null>(null);
  const [round, setRound] = useState(0);
  const seq = useRef(0);

  const granted = permission?.granted === true;
  // Asked once, by itself: the person tapped "scan", so the camera is what they came for.
  const asked = useRef(false);
  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain && !asked.current) { asked.current = true; void request(); }
  }, [permission, request]);
  const denied = permission !== null && !permission.granted && (!permission.canAskAgain || asked.current);

  const go = useCallback((action: ScanAction, visit: ScanVisit | null, patient: ScanPatient) => {
    // The scan screen is replaced, so Back from the job returns to where the person was.
    router.replace({ pathname: "/seat/[key]", params: scannedParams(action, visit, patient, t) });
  }, [router, t]);

  const find = useCallback(async (source: ScanSource): Promise<void> => {
    if ("raw" in source && source.raw.trim() === "") return;
    const mine = ++seq.current;
    setBusy(true); setLooked(null);
    const l = await look(api, source);
    if (mine !== seq.current) return;
    setBusy(false);
    if (l.outcome.outcome === "visit") {
      const plan = model.scanPlan(l.outcome.visit, model.reachable(l.outcome.permitted, seats), { cashOpen: l.cashOpen });
      if (plan.jump !== null) { go(plan.jump, l.outcome.visit, l.outcome.visit.patient); return; }
    }
    setLooked(l);
  }, [api, seats, go]);

  const again = (): void => { seq.current += 1; setLooked(null); setBusy(false); setTyped(""); setRound((n) => n + 1); };

  return (
    <View style={{ flex: 1, backgroundColor: color.agent }} testID="scan-screen">
      <Band scan={false} right={
        <Pressable testID="scan-back" accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
          <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
        </Pressable>
      } />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "web" ? undefined : "padding"}>
        <View style={s.cam}>
          {/* One read per mounting: "Scan another" mounts it again. Unmounted while a card is up, so nothing is read behind it. */}
          {granted && looked === null && !busy && <ScanCamera key={round} onRead={(data) => { void find({ raw: data }); }} />}
          <View pointerEvents="none" style={s.aimWrap}>
            <View style={s.aim}>
              <View style={[s.corner, { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 }]} />
              <View style={[s.corner, { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 }]} />
              <View style={[s.corner, { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 }]} />
              <View style={[s.corner, { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 }]} />
              {granted && <View style={s.beam} />}
              {busy && <ActivityIndicator color={color.mint} size="large" />}
            </View>
            {/* On a dark plate: the words stay readable whatever the camera is pointed at. */}
            <View style={s.plate}>
              <Text style={s.title}>{t("mobile.scan.title")}</Text>
              {denied
                ? <Text style={[s.hint, { color: color.gold }]} testID="scan-denied">{t("mobile.scan.denied")}</Text>
                : <Text style={s.hint} testID="scan-hint">{t(busy ? "mobile.scan.looking" : "mobile.scan.hint")}</Text>}
            </View>
          </View>
        </View>
        <View style={[s.typeBox, { paddingBottom: Math.max(insets.bottom, space.md) + space.sm }]}>
          <Text style={s.typeLabel}>{t("mobile.scan.typeLabel")}</Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              testID="scan-typed" accessibilityLabel={t("mobile.scan.typeLabel")} value={typed} onChangeText={setTyped}
              autoCapitalize="characters" autoCorrect={false} autoComplete="off" returnKeyType="go" editable={!busy}
              placeholder={t("mobile.scan.typeHolder")} placeholderTextColor={color.agentDim}
              onSubmitEditing={() => { void find({ raw: typed }); }} style={s.input}
            />
            <Pressable testID="scan-go" accessibilityRole="button" accessibilityState={{ disabled: busy || typed.trim() === "" }} disabled={busy || typed.trim() === ""}
              onPress={() => { void find({ raw: typed }); }} style={({ pressed }) => [s.goBtn, (busy || typed.trim() === "") && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
              <Text style={s.goText}>{t("mobile.scan.go")}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      {looked !== null && (
        <ActionCard
          looked={looked} seats={seats} onClose={again} onAgain={again}
          onPick={(c) => { void find({ encounterId: c.encounterId }); }}
          onAct={(action, visit) => go(action, visit, visit.patient)}
          onNewVisit={(patient) => go("newVisit", null, patient)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  cam: { flex: 1, backgroundColor: "#0b1512", overflow: "hidden" },
  aimWrap: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md },
  aim: { width: "72%", maxWidth: 300, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  corner: { position: "absolute", width: 34, height: 34, borderColor: color.mint },
  beam: { position: "absolute", left: 14, right: 14, height: 2, borderRadius: 1, backgroundColor: color.mint, opacity: 0.85 },
  plate: { alignItems: "center", gap: 4, backgroundColor: "rgba(11,21,18,.72)", borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md, marginTop: space.sm },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  hint: { color: color.agentFg, fontSize: 14.5, lineHeight: 20, textAlign: "center" },
  typeBox: { backgroundColor: color.agent, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, borderTopWidth: 1, borderTopColor: "rgba(217,239,228,.14)" },
  typeLabel: { color: color.agentDim, fontSize: 13, fontWeight: "600" },
  input: { flex: 1, minHeight: TOUCH + 4, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(217,239,228,.28)", backgroundColor: "rgba(255,255,255,.06)", paddingHorizontal: 14, color: "#fff", fontFamily: MONO, fontSize: 18 },
  goBtn: { minHeight: TOUCH + 4, minWidth: 76, borderRadius: radius.md, backgroundColor: color.mint, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
  goText: { color: color.agent, fontSize: 16, fontWeight: "800" },
});
