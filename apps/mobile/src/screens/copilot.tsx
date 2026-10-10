import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, KeyboardScrollView, s as ui } from "../ui";
import { PHONE_SCREEN, answerText, chipsFor, type AskReply, type AskSource } from "../copilot/model";

/**
 * E1.3 — "COPILOT" (decision 0064; spec /opt/hmis-context/SPEC-copilot-phone-2026-10-11.md). Three
 * chips for this person's seats, a box, and the answers newest first — each with a one-tap "Wrong".
 *
 * NOTHING IS STORED ON THE PHONE: the conversation is this screen's state and ends when it closes.
 * THE NOTICE FIRST (decision 0065): until the server says this person dismissed it, the one line and
 * OK sit above the chips. Everything — box included — is inside the KeyboardScrollView, so the box
 * stays above the Android keyboard (the vc24 rule).
 */
type Turn = { n: number; question: string; text: string | null; askId: string | null; report: boolean; wrong: "no" | "sending" | "yes" };

export function CopilotScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const { call, state } = useSession();
  const chips = useMemo(() => (state.status === "signedIn" ? chipsFor(state.me.permissions) : []), [state]);
  const [notice, setNotice] = useState(false);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);

  useEffect(() => {
    let live = true;
    // A failed read shows nothing; the next visit asks again. The desk is never stopped by it.
    call<{ seen: boolean }>("GET", "/copilot/notice").then((r) => { if (live) setNotice(!r.seen); }, () => undefined);
    return () => { live = false; };
  }, [call]);

  const dismiss = (): void => {
    setNotice(false);
    call("POST", "/copilot/notice").catch(() => undefined);
  };

  const patch = (n: number, p: Partial<Turn>) => setTurns((all) => all.map((x) => (x.n === n ? { ...x, ...p } : x)));

  const ask = async (question: string, source: AskSource): Promise<void> => {
    const q = question.trim();
    if (q === "" || busy) return;
    const n = ++counter.current;
    setTurns((all) => [{ n, question: q, text: null, askId: null, report: false, wrong: "no" }, ...all]);
    if (source === "typed") setText("");
    setBusy(true);
    try {
      const reply = await call<AskReply>("POST", "/copilot/ask", { question: q, screen: PHONE_SCREEN, source });
      patch(n, {
        text: answerText(reply, t, lang),
        // "Wrong" is for an answer; "I did not understand" is already counted as notUnderstood (G3a).
        askId: reply.source === "none" ? null : reply.askId ?? null,
        report: reply.intent === "my_day_report" && reply.answer.payload !== undefined,
      });
    } catch (e) {
      patch(n, { text: t(e instanceof NetworkError ? "copilotPhone.offline" : "copilot.answer.notUnderstood") });
    } finally { setBusy(false); }
  };

  const markWrong = async (turn: Turn): Promise<void> => {
    if (turn.askId === null || turn.wrong !== "no") return;
    patch(turn.n, { wrong: "sending" });
    try {
      await call("POST", "/copilot/feedback", { askId: turn.askId, wrong: true });
      patch(turn.n, { wrong: "yes" });
    } catch { patch(turn.n, { wrong: "no" }); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band copilot={false} right={
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} testID="copilot-back" style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
          <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
        </Pressable>
      } />
      <KeyboardScrollView testID="copilot" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("copilotPhone.title")}</Text>

        {notice && (
          <View testID="copilot-notice" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: color.wash, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md }}>
            <Text testID="copilot-notice-text" style={[type.small, { flex: 1, color: color.dim }]}>{t("copilot.notice.text")}</Text>
            <Pressable testID="copilot-notice-ok" accessibilityRole="button" hitSlop={8} onPress={dismiss}
              style={{ minHeight: 40, minWidth: 48, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: color.green }}>{t("copilot.notice.ok")}</Text>
            </Pressable>
          </View>
        )}

        <View testID="copilot-chips" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {chips.map((c) => (
            <Pressable key={c} testID={`copilot-chip-${c}`} accessibilityRole="button" disabled={busy} onPress={() => { void ask(t(`copilotPhone.chip.${c}`), "chip"); }}
              style={({ pressed }) => [{ minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: 20, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.greenSoft }, pressed && { opacity: 0.7 }]}>
              <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: color.green }}>{t(`copilotPhone.chip.${c}`)}</Text>
            </Pressable>
          ))}
        </View>

        <View testID="copilot-input-row" style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={[ui.input, { flex: 1 }]}>
            <TextInput testID="copilot-input" value={text} onChangeText={setText} placeholder={t("copilotPhone.placeholder")} placeholderTextColor={color.faint}
              accessibilityLabel={t("copilotPhone.placeholder")} maxLength={500} returnKeyType="send" onSubmitEditing={() => { void ask(text, "typed"); }}
              style={[ui.inputText, { fontFamily: undefined, fontSize: 16 }]} />
          </View>
          <Button label={t("copilotPhone.ask")} onPress={() => { void ask(text, "typed"); }} busy={busy} disabled={text.trim() === ""} testID="copilot-ask" />
        </View>

        {turns.map((turn) => (
          <View key={turn.n} testID={`copilot-turn-${String(turn.n)}`} style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 6 }}>
            <Text numberOfLines={1} style={[type.small, { color: color.faint }]}>{turn.question}</Text>
            {turn.text === null
              ? <Text style={[type.body, { color: color.dim }]}>…</Text>
              : <Text testID={`copilot-answer-${String(turn.n)}`} style={[type.body, { color: color.ink }]}>{turn.text}</Text>}
            {turn.report && <Text testID={`copilot-report-${String(turn.n)}`} numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("copilotPhone.report")}</Text>}
            {turn.askId !== null && (
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                {turn.wrong === "yes"
                  ? <Text testID={`copilot-wrong-done-${String(turn.n)}`} numberOfLines={1} style={[type.small, { color: color.red }]}>{t("copilotPhone.marked")}</Text>
                  : (
                    <Pressable testID={`copilot-wrong-${String(turn.n)}`} accessibilityRole="button" hitSlop={8} disabled={turn.wrong === "sending"} onPress={() => { void markWrong(turn); }}
                      style={{ minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: color.line }}>
                      <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.red }}>{t("copilotPhone.wrong")}</Text>
                    </Pressable>
                  )}
              </View>
            )}
          </View>
        ))}
      </KeyboardScrollView>
    </View>
  );
}
