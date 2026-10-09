import { type ReactNode, forwardRef, useCallback, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, type ModalProps, type ScrollViewProps, type TextInputProps } from "react-native";
import { Text, TextInput } from "./text";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IS_PRODUCTION } from "./config";
import { useI18n } from "./i18n";
import { useSessionOptional } from "./session";
import { color, radius, space, TOUCH, type } from "./theme";

export const MONO = Platform.select({ android: "monospace", ios: "Menlo", default: "ui-monospace, Menlo, monospace" });

/** The scan mark: four corners and a line — drawn, so the header needs no icon font. */
export function ScanMark({ tint = color.agentFg, size = 22 }: { tint?: string; size?: number }) {
  const c = Math.round(size * 0.32);
  const corner = { position: "absolute" as const, width: c, height: c, borderColor: tint };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[corner, { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 3 }]} />
      <View style={[corner, { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 3 }]} />
      <View style={[corner, { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 3 }]} />
      <View style={[corner, { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 3 }]} />
      <View style={{ position: "absolute", left: 3, right: 3, top: size / 2 - 1, height: 2, borderRadius: 1, backgroundColor: color.mint }} />
    </View>
  );
}

/**
 * The pine band every screen opens with: the mark, the name, the language switch.
 *
 * QUICK SCAN (owner 2026-10-08, board part "scan" frame A): the scan button lives HERE, so it is in
 * the same place — top right, first icon — on home and on every work screen, and no screen copies
 * it. It shows for a signed-in session only; a screen with no patient work passes `scan={false}`.
 */
export function Band({ right, scan = true }: { right?: ReactNode; scan?: boolean }) {
  const { t, toggle } = useI18n();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const session = useSessionOptional();
  const showScan = scan && session?.state.status === "signedIn";
  return (
    <View style={[s.band, { paddingTop: insets.top + space.md }]}>
      <View style={s.row}>
        <View style={s.mark} />
        <Text style={s.brand}>{t("app.title")}</Text>
        {right === undefined && <Text style={s.product} numberOfLines={1}>{t("login.product")}</Text>}
        <View style={{ flex: 1 }} />
        {showScan && (
          // A 40 dp mark with 4 dp of slop on every side: the 48 dp target without a taller band.
          <Pressable onPress={() => router.push("/scan")} accessibilityRole="button" accessibilityLabel={t("mobile.scan.label")} hitSlop={4} testID="band-scan"
            style={({ pressed }) => [s.scan, pressed && { opacity: 0.6 }]}>
            <ScanMark />
          </Pressable>
        )}
        {right}
        <Pressable onPress={toggle} accessibilityRole="button" hitSlop={8} style={s.lang} testID="lang-toggle">
          <Text style={s.langText}>{t("app.language")}</Text>
        </Pressable>
      </View>
      {!IS_PRODUCTION && (
        <Text style={s.staging} testID="staging-strip">{t("mobile.staging")}</Text>
      )}
    </View>
  );
}

export function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "faint" }) {
  return <Text style={[type.tag, { color: tone === "dim" ? color.dim : color.faint, fontFamily: MONO }]}>{children}</Text>;
}

export type FieldProps = TextInputProps & { label: string; secure?: boolean; revealLabel?: string; hideLabel?: string };

/**
 * A labelled input. iPHONE (owner 2026-10-09: "the keyboard didn't pop up"): the WHOLE bordered row
 * is the target — a tap on its padding or border focuses the input inside, so the keyboard comes up
 * wherever the finger lands. The ref reaches the TextInput itself, so a screen can move focus on
 * ("next" on the username goes to the password).
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field({ label, secure, revealLabel, hideLabel, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  const [focus, setFocus] = useState(false);
  const input = useRef<TextInput | null>(null);
  const bind = useCallback((node: TextInput | null) => {
    input.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref !== null) ref.current = node;
  }, [ref]);
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={[type.tag, s.label]}>{label}</Text>
      <Pressable
        testID={rest.testID === undefined ? undefined : `${rest.testID}-row`}
        // The row is only a bigger target; the screen reader still meets the input itself.
        accessible={false}
        onPress={() => input.current?.focus()}
        style={[s.input, focus && s.inputFocus]}
      >
        <TextInput
          {...rest}
          ref={bind}
          accessibilityLabel={label}
          secureTextEntry={secure === true && !shown}
          onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
          onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
          placeholderTextColor={color.faint}
          style={s.inputText}
        />
        {secure === true && (
          <Pressable onPress={() => setShown((v) => !v)} accessibilityRole="button" style={s.reveal} hitSlop={8}>
            <Text style={s.revealText}>{shown ? hideLabel : revealLabel}</Text>
          </Pressable>
        )}
      </Pressable>
    </View>
  );
});

/**
 * KEYBOARD-AWARE SHEETS (owner 2026-10-09: "the input should be modal responsive with keyboard").
 * A `Modal` is drawn outside the screen's own KeyboardAvoidingView, so on an iPhone the keyboard
 * would rise over a sheet's input and its Save button. Every Modal in the app is a `KeyboardModal`:
 * on iOS its content is lifted by the keyboard's height; everywhere else the wrapper is a plain
 * full-size View (Android resizes the window itself — its behaviour is unchanged).
 */
export function KeyboardSheet({ children }: { children?: ReactNode }) {
  return (
    <KeyboardAvoidingView testID="keyboard-sheet" behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      {children}
    </KeyboardAvoidingView>
  );
}

export function KeyboardModal({ children, ...rest }: ModalProps) {
  return <Modal {...rest}><KeyboardSheet>{children}</KeyboardSheet></Modal>;
}

/**
 * Scroll views that hold inputs, iPhone only (Android keeps exactly what it had):
 * `keyboardScroll()` inside a KeyboardModal / KeyboardAvoidingView — taps reach buttons while the
 * keyboard is up and a drag pulls it down; `keyboardScrollInsets()` on a bare screen — the same,
 * and the scroll view also insets itself by the keyboard so the focused input scrolls into view.
 * (Never both: an inset inside a view that also pads for the keyboard leaves the space twice.)
 */
export function keyboardScroll(): Partial<ScrollViewProps> {
  return Platform.OS === "ios" ? { keyboardShouldPersistTaps: "handled", keyboardDismissMode: "interactive" } : {};
}
export function keyboardScrollInsets(): Partial<ScrollViewProps> {
  return Platform.OS === "ios" ? { ...keyboardScroll(), automaticallyAdjustKeyboardInsets: true } : {};
}

export function Button({ label, onPress, busy, disabled, kind = "primary", testID }: {
  label: string; onPress: () => void; busy?: boolean; disabled?: boolean; kind?: "primary" | "secondary"; testID?: string;
}) {
  const off = disabled === true || busy === true;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: busy === true }}
      style={({ pressed }) => [
        s.btn,
        kind === "primary" ? s.btnPrimary : s.btnSecondary,
        off && { opacity: 0.55 },
        pressed && !off && { opacity: 0.85 },
      ]}
    >
      {busy === true ? (
        <ActivityIndicator color={kind === "primary" ? "#f2faf6" : color.green} />
      ) : (
        <Text style={[s.btnText, { color: kind === "primary" ? "#f2faf6" : color.green }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Note({ tone, children, testID }: { tone: "bad" | "warn" | "info"; children: ReactNode; testID?: string }) {
  const map = {
    bad: { bg: color.redSoft, line: color.redLine, fg: color.red },
    warn: { bg: color.goldSoft, line: color.goldLine, fg: "#8a5a10" },
    info: { bg: color.wash, line: color.line, fg: color.dim },
  }[tone];
  return (
    <View testID={testID} accessibilityRole={tone === "bad" ? "alert" : undefined}
      style={[s.note, { backgroundColor: map.bg, borderColor: map.line }]}>
      <Text style={[type.small, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  band: { backgroundColor: color.agent, paddingHorizontal: space.lg, paddingBottom: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  mark: { width: 12, height: 12, backgroundColor: color.mint, transform: [{ rotate: "45deg" }] },
  brand: { color: "#fff", fontFamily: MONO, fontWeight: "700", fontSize: 15, letterSpacing: 1.5 },
  product: { color: color.agentDim, fontSize: 12, flexShrink: 1 },
  scan: { width: 40, height: 40, alignItems: "center", justifyContent: "center", marginVertical: -4 },
  lang: { minHeight: 32, paddingHorizontal: 10, justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: "rgba(217,239,228,.18)" },
  langText: { color: color.agentFg, fontSize: 13, fontWeight: "600" },
  staging: { marginTop: space.sm, color: color.gold, fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  label: { color: color.dim, fontFamily: MONO, marginBottom: 6 },
  input: { flexDirection: "row", alignItems: "center", minHeight: TOUCH + 4, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md },
  inputFocus: { borderColor: color.green, borderWidth: 2 },
  inputText: { flex: 1, paddingHorizontal: 14, fontSize: 17, color: color.ink, fontFamily: MONO, minHeight: TOUCH },
  reveal: { paddingHorizontal: 14, minHeight: TOUCH, justifyContent: "center" },
  revealText: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.dim },
  btn: { minHeight: TOUCH + 4, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
  btnPrimary: { backgroundColor: color.green, borderWidth: 1, borderColor: color.green },
  btnSecondary: { backgroundColor: color.card, borderWidth: 1, borderColor: color.greenLine },
  btnText: { fontSize: 16, fontWeight: "700", textAlign: "center" },
  note: { borderWidth: 1, borderRadius: radius.md, padding: space.md, marginBottom: space.lg },
});
