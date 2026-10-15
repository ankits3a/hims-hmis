import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Platform, StyleSheet, View } from "react-native";
import { useI18n } from "../i18n";
import { hintStore } from "../storage";
import { Text } from "../text";
import { color, radius } from "../theme";

/**
 * SWIPE A ROW (board part "gestures" frame B). A row slid to the right uncovers a strip that NAMES
 * the one action it does — the screen's most common one — and letting go past the mark does it.
 *
 * A SHORTCUT, NEVER THE ONLY WAY, AND NEVER A DANGEROUS ONE: every screen that wraps a row in this
 * passes an action its own visible button already does (start, open the form, photograph). Nothing
 * here deletes, cancels, pays or completes. A screen reader gets the same action by name
 * (`accessibilityActions`), since a swipe is not something it can do.
 */
export const SWIPE_REVEAL = 136;
/** Past this the action is done on release — and by here the whole label on the strip has been uncovered. */
export const SWIPE_FIRE = 100;

/** Is this drag a swipe to the right — and not the list being scrolled? Pure, so the threshold is a test. */
export function isSwipeRight(dx: number, dy: number): boolean {
  return dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.6;
}
/** Did the row travel far enough, when let go, to mean it? */
export function swipeFires(dx: number): boolean {
  return dx >= SWIPE_FIRE;
}

/**
 * A swipe to the LEFT (owner 2026-10-09) — a second, rarer shortcut a row may carry. The same
 * discipline: it only OPENS something that asks before anything is written, and a row that does not
 * pass one does not move left at all.
 */
export function isSwipeLeft(dx: number, dy: number): boolean {
  return dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.6;
}
/** A left swipe travels a little further before it means it: its label is longer, and it must be read whole first. */
export const SWIPE_LEFT_REVEAL = 156;
export const SWIPE_LEFT_FIRE = 124;
export function swipeLeftFires(dx: number): boolean {
  return dx <= -SWIPE_LEFT_FIRE;
}

export function SwipeRow({ label, onSwipe, children, testID, disabled = false, leftLabel, onSwipeLeft }: {
  label: string; onSwipe: () => void; children: ReactNode; testID?: string; disabled?: boolean;
  /** The left swipe, when this row has one: its name on the amber strip, and what it opens. */
  leftLabel?: string; onSwipeLeft?: () => void;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const fire = useRef(onSwipe);
  fire.current = onSwipe;
  const off = useRef(disabled);
  off.current = disabled;
  const fireLeft = useRef(onSwipeLeft);
  fireLeft.current = onSwipeLeft;
  const hasLeft = onSwipeLeft !== undefined && leftLabel !== undefined;
  /** True from the moment the row starts to slide until just after it is let go: a slide is never also a tap on the row. */
  const slid = useRef(false);
  const home = (): void => {
    Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 4 }).start();
    setTimeout(() => { slid.current = false; }, 250);
  };
  /**
   * The browser export only: there a mouse-up after a drag is still a "click" on the button under
   * it, so the click is stopped on its way down. On a phone the responder system has already taken
   * the touch away from the button, and none of this runs.
   */
  const over = useRef<View>(null);
  useEffect(() => {
    const node = over.current as unknown as { addEventListener?: (t: string, f: (e: { stopPropagation: () => void; preventDefault: () => void }) => void, capture: boolean) => void; removeEventListener?: (t: string, f: (e: never) => void, capture: boolean) => void } | null;
    if (Platform.OS !== "web" || node === null || typeof node.addEventListener !== "function") return;
    const stop = (e: { stopPropagation: () => void; preventDefault: () => void }): void => { if (slid.current) { e.stopPropagation(); e.preventDefault(); } };
    node.addEventListener("click", stop, true);
    return () => node.removeEventListener?.("click", stop as never, true);
  }, []);
  const pan = useMemo(() => PanResponder.create({
    // CAPTURE: the row inside is a button, and a sideways drag must reach this before it does.
    onMoveShouldSetPanResponderCapture: (_, g) => !off.current && (isSwipeRight(g.dx, g.dy) || (fireLeft.current !== undefined && isSwipeLeft(g.dx, g.dy))),
    onPanResponderGrant: () => { slid.current = true; },
    onPanResponderMove: (_, g) => { x.setValue(Math.max(fireLeft.current === undefined ? 0 : -SWIPE_LEFT_REVEAL, Math.min(SWIPE_REVEAL, g.dx))); },
    onPanResponderRelease: (_, g) => {
      const go = swipeFires(g.dx);
      const left = fireLeft.current !== undefined && swipeLeftFires(g.dx);
      home();
      if (go) fire.current(); else if (left) fireLeft.current?.();
    },
    onPanResponderTerminate: home,
    // Once the row is sliding, the list under it does not take the finger back.
    onPanResponderTerminationRequest: () => false,
  }), []);
  return (
    <View
      testID={testID} style={s.wrap}
      accessibilityActions={disabled ? [] : [{ name: "swipe", label }, ...(hasLeft ? [{ name: "swipeLeft", label: leftLabel }] : [])]}
      onAccessibilityAction={(e) => {
        if (disabled) return;
        if (e.nativeEvent.actionName === "swipe") onSwipe();
        else if (e.nativeEvent.actionName === "swipeLeft" && hasLeft) onSwipeLeft();
      }}
    >
      {/* The strip is not there until the row moves: a row with a tinted background must not show it through. */}
      <Animated.View style={[s.under, { opacity: x.interpolate({ inputRange: [0, 6], outputRange: [0, 1], extrapolate: "clamp" }) }]} pointerEvents="none">
        <Text style={s.underText} numberOfLines={2}>{label}</Text>
      </Animated.View>
      {hasLeft && (
        <Animated.View style={[s.under, s.underLeft, { opacity: x.interpolate({ inputRange: [-6, 0], outputRange: [1, 0], extrapolate: "clamp" }) }]} pointerEvents="none">
          <Text style={[s.underText, s.underTextLeft]} numberOfLines={2}>{leftLabel}</Text>
        </Animated.View>
      )}
      <Animated.View style={[s.over, { transform: [{ translateX: x }] }]} {...pan.panHandlers} ref={over}>{children}</Animated.View>
    </View>
  );
}

/** "Swipe right on a row for its most common action" — under a list the first three times it is opened, then never. */
export function SwipeHint({ list, textKey = "mobile.scan.swipeHint" }: { list: string; textKey?: string }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    void hintStore.seen(`swipe.${list}`).then((n) => { if (live) setShow(n <= 3); });
    return () => { live = false; };
  }, [list]);
  if (!show) return null;
  return <Text testID="swipe-hint" style={s.hint}>{t(textKey)}</Text>;
}

const s = StyleSheet.create({
  wrap: { borderRadius: radius.lg, overflow: "hidden" },
  under: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center", paddingLeft: 12, backgroundColor: color.green, borderRadius: radius.lg },
  // A solid sheet under the row itself, so a row drawn with a tint slides as a card and not as glass.
  over: { backgroundColor: color.card, borderRadius: radius.lg },
  underText: { color: "#f2faf6", fontSize: 14, lineHeight: 18, fontWeight: "800", width: SWIPE_FIRE - 22 },
  underLeft: { backgroundColor: color.gold, alignItems: "flex-end", paddingLeft: 0, paddingRight: 12 },
  underTextLeft: { color: color.ink, textAlign: "right", fontSize: 13, lineHeight: 17, width: SWIPE_LEFT_FIRE - 22 },
  hint: { fontSize: 12.5, lineHeight: 18, color: color.faint, textAlign: "center", paddingTop: 2 },
});
