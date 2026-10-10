import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { NetworkError } from "../api";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { whenText, type ReminderRow } from "./model";

type T = (key: string, vars?: Record<string, string | number>) => string;
type Call = <R>(method: "GET" | "POST", path: string, body?: unknown) => Promise<R>;

/** The person's active reminders, soonest first; `null` until read (or when the server has no such route yet). */
export function useReminders(call: Call, on: boolean): { items: ReminderRow[] | null; failed: "offline" | "refused" | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<ReminderRow[] | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    if (!on) return;
    try {
      const got = await call<{ items: ReminderRow[] }>("GET", "/reminders");
      if (alive.current) { setItems(Array.isArray(got.items) ? got.items : []); setFailed(null); }
    } catch (e) {
      /* offline or an older server: the card offers "+ Reminder" and the screen says why */
      if (alive.current) setFailed(e instanceof NetworkError ? "offline" : "refused");
    }
  }, [call, on]);
  return { items, failed, reload };
}

/**
 * E1.2 — one line on every seat's home, under attendance: the next reminder ("Today 16:00 · see bed
 * 12"), or "+ Reminder" when there is none. Opens the Reminders screen.
 */
export function ReminderCard({ t, items, onOpen, nowMs = Date.now() }: { t: T; items: ReminderRow[] | null; onOpen: () => void; nowMs?: number }) {
  const next = items !== null && items.length > 0 ? items[0]! : null;
  return (
    <Pressable testID="reminders-card" accessibilityRole="button" onPress={onOpen}
      style={({ pressed }) => ({ marginTop: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md, backgroundColor: pressed ? color.wash : color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg })}>
      <Text numberOfLines={1} style={[type.tag, { color: color.faint }]}>{t("reminders.title")}</Text>
      {next === null
        ? <Text testID="reminders-card-add" numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: "600", color: color.green }}>{t("reminders.addShort")}</Text>
        : <Text testID="reminders-card-next" numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: "600", color: color.ink }}>{`${whenText(t, next.dueAt, nowMs)} · ${next.text}`}</Text>}
      {next !== null && items!.length > 1 && <Text testID="reminders-card-more" style={{ fontSize: 12, color: color.faint }}>{`+${String(items!.length - 1)}`}</Text>}
      <Text style={{ color: color.faint, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}
