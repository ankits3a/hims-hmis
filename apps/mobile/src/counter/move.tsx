import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Button, MONO, Note, KeyboardModal, keyboardScroll } from "../ui";
import { refusalText } from "../vitals/api";
import type { CounterApi, TenderMode, WireDoctorSummary, WireMovePreview, WireMoveResult } from "./api";
import { bookableToday, moveCollectPaise, moveFee, moveMoneyBlocks, moveMoneyLine, rs } from "./rules";
import type { DeptQueue, MoveConsultTerms, MoveVisitType } from "./rules";

/**
 * "WRONG DEPARTMENT? MOVE PATIENT" ON THE PHONE (owner 2026-10-05; the web's
 * `desk-one/move-department.tsx`). The same two server calls — `move-preview`, then
 * `move-department` — and the same shared arithmetic for what the preview means
 * (`moveFee`, `moveMoneyLine`, `moveMoneyBlocks`, `moveCollectPaise`), so the fee line and the
 * money line on the phone are the sentences the counter PC shows.
 *
 * The server decides everything: whether the visit may still move, what kind of visit it becomes
 * there, what it costs, and which of the four money rules applies. A move that collects a
 * difference carries its tender in the SAME request, so there is no state in which the patient
 * was moved and the money was not taken.
 */
export type MovableVisit = {
  encounterId: string; departmentId: string | null; departmentName: string | null; doctorName: string | null; tokenText: string | null;
};

export function MoveDepartment({ api, visit, queues, labelOf, terms, onMoved, onClose }: {
  api: CounterApi;
  visit: MovableVisit;
  queues: DeptQueue<WireDoctorSummary>[];
  labelOf: (doctor: { userId: string; designation?: string | null }) => string | null;
  terms: MoveConsultTerms | undefined;
  onMoved: (result: WireMoveResult, to: { departmentName: string; doctor: WireDoctorSummary }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [deptId, setDeptId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<TenderMode>("cash");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<WireMovePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets = queues.filter((q) => q.departmentId !== visit.departmentId);
  const dq = targets.find((q) => q.departmentId === deptId) ?? null;

  // The preview is asked the moment a department is picked — the cost is on screen BEFORE the write.
  useEffect(() => {
    if (deptId === null) { setPreview(null); return; }
    let live = true;
    setPreview(null); setPreviewError(null);
    api.movePreview(visit.encounterId, deptId).then(
      (p) => { if (live) setPreview(p); },
      (e: unknown) => {
        if (!live) return;
        setPreviewError(e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
      },
    );
    return () => { live = false; };
  }, [api, deptId, visit.encounterId, t]);

  const money = preview?.money;
  const maySettle = preview?.maySettleDifference === true;
  const blocked = moveMoneyBlocks(money, maySettle);
  const collect = moveCollectPaise(money, maySettle);
  const line = money === undefined ? null : moveMoneyLine(money, maySettle);
  const feeLine = (vt: MoveVisitType, serverPaise?: number): string => {
    const fee = moveFee(vt, terms, serverPaise);
    const kind = t(`registrationCounter.move.vt.${vt}`);
    if (fee === null) return kind;
    return `${kind} · ${fee.kind === "amount" ? rs(fee.paise) : t(fee.kind === "feesOff" ? "registrationCounter.move.feesOff" : "registrationCounter.move.free")}`;
  };

  const submit = async (): Promise<void> => {
    if (deptId === null || doctorId === null || dq === null) { setError(t("registrationCounter.move.pickBoth")); return; }
    if (reason.trim() === "") { setError(t("registrationCounter.move.reasonRequired")); return; }
    if (collect > 0 && mode !== "cash" && ref.trim() === "") { setError(t("registrationCounter.move.money.refRequired")); return; }
    const doctor = dq.doctors.find((d) => d.doctor.id === doctorId);
    if (doctor === undefined) return;
    setBusy(true); setError(null);
    try {
      const result = await api.move(visit.encounterId, {
        departmentId: deptId, doctorId, reason: reason.trim(),
        ...(collect > 0 ? { tenders: [{ mode, amountPaise: collect, ...(mode === "cash" ? {} : { refText: ref.trim() }) }] } : {}),
      });
      onMoved(result, { departmentName: dq.departmentName, doctor });
    } catch (e) {
      // A move is one transaction on the server: a request that never arrived moved nothing and took nothing.
      setError(e instanceof NetworkError ? t("mobile.counter.moveNetwork") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tone = line?.tone ?? "ok";
  return (
    <KeyboardModal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.paper }} testID="move-dept-panel">
        <ScrollView {...keyboardScroll()} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }} keyboardShouldPersistTaps="handled">
          <Text style={[type.heading, { color: color.ink }]}>{t("registrationCounter.move.title")}</Text>
          <Text style={[type.small, { color: color.dim, marginTop: 4 }]}>{t("registrationCounter.move.explain")}</Text>

          <View style={s.from} testID="move-dept-from">
            <Text style={s.tag}>{t("registrationCounter.move.from")}</Text>
            <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{visit.departmentName ?? "—"}</Text>
            <Text style={[type.small, { color: color.dim }]}>{[visit.doctorName, visit.tokenText].filter((x) => x !== null && x !== "").join(" · ")}</Text>
          </View>

          <Text style={[s.tag, { marginTop: space.lg }]}>{t("registrationCounter.move.toDept")}</Text>
          <View style={s.pills}>
            {targets.map((q) => (
              <Pill key={q.departmentId} testID={`move-dept-${q.departmentId}`} on={deptId === q.departmentId} label={q.departmentName}
                onPress={() => { const open = q.doctors.filter(bookableToday); setDeptId(q.departmentId); setDoctorId(open.length === 1 ? open[0]!.doctor.id : null); setError(null); }} />
            ))}
            {targets.length === 0 && <Text style={[type.small, { color: color.faint }]}>{t("registrationCounter.move.noTargets")}</Text>}
          </View>

          {dq !== null && (
            <>
              <Text style={[s.tag, { marginTop: space.lg }]}>{t("registrationCounter.move.toDoctor")}</Text>
              <View style={{ gap: space.sm, marginTop: 6 }}>
                {dq.doctors.map((doc) => {
                  const tag = labelOf(doc.doctor);
                  const on = doctorId === doc.doctor.id;
                  // A doctor who is not sitting today takes nobody: shown, said, not selectable (the server would refuse).
                  const open = bookableToday(doc);
                  return (
                    <Pressable key={doc.doctor.id} testID={`move-doctor-${doc.doctor.id}`} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !open }} disabled={!open}
                      onPress={() => { setDoctorId(doc.doctor.id); setError(null); }}
                      style={[s.doc, on && { borderColor: color.green, borderWidth: 2, backgroundColor: color.greenSoft }, !open && { opacity: 0.55 }]}>
                      <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{doc.doctor.displayName}</Text>
                      <Text style={[type.small, { color: color.dim }]}>
                        {tag === null ? "" : `${tag} · `}{open ? t("registrationCounter.move.waiting", { count: doc.waitingCount }) : t(doc.onLeaveToday ? "mobile.counter.seat.away" : "mobile.counter.seat.notToday")}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {previewError !== null && <View style={{ marginTop: space.lg }}><Note tone="bad" testID="move-dept-preview-error">{previewError}</Note></View>}
          {preview !== null && deptId !== null && (
            <View style={s.fee} testID="move-dept-fee">
              <Text style={[type.small, { color: color.dim }]}>{t("registrationCounter.move.now")}</Text>
              <Text style={[type.body, { color: color.ink, fontWeight: "700" }]}>{feeLine(preview.from.visitType, preview.from.feePaise)}</Text>
              <Text style={[type.small, { color: color.dim, marginTop: 6 }]}>{t("registrationCounter.move.after", { dept: dq?.departmentName ?? "" })}</Text>
              <Text testID="move-dept-fee-after" style={[type.body, { color: color.ink, fontWeight: "700" }]}>{feeLine(preview.to.visitType, preview.to.feePaise)}</Text>
            </View>
          )}

          {line !== null && deptId !== null && (
            <View testID="move-dept-money" accessibilityRole={tone === "stop" ? "alert" : undefined}
              style={[s.money, tone === "stop" ? { backgroundColor: color.redSoft, borderColor: color.redLine } : tone === "warn" ? { backgroundColor: color.goldSoft, borderColor: color.goldLine } : null]}>
              <Text style={[type.small, { color: tone === "stop" ? color.red : color.ink }]}>{t(line.key, line.vars)}</Text>
            </View>
          )}

          {collect > 0 && (
            <View testID="move-dept-tender" style={{ marginTop: space.md, gap: space.sm }}>
              <View style={s.pills}>
                {(["cash", "upi", "card"] as const).map((m) => (
                  <Pill key={m} testID={`move-tender-${m}`} on={mode === m} label={t(`registrationCounter.move.money.mode.${m}`)} onPress={() => { setMode(m); setError(null); }} />
                ))}
              </View>
              {mode !== "cash" && (
                <TextInput testID="move-tender-ref" style={s.input} value={ref} onChangeText={setRef} autoCapitalize="characters"
                  placeholder={t("registrationCounter.move.money.refHint")} placeholderTextColor={color.faint} accessibilityLabel={t("registrationCounter.move.money.refHint")} />
              )}
            </View>
          )}

          <TextInput testID="move-dept-reason" style={[s.input, { marginTop: space.lg, minHeight: 72, textAlignVertical: "top", paddingTop: 12 }]} multiline value={reason} onChangeText={setReason}
            placeholder={t("registrationCounter.move.reasonHint")} placeholderTextColor={color.faint} accessibilityLabel={t("registrationCounter.move.reasonHint")} />
          <Text style={[type.small, { color: color.faint, marginTop: 6 }]}>{t("registrationCounter.move.slips")}</Text>
          {error !== null && <View style={{ marginTop: space.md }}><Note tone="bad" testID="move-dept-error">{error}</Note></View>}
        </ScrollView>
        <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
          <Button testID="move-dept-submit" busy={busy} disabled={blocked}
            label={dq === null
              ? t("registrationCounter.move.submitBare")
              : collect > 0
                ? t("registrationCounter.move.money.submitCollect", { diff: rs(collect), dept: dq.departmentName })
                : t("registrationCounter.move.submit", { dept: dq.departmentName })}
            onPress={() => { void submit(); }} />
          <Button testID="move-dept-cancel" kind="secondary" label={t("registrationCounter.move.cancel")} onPress={onClose} />
        </View>
      </View>
    </KeyboardModal>
  );
}

export function Pill({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={[s.pill, on && { backgroundColor: color.green, borderColor: color.green }]}>
      <Text style={{ color: on ? "#f2faf6" : color.ink, fontWeight: on ? "700" : "500", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  tag: { ...type.tag, color: color.dim, fontFamily: MONO },
  from: { marginTop: space.lg, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, gap: 2 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: 6 },
  pill: { minHeight: TOUCH - 4, paddingHorizontal: 14, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  doc: { minHeight: TOUCH + 8, justifyContent: "center", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  fee: { marginTop: space.lg, backgroundColor: color.card, borderWidth: 1, borderColor: color.line2, borderRadius: radius.md, padding: space.md },
  money: { marginTop: space.sm, borderWidth: 1, borderColor: color.line2, backgroundColor: color.card, borderRadius: radius.md, padding: space.md },
  input: { minHeight: TOUCH + 4, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: color.ink },
  bar: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
});
