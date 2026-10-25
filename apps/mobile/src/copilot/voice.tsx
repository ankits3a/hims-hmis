import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import { NetworkError } from "../api";
import { useVoiceRecorder } from "../consult/recorder";
import { useI18n, type Lang } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius } from "../theme";
import { MONO, Note } from "../ui";

/**
 * #590 (plan E1.7) — SPEAK A QUESTION TO THE COPILOT. OFF until ruling R-2: `VOICE_ASK` in app.config.ts,
 * read here from the build's `extra`. While it is off the copilot screen draws none of this.
 *
 * ON: tap, speak (at most ASK_SECONDS — `POST /speech/transcribe` leaves the push-to-talk limit to the
 * client), tap again. The clip goes to the hospital's server, which answers TEXT ONLY. The text is put in
 * the box for the person to read and edit; it is asked only when they tap Ask, never by itself. The clip
 * is deleted from the phone as it is read (src/consult/recorder.ts).
 */
export const VOICE_ASK: boolean = (Constants.expoConfig?.extra as { voiceAsk?: boolean } | undefined)?.voiceAsk === true;
export const ASK_SECONDS = 15;

type Words = Record<"check" | "nothingHeard" | "micRefused" | "unavailable", string>;
/** Kept beside the code until they move into locales/*.json as `copilotPhone.voice.*`; a test holds en and hi to the same keys. */
export const VOICE_WORDS: Record<Lang, Words> = {
  en: {
    check: "Check the words, then tap Ask.",
    nothingHeard: "Nothing was heard. Speak again, or type your question.",
    micRefused: "This phone has not allowed HMIS to use the microphone. Allow it in the phone's settings, or type your question.",
    unavailable: "Speaking is not available right now. Type your question.",
  },
  hi: {
    check: "शब्द जाँच लें, फिर पूछें दबाएँ।",
    nothingHeard: "कुछ सुनाई नहीं दिया। फिर बोलें, या अपना सवाल लिखें।",
    micRefused: "इस फ़ोन ने HMIS को माइक्रोफ़ोन की अनुमति नहीं दी है। फ़ोन की सेटिंग में अनुमति दें, या अपना सवाल लिखें।",
    unavailable: "अभी बोलकर पूछना उपलब्ध नहीं है। अपना सवाल लिखें।",
  },
};

/** The mic strip under the copilot's box. `autoStart` — opened from the widget's mic: listen at once. */
export function VoiceAsk({ autoStart, disabled, onHeard }: { autoStart: boolean; disabled: boolean; onHeard: (text: string) => void }) {
  const { t, lang } = useI18n();
  const { call } = useSession();
  const recorder = useVoiceRecorder();
  const words = VOICE_WORDS[lang];
  const [phase, setPhase] = useState<"idle" | "recording" | "sending">("idle");
  const [seconds, setSeconds] = useState(0);
  const [note, setNote] = useState<{ tone: "bad" | "info"; text: string } | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(0);

  useEffect(() => () => { if (tick.current !== null) clearInterval(tick.current); void recorder.discard(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = async (): Promise<void> => {
    if (tick.current === null) return;
    clearInterval(tick.current);
    tick.current = null;
    setPhase("sending");
    try {
      const clip = await recorder.take(Math.max(1, Math.min(ASK_SECONDS, (Date.now() - started.current) / 1000)));
      const heard = clip === null ? "" : (await call<{ text: string }>("POST", "/speech/transcribe", { audio: clip.audio, language: lang })).text.trim();
      setPhase("idle");
      if (heard === "") { setNote({ tone: "bad", text: words.nothingHeard }); return; }
      setNote({ tone: "info", text: words.check });
      onHeard(heard);
    } catch (e) {
      setPhase("idle");
      setNote({ tone: "bad", text: e instanceof NetworkError ? t("copilotPhone.offline") : words.unavailable });
    }
  };
  const record = async (): Promise<void> => {
    setNote(null);
    try {
      if (!(await recorder.allow())) { setNote({ tone: "bad", text: words.micRefused }); return; }
      await recorder.start();
      started.current = Date.now();
      setSeconds(0);
      setPhase("recording");
      tick.current = setInterval(() => {
        const s = Math.floor((Date.now() - started.current) / 1000);
        setSeconds(s);
        if (s >= ASK_SECONDS) void stop();
      }, 250);
    } catch {
      setPhase("idle");
      setNote({ tone: "bad", text: words.unavailable });
    }
  };
  useEffect(() => { if (autoStart) void record(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ gap: 8 }}>
      {phase === "recording" ? (
        <Pressable testID="copilot-voice-stop" accessibilityRole="button" onPress={() => { void stop(); }} style={[st.mic, st.micRec]}>
          <View style={[st.dot, { backgroundColor: color.red }]}><Text style={{ color: "#fff", fontWeight: "700" }}>■</Text></View>
          <View style={{ flex: 1 }}><Text style={st.micTitle}>{t("mobile.consult.voice.recording")}</Text><Text style={st.micSub}>{t("mobile.consult.voice.recordingHint")}</Text></View>
          <Text testID="copilot-voice-timer" style={st.timer}>{`0:${String(seconds).padStart(2, "0")}`}</Text>
        </Pressable>
      ) : phase === "sending" ? (
        <View style={st.mic} testID="copilot-voice-sending"><Text style={st.micTitle}>{t("mobile.consult.voice.typing")}</Text></View>
      ) : (
        <Pressable testID="copilot-voice-start" accessibilityRole="button" disabled={disabled} onPress={() => { void record(); }} style={[st.mic, disabled && { opacity: 0.6 }]}>
          <View style={st.dot}><Text style={{ color: "#f2faf6", fontSize: 16 }}>●</Text></View>
          <View style={{ flex: 1 }}><Text style={st.micTitle}>{t("mobile.consult.voice.speak")}</Text><Text style={st.micSub}>{t("mobile.consult.voice.speakHint", { seconds: ASK_SECONDS })}</Text></View>
        </Pressable>
      )}
      {note !== null && <Note tone={note.tone} testID="copilot-voice-note">{note.text}</Note>}
    </View>
  );
}

// The consult notes drawer's mic, the same size and colours (src/consult/sheets.tsx).
const st = StyleSheet.create({
  mic: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: 12, backgroundColor: color.paper },
  micRec: { borderColor: color.redLine, backgroundColor: color.redSoft },
  dot: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.green, alignItems: "center", justifyContent: "center" },
  micTitle: { fontSize: 15, fontWeight: "700", color: color.ink },
  micSub: { fontSize: 12.5, lineHeight: 18, color: color.dim },
  timer: { fontFamily: MONO, fontSize: 18, fontWeight: "700", color: color.red },
});
