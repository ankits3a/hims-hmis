import { type ReactNode, createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput as RNTextInput, View, type ModalProps, type ScrollViewProps, type TextInputProps } from "react-native";
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
 * on iPhone its content is lifted by the keyboard's height.
 *
 * ANDROID DRAWS NO MODAL (owner 2026-10-10: the keyboard hid the boxes of every sheet). Since React Native
 * 0.81 a Modal's dialog window is edge-to-edge, so Android does not resize it for the keyboard, and the
 * keyboard events come from the activity's window, not the dialog's — padding inside a Modal did nothing on
 * the phone. On Android a KeyboardModal is drawn by the `SheetHost` (app/_layout.tsx) as a full-screen layer
 * in the activity's own window, lifted by the keyboard's height; Back closes the top one. Android's
 * ScrollView then keeps the focused box in view as it shrinks. `ownWindow` keeps a real Modal (the cameras:
 * no box, and they take the whole screen). Without a host (tests) it falls back to a Modal.
 */
export function KeyboardSheet({ children }: { children?: ReactNode }) {
  return (
    <KeyboardAvoidingView testID="keyboard-sheet" behavior={Platform.OS === "web" ? undefined : "padding"} style={{ flex: 1 }}>
      {children}
    </KeyboardAvoidingView>
  );
}

/** The keyboard's height while it is up on Android (activity window only), else 0. */
export function useAndroidKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const up = Keyboard.addListener("keyboardDidShow", (e) => setHeight(Math.max(0, e.endCoordinates.height)));
    const down = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => { up.remove(); down.remove(); };
  }, []);
  return height;
}

type Sheet = { node: ReactNode; opaque: boolean; testID?: string };
const SheetHostContext = createContext<((id: number, sheet: Sheet | null) => void) | null>(null);
let nextSheetId = 1;

/** Draws every open Android KeyboardModal over the app, newest on top, above the keyboard. */
export function SheetHost({ children }: { children?: ReactNode }) {
  const [sheets, setSheets] = useState<{ id: number; sheet: Sheet }[]>([]);
  const put = useCallback((id: number, sheet: Sheet | null) => {
    setSheets((all) => {
      const at = all.findIndex((x) => x.id === id);
      if (sheet === null) return at < 0 ? all : all.filter((x) => x.id !== id);
      if (at < 0) return [...all, { id, sheet }];
      const next = all.slice();
      next[at] = { id, sheet };
      return next;
    });
  }, []);
  const keyboard = useAndroidKeyboardHeight();
  const insets = useSafeAreaInsets();
  return (
    <SheetHostContext.Provider value={put}>
      {children}
      {sheets.map(({ id, sheet }) => (
        // The keyboard's reported height leaves out the navigation bar; the layer reaches the screen's foot.
        <View key={id} testID={sheet.testID ?? "sheet-layer"}
          style={[StyleSheet.absoluteFill, s.sheetLayer, sheet.opaque && { backgroundColor: color.paper }, { paddingBottom: keyboard > 0 ? keyboard + insets.bottom : 0 }]}>
          {sheet.node}
        </View>
      ))}
    </SheetHostContext.Provider>
  );
}

function HostedSheet({ put, visible, transparent, onRequestClose, testID, children }: ModalProps & { put: (id: number, sheet: Sheet | null) => void }) {
  const id = useRef(0);
  if (id.current === 0) id.current = nextSheetId++;
  const shown = visible !== false;
  useEffect(() => { put(id.current, shown ? { node: children, opaque: transparent !== true, testID } : null); });
  useEffect(() => () => put(id.current, null), [put]);
  useEffect(() => {
    if (!shown) return undefined;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { onRequestClose?.({} as never); return true; });
    return () => back.remove();
  }, [shown, onRequestClose]);
  return null;
}

export function KeyboardModal({ children, ownWindow, ...rest }: ModalProps & { ownWindow?: boolean }) {
  const put = useContext(SheetHostContext);
  if (Platform.OS === "android" && put !== null && ownWindow !== true) return <HostedSheet put={put} {...rest}>{children}</HostedSheet>;
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

/**
 * The scroll view of a bare screen that holds inputs. iPhone: `keyboardScrollInsets()`. ANDROID (owner
 * 2026-10-10: Desk One's "New patient" boxes hidden under the keyboard): the app is edge-to-edge since
 * React Native 0.81, so Android no longer shrinks the screen for the keyboard. When the keyboard rises
 * the scroll view ends at the keyboard's top (a bottom margin of exactly the overlap, measured), and the
 * box being typed in is scrolled back into view.
 */
export const KeyboardScrollView = forwardRef<ScrollView, ScrollViewProps>(function KeyboardScrollView({ style, onScroll, ...props }, outer) {
  const inner = useRef<ScrollView | null>(null);
  const offset = useRef(0);
  const liftRef = useRef(0);
  const [lift, setLift] = useState(0);
  const setRefs = useCallback((node: ScrollView | null) => {
    inner.current = node;
    if (typeof outer === "function") outer(node);
    else if (outer !== null) outer.current = node;
  }, [outer]);
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const apply = (n: number) => { liftRef.current = n; setLift(n); };
    const up = Keyboard.addListener("keyboardDidShow", (e) => {
      const host = inner.current?.getNativeScrollRef() ?? null;
      if (host === null) return;
      host.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        // `screenY` is the keyboard's top in the window; the margin already applied is added back.
        apply(Math.max(0, Math.round(y + h + liftRef.current - e.endCoordinates.screenY)));
      });
    });
    const down = Keyboard.addListener("keyboardDidHide", () => apply(0));
    return () => { up.remove(); down.remove(); };
  }, []);
  useEffect(() => {
    if (Platform.OS !== "android" || lift === 0) return undefined;
    const timer = setTimeout(() => scrollFocusedIntoView(inner.current, offset.current), 80);
    return () => clearTimeout(timer);
  }, [lift]);
  return (
    <ScrollView ref={setRefs} {...keyboardScrollInsets()} {...props} scrollEventThrottle={props.scrollEventThrottle ?? 32}
      style={lift > 0 ? [style, { marginBottom: lift }] : style}
      onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; onScroll?.(e); }} />
  );
});

/** Scrolls `view` so the focused text box is inside it (Android, after the view has shrunk above the keyboard). */
export function scrollFocusedIntoView(view: ScrollView | null, offset: number): void {
  const box = RNTextInput.State.currentlyFocusedInput();
  const host = view?.getNativeScrollRef() ?? null;
  if (box === null || view === null || host === null) return;
  host.measureInWindow((_x: number, viewY: number, _w: number, viewH: number) => {
    box.measureInWindow((_bx: number, boxY: number, _bw: number, boxH: number) => {
      const below = boxY + Math.min(boxH, 160) + space.md - (viewY + viewH);
      const above = viewY - boxY;
      if (below > 0) view.scrollTo({ y: offset + below, animated: true });
      else if (above > 0) view.scrollTo({ y: Math.max(0, offset - above - space.md), animated: true });
    });
  });
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
  sheetLayer: { zIndex: 100, elevation: 100 },
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
