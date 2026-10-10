import { useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO, Note, KeyboardModal, keyboardScroll, scrollFocusedIntoView, useAndroidKeyboardHeight } from "../ui";
import { refusalText } from "../vitals/api";
import { voiceNotice } from "./draft";
import {
  DAY_CHOICES, FREQUENCIES, MAX_DIAGNOSES, MAX_TESTS, MIN_REASON, REVIEW_CHOICES, addLine, changeLine, changedChars, dosesFor, lineComplete, lineSub,
  lineText,
} from "./rules";
import type { ConsultApi, WireSignal, WireAdviceTemplate, WireIcd10Hit, WireMedicineHit, WireMyDiagnosis, WirePriceRow, WireRxSet, WireTestHit, WireVoiceResult, WireVoiceStatus } from "./api";
import type { ConsultDraft, ConsultLine, DxSource, LineWarning } from "./rules";
import { dxKeyOf } from "./rules";
import { SUGGEST_DEFAULT, crossOff, notOffered } from "./signals";
import type { SuggestState } from "./signals";
import type { VoiceRecorder } from "./recorder";

type T = ReturnType<typeof useI18n>["t"];
export type Patch = (next: (d: ConsultDraft) => ConsultDraft) => void;

const says = (e: unknown, t: T): string => (e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));

/**
 * One drawer: a full-height sheet over the visit, closed with Done. What it changed is already on the visit.
 *
 * ANDROID DRAWS NO MODAL (owner 2026-10-10: the keyboard covered the Notes and Advice boxes, and padding a
 * Modal did not help). Since React Native 0.81 a Modal's dialog window is edge-to-edge, so Android no longer
 * resizes it for the keyboard, and the keyboard events come from the activity's window, not the dialog's.
 * On Android the drawer is therefore an overlay inside the consult screen, lifted by the keyboard's height,
 * and the focused box is scrolled into view; Back closes it as the Modal did. iPhone keeps the KeyboardModal.
 */
export function Drawer({ title, onClose, children, testID, foot }: { title: string; onClose: () => void; children: React.ReactNode; testID: string; foot?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const android = Platform.OS === "android";
  const keyboard = useAndroidKeyboardHeight();
  const scroll = useRef<ScrollView>(null);
  const offset = useRef(0);
  useEffect(() => {
    if (!android) return undefined;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => back.remove();
  }, [android, onClose]);
  useEffect(() => {
    if (!android || keyboard === 0) return undefined;
    // After the sheet has shrunk above the keyboard, bring the box being typed in back into view.
    const timer = setTimeout(() => scrollFocusedIntoView(scroll.current, offset.current), 80);
    return () => clearTimeout(timer);
  }, [android, keyboard]);
  const sheet = (
    <View style={st.scrim}>
      <View style={[st.sheet, { paddingBottom: (android && keyboard > 0 ? 0 : insets.bottom) + space.md }]} testID={testID}>
        <View style={st.grab} />
        <View style={st.head}>
          <Text style={st.title}>{title}</Text>
          <Pressable testID={`${testID}-done`} accessibilityRole="button" hitSlop={10} onPress={onClose} style={st.doneBtn}>
            <Text style={st.done}>{t("mobile.consult.done")}</Text>
          </Pressable>
        </View>
        <ScrollView ref={scroll} {...keyboardScroll()} keyboardShouldPersistTaps="handled" scrollEventThrottle={32}
          onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; }}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md }}>{children}</ScrollView>
        {foot !== undefined && <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>{foot}</View>}
      </View>
    </View>
  );
  if (android) {
    // The keyboard's reported height leaves out the navigation bar; the overlay reaches the screen's foot.
    return <View testID="drawer-overlay" style={[StyleSheet.absoluteFill, st.overlay, { paddingBottom: keyboard > 0 ? keyboard + insets.bottom : 0 }]}>{sheet}</View>;
  }
  return <KeyboardModal visible transparent animationType="slide" onRequestClose={onClose}>{sheet}</KeyboardModal>;
}

export function Chip({ label, on, onPress, testID, dashed }: { label: string; on?: boolean; onPress: () => void; testID?: string; dashed?: boolean }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected: on === true }} onPress={onPress}
      style={[st.chip, on === true && st.chipOn, dashed === true && { borderStyle: "dashed" }]}>
      <Text style={[st.chipText, on === true && { color: "#f2faf6" }]}>{label}</Text>
    </Pressable>
  );
}
/** The × beside a suggestion: one tap, at least 40 px, read aloud with the thing it crosses off. */
export function Cross({ name, onPress, testID }: { name: string; onPress: () => void; testID: string }) {
  const { t } = useI18n();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={t("mobile.consult.dontSuggest", { name })} hitSlop={6} onPress={onPress} style={st.cross}>
      <Text style={st.crossText}>×</Text>
    </Pressable>
  );
}
const Lab = ({ children }: { children: string }) => <Text style={st.lab}>{children}</Text>;

function Box(props: React.ComponentProps<typeof TextInput>) {
  const [focus, setFocus] = useState(false);
  return <TextInput {...props} onFocus={(e) => { setFocus(true); props.onFocus?.(e); }} onBlur={(e) => { setFocus(false); props.onBlur?.(e); }}
    placeholderTextColor={color.faint} style={[st.box, props.multiline === true && { minHeight: 120, textAlignVertical: "top" }, focus && st.boxFocus, props.style]} />;
}

/** A search that waits for the typing to pause, and says plainly when the phone has no signal. */
function useSearch<R>(q: string, min: number, run: (q: string) => Promise<R[]>): { rows: R[]; error: string | null; busy: boolean } {
  const { t } = useI18n();
  const [rows, setRows] = useState<R[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const text = q.trim();
    if (text.length < min) { setRows([]); setError(null); return; }
    const mine = ++seq.current;
    setBusy(true);
    const timer = setTimeout(() => {
      run(text).then((r) => { if (seq.current === mine) { setRows(r); setError(null); } })
        .catch((e) => { if (seq.current === mine) { setRows([]); setError(says(e, t)); } })
        .finally(() => { if (seq.current === mine) setBusy(false); });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return { rows, error, busy };
}

// ——— 1 · Notes, and the spoken note ———

const COMMON_COMPLAINTS = ["Fever", "Cough", "Cold", "Body ache", "Headache", "Sore throat", "Vomiting", "Loose motion", "Abdominal pain", "Weakness"];

export function NotesDrawer({ api, encounterId, draft, patch, onClose, recorder, deskWords, onAddMedicine, onAddTest }: {
  api: ConsultApi; encounterId: string; draft: ConsultDraft; patch: Patch; onClose: () => void; recorder: VoiceRecorder; deskWords: string | null;
  onAddMedicine: (hit: { medicineId: string; name: string }) => void; onAddTest: (t: { serviceId: string; code: string; name: string; pricePaise: number }) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const found = useSearch(q, 2, async (text) => (await api.complaints(text)).map((x) => x.term));
  const [status, setStatus] = useState<WireVoiceStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "notice" | "recording" | "sending" | "heard">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<WireVoiceResult | null>(null);
  const [text, setText] = useState("");
  const [taken, setTaken] = useState<string[]>([]);
  /** "Did you mean" rows the doctor crossed off. A row merely left alone is NOT one of these. */
  const [crossedOff, setCrossedOff] = useState<string[]>([]);
  /** A look-alike suggestion waits for its second tap. */
  const [lasaAsk, setLasaAsk] = useState<string | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(0);

  useEffect(() => { api.voiceStatus().then(setStatus).catch(() => setStatus(null)); }, [api]);
  useEffect(() => () => { if (tick.current !== null) clearInterval(tick.current); void recorder.discard(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const max = status?.maxSeconds ?? 60;
  const toggle = (c: string): void => patch((d) => ({ ...d, complaints: d.complaints.includes(c) ? d.complaints.filter((x) => x !== c) : [...d.complaints, c].slice(0, 12) }));
  const offered = useMemo(() => {
    const base = [...draft.complaints, ...(q.trim().length >= 2 ? found.rows : COMMON_COMPLAINTS)];
    return [...new Set(base)].slice(0, 14);
  }, [draft.complaints, found.rows, q]);

  const stop = async (): Promise<void> => {
    if (tick.current !== null) { clearInterval(tick.current); tick.current = null; }
    const secs = Math.max(1, Math.min(max, (Date.now() - started.current) / 1000));
    setPhase("sending");
    try {
      const clip = await recorder.take(secs);
      if (clip === null) { setPhase("idle"); setError(t("mobile.consult.voice.nothingHeard")); return; }
      const out = await api.voice(encounterId, clip.audio, clip.mimeType, clip.seconds);
      if (out.text.trim() === "") { setPhase("idle"); setError(t("mobile.consult.voice.nothingHeard")); return; }
      setHeard(out); setText(out.text); setTaken([]); setCrossedOff([]); setLasaAsk(null); setPhase("heard");
    } catch (e) {
      setPhase("idle");
      const why = e instanceof ApiError ? (e.body as { detail?: { why?: string } } | null)?.detail?.why : undefined;
      setError(why !== undefined ? t(`mobile.consult.voice.off.${why}`) : says(e, t));
    }
  };
  const record = async (): Promise<void> => {
    setError(null);
    try {
      if (!(await recorder.allow())) { setError(t("mobile.consult.voice.micRefused")); return; }
      await recorder.start();
      started.current = Date.now(); setSeconds(0); setPhase("recording");
      tick.current = setInterval(() => {
        const s = Math.floor((Date.now() - started.current) / 1000);
        setSeconds(s);
        if (s >= max) void stop();
      }, 250);
    } catch (e) {
      setPhase("idle"); setError(says(e, t));
    }
  };
  const speak = async (): Promise<void> => {
    if (!(await voiceNotice.seen())) { setPhase("notice"); return; }
    await record();
  };
  const keep = (): void => {
    const h = heard;
    if (h === null) return;
    const kept = text.trim();
    if (kept !== "") patch((d) => ({ ...d, notes: [d.notes.trim(), kept].filter((x) => x !== "").join("\n").slice(0, 4000) }));
    // Counts only: how much was changed, how long the kept text is. Never the words.
    void api.voiceKept(h.voiceId, changedChars(h.text, kept), kept.length).catch(() => undefined);
    // …and what became of each "did you mean": taken, or CROSSED OFF. One left alone is neither (decision
    // 0050 P0: not looking is not a dismissal). A taken medicine is counted when the line is issued.
    const idOf = (sg: WireVoiceResult["suggestions"][number]): string => (sg.kind === "medicine" ? sg.medicineId : sg.serviceId);
    const told = h.suggestions.flatMap((sg, rankShown): WireSignal[] => {
      const more = { surface: "consult_phone" as const, encounterId, itemKey: idOf(sg), rankShown };
      if (crossedOff.includes(idOf(sg))) return [{ kind: sg.kind, source: "voice", outcome: "dismissed" as const, ...more }];
      if (sg.kind === "test" && taken.includes(idOf(sg))) return [{ kind: sg.kind, source: "voice", outcome: "accepted" as const, ...more }];
      return [];
    });
    if (told.length > 0) void api.signals({ suggestions: told }).catch(() => undefined);
    setHeard(null); setPhase("idle");
  };

  const voiceOff = status === null ? "unknown" : status.why;
  if (phase === "notice") {
    return (
      <Drawer testID="notes-drawer" title={t("mobile.consult.voice.noticeTitle")} onClose={() => setPhase("idle")}>
        <Note tone="warn" testID="voice-notice">{t("mobile.consult.voice.notice")}</Note>
        <View style={st.kv}><Text style={st.k}>{t("mobile.consult.voice.sent")}</Text><Text style={st.v}>{t("mobile.consult.voice.sentWhat")}</Text></View>
        <View style={st.kv}><Text style={st.k}>{t("mobile.consult.voice.neverSent")}</Text><Text style={st.v}>{t("mobile.consult.voice.neverWhat")}</Text></View>
        <Button testID="voice-notice-ok" label={t("mobile.consult.voice.understand")} onPress={() => { void voiceNotice.mark().then(record); }} />
        <Button testID="voice-notice-no" kind="secondary" label={t("mobile.consult.voice.notNow")} onPress={() => setPhase("idle")} />
        <Text style={st.fine}>{t("mobile.consult.voice.noticeOnce")}</Text>
      </Drawer>
    );
  }
  if (phase === "heard" && heard !== null) {
    return (
      <Drawer testID="notes-drawer" title={t("mobile.consult.voice.heardTitle")} onClose={keep}
        foot={<View style={st.two}>
          <View style={{ flex: 1 }}><Button testID="voice-again" kind="secondary" label={t("mobile.consult.voice.again")} onPress={() => { setHeard(null); void record(); }} /></View>
          <View style={{ flex: 1.4 }}><Button testID="voice-keep" label={t("mobile.consult.voice.keep")} onPress={keep} /></View>
        </View>}>
        <Box testID="voice-text" multiline value={text} onChangeText={setText} maxLength={3000} accessibilityLabel={t("mobile.consult.voice.heardTitle")} />
        {heard.suggestions.length > 0 && <Lab>{t("mobile.consult.voice.didYouMean")}</Lab>}
        {heard.suggestions.map((sg, i) => {
          const id = sg.kind === "medicine" ? sg.medicineId : sg.serviceId;
          const done = taken.includes(id);
          const asking = lasaAsk === id;
          if (crossedOff.includes(id)) return null;
          return (
            <View key={`${sg.kind}-${id}`} style={st.hit} testID={`voice-suggest-${String(i)}`}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.hitName}><Text style={{ fontWeight: "700" }}>{sg.heard}</Text> → {sg.name}</Text>
                {sg.kind === "medicine" && <Text style={st.hitSub}>{[sg.strength, sg.form, sg.drugClass ?? null].filter((x) => x !== null && x !== "").join(" · ")}</Text>}
                <Text style={st.hitSub}>{t(sg.kind === "medicine" ? "mobile.consult.voice.fromMedicines" : "mobile.consult.voice.fromTests")}</Text>
                {asking && sg.kind === "medicine" && <Text testID={`voice-lasa-${String(i)}`} style={[st.hitSub, { color: "#8a5a10", fontWeight: "700" }]}>{t("mobile.consult.lasa.ask", { name: sg.name, other: sg.lasa ?? "" })}</Text>}
              </View>
              <Pressable testID={`voice-suggest-add-${String(i)}`} accessibilityRole="button" disabled={done} onPress={() => {
                // A look-alike name takes a second tap, on the same button, after the question is shown.
                if (sg.kind === "medicine" && (sg.lasa ?? null) !== null && !asking) { setLasaAsk(id); return; }
                setLasaAsk(null);
                setTaken((x) => [...x, id]);
                if (sg.kind === "medicine") onAddMedicine({ medicineId: sg.medicineId, name: sg.name });
                else onAddTest({ serviceId: sg.serviceId, code: sg.code, name: sg.name, pricePaise: sg.pricePaise });
              }} style={[st.small, done ? st.smallDone : st.smallOn]}>
                <Text style={[st.smallText, { color: done ? color.green : "#f2faf6" }]}>{done ? t("mobile.consult.added") : asking ? t("mobile.consult.lasa.yesShort") : t(sg.kind === "medicine" ? "mobile.consult.voice.addMedicine" : "mobile.consult.voice.addTest")}</Text>
              </Pressable>
              {!done && <Cross testID={`voice-suggest-x-${String(i)}`} name={sg.name} onPress={() => { setLasaAsk(null); setCrossedOff((x) => [...x, id]); }} />}
            </View>
          );
        })}
        <Text style={st.fine}>{t("mobile.consult.voice.heardHint")}</Text>
      </Drawer>
    );
  }
  return (
    <Drawer testID="notes-drawer" title={t("mobile.consult.notes")} onClose={onClose}>
      <Lab>{t("mobile.consult.complaint")}</Lab>
      {deskWords !== null && <Text style={st.said}>{t("mobile.consult.toldDesk", { words: deskWords })}</Text>}
      <View style={st.chips}>
        {offered.map((c) => <Chip key={c} testID={`complaint-${c}`} label={c} on={draft.complaints.includes(c)} onPress={() => toggle(c)} />)}
      </View>
      <Box testID="complaint-input" value={q} onChangeText={setQ} placeholder={t("mobile.consult.complaintAdd")} returnKeyType="done" maxLength={80}
        onSubmitEditing={() => { const c = q.trim(); if (c !== "") { toggle(c); setQ(""); } }} />
      <Lab>{t("mobile.consult.examination")}</Lab>
      <Box testID="notes-input" multiline value={draft.notes} maxLength={4000} placeholder={t("mobile.consult.notesHint")}
        onChangeText={(v) => patch((d) => ({ ...d, notes: v }))} />
      {phase === "recording" ? (
        <Pressable testID="voice-stop" accessibilityRole="button" onPress={() => { void stop(); }} style={[st.mic, st.micRec]}>
          <View style={[st.dot, { backgroundColor: color.red }]}><Text style={{ color: "#fff", fontWeight: "700" }}>■</Text></View>
          <View style={{ flex: 1 }}><Text style={st.micTitle}>{t("mobile.consult.voice.recording")}</Text><Text style={st.micSub}>{t("mobile.consult.voice.recordingHint")}</Text></View>
          <Text testID="voice-timer" style={st.timer}>{`0:${String(seconds).padStart(2, "0")}`}</Text>
        </Pressable>
      ) : phase === "sending" ? (
        <View style={st.mic} testID="voice-sending"><Text style={st.micTitle}>{t("mobile.consult.voice.typing")}</Text></View>
      ) : voiceOff === null ? (
        <Pressable testID="voice-start" accessibilityRole="button" onPress={() => { void speak(); }} style={st.mic}>
          <View style={st.dot}><Text style={{ color: "#f2faf6", fontSize: 16 }}>●</Text></View>
          <View style={{ flex: 1 }}><Text style={st.micTitle}>{t("mobile.consult.voice.speak")}</Text><Text style={st.micSub}>{t("mobile.consult.voice.speakHint", { seconds: max })}</Text></View>
        </Pressable>
      ) : (
        <View style={[st.mic, { opacity: 0.7 }]} testID="voice-off"><Text style={st.micSub}>{t(`mobile.consult.voice.off.${voiceOff}`)}</Text></View>
      )}
      {error !== null && <Note tone="bad" testID="notes-error">{error}</Note>}
    </Drawer>
  );
}

// ——— 2 · Diagnosis (optional) ———

export function DiagnosisDrawer({ api, draft, patch, onClose, suggest = SUGGEST_DEFAULT }: {
  api: ConsultApi; draft: ConsultDraft; patch: Patch; onClose: () => void;
  /** This doctor's three-crosses list. "You use these most" is the doctor's own list and is not behind the switch; a × takes a row off it. */
  suggest?: SuggestState;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const found = useSearch<WireIcd10Hit>(q, 2, (text) => api.diagnoses(text));
  const [all, setMine] = useState<WireMyDiagnosis[]>([]);
  const [, setTick] = useState(0);
  const enc = draft.encounterId;
  const keyOf = (m: { text: string; icd10Code: string | null }): string => dxKeyOf(m.icd10Code, m.text) ?? m.text;
  useEffect(() => {
    api.myDiagnoses().then((items) => {
      setMine(items);
      const shown = items.filter((m) => !notOffered(suggest, enc, "diagnosis", null, keyOf(m))).map(keyOf);
      if (shown.length > 0) void api.signals({ suggestions: [{ kind: "diagnosis", source: "suggested", outcome: "shown", surface: "consult_phone", encounterId: enc, items: shown.slice(0, 20) }] }).catch(() => undefined);
    }).catch(() => setMine([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const mine = all.filter((m) => !notOffered(suggest, enc, "diagnosis", null, keyOf(m)));
  const has = (text: string): boolean => draft.diagnoses.some((d) => d.text.toLowerCase() === text.toLowerCase());
  const add = (text: string, icd10Code: string | null, source: DxSource): void => patch((d) => (has(text) || d.diagnoses.length >= MAX_DIAGNOSES ? d : { ...d, diagnoses: [...d.diagnoses, { text, icd10Code, source }] }));
  const drop = (text: string): void => patch((d) => ({ ...d, diagnoses: d.diagnoses.filter((x) => x.text !== text) }));
  const told = (m: { text: string; icd10Code: string | null }, rankShown: number, outcome: "accepted" | "dismissed"): void => {
    void api.signals({ suggestions: [{ kind: "diagnosis", source: "suggested", outcome, surface: "consult_phone", encounterId: enc, itemKey: keyOf(m), rankShown }] }).catch(() => undefined);
  };
  /** `offered` is the row's rank among the doctor's most-used — a row the SYSTEM put forward, so it has a ×. */
  const row = (text: string, code: string | null, sub: string | null, key: string, offered: number | null = null) => (
    <View key={key} style={st.hit}>
      <Pressable testID={`dx-${key}`} accessibilityRole="button" style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}
        onPress={() => {
          if (has(text)) { drop(text); return; }
          if (offered !== null) told({ text, icd10Code: code }, offered, "accepted");
          add(text, code, offered !== null ? "suggested" : "search");
        }}>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={st.hitName}>{text}</Text>{sub !== null && <Text style={st.hitSub}>{sub}</Text>}</View>
        {code !== null && <Text style={st.code}>{code}</Text>}
        {has(text) && <Text style={st.tick}>✓</Text>}
      </Pressable>
      {offered !== null && !has(text) && <Cross testID={`dx-x-${key}`} name={text} onPress={() => { crossOff(enc, "diagnosis", keyOf({ text, icd10Code: code })); told({ text, icd10Code: code }, offered, "dismissed"); setTick((n) => n + 1); }} />}
    </View>
  );
  return (
    <Drawer testID="dx-drawer" title={t("mobile.consult.diagnosis")} onClose={onClose}>
      <Box testID="dx-input" value={q} onChangeText={setQ} placeholder={t("mobile.consult.dxSearch")} maxLength={80} returnKeyType="done"
        onSubmitEditing={() => { const text = q.trim(); if (text.length >= 3 && found.rows.length === 0) { add(text, null, "typed"); setQ(""); } }} />
      {draft.diagnoses.length > 0 && <View style={st.chips}>{draft.diagnoses.map((d) => <Chip key={d.text} testID={`dx-on-${d.text}`} label={`${d.text} ✕`} on onPress={() => drop(d.text)} />)}</View>}
      {q.trim().length < 2 && mine.length > 0 && <Lab>{t("mobile.consult.dxMine")}</Lab>}
      {q.trim().length < 2 && mine.map((m, i) => row(m.text, m.icd10Code, t("mobile.consult.dxUsed", { count: m.uses }), `mine-${String(all.indexOf(m))}`, i))}
      {q.trim().length >= 2 && found.rows.map((h) => row(h.description, h.code, null, h.code))}
      {q.trim().length >= 3 && !found.busy && found.rows.length === 0 && found.error === null && (
        <Pressable testID="dx-free" accessibilityRole="button" onPress={() => { void api.signals({ misses: [{ kind: "diagnosis", term: q.trim(), stage: "search" }] }).catch(() => undefined); add(q.trim(), null, "typed"); setQ(""); }} style={st.hit}>
          <Text style={st.hitName}>{t("mobile.consult.dxFree", { text: q.trim() })}</Text>
        </Pressable>
      )}
      {found.error !== null && <Note tone="bad" testID="dx-error">{found.error}</Note>}
      <Text style={st.fine}>{t("mobile.consult.dxOptional")}</Text>
    </Drawer>
  );
}

// ——— 3 · Medicines ———

export function blankLine(): ConsultLine {
  return { drug: "", dose: "", frequency: "", durationDays: null, food: null, instructions: "", route: "oral", medicineId: null, mark: null, was: null };
}

export function MedicinesDrawer({ api, draft, patch, warnings, checking, onClose, startWith, childNoDose = false }: {
  api: ConsultApi; draft: ConsultDraft; patch: Patch; warnings: LineWarning[]; checking: boolean; onClose: () => void;
  /** A set or a repeat brought a CHILD's medicines without their doses: say so above the lines. */
  childNoDose?: boolean;
  /** Open straight into the editor for this medicine (a voice suggestion, or "+ add"). */
  startWith?: { medicineId: string | null; name: string } | "new" | null;
}) {
  const { t } = useI18n();
  const days = (n: number): string => t("mobile.consult.days", { count: n });
  const food = { before: t("mobile.consult.foodBefore"), after: t("mobile.consult.foodAfter") };
  const [editing, setEditing] = useState<{ index: number | null; line: ConsultLine } | null>(
    startWith === "new" ? { index: null, line: blankLine() }
      : startWith !== null && startWith !== undefined ? { index: null, line: { ...blankLine(), drug: startWith.name, medicineId: startWith.medicineId } } : draft.lines.length === 0 ? { index: null, line: blankLine() } : null,
  );
  const [q, setQ] = useState("");
  const found = useSearch<WireMedicineHit>(q, 2, (text) => api.medicines(text));
  const [otherDays, setOtherDays] = useState(false);
  /** A pick whose name is easily confused with another waits here for a second tap. */
  const [ask, setAsk] = useState<WireMedicineHit | null>(null);
  /*
   * A LEARNED NICKNAME'S ROW (decisions 0051, 0055). The search may answer with one row marked `alias`:
   * the medicine the hospital has learned the typed nickname means. It shows the product's full name,
   * a "nickname" tag and a cross; nothing is picked for the doctor. Taken, crossed, or passed over for
   * another row — each is told to the server against the nickname's id, never the typed word.
   */
  const [crossedNick, setCrossedNick] = useState<string[]>([]);
  const nick = (aliasId: string, outcome: "accepted" | "dismissed" | "manual", pickedId?: string): void => {
    void api.signals({ suggestions: [{ kind: "alias", source: "search", outcome, surface: "consult_phone", encounterId: draft.encounterId, itemKey: aliasId, ...(pickedId === undefined ? {} : { contextKey: `med:${pickedId}` }) }] }).catch(() => undefined);
  };
  const rows = found.rows.filter((h) => h.alias === undefined || !crossedNick.includes(h.alias.id));
  const pick = (h: WireMedicineHit): void => {
    const offered = rows.find((r) => r.alias !== undefined);
    if (h.alias !== undefined) nick(h.alias.id, "accepted");
    else if (offered?.alias !== undefined) nick(offered.alias.id, "manual", h.id);
    setAsk(null); set({ drug: h.name, medicineId: h.id, route: h.routeClass === "topical" ? "topical" : "oral", source: "search" });
  };
  /** A second tap is asked for a known look-alike pair, and for a nickname whose medicine has a near name. */
  const needsAsk = (h: WireMedicineHit): boolean => (h.lasa ?? null) !== null || h.alias?.lasaGuard === true;
  const typed = (text: string): void => {
    // Nothing in the hospital's list answered this word: kept for the alias tool, the term alone.
    void api.signals({ misses: [{ kind: "medicine", term: text, stage: "search" }] }).catch(() => undefined);
    set({ drug: text, medicineId: null, source: "typed" });
  };

  const set = (p: Partial<ConsultLine>): void => setEditing((e) => (e === null ? e : { ...e, line: { ...e.line, ...p } }));
  const commit = (): void => {
    const e = editing;
    if (e === null || !lineComplete(e.line)) return;
    patch((d) => (e.index === null ? addLine(d, e.line, Date.now()) : changeLine(d, e.index, e.line, days, Date.now())));
    setEditing(null); setQ(""); setOtherDays(false);
  };

  if (editing !== null) {
    const l = editing.line;
    const picked = l.drug.trim() !== "";
    return (
      <Drawer testID="meds-drawer" title={t("mobile.consult.medicines")} onClose={() => { if (draft.lines.length === 0) onClose(); else { setEditing(null); setQ(""); } }}
        foot={picked ? <>
          <Button testID="line-add" label={t(editing.index === null ? "mobile.consult.addLine" : "mobile.consult.saveLine")} disabled={!lineComplete(l)} onPress={commit} />
          <Text testID="line-preview" style={st.fine}>{[lineText(l, days), lineSub(l, food)].filter((x) => x !== "").join(" · ")}</Text>
        </> : undefined}>
        {!picked ? (
          <>
            <Box testID="med-input" autoFocus value={q} onChangeText={setQ} placeholder={t("mobile.consult.medSearch")} maxLength={80} returnKeyType="done"
              onSubmitEditing={() => { const text = q.trim(); if (text.length >= 3 && !found.busy && found.error === null && rows.length === 0) typed(text); }} />
            {ask !== null && (
              <View testID="lasa-ask" style={[st.alert, st.alertAmber]}>
                <Text style={[st.alertTitle, { color: "#8a5a10" }]}>{(ask.lasa ?? null) !== null ? t("mobile.consult.lasa.ask", { name: ask.name, other: ask.lasa ?? "" }) : t("mobile.consult.nickname.ask", { name: ask.name })}</Text>
                <Text style={[st.alertBody, { color: "#8a5a10" }]}>{(ask.lasa ?? null) !== null ? t("mobile.consult.lasa.body") : t("mobile.consult.nickname.askBody")}</Text>
                <View style={[st.two, { marginTop: 10 }]}>
                  <View style={{ flex: 1 }}><Button testID="lasa-no" kind="secondary" label={t("mobile.consult.lasa.no")} onPress={() => setAsk(null)} /></View>
                  <View style={{ flex: 1.3 }}><Button testID="lasa-yes" label={t("mobile.consult.lasa.yes", { name: ask.name.split(" ")[0] ?? ask.name })} onPress={() => pick(ask)} /></View>
                </View>
              </View>
            )}
            {ask === null && rows.map((h) => (
              <View key={h.id} style={[st.hit, { paddingVertical: 0 }]}>
                <Pressable testID={`med-hit-${h.id}`} accessibilityRole="button" onPress={() => (needsAsk(h) ? setAsk(h) : pick(h))} style={[st.hit, { flex: 1, minWidth: 0, borderTopWidth: 0 }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={st.hitName}>{h.name}</Text>
                    <Text testID={`med-hit-sub-${h.id}`} style={st.hitSub}>{[h.strength, h.form, h.drugClass ?? h.salts.slice(0, 3).join(" + ")].filter((x) => x !== null && x !== "").join(" · ")}</Text>
                    {h.alias !== undefined && <Text testID={`med-nickname-${h.id}`} style={st.nickTag}>{t("mobile.consult.nickname.tag")}</Text>}
                  </View>
                </Pressable>
                {h.alias !== undefined && <Cross testID={`med-nickname-x-${h.id}`} name={h.name} onPress={() => { nick(h.alias!.id, "dismissed"); setCrossedNick((x) => [...x, h.alias!.id]); }} />}
              </View>
            ))}
            {q.trim().length >= 3 && !found.busy && rows.length === 0 && found.error === null && (
              <Pressable testID="med-free" accessibilityRole="button" onPress={() => typed(q.trim())} style={st.hit}>
                <Text style={st.hitName}>{t("mobile.consult.medFree", { text: q.trim() })}</Text>
              </Pressable>
            )}
            {found.error !== null && <Note tone="bad" testID="med-error">{found.error}</Note>}
          </>
        ) : (
          <>
            <View style={st.hit}>
              <Text testID="line-drug" style={[st.hitName, { flex: 1, fontWeight: "700" }]}>{l.drug}</Text>
              <Pressable testID="line-change-drug" accessibilityRole="button" hitSlop={8} onPress={() => { set({ drug: "", medicineId: null, source: null }); setQ(""); }}><Text style={st.link}>{t("mobile.consult.change")}</Text></Pressable>
            </View>
            <Lab>{t("mobile.consult.dose")}</Lab>
            <View style={st.chips}>{dosesFor(l.drug).map((d) => <Chip key={d} testID={`dose-${d}`} label={d} on={l.dose === d} onPress={() => set({ dose: d })} />)}</View>
            {!dosesFor(l.drug).includes(l.dose) && <Box testID="dose-input" value={l.dose} onChangeText={(v) => set({ dose: v })} placeholder={t("mobile.consult.doseOther")} maxLength={100} />}
            <Lab>{t("mobile.consult.howOften")}</Lab>
            <View style={st.chips}>{FREQUENCIES.map((f) => <Chip key={f} testID={`freq-${f}`} label={f} on={l.frequency === f} onPress={() => set({ frequency: f })} />)}</View>
            <Lab>{t("mobile.consult.daysLabel")}</Lab>
            <View style={st.chips}>
              {DAY_CHOICES.map((n) => <Chip key={n} testID={`days-${String(n)}`} label={String(n)} on={l.durationDays === n && !otherDays} onPress={() => { setOtherDays(false); set({ durationDays: n }); }} />)}
              <Chip testID="days-other" dashed label={t("mobile.consult.other")} on={otherDays} onPress={() => setOtherDays(true)} />
            </View>
            {otherDays && <Box testID="days-input" keyboardType="number-pad" value={l.durationDays === null ? "" : String(l.durationDays)} maxLength={3}
              onChangeText={(v) => { const n = Number(v.replace(/[^0-9]/g, "")); set({ durationDays: Number.isInteger(n) && n > 0 ? n : null }); }} placeholder={t("mobile.consult.daysLabel")} />}
            <Lab>{t("mobile.consult.food")}</Lab>
            <View style={st.chips}>
              <Chip testID="food-before" label={food.before} on={l.food === "before"} onPress={() => set({ food: l.food === "before" ? null : "before" })} />
              <Chip testID="food-after" label={food.after} on={l.food === "after"} onPress={() => set({ food: l.food === "after" ? null : "after" })} />
            </View>
            <Box testID="line-instructions" value={l.instructions} onChangeText={(v) => set({ instructions: v })} placeholder={t("mobile.consult.instructions")} maxLength={300} />
          </>
        )}
      </Drawer>
    );
  }

  return (
    <Drawer testID="meds-drawer" title={t("mobile.consult.medicines")} onClose={onClose}
      foot={<Button testID="med-add" kind="secondary" label={t("mobile.consult.addAnother")} onPress={() => setEditing({ index: null, line: blankLine() })} />}>
      {checking && <Text style={st.fine} testID="meds-checking">{t("mobile.consult.checking")}</Text>}
      {childNoDose && <Note tone="warn" testID="child-no-dose">{t("mobile.consult.childNoDose")}</Note>}
      {draft.lines.map((l, i) => {
        const mine = warnings.filter((w) => w.lineIndex === i);
        return (
          <View key={`${String(i)}-${l.drug}`} testID={`line-${String(i)}`} style={st.lineCard}>
            <Pressable testID={`line-edit-${String(i)}`} accessibilityRole="button" onPress={() => setEditing({ index: i, line: l })}>
              <Text style={st.lineMain}>{lineText(l, days)}</Text>
              {lineSub(l, food) !== "" && <Text style={st.hitSub}>{lineSub(l, food)}</Text>}
              {!lineComplete(l) && <Text style={[st.hitSub, { color: color.red, fontWeight: "700" }]}>{t("mobile.consult.lineIncomplete")}</Text>}
              {(l.source ?? null) !== null && <Text testID={`line-source-${String(i)}`} style={st.fine}>{t(`mobile.consult.source.${l.source ?? "typed"}`)}</Text>}
            </Pressable>
            {mine.map((w) => (
              <View key={w.key} testID={`warn-${w.kind}-${String(i)}`} style={[st.alert, w.hard ? st.alertRed : st.alertAmber]}>
                <Text style={[st.alertTitle, { color: w.hard ? color.red : "#8a5a10" }]}>{warningTitle(w, t)}</Text>
                <Text style={[st.alertBody, { color: w.hard ? color.red : "#8a5a10" }]}>{warningBody(w, t)}</Text>
                {w.hard && (
                  <Box testID={`reason-${w.kind}-${String(i)}`} value={draft.reasons[w.key] ?? ""} maxLength={500} placeholder={t("mobile.consult.reasonHint")}
                    onChangeText={(v) => patch((d) => ({ ...d, reasons: { ...d.reasons, [w.key]: v } }))} style={{ marginTop: 8 }} />
                )}
                {w.hard && <Text style={[st.fine, { marginTop: 4 }]}>{(draft.reasons[w.key] ?? "").trim().length >= MIN_REASON ? t("mobile.consult.reasonKept") : t("mobile.consult.reasonNeeded")}</Text>}
              </View>
            ))}
            <Pressable testID={`line-remove-${String(i)}`} accessibilityRole="button" hitSlop={6} onPress={() => patch((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}>
              <Text style={[st.link, { color: color.red }]}>{t("mobile.consult.remove")}</Text>
            </Pressable>
          </View>
        );
      })}
      {draft.lines.length === 0 && <Text style={st.fine}>{t("mobile.consult.noMedicines")}</Text>}
    </Drawer>
  );
}

export function warningTitle(w: LineWarning, t: T): string {
  if (w.kind === "allergy") return t("mobile.consult.warn.allergy", { substance: w.substance });
  if (w.kind === "interaction") return t("mobile.consult.warn.interaction", { a: w.saltPair[0], b: w.saltPair[1] });
  if (w.kind === "duplicate") return t("mobile.consult.warn.duplicate", { moiety: w.moiety });
  return t("mobile.consult.warn.disease", { moiety: w.moiety, title: w.title });
}
export function warningBody(w: LineWarning, t: T): string {
  if (w.kind === "interaction") return w.note;
  if (w.kind === "duplicate") return w.drugClass === null ? t("mobile.consult.warn.duplicateBody") : t("mobile.consult.warn.duplicateClass", { cls: w.drugClass });
  if (w.kind === "disease") return t("mobile.consult.warn.diseaseBody");
  return t("mobile.consult.warn.allergyBody");
}

// ——— 4 · Tests ———

export function TestsDrawer({ api, draft, patch, onClose, suggest = SUGGEST_DEFAULT }: {
  api: ConsultApi; draft: ConsultDraft; patch: Patch; onClose: () => void;
  /** The hospital's switch AND this doctor's own, with the three-crosses list. Off ⇒ no "often advised with this diagnosis"; search stays. */
  suggest?: SuggestState;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [list, setList] = useState<WirePriceRow[] | null>(null);
  const [offeredAll, setBefore] = useState<WireTestHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const enc = draft.encounterId;
  const first = draft.diagnoses[0];
  /** The diagnosis these tests were offered FOR — what a tap or a cross is counted under. */
  const context = first === undefined ? null : dxKeyOf(first.icd10Code, first.text);
  useEffect(() => {
    api.priceList().then(setList).catch((e) => { setList([]); setError(says(e, t)); });
    if (suggest.on && draft.diagnoses.length > 0) api.testsFor(draft.diagnoses.map((d) => ({ text: d.text, icd10: d.icd10Code }))).then((items) => {
      setBefore(items);
      const shown = items.filter((x) => !notOffered(suggest, enc, "test", context, x.serviceId)).map((x) => x.serviceId);
      if (shown.length > 0) void api.signals({ suggestions: [{ kind: "test", source: "suggested", outcome: "shown", surface: "consult_phone", encounterId: enc, ...(context === null ? {} : { contextKey: context }), items: shown.slice(0, 20) }] }).catch(() => undefined);
    }).catch(() => setBefore([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const before = offeredAll.filter((x) => !notOffered(suggest, enc, "test", context, x.serviceId));
  const told = (serviceId: string, rankShown: number, outcome: "accepted" | "dismissed"): void => {
    void api.signals({ suggestions: [{ kind: "test", source: "suggested", outcome, surface: "consult_phone", encounterId: enc, ...(context === null ? {} : { contextKey: context }), itemKey: serviceId, rankShown }] }).catch(() => undefined);
  };
  const has = (id: string): boolean => draft.tests.some((x) => x.serviceId === id);
  const toggle = (x: { serviceId: string; code: string; name: string; pricePaise: number }): void =>
    patch((d) => (has(x.serviceId) ? { ...d, tests: d.tests.filter((y) => y.serviceId !== x.serviceId) } : d.tests.length >= MAX_TESTS ? d : { ...d, tests: [...d.tests, { serviceId: x.serviceId, code: x.code, name: x.name, pricePaise: x.pricePaise }] }));
  const needle = q.trim().toLowerCase();
  const hits = needle.length < 2 || list === null ? [] : list.filter((r) => r.name.toLowerCase().includes(needle) || r.code.toLowerCase().includes(needle)).slice(0, 12);
  return (
    <Drawer testID="tests-drawer" title={t("mobile.consult.tests")} onClose={() => {
      // A test the price list could not answer, left in the box as the sheet closes: the term alone.
      if (needle.length >= 3 && list !== null && list.length > 0 && hits.length === 0) void api.signals({ misses: [{ kind: "test", term: needle, stage: "search" }] }).catch(() => undefined);
      onClose();
    }}>
      <Box testID="test-input" value={q} onChangeText={setQ} placeholder={t("mobile.consult.testSearch")} maxLength={60} />
      {draft.tests.length > 0 && <View style={st.chips}>{draft.tests.map((x) => <Chip key={x.serviceId} testID={`test-on-${x.serviceId}`} label={`${x.name} ✕`} on onPress={() => toggle(x)} />)}</View>}
      {needle.length < 2 && before.length > 0 && <Lab>{t("mobile.consult.testsBefore")}</Lab>}
      {needle.length < 2 && before.length > 0 && <View style={st.chips}>{before.map((x, i) => (
        <View key={x.serviceId} style={st.offer}>
          <Chip testID={`test-before-${x.serviceId}`} label={x.name} on={has(x.serviceId)} onPress={() => { if (!has(x.serviceId)) told(x.serviceId, i, "accepted"); toggle(x); }} />
          {!has(x.serviceId) && <Cross testID={`test-before-x-${x.serviceId}`} name={x.name} onPress={() => { crossOff(enc, "test", x.serviceId); told(x.serviceId, i, "dismissed"); setTick((n) => n + 1); }} />}
        </View>
      ))}</View>}
      {hits.map((r) => (
        <Pressable key={r.serviceId} testID={`test-hit-${r.serviceId}`} accessibilityRole="button" onPress={() => toggle(r)} style={st.hit}>
          <View style={{ flex: 1, minWidth: 0 }}><Text style={st.hitName}>{r.name}</Text><Text style={st.hitSub}>{r.code}</Text></View>
          {has(r.serviceId) && <Text style={st.tick}>✓</Text>}
        </Pressable>
      ))}
      {needle.length >= 2 && list !== null && hits.length === 0 && <Text style={st.fine}>{t("mobile.consult.testNone")}</Text>}
      {error !== null && <Note tone="bad" testID="tests-error">{error}</Note>}
      <Text style={st.fine}>{t("mobile.consult.testsHint")}</Text>
    </Drawer>
  );
}

// ——— 5 · Advice and follow-up ———

export function AdviceDrawer({ api, draft, patch, onClose, followChoices }: {
  api: ConsultApi; draft: ConsultDraft; patch: Patch; onClose: () => void;
  followChoices: { days: number | null; isDefault: boolean; send: number | null }[];
}) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<WireAdviceTemplate[]>([]);
  useEffect(() => { api.advice().then(setTemplates).catch(() => setTemplates([])); }, [api]);
  const textOf = (a: WireAdviceTemplate): string => (draft.adviceLang === "hi" ? a.textHi ?? a.textEn : a.textEn ?? a.textHi) ?? a.title;
  const toggle = (text: string): void => patch((d) => ({ ...d, adviceChips: d.adviceChips.includes(text) ? d.adviceChips.filter((x) => x !== text) : [...d.adviceChips, text].slice(0, 10) }));
  return (
    <Drawer testID="advice-drawer" title={t("mobile.consult.adviceTitle")} onClose={onClose}>
      <Lab>{t("mobile.consult.adviceLang")}</Lab>
      <View style={st.chips}>
        <Chip testID="advice-lang-en" label="English" on={draft.adviceLang === "en"} onPress={() => patch((d) => ({ ...d, adviceLang: "en", adviceChips: [] }))} />
        <Chip testID="advice-lang-hi" label="हिन्दी" on={draft.adviceLang === "hi"} onPress={() => patch((d) => ({ ...d, adviceLang: "hi", adviceChips: [] }))} />
      </View>
      {templates.length > 0 && <Lab>{t("mobile.consult.adviceChips")}</Lab>}
      <View style={st.chips}>
        {templates.slice(0, 14).map((a) => <Chip key={a.id} testID={`advice-${a.id}`} label={a.title} on={draft.adviceChips.includes(textOf(a))} onPress={() => toggle(textOf(a))} />)}
      </View>
      <Box testID="advice-input" multiline value={draft.adviceText} maxLength={2000} placeholder={t("mobile.consult.adviceHint")} onChangeText={(v) => patch((d) => ({ ...d, adviceText: v }))} />
      <Lab>{t("mobile.consult.reviewAfter")}</Lab>
      <View style={st.chips}>
        {REVIEW_CHOICES.map((n) => <Chip key={n} testID={`review-${String(n)}`} label={t("mobile.consult.days", { count: n })} on={draft.reviewDays === n} onPress={() => patch((d) => ({ ...d, reviewDays: d.reviewDays === n ? null : n }))} />)}
        <Chip testID="review-none" dashed label={t("mobile.consult.reviewNone")} on={draft.reviewDays === null} onPress={() => patch((d) => ({ ...d, reviewDays: null }))} />
      </View>
      {followChoices.length > 1 && (
        <>
          <Lab>{t("mobile.consult.freeWindow")}</Lab>
          <View style={st.chips}>
            {followChoices.map((c) => <Chip key={String(c.send)} testID={`follow-${c.send === null ? "default" : String(c.send)}`} on={draft.followUpSend === c.send}
              label={c.days === null ? t("opdConsult.followUpDefault") : t("mobile.consult.days", { count: c.days })} onPress={() => patch((d) => ({ ...d, followUpSend: c.send }))} />)}
          </View>
        </>
      )}
      <Pressable testID="return-today" accessibilityRole="checkbox" accessibilityState={{ checked: draft.returnToday === true }} onPress={() => patch((d) => ({ ...d, returnToday: d.returnToday !== true }))} style={st.check}>
        <View style={[st.checkBox, draft.returnToday === true && { backgroundColor: color.green, borderColor: color.green }]}>{draft.returnToday === true && <Text style={{ color: "#fff", fontWeight: "700" }}>✓</Text>}</View>
        <Text style={{ flex: 1, fontSize: 14.5, lineHeight: 20, color: color.ink }}>{t("mobile.consult.returnToday")}</Text>
      </Pressable>
    </Drawer>
  );
}

// ——— My sets ———

export function SetsDrawer({ api, onClose, onUse, canSave, onSave }: {
  api: ConsultApi; onClose: () => void; onUse: (set: WireRxSet) => void; canSave: boolean; onSave: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sets, setSets] = useState<WireRxSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = (): void => { api.sets().then((r) => { setSets(r.items); setError(null); }).catch((e) => { setSets([]); setError(says(e, t)); }); };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = (sets ?? []).filter((x) => x.mine);
  const starter = (sets ?? []).filter((x) => !x.mine && x.signed);
  const sub = (x: WireRxSet): string => [...x.body.lines.slice(0, 3).map((l) => l.drug.split(" ")[0] ?? l.drug), x.body.tests.length > 0 ? t("mobile.consult.sets.tests", { count: x.body.tests.length }) : null,
    x.body.reviewDays === null ? null : t("mobile.consult.sets.review", { count: x.body.reviewDays })].filter((p) => p !== null).join(" · ");
  const card = (x: WireRxSet) => (
    <View key={x.id} style={st.setCard} testID={`set-${x.id}`}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{x.name}</Text>
        <Text style={st.hitSub}>{sub(x)}</Text>
        {!x.mine && x.signedByName !== null && <Text style={st.hitSub}>{t("mobile.consult.sets.signedBy", { name: x.signedByName })}</Text>}
      </View>
      <Pressable testID={`set-use-${x.id}`} accessibilityRole="button" onPress={() => onUse(x)} style={[st.small, st.smallOn]}><Text style={[st.smallText, { color: "#f2faf6" }]}>{t("mobile.consult.sets.use")}</Text></Pressable>
    </View>
  );
  return (
    <Drawer testID="sets-drawer" title={t("mobile.consult.sets.title")} onClose={onClose}>
      {sets === null && <Text style={st.fine}>{t("mobile.doctor.loading")}</Text>}
      {mine.length > 0 && <Lab>{t("mobile.consult.sets.yours")}</Lab>}
      {mine.map(card)}
      {starter.length > 0 && <Lab>{t("mobile.consult.sets.hospital", { department: starter[0]?.departmentName ?? "" })}</Lab>}
      {starter.map(card)}
      {sets !== null && mine.length === 0 && starter.length === 0 && error === null && <Text style={st.fine} testID="sets-empty">{t("mobile.consult.sets.empty")}</Text>}
      {error !== null && <Note tone="bad" testID="sets-error">{error}</Note>}
      {canSave && (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <Lab>{t("mobile.consult.sets.saveTitle")}</Lab>
          <Box testID="set-name" value={name} onChangeText={(v) => { setName(v); setSaved(false); }} placeholder={t("mobile.consult.sets.nameHint")} maxLength={60} />
          <Button testID="set-save" kind="secondary" label={t(saved ? "mobile.consult.sets.saved" : "mobile.consult.sets.save")} busy={busy} disabled={name.trim() === "" || saved}
            onPress={() => { setBusy(true); setError(null); onSave(name.trim()).then(() => { setSaved(true); load(); }).catch((e) => setError(says(e, t))).finally(() => setBusy(false)); }} />
        </View>
      )}
      <Text style={st.fine}>{t("mobile.consult.sets.hint")}</Text>
    </Drawer>
  );
}

const st = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(12,22,19,.45)", justifyContent: "flex-end" },
  overlay: { zIndex: 50, elevation: 50 },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: "92%", minHeight: "60%" },
  grab: { width: 38, height: 4, borderRadius: 2, backgroundColor: color.line, alignSelf: "center", marginTop: 10 },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: color.ink },
  doneBtn: { minHeight: 40, minWidth: 56, alignItems: "flex-end", justifyContent: "center" },
  done: { color: color.green, fontSize: 15, fontWeight: "700" },
  lab: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.faint, textTransform: "uppercase", marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  chipOn: { backgroundColor: color.green, borderColor: color.green },
  chipText: { fontSize: 14, fontWeight: "700", color: color.ink },
  box: { minHeight: TOUCH, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.paper, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: color.ink },
  boxFocus: { borderColor: color.green, borderWidth: 2, backgroundColor: color.card },
  hit: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: TOUCH, paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line2 },
  hitName: { fontSize: 15, lineHeight: 21, color: color.ink },
  hitSub: { fontSize: 12.5, lineHeight: 18, color: color.dim },
  code: { fontFamily: MONO, fontSize: 12, color: color.dim, backgroundColor: color.wash, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  tick: { color: color.green, fontSize: 18, fontWeight: "700" },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  fine: { fontSize: 12.5, lineHeight: 18, color: color.faint },
  said: { fontSize: 13.5, lineHeight: 19, color: color.dim, borderLeftWidth: 3, borderLeftColor: color.line, paddingLeft: 8 },
  mic: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: 12, backgroundColor: color.paper },
  micRec: { borderColor: color.redLine, backgroundColor: color.redSoft },
  dot: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.green, alignItems: "center", justifyContent: "center" },
  micTitle: { fontSize: 15, fontWeight: "700", color: color.ink },
  micSub: { fontSize: 12.5, lineHeight: 18, color: color.dim },
  timer: { fontFamily: MONO, fontSize: 18, fontWeight: "700", color: color.red },
  kv: { flexDirection: "row", gap: 10 },
  k: { width: 92, fontSize: 13, color: color.dim },
  v: { flex: 1, fontSize: 13.5, lineHeight: 19, fontWeight: "700", color: color.ink },
  two: { flexDirection: "row", gap: space.sm },
  cross: { minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 999 },
  crossText: { fontSize: 20, lineHeight: 22, color: color.dim },
  nickTag: { alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden", fontSize: 11.5, lineHeight: 16, fontWeight: "700", color: "#8a5a10", backgroundColor: "#fdf3dc" },
  offer: { flexDirection: "row", alignItems: "center" },
  small: { minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: radius.md, borderWidth: 1 },
  smallOn: { backgroundColor: color.green, borderColor: color.green },
  smallDone: { backgroundColor: color.greenSoft, borderColor: color.greenLine },
  smallText: { fontSize: 13, fontWeight: "700" },
  lineCard: { borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: 12, gap: 8, backgroundColor: color.card },
  lineMain: { fontSize: 15.5, lineHeight: 22, fontWeight: "700", color: color.ink },
  alert: { borderWidth: 1, borderRadius: radius.md, padding: 10 },
  alertRed: { backgroundColor: color.redSoft, borderColor: color.redLine },
  alertAmber: { backgroundColor: color.goldSoft, borderColor: color.goldLine },
  alertTitle: { fontSize: 14, lineHeight: 20, fontWeight: "700" },
  alertBody: { fontSize: 13, lineHeight: 19 },
  setCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: 12 },
  check: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: TOUCH, marginTop: 4 },
  checkBox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: color.line, alignItems: "center", justifyContent: "center" },
});
