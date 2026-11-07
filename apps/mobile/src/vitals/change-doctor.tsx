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
  const [deptOpen, setDeptOpen] = useState(false);
  const otherDept = canMoveDepartment && departmentId !== null && current !== null && departmentId !== current;
  const chosenDept = departmentId ?? current;
  const chosenName = departments.find((d) => d.id === chosenDept)?.name ?? null;
  // Numbered steps: Department (when the seat may move one), Doctor, Reason, Patient agreed.
  const first = canMoveDepartment && departments.length > 0 ? 1 : 0;
  const step = { dept: first, doctor: first + 1, reason: first + 2, consent: first + 3 };
  const missing = doctorId === null ? "doctor" : reason === null ? "reason" : !consented ? "consent" : null;
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
              <View style={s.section}>
                <StepHead n={step.dept} done label={t("changeDoctor.department")} />
                {deptOpen ? (
                  <View style={s.chips}>
                    {departments.map((d) => (
                      <Chip key={d.id} testID={`change-doctor-department-${d.id}`} on={chosenDept === d.id} label={d.name} onPress={() => { setDepartmentId(d.id); setDeptOpen(false); }} />
                    ))}
                  </View>
                ) : (
                  <View style={s.deptRow}>
                    <Text testID="change-doctor-department-chosen" style={s.deptName} numberOfLines={1}>{chosenName ?? ""}</Text>
                    <Pressable testID="change-doctor-department-change" accessibilityRole="button" onPress={() => setDeptOpen(true)} style={s.deptChange}>
                      <Text style={s.deptChangeText} numberOfLines={1}>{t("changeDoctor.changeDept")}</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}
            <View style={[s.section, step.dept === 0 && s.sectionFirst]}>
              <StepHead
                n={step.doctor} done={doctorId !== null} testID="change-doctor-step-doctor"
                label={canMoveDepartment && chosenName !== null ? `${t("changeDoctor.doctorLabel")} · ${chosenName}` : t("changeDoctor.doctorLabel")}
              />
              {doctors !== null && doctors.length === 0 && error === null && (
                <Note tone="warn" testID="change-doctor-none">{t(otherDept ? "changeDoctor.noneDept" : "changeDoctor.none")}</Note>
              )}
              <View style={s.chips}>
                {(doctors ?? []).map((d) => (
                  <Chip key={d.id} testID={`change-doctor-doctor-${d.id}`} on={doctorId === d.id} label={d.displayName} onPress={() => setDoctorId(d.id)} />
                ))}
              </View>
            </View>
            <View style={s.section}>
              <StepHead n={step.reason} done={reason !== null} testID="change-doctor-step-reason" label={t("changeDoctor.reasonLabel")} />
              <View style={s.chips}>
                {REASONS.map((r) => (
                  <Chip key={r} testID={`change-doctor-reason-${r}`} on={reason === r} label={t(`changeDoctor.reason.${r}`)} onPress={() => setReason(r)} />
                ))}
              </View>
            </View>
            <View style={s.section}>
              <StepHead n={step.consent} done={consented} testID="change-doctor-step-consent" label={t("changeDoctor.consent")} />
              <Pressable
                testID="change-doctor-consent" accessibilityRole="checkbox" accessibilityState={{ checked: consented }}
                onPress={() => setConsented((c) => !c)} style={[s.consent, consented && s.consentOn]}
              >
                <View style={[s.box, consented && s.boxOn]}>
                  {consented && <Text style={s.boxTick}>✓</Text>}
                </View>
                <Text style={s.consentText}>{t("changeDoctor.consentBox")}</Text>
              </Pressable>
            </View>
            {missing !== null && (
              <Text testID="change-doctor-next" style={s.next} numberOfLines={1}>{t(`changeDoctor.next.${missing}`)}</Text>
            )}
            {error !== null && <Note tone="bad" testID="change-doctor-error">{error}</Note>}
            <Button testID="change-doctor-confirm" label={t(otherDept ? "changeDoctor.confirmDept" : "changeDoctor.confirm")} busy={busy} disabled={doctorId === null || reason === null || !consented || busy} onPress={() => { void confirm(); }} />
            <Button testID="change-doctor-cancel" kind="secondary" label={t("changeDoctor.cancel")} disabled={busy} onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </KeyboardModal>
  );
}

/** A step heading: a numbered dot that turns into a green tick once the step is done. */
function StepHead({ n, label, done, testID }: { n: number; label: string; done: boolean; testID?: string }) {
  return (
    <View style={s.stepHead} testID={testID} accessibilityState={{ checked: done }}>
      <View style={[s.dot, done && s.dotOn]}>
        <Text style={[s.dotText, done && { color: "#ffffff" }]}>{done ? "✓" : String(n)}</Text>
      </View>
      <Text style={s.stepLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function Chip({ on, label, onPress, testID }: { on: boolean; label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[s.chip, on && s.chipOn]}>
      <Text style={[s.chipText, on && { color: "#ffffff" }]}>{on ? "✓ " : ""}{label}</Text>
    </Pressable>
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
  section: { gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line },
  sectionFirst: { marginTop: space.xs },
  deptRow: { minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.wash },
  deptName: { flex: 1, fontSize: 15, fontWeight: "700", color: color.ink },
  deptChange: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.md },
  deptChangeText: { fontSize: 14.5, fontWeight: "700", color: color.green },
  stepHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: color.dim, backgroundColor: color.card },
  dotOn: { backgroundColor: color.green, borderColor: color.green },
  dotText: { fontSize: 13, fontWeight: "700", color: color.ink },
  stepLabel: { flexShrink: 1, fontSize: 15, fontWeight: "700", color: color.ink },
  consent: { minHeight: TOUCH + 4, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.goldLine, backgroundColor: color.goldSoft },
  consentOn: { borderColor: color.green, backgroundColor: color.greenSoft },
  box: { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: color.dim, backgroundColor: color.card, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: color.green, borderColor: color.green },
  boxTick: { fontSize: 16, lineHeight: 18, fontWeight: "800", color: "#ffffff" },
  consentText: { flexShrink: 1, fontSize: 15, fontWeight: "600", color: color.ink },
  next: { marginTop: space.sm, fontSize: 14, fontWeight: "700", color: color.gold, textAlign: "center" },
  token: { fontSize: 56, lineHeight: 64, fontWeight: "800", color: color.ink },
});
