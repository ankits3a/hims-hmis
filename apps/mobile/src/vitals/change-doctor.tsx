import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../text";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Note, KeyboardModal, keyboardScroll } from "../ui";
import { refusalText, type VitalsApi, type WireDepartmentMove } from "./api";

const REASONS = ["patientAsked", "doctorUnavailable", "wrongDoctor", "other"] as const;
type Reason = (typeof REASONS)[number];

/**
 * Spec #1025 — change this patient's doctor from the bay: the department's doctors sitting today, the
 * patient's agreement and a reason. The token and the queue place stay as they are.
 *
 * Spec #1031 — with `canMoveDepartment` the sheet opens with a Department row, set to the visit's own.
 * Another department moves the visit there (new visit and token, no money, no paper); the new token
 * then stays on the sheet, large, for staff to write on the old slip, until they tap Done.
 */
export function ChangeDoctorSheet({ api, encounterId, onDone, onMoved, onClose, canMoveDepartment = false }: {
  api: Pick<VitalsApi, "changeDoctorOptions" | "changeDoctor" | "changeDepartmentOptions" | "moveDepartment" | "printMovedToken">;
  encounterId: string; onDone: (doctorName: string) => void; onMoved?: (moved: WireDepartmentMove) => void; onClose: () => void;
  canMoveDepartment?: boolean;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [doctors, setDoctors] = useState<{ id: string; displayName: string }[] | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [moved, setMoved] = useState<WireDepartmentMove | null>(null);
  const [printed, setPrinted] = useState(false);
  const otherDept = canMoveDepartment && departmentId !== null && current !== null && departmentId !== current;
  const failed = (e: unknown): string => (e instanceof ApiError ? refusalText(e.body, e.code) : t("home.cover.failed"));

  useEffect(() => {
    setDoctors(null);
    setDoctorId(null);
    if (canMoveDepartment) {
      api.changeDepartmentOptions(encounterId, departmentId ?? undefined).then((out) => {
        setDepartments(out.departments);
        setCurrent(out.currentDepartmentId);
        setDoctors(out.doctors);
      }, (e: unknown) => { setDoctors([]); setError(failed(e)); });
      return;
    }
    api.changeDoctorOptions(encounterId).then((out) => setDoctors(out.items), (e: unknown) => { setDoctors([]); setError(failed(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read when the sheet opens, and one per department picked
  }, [encounterId, departmentId]);

  const confirm = async (): Promise<void> => {
    if (doctorId === null || reason === null || !consented || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (otherDept && departmentId !== null) {
        setMoved(await api.moveDepartment(encounterId, { departmentId, doctorId, consented, reason: t(`changeDoctor.reason.${reason}`) }));
        return;
      }
      await api.changeDoctor(encounterId, { toDoctorId: doctorId, consented, reason: t(`changeDoctor.reason.${reason}`) });
      onDone(doctors?.find((d) => d.id === doctorId)?.displayName ?? "");
      onClose();
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusy(false);
    }
  };

  const print = async (): Promise<void> => {
    if (moved === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.printMovedToken(moved.encounterId);
      setPrinted(true);
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = (): void => { if (moved !== null) onMoved?.(moved); onClose(); };

  if (moved !== null) {
    return (
      <KeyboardModal visible transparent animationType="slide" onRequestClose={finish}>
        <Pressable style={s.scrim} onPress={busy ? undefined : finish} accessibilityLabel={t("changeDoctor.finish")} testID="change-doctor-scrim" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View testID="change-department-done" style={{ gap: space.sm }}>
            <Text style={s.hint} numberOfLines={1}>{moved.departmentName} · {moved.doctorName}</Text>
            <Text style={s.label}>{t("changeDoctor.newToken")}</Text>
            <Text testID="change-department-token" style={s.token}>{moved.tokenNo ?? "—"}</Text>
            <Text style={s.hint} numberOfLines={1}>{t("changeDoctor.writeOnSlip")}</Text>
            {error !== null && <Note tone="bad" testID="change-doctor-error">{error}</Note>}
            {moved.printSlip && (
              <Button testID="change-department-print" kind="secondary" label={t(printed ? "changeDoctor.printed" : "changeDoctor.print")} busy={busy} disabled={busy || printed} onPress={() => { void print(); }} />
            )}
            <Button testID="change-department-close" label={t("changeDoctor.finish")} disabled={busy} onPress={finish} />
          </View>
        </View>
      </KeyboardModal>
    );
  }

  return (
    <KeyboardModal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={busy ? undefined : onClose} accessibilityLabel={t("changeDoctor.cancel")} testID="change-doctor-scrim" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <ScrollView {...keyboardScroll()} style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
          <View testID="change-doctor-dialog" accessibilityLabel={t("changeDoctor.title")} style={{ gap: space.sm }}>
            <Text style={s.title} numberOfLines={1}>{t(canMoveDepartment ? "changeDoctor.titleDept" : "changeDoctor.title")}</Text>
            <Text style={s.hint}>{t(otherDept ? "changeDoctor.hintDept" : "changeDoctor.hint")}</Text>
            {canMoveDepartment && departments.length > 0 && (
              <>
                <Text style={s.label}>{t("changeDoctor.department")}</Text>
                <View style={s.chips}>
                  {departments.map((d) => {
                    const on = (departmentId ?? current) === d.id;
                    return (
                      <Pressable
                        key={d.id} testID={`change-doctor-department-${d.id}`} accessibilityRole="button" accessibilityState={{ selected: on }}
                        onPress={() => setDepartmentId(d.id)} style={[s.chip, on && s.chipOn]}
                      >
                        <Text style={[s.chipText, on && { color: "#ffffff" }]}>{d.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}
            {doctors !== null && doctors.length === 0 && error === null && (
              <Note tone="warn" testID="change-doctor-none">{t(otherDept ? "changeDoctor.noneDept" : "changeDoctor.none")}</Note>
            )}
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
            <Button testID="change-doctor-confirm" label={t(otherDept ? "changeDoctor.confirmDept" : "changeDoctor.confirm")} busy={busy} disabled={doctorId === null || reason === null || !consented || busy} onPress={() => { void confirm(); }} />
            <Button testID="change-doctor-cancel" kind="secondary" label={t("changeDoctor.cancel")} disabled={busy} onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </KeyboardModal>
  );
}

export function ChangeDoctorLink({ onPress, department = false }: { onPress: () => void; department?: boolean }) {
  const { t } = useI18n();
  return (
    <Pressable testID="change-doctor-open" accessibilityRole="button" hitSlop={6} onPress={onPress} style={s.linkBtn}>
      <Text style={s.linkText} numberOfLines={1}>{t(department ? "changeDoctor.actionDept" : "changeDoctor.action")} ›</Text>
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
  token: { fontSize: 56, lineHeight: 64, fontWeight: "800", color: color.ink },
});
