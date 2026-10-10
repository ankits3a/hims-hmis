import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { appTargetOf, waitingAge, waitingLines } from "../../../../packages/contracts/src/waiting";
import type { WaitingKind, WaitingLine, WaitingTone, WireWaiting } from "../../../../packages/contracts/src/waiting";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Call = <R>(method: "GET" | "POST", path: string, body?: unknown) => Promise<R>;
type Push = (href: string | { pathname: string; params: Record<string, string> }) => void;

/**
 * E1.4 / E1.5 (decision 0064) — "WAITING FOR ME" on the phone: the same `GET /me/waiting` the web's
 * My day reads, drawn through the same `waitingLines()` (packages/contracts/src/waiting.ts), so the
 * phone list equals the web list. Counts only: no patient on the home card, nothing for a lock screen.
 */
export function useWaiting(call: Call, on: boolean): { lines: WaitingLine[] | null; reload: () => Promise<void> } {
  const [lines, setLines] = useState<WaitingLine[] | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    if (!on) return;
    try {
      const got = await call<WireWaiting>("GET", "/me/waiting");
      if (alive.current) setLines(waitingLines(got));
    } catch {
      /* offline or an older server: the card keeps what it last drew, or is not drawn */
    }
  }, [call, on]);
  return { lines, reload };
}

/** One tap to where the line is worked: the bell, reminders, my duties — or Open loops, which says where. */
export function openWaiting(push: Push, kind: WaitingKind): void {
  const to = appTargetOf(kind);
  if (to.type === "route") push(to.path);
  else if (to.type === "seat") push({ pathname: "/seat/[key]", params: { key: to.key } });
  else push({ pathname: "/loops", params: { kind: to.kind } });
}

export const toneColor = (tone: WaitingTone): string => (tone === "hot" ? color.red : tone === "warn" ? color.gold : color.ink);

/** One line: the number, the words, and how long the oldest has waited. */
export function WaitingRow({ t, line, nowMs, onPress, where }: { t: T; line: WaitingLine; nowMs: number; onPress?: () => void; where?: string | null }) {
  const age = waitingAge(line.oldestAt, nowMs);
  const body = (
    <>
      <Text style={{ fontSize: 18, fontWeight: "800", color: toneColor(line.tone), minWidth: 28, fontVariant: ["tabular-nums"] }}>{String(line.count)}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: color.ink }}>{t(`openLoops.kind.${line.kind}`, { count: line.count })}</Text>
        {where != null && <Text testID={`waiting-where-${line.kind}`} numberOfLines={1} style={[type.small, { color: color.dim }]}>{where}</Text>}
      </View>
      {age !== null && <Text numberOfLines={1} style={{ fontSize: 12, color: color.faint }}>{age}</Text>}
      {onPress !== undefined && <Text style={{ color: color.faint, fontSize: 20 }}>›</Text>}
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 44, paddingVertical: 4 };
  return onPress === undefined
    ? <View testID={`waiting-line-${line.kind}`} style={style}>{body}</View>
    : (
      <Pressable testID={`waiting-line-${line.kind}`} accessibilityRole="button" onPress={onPress}
        style={({ pressed }) => [style, { backgroundColor: pressed ? color.wash : "transparent", borderRadius: radius.md }]}>
        {body}
      </Pressable>
    );
}

/**
 * The card at the top of every seat's home: one line per kind, each opening its screen in one tap;
 * the heading opens the Open loops list. Not drawn until read, and not drawn when nothing waits —
 * the home is already long, and an empty card is noise.
 */
export function WaitingCard({ t, lines, push, nowMs = Date.now() }: { t: T; lines: WaitingLine[] | null; push: Push; nowMs?: number }) {
  if (lines === null || lines.length === 0) return null;
  return (
    <View testID="waiting-card" style={{ marginTop: space.sm, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderLeftWidth: 4, borderLeftColor: lines.some((l) => l.tone === "hot") ? color.red : color.gold, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm }}>
      <Pressable testID="waiting-card-all" accessibilityRole="button" onPress={() => push("/loops")} hitSlop={6}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 32 }}>
        <Text numberOfLines={1} style={[type.tag, { color: color.faint, flex: 1 }]}>{t("openLoops.title")}</Text>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: color.green }}>{t("openLoops.all")}</Text>
      </Pressable>
      {lines.map((l) => <WaitingRow key={l.kind} t={t} line={l} nowMs={nowMs} onPress={() => openWaiting(push, l.kind)} />)}
    </View>
  );
}
