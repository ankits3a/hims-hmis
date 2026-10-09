import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { ApiError, NetworkError } from "../api";
import { TeleMark } from "../counter/tele-mark";
import { teleSlotClock } from "../doctor/rules";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Button, MONO, Note } from "../ui";
import { refusalText } from "../vitals/api";

/**
 * ═══ TELE-CALL ON THE DOCTOR'S PHONE (owner 2026-10-09) ═══
 *
 * The doctor rings from this same phone: `Call patient` asks the server for the number (the one
 * place it is handed over) and opens the dialer. Back in the app there are two answers — `No
 * answer` and `Spoke to patient` — and Complete stays locked until the second (the server's rule;
 * this screen only mirrors it). NOTHING HERE SPEAKS OF MONEY: a tele-call is in the doctor's line
 * only because it may be consulted.
 */
export type TeleVisitBits = {
  consultMode?: string | null; teleOutcome?: string | null; teleOutcomeAt?: string | null; teleNoAnswerCount?: number | null;
};
export type TeleOutcomeAnswer = { outcome: "spoke" | "no_answer"; final: boolean; encounter: TeleVisitBits & { status: string } };
export type TeleCallApi = {
  teleCall: (encounterId: string) => Promise<{ telePhone: string | null }>;
  teleOutcome: (encounterId: string, outcome: "spoke" | "no_answer") => Promise<TeleOutcomeAnswer>;
};

export const isTele = (e: TeleVisitBits | null | undefined): boolean => e?.consultMode === "tele";
export const hasSpoken = (e: TeleVisitBits | null | undefined): boolean => e?.teleOutcome === "spoke";

/** The title card: a phone icon, "Tele-call" and the slot it was booked for. Nothing else. */
export function TeleCard({ slotAt, testID }: { slotAt: string | null | undefined; testID: string }) {
  const { t } = useI18n();
  return (
    <View testID={testID} style={s.card}>
      <TeleMark size={20} />
      <Text style={s.title} numberOfLines={1}>{t("mobile.tele.title")}</Text>
      {slotAt != null && <Text testID={`${testID}-slot`} style={s.slot}>{teleSlotClock(slotAt)}</Text>}
    </View>
  );
}

/** Call, then one of two answers. `onSpoke` re-reads the visit; `onLeft` returns to the line with a sentence. */
export function TeleCallPanel({ api, encounterId, visit, slotAt, onSpoke, onLeft }: {
  api: TeleCallApi; encounterId: string; visit: TeleVisitBits; slotAt: string | null | undefined;
  onSpoke: (e: TeleVisitBits) => void; onLeft: (line: string) => void;
}) {
  const { t } = useI18n();
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState<"call" | "spoke" | "no_answer" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const said = (e: unknown): string => (e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));

  const call = async (): Promise<void> => {
    if (busy !== null) return;
    setBusy("call"); setError(null);
    try {
      const r = await api.teleCall(encounterId);
      setPhone(r.telePhone);
      // Not awaited: the dialer is another app, and this screen must stay answerable whatever it does.
      if (r.telePhone !== null) void Linking.openURL(`tel:${r.telePhone}`).catch(() => undefined);
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(null);
    }
  };
  const answer = async (outcome: "spoke" | "no_answer"): Promise<void> => {
    if (busy !== null) return;
    setBusy(outcome); setError(null);
    try {
      const r = await api.teleOutcome(encounterId, outcome);
      if (r.outcome === "spoke") onSpoke(r.encounter);
      else onLeft(t(r.final ? "mobile.tele.toDesk" : "mobile.tele.backInLine"));
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(null);
    }
  };

  const spoke = hasSpoken(visit);
  return (
    <View style={s.panel} testID="tele-panel">
      <TeleCard slotAt={slotAt} testID="tele-card" />
      {spoke ? (
        <Text testID="tele-spoke" style={s.spoke} numberOfLines={1}>{t("mobile.tele.spokeAt", { time: teleSlotClock(visit.teleOutcomeAt ?? null) })}</Text>
      ) : (
        <>
          {(visit.teleNoAnswerCount ?? 0) > 0 && <Text testID="tele-tried" style={s.tried} numberOfLines={1}>{t("mobile.tele.triedOnce")}</Text>}
          <Button testID="tele-call" label={t("mobile.tele.call")} busy={busy === "call"} disabled={busy !== null} onPress={() => { void call(); }} />
          {phone !== null && <Text testID="tele-number" style={s.number}>{phone}</Text>}
          {/* Two answers side by side, each ONE line at 360 px — a smaller face than the app's full-width button. */}
          <View style={s.two}>
            {(["no_answer", "spoke"] as const).map((o) => (
              <Pressable key={o} testID={o === "spoke" ? "tele-spoke-go" : "tele-no-answer"} accessibilityRole="button" accessibilityState={{ disabled: busy !== null, busy: busy === o }}
                disabled={busy !== null} onPress={() => { void answer(o); }} style={[s.answer, o === "spoke" && { borderColor: color.green }, busy !== null && { opacity: 0.55 }]}>
                {busy === o ? <ActivityIndicator color={color.green} />
                  : <Text style={s.answerText} numberOfLines={1}>{t(o === "spoke" ? "mobile.tele.spoke" : "mobile.tele.noAnswer")}</Text>}
              </Pressable>
            ))}
          </View>
        </>
      )}
      {error !== null && <Note tone="bad" testID="tele-error">{error}</Note>}
    </View>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { ...type.body, fontWeight: "700", color: color.blue, flex: 1 },
  slot: { fontFamily: MONO, fontSize: 15, fontWeight: "700", color: color.blue },
  panel: { gap: space.sm, backgroundColor: color.card, borderWidth: 2, borderColor: color.blue, borderRadius: radius.lg, padding: space.md },
  two: { flexDirection: "row", gap: space.sm },
  answer: { flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card, paddingHorizontal: 6 },
  answerText: { fontSize: 14, fontWeight: "700", color: color.green },
  number: { fontFamily: MONO, fontSize: 18, fontWeight: "700", color: color.ink, textAlign: "center" },
  spoke: { ...type.body, fontWeight: "700", color: color.green },
  tried: { ...type.small, fontWeight: "700", color: "#8a5a10" },
});
