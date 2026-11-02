import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../text";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Note, KeyboardModal, keyboardScroll } from "../ui";
import { refusalText, type VitalsApi } from "./api";

const REASONS = ["patientAsked", "doctorUnavailable", "wrongDoctor", "other"] as const;
type Reason = (typeof REASONS)[number];

/**
 * Spec #1025 — change this patient's doctor from the bay: the department's doctors sitting today, the
 * patient's agreement and a reason. The token and the queue place stay as they are.
 */
export function ChangeDoctorSheet({ api, encounterId, onDone, onClose }: {
  api: Pick<VitalsApi, "changeDoctorOptions" | "changeDoctor">; encounterId: string; onDone: (doctorName: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [doctors, setDoctors] = useState<{ id: string; displayName: string }[] | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = (e: unknown): string => (e instanceof ApiError ? refusalText(e.body, e.code) : t("home.cover.failed"));

  useEffect(() => {
    api.changeDoctorOptions(encounterId).then((out) => setDoctors(out.items), (e: unknown) => { setDoctors([]); setError(failed(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read when the sheet opens
  }, [encounterId]);

  const confirm = async (): Promise<void> => {
    if (doctorId === null || reason === null || !consented || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.changeDoctor(encounterId, { toDoctorId: doctorId, consented, reason: t(`changeDoctor.reason.${reason}`) });
      onDone(doctors?.find((d) => d.id === doctorId)?.displayName ?? "");
      onClose();
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardModal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={busy ? undefined : onClose} accessibilityLabel={t("changeDoctor.cancel")} testID="change-doctor-scrim" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <ScrollView {...keyboardScroll()} style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
          <View testID="change-doctor-dialog" accessibilityLabel={t("changeDoctor.title")} style={{ gap: space.sm }}>
            <Text style={s.title} numberOfLines={1}>{t("changeDoctor.title")}</Text>
            <Text style={s.hint}>{t("changeDoctor.hint")}</Text>
            {doctors !== null && doctors.length === 0 && error === null && <Note tone="warn" testID="change-doctor-none">{t("changeDoctor.none")}</Note>}
            <View style={s.chips}>
              {(doctors ?? []).map((d) => (
                <Pressable
                  key={d.id} testID={`change-doctor-doctor-${d.id}`} accessibilityRole="button" accessibilityState={{ selected: doctorId === d.id }}
                  onPress={() => setDoctorId(d.id)} style={[s.chip, doctorId === d.id && s.chipOn]}
                >
                  <Text style={[s.chipText, doctorId === d.id && { color: "#ffffff" }]}>{d.displayName}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={s.label}>{t("changeDoctor.reasonLabel")}</Text>
            <View style={s.chips}>
              {REASONS.map((r) => (
                <Pressable
                  key={r} testID={`change-doctor-reason-${r}`} accessibilityRole="button" accessibilityState={{ selected: reason === r }}
                  onPress={() => setReason(r)} style={[s.chip, reason === r && s.chipOn]}
                >
                  <Text style={[s.chipText, reason === r && { color: "#ffffff" }]}>{t(`changeDoctor.reason.${r}`)}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              testID="change-doctor-consent" accessibilityRole="checkbox" accessibilityState={{ checked: consented }}
              onPress={() => setConsented((c) => !c)} style={[s.chip, s.consent, consented && s.chipOn]}
            >
              <Text style={[s.chipText, consented && { color: "#ffffff" }]}>{consented ? "✓ " : ""}{t("changeDoctor.consent")}</Text>
            </Pressable>
            {error !== null && <Note tone="bad" testID="change-doctor-error">{error}</Note>}
            <Button testID="change-doctor-confirm" label={t("changeDoctor.confirm")} busy={busy} disabled={doctorId === null || reason === null || !consented || busy} onPress={() => { void confirm(); }} />
            <Button testID="change-doctor-cancel" kind="secondary" label={t("changeDoctor.cancel")} disabled={busy} onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </KeyboardModal>
  );
}

export function ChangeDoctorLink({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable testID="change-doctor-open" accessibilityRole="button" hitSlop={6} onPress={onPress} style={s.linkBtn}>
      <Text style={s.linkText} numberOfLines={1}>{t("changeDoctor.action")} ›</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(19,36,32,.45)" },
  sheet: { maxHeight: "88%", backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: space.lg, paddingTop: space.lg },
  linkBtn: { minHeight: 36, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { fontSize: 14.5, fontWeight: "700", color: color.ink },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700", color: color.ink },
  hint: { fontSize: 13.5, lineHeight: 19, color: color.dim },
  label: { fontSize: 13.5, fontWeight: "600", color: color.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  chipOn: { backgroundColor: color.green, borderColor: color.green },
  chipText: { fontSize: 14, fontWeight: "600", color: color.ink },
  consent: { alignSelf: "stretch" },
});
