import { useMemo, useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Text } from "../text";
import { useI18n } from "../i18n";
import { color, radius } from "../theme";
import { isConvex } from "./rules";
import type { Point, Quad } from "./rules";

/**
 * THE CROP STEP — the photo, the page's four corners, and a thumb.
 *
 * The corners arrive already on the page when it was found (`status: "found"`), or just inside the
 * frame when it was not. Each is a 48 dp handle; while one is held a round glass shows the pixels
 * under it at 2.5×, because the thumb is covering exactly the corner being placed. The glass sits
 * above the finger and drops below it near the top edge.
 *
 * Coordinates: `quad` is in the PHOTO's pixels. The picture is drawn to fit the box it is given, so
 * everything on screen is `quad × scale`.
 */
export type CropStatus = "finding" | "found" | "none";
const HANDLE = 48;
const GLASS = 124;
const ZOOM = 2.5;
const CORNERS = ["tl", "tr", "br", "bl"] as const;

export function Crop({ uri, width, height, quad, status, onQuad }: {
  uri: string; width: number; height: number; quad: Quad; status: CropStatus; onQuad: (q: Quad) => void;
}) {
  const { t } = useI18n();
  // The picture takes whatever room the screen has left for it — measured, never assumed — and the
  // corner handles need half their own width of margin so one on the photo's edge is still whole.
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const scale = room === null ? 0 : Math.max(0, Math.min((room.w - HANDLE) / width, (room.h - HANDLE) / height));
  const dw = width * scale;
  const dh = height * scale;
  const live = useRef({ quad, scale, width, height, onQuad });
  live.current = { quad, scale, width, height, onQuad };
  const start = useRef<Point>({ x: 0, y: 0 });

  const responders = useMemo(() => CORNERS.map((_, i) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { start.current = live.current.quad[i]!; setHeld(i); },
    onPanResponderMove: (_e, g) => {
      const c = live.current;
      if (c.scale === 0) return;
      const next = [...c.quad] as Quad;
      next[i] = {
        x: Math.min(c.width, Math.max(0, start.current.x + g.dx / c.scale)),
        y: Math.min(c.height, Math.max(0, start.current.y + g.dy / c.scale)),
      };
      c.onQuad(next);
    },
    onPanResponderRelease: () => { setHeld(null); },
    onPanResponderTerminate: () => { setHeld(null); },
  })), []);

  const onLayout = (e: LayoutChangeEvent): void => { setRoom({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }); };
  const ok = isConvex(quad);
  const line = ok ? color.mint : color.red;
  const pts = quad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const heldPt = held === null ? null : pts[held]!;

  return (
    <View style={s.box}>
      <Text testID="crop-status" style={[s.status, status === "none" && { color: "#8a5a10" }]}>
        {t(`slipCapture.crop.${status}`)}
      </Text>
      <View testID="crop" onLayout={onLayout} style={s.room}>
      {scale > 0 && (
        <View style={{ width: dw, height: dh }}>
          <Image source={{ uri }} style={{ width: dw, height: dh, borderRadius: radius.sm }} resizeMode="stretch" accessibilityIgnoresInvertColors />
          {/* The four sides: a thin bar from each corner to the next, turned to the angle between them. */}
          {pts.map((a, i) => {
            const b = pts[(i + 1) % 4]!;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
            return (
              <View key={`side-${String(i)}`} pointerEvents="none" style={{
                position: "absolute", left: (a.x + b.x) / 2 - len / 2, top: (a.y + b.y) / 2 - 1.5,
                width: len, height: 3, backgroundColor: line, transform: [{ rotate: `${String(deg)}deg` }],
              }} />
            );
          })}
          {pts.map((p, i) => (
            <View
              key={CORNERS[i]} testID={`crop-handle-${CORNERS[i]!}`} {...responders[i]!.panHandlers}
              accessible accessibilityRole="adjustable" accessibilityLabel={t("slipCapture.crop.handle", { corner: t(`slipCapture.crop.${CORNERS[i]!}`) })}
              hitSlop={10}
              style={[s.handle, { left: p.x - HANDLE / 2, top: p.y - HANDLE / 2, borderColor: line }, held === i && s.handleHeld]}
            >
              <View style={[s.dot, { backgroundColor: line }]} />
            </View>
          ))}
          {heldPt !== null && (
            <View testID="crop-glass" pointerEvents="none" style={[s.glass, {
              left: Math.min(dw - GLASS, Math.max(0, heldPt.x - GLASS / 2)),
              top: heldPt.y - GLASS - 44 < 0 ? Math.min(dh - GLASS, heldPt.y + 44) : heldPt.y - GLASS - 44,
            }]}>
              <Image
                source={{ uri }} resizeMode="stretch"
                style={{ position: "absolute", width: dw * ZOOM, height: dh * ZOOM, left: GLASS / 2 - heldPt.x * ZOOM, top: GLASS / 2 - heldPt.y * ZOOM }}
              />
              <View style={s.crossH} /><View style={s.crossV} />
            </View>
          )}
        </View>
      )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  box: { flex: 1, gap: 8 },
  room: { flex: 1, alignItems: "center", justifyContent: "center" },
  status: { fontSize: 14, lineHeight: 19, fontWeight: "700", color: color.green },
  handle: { position: "absolute", width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2, borderWidth: 3, backgroundColor: "rgba(255,255,255,.35)", alignItems: "center", justifyContent: "center" },
  handleHeld: { backgroundColor: "rgba(255,255,255,.12)", transform: [{ scale: 1.15 }] },
  dot: { width: 10, height: 10, borderRadius: 5 },
  glass: { position: "absolute", width: GLASS, height: GLASS, borderRadius: GLASS / 2, overflow: "hidden", borderWidth: 3, borderColor: "#fff", backgroundColor: "#000", elevation: 6 },
  crossH: { position: "absolute", left: GLASS / 2 - 12, top: GLASS / 2 - 1, width: 24, height: 2, backgroundColor: color.mint },
  crossV: { position: "absolute", left: GLASS / 2 - 1, top: GLASS / 2 - 12, width: 2, height: 24, backgroundColor: color.mint },
});
