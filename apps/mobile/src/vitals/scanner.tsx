import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../text";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useI18n } from "../i18n";
import { color, radius, space } from "../theme";
import { Button, KeyboardModal } from "../ui";

/**
 * THE CAMERA ITSELF, without the sheet around it — the one barcode reader in the app. The modal
 * below and the header's quick-scan screen (src/screens/scan.tsx) both draw this; mounting it again
 * (a new `key`) arms it for the next read.
 */
export function ScanCamera({ onRead }: { onRead: (data: string) => void }) {
  const done = useRef(false);
  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39"] }}
      onBarcodeScanned={(r) => {
        if (done.current || r.data.trim() === "") return; // one read per opening
        done.current = true;
        onRead(r.data.trim());
      }}
    />
  );
}

/**
 * THE SCAN DOOR. On the counter PC a barcode gun types into the identify box; a phone has a
 * camera. What it reads goes through exactly the same door (`classifyDoor`): a patient card
 * (`q1.…`) is verified by the server before it is trusted, a token number or UHID is looked up on
 * the bench. The camera is asked for only when the nurse opens this sheet.
 */
export function Scanner({ open, onRead, onClose }: { open: boolean; onRead: (data: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [permission, request] = useCameraPermissions();
  if (!open) return null;
  const granted = permission?.granted === true;
  const blocked = permission !== null && !permission.granted && !permission.canAskAgain;
  return (
    <KeyboardModal visible animationType="slide" onRequestClose={onClose} testID="scanner">
      <View style={s.wrap}>
        <Text style={s.title}>{t("mobile.vitals.scanTitle")}</Text>
        {granted ? (
          <>
            <View style={s.frame}>
              <ScanCamera onRead={onRead} />
            </View>
            <Text style={s.hint}>{t("mobile.vitals.scanHint")}</Text>
          </>
        ) : (
          <View style={{ gap: space.md }}>
            <Text style={s.hint} testID="scan-ask">{t(blocked ? "mobile.vitals.scanDenied" : "mobile.vitals.scanAsk")}</Text>
            {!blocked && <Button testID="scan-allow" label={t("mobile.vitals.scanAllow")} onPress={() => { void request(); }} />}
          </View>
        )}
        <View style={{ flex: 1 }} />
        <Button testID="scan-cancel" kind="secondary" label={t("mobile.vitals.scanCancel")} onPress={onClose} />
      </View>
    </KeyboardModal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.agent, padding: space.xl, paddingTop: 56, gap: space.lg },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  frame: { aspectRatio: 1, borderRadius: radius.lg, overflow: "hidden", borderWidth: 2, borderColor: color.mint, backgroundColor: "#000" },
  hint: { color: color.agentFg, fontSize: 15, lineHeight: 21 },
});
