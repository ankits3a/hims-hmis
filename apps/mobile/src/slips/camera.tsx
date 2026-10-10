import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../text";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { color, radius, space } from "../theme";
import { Button, KeyboardModal } from "../ui";
import type { Photo } from "./imaging";

/**
 * THE SLIP CAMERA — full screen, rear lens, one big shutter under the thumb.
 *
 * It opens only after the desk has confirmed whose slip this is. The corner marks are a GUIDE (fit
 * the whole page inside them); the real edges are found afterwards and the desk can drag them. The
 * lamp is a switch because consulting-room corridors are dim and a flash photo of glossy paper
 * glares — a steady torch lets the desk tilt the page until the writing is clear, then shoot.
 *
 * The picture is taken at the camera's full size: the crop step works on that, and only the final
 * straightened page is brought down to the server's limit.
 *
 * BACK-TO-BACK (owner 2026-10-07): with `burst` the camera stays open after a shot — the desk turns
 * the page and shoots again — and "Done" goes back to the strip. Each page is cut to its corners
 * there; this screen only counts them.
 *
 * Focus: the rear camera focuses continuously by itself. expo-camera has no tap-to-focus point;
 * that is listed as deferred in the plan (§3b).
 */
export function SlipCamera({ open, onShot, onClose, burst = null }: {
  open: boolean; onShot: (p: Photo) => void; onClose: () => void;
  /** Pages already in the strip, and the most one slip takes. Null: one photo, then the crop. */
  burst?: { taken: number; max: number } | null;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cam = useRef<CameraView | null>(null);
  if (!open) return null;
  const granted = permission?.granted === true;
  const blocked = permission !== null && !permission.granted && !permission.canAskAgain;
  const full = burst !== null && burst.taken >= burst.max;

  const shoot = async (): Promise<void> => {
    if (busy || full) return;
    setBusy(true); setFailed(false);
    try {
      // The browser preview has no camera: a test page may hand over a photo instead (web only).
      const stub = Platform.OS === "web" ? (globalThis as { __HMIS_TEST_PHOTO__?: Photo }).__HMIS_TEST_PHOTO__ : undefined;
      if (stub !== undefined) { onShot(stub); return; }
      const pic = await cam.current?.takePictureAsync({ quality: 0.92, exif: false });
      if (pic === undefined || pic === null || pic.width === 0 || pic.height === 0) { setFailed(true); return; }
      if (burst === null) setTorch(false);
      onShot({ uri: pic.uri, width: pic.width, height: pic.height });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardModal ownWindow visible animationType="slide" onRequestClose={onClose} testID="slip-camera" statusBarTranslucent>
      <View style={s.wrap}>
        {granted ? (
          <>
            <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} />
            <View pointerEvents="none" style={s.guide}>
              <View style={[s.mark, s.tl]} /><View style={[s.mark, s.tr]} /><View style={[s.mark, s.bl]} /><View style={[s.mark, s.br]} />
            </View>
            <View style={[s.top, { paddingTop: insets.top + space.md }]}>
              <View style={s.topRow}>
                <Pressable testID="cam-cancel" accessibilityRole="button" onPress={onClose} style={s.chip}><Text style={s.chipText}>{t("slipCapture.cancel")}</Text></Pressable>
                <View style={{ flex: 1 }} />
                <Pressable testID="cam-torch" accessibilityRole="switch" accessibilityState={{ checked: torch }} onPress={() => setTorch((v) => !v)} style={[s.chip, torch && s.chipOn]}>
                  <Text style={[s.chipText, torch && { color: color.ink }]}>{t(torch ? "mobile.slips.torchOn" : "mobile.slips.torchOff")}</Text>
                </Pressable>
              </View>
              <Text style={s.title}>{t("slipCapture.fitCorners")}</Text>
              {burst !== null && (
                <Text testID="cam-count" style={s.count}>
                  {full ? t("mobile.slips.pagesFull", { max: burst.max }) : t("mobile.slips.camNext", { n: burst.taken + 1, taken: burst.taken })}
                </Text>
              )}
            </View>
            <View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, space.lg) + space.md }]}>
              {failed && <Text accessibilityRole="alert" testID="cam-failed" style={s.failed}>{t("mobile.slips.camFailed")}</Text>}
              <View style={s.shootRow}>
                <View style={s.side} />
                <Pressable testID="cam-shoot" accessibilityRole="button" accessibilityLabel={t(burst === null ? "slipCapture.capture" : "mobile.slips.camNextPage")} disabled={busy || full} onPress={() => { void shoot(); }} style={[s.shutter, (busy || full) && { opacity: 0.5 }]}>
                  <View style={s.shutterIn}>{burst !== null && <Text style={s.plus}>+</Text>}</View>
                </Pressable>
                <View style={s.side}>
                  {burst !== null && (
                    <Pressable testID="cam-done" accessibilityRole="button" onPress={onClose} style={s.done}>
                      <Text style={s.doneText}>{t("mobile.slips.camDone", { count: burst.taken })}</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          </>
        ) : (
          <View style={[s.ask, { paddingTop: insets.top + space.xxl }]}>
            <Text style={s.askTitle}>{t("mobile.slips.camTitle")}</Text>
            <Text style={s.askText} testID="cam-ask">{t(blocked ? "mobile.slips.camDenied" : "mobile.slips.camAsk")}</Text>
            {!blocked && <Button testID="cam-allow" label={t("mobile.slips.camAllow")} onPress={() => { void request(); }} />}
            <Button testID="cam-cancel" kind="secondary" label={t("slipCapture.cancel")} onPress={onClose} />
          </View>
        )}
      </View>
    </KeyboardModal>
  );
}

const M = 34;
const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#000" },
  guide: { position: "absolute", left: "7%", right: "7%", top: "19%", bottom: "22%" },
  mark: { position: "absolute", width: M, height: M, borderColor: color.mint },
  tl: { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4, borderTopLeftRadius: 6 },
  tr: { right: 0, top: 0, borderRightWidth: 4, borderTopWidth: 4, borderTopRightRadius: 6 },
  bl: { left: 0, bottom: 0, borderLeftWidth: 4, borderBottomWidth: 4, borderBottomLeftRadius: 6 },
  br: { right: 0, bottom: 0, borderRightWidth: 4, borderBottomWidth: 4, borderBottomRightRadius: 6 },
  top: { position: "absolute", left: 0, right: 0, top: 0, gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md, backgroundColor: "rgba(0,0,0,.45)" },
  topRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { color: "#fff", fontSize: 15, fontWeight: "700", textAlign: "center" },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: "rgba(255,255,255,.55)" },
  chipOn: { backgroundColor: "#ffd866", borderColor: "#ffd866" },
  chipText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center", gap: space.md, paddingTop: space.lg, backgroundColor: "rgba(0,0,0,.45)" },
  shutter: { width: 84, height: 84, borderRadius: 42, borderWidth: 5, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterIn: { width: 64, height: 64, borderRadius: 32, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  count: { color: "#ffd866", fontSize: 14, fontWeight: "700", textAlign: "center" },
  shootRow: { flexDirection: "row", alignItems: "center", alignSelf: "stretch", paddingHorizontal: space.md },
  side: { flex: 1, alignItems: "flex-end" },
  plus: { fontSize: 34, lineHeight: 38, fontWeight: "700", color: "#132420", textAlign: "center" },
  done: { minHeight: 52, justifyContent: "center", paddingHorizontal: 16, borderRadius: 26, backgroundColor: color.mint },
  doneText: { color: "#0b1a15", fontSize: 15, fontWeight: "800" },
  failed: { color: "#fff", backgroundColor: color.red, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, fontSize: 14, fontWeight: "700" },
  ask: { flex: 1, backgroundColor: color.agent, padding: space.xl, gap: space.lg },
  askTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  askText: { color: color.agentFg, fontSize: 15, lineHeight: 21 },
});
