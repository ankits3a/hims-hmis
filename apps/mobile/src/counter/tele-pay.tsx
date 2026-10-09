import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Button, MONO, Note } from "../ui";
import { refusalText } from "../vitals/api";
import { newIntentKey } from "./api";
import { QrRows } from "./qr-rows";
import type { CounterApi, WireAppointment } from "./api";
import { rs } from "./rules";

/**
 * ═══ TELE-CALL MONEY ON THE PHONE'S DESK — A DESK-ONLY FILE (owner 2026-10-09) ═══
 *
 * *"Doctor will not see 'paid' written or marked against any patient name or id."* "To pay" and
 * "Paid" are written here and under `mobile.counter.telePay.*`, and no file of the doctor's seat
 * imports either (`__tests__/tele-desk-only.test.ts` reads those sources).
 *
 * The desk collects exactly what the server quoted, as one ordinary advance receipt in the
 * cashier's own open drawer. ONE idempotency key per intent: a lost answer is settled by sending
 * the same request again — the server answers it, it does not take the money twice.
 */
type Mode = "cash" | "upi" | "card";

/** The words beside a tele-call row: what it owes, or that it is paid. Null when there is nothing to say. */
export function teleMoneyWord(a: WireAppointment, t: ReturnType<typeof useI18n>["t"]): { text: string; paid: boolean } | null {
  const mark = a.teleDesk;
  if (a.mode !== "tele" || mark === undefined || mark === null) return null;
  const gone = a.status === "cancelled" || a.status === "no_show";
  if (mark.covered) {
    const paise = mark.amountPaise ?? 0;
    return { paid: true, text: gone && paise > 0 ? t("mobile.counter.telePay.paidRefund", { amount: rs(paise) }) : t("mobile.counter.telePay.paid") };
  }
  if (gone || a.status === "rescheduled" || mark.amountPaise === null) return null;
  return { paid: false, text: mark.amountPaise === 0 ? t("mobile.counter.telePay.nothingToPay") : t("mobile.counter.telePay.toPay", { amount: rs(mark.amountPaise) }) };
}

/** The line and the Collect button on a tele-call card. */
export function TelePay({ api, appointment, mayCollect, onPaid }: {
  api: CounterApi; appointment: WireAppointment; mayCollect: boolean; onPaid: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("cash");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newIntentKey);
  /*
    The hospital's UPI id as a QR for exactly this amount — asked for only when the sheet is opened,
    and drawn only when an id is set. Nothing is sent to anyone: the patient scans it at the desk, and
    the cashier types the reference the payer's app shows. No id, or no answer: counter collection.
  */
  const [upi, setUpi] = useState<{ vpa: string; qr: string[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setUpi(null);
    api.teleFee(appointment.id).then((f) => { if (live) setUpi(f.upi ?? null); }, () => undefined);
    return () => { live = false; };
  }, [open, api, appointment.id]);

  const word = teleMoneyWord(appointment, t);
  if (word === null) return null;
  const a = appointment;
  const amountPaise = a.teleDesk?.amountPaise ?? 0;
  const free = amountPaise === 0;
  const ready = free || mode !== "upi" || ref.trim() !== "";

  const collect = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true); setError(null);
    try {
      await api.teleAdvance(a.id, free
        ? { amountPaise: 0 }
        : { amountPaise, tenders: [{ mode, amountPaise, ...(ref.trim() === "" ? {} : { refText: ref.trim() }) }] }, key);
      setOpen(false); setKey(newIntentKey()); setRef("");
      onPaid();
    } catch (e) {
      // The SAME key is kept: sending again is answered by the server, never paid twice.
      setError(e instanceof NetworkError ? t("mobile.counter.telePay.unknown") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      <Text testID={`tele-money-${a.id}`} style={[type.small, { fontWeight: "700", color: word.paid ? color.green : color.gold }]} numberOfLines={1}>{word.text}</Text>
      {!word.paid && mayCollect && (
        <Button testID={`tele-collect-${a.id}`} label={free ? t("mobile.counter.telePay.confirmFree") : t("mobile.counter.telePay.collect", { amount: rs(amountPaise) })} onPress={() => { setError(null); setOpen(true); }} />
      )}
      {open && (
        <Modal visible animationType="slide" onRequestClose={() => { if (!busy) setOpen(false); }}>
          <View style={{ flex: 1, backgroundColor: color.paper }} testID="tele-pay">
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, gap: space.md }}>
              <Text style={[type.heading, { color: color.ink }]} testID="tele-pay-title" numberOfLines={1}>
                {free ? t("mobile.counter.telePay.nothingToPay") : t("mobile.counter.telePay.collect", { amount: rs(amountPaise) })}
              </Text>
              <Text style={[type.small, { color: color.dim, fontFamily: MONO }]}>{a.appointmentNo ?? ""}</Text>
              {!free && (
                <>
                  <Text style={s.lbl}>{t("mobile.counter.telePay.paidBy")}</Text>
                  <View style={s.three} accessibilityRole="radiogroup">
                    {(["cash", "upi", "card"] as const).map((m) => {
                      const on = mode === m;
                      return (
                        <Pressable key={m} testID={`tele-mode-${m}`} accessibilityRole="radio" accessibilityState={{ checked: on }} disabled={busy} onPress={() => { setMode(m); setError(null); }}
                          style={[s.seg, on && { backgroundColor: color.green, borderColor: color.green }]}>
                          <Text style={{ fontSize: 14, fontWeight: "700", color: on ? "#f2faf6" : color.ink }}>{t(`mobile.counter.telePay.mode.${m}`)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {mode === "upi" && upi !== null && (
                    <View style={{ gap: 6, alignItems: "center" }} testID="tele-upi">
                      <QrRows testID="tele-upi-qr" rows={upi.qr} size={220} label={t("mobile.counter.telePay.upiQr")} />
                      <Text style={[type.small, { color: color.dim, fontFamily: MONO }]} numberOfLines={1}>{upi.vpa}</Text>
                    </View>
                  )}
                  {mode === "upi" && (
                    <View style={{ gap: 4 }}>
                      <Text style={[type.small, { color: color.dim }]}>{t("mobile.counter.telePay.upiRef")}</Text>
                      <TextInput testID="tele-ref" style={[s.input, { fontFamily: MONO }]} value={ref} editable={!busy} onChangeText={(v) => { setRef(v); setError(null); }}
                        autoCapitalize="characters" autoCorrect={false} maxLength={80} accessibilityLabel={t("mobile.counter.telePay.upiRef")} />
                    </View>
                  )}
                </>
              )}
              {error !== null && <Note tone="bad" testID="tele-pay-error">{error}</Note>}
            </ScrollView>
            <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]}>
              <Button testID="tele-pay-go" busy={busy} disabled={!ready} label={free ? t("mobile.counter.telePay.confirmFree") : t("mobile.counter.telePay.received", { amount: rs(amountPaise) })} onPress={() => { void collect(); }} />
              <Pressable testID="tele-pay-close" accessibilityRole="button" disabled={busy} onPress={() => setOpen(false)} style={{ minHeight: TOUCH, justifyContent: "center", alignItems: "center" }}>
                <Text style={{ color: color.dim, fontWeight: "600", fontSize: 14 }}>{t("mobile.back")}</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  lbl: { ...type.tag, color: color.dim, fontFamily: MONO, marginTop: space.sm },
  three: { flexDirection: "row", gap: space.sm },
  seg: { flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  input: { minHeight: TOUCH + 4, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: color.ink },
  bar: { paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
});
