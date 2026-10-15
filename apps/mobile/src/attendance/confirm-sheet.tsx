import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { ApiError } from "../api";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, Note, KeyboardModal } from "../ui";
import { attendanceApi, type MyRequest } from "./api";
import { reasonKey } from "./rules";
import { TONE, dateLabel, type T } from "./views";
import type { Call } from "../doctor/api";

/** The request about `date` that matters now: one still open or seen, else the newest. */
export function requestFor(requests: readonly MyRequest[], date: string): MyRequest | null {
  const mine = requests.filter((r) => r.date === date);
  return mine.find((r) => r.status === "open" || r.status === "seen") ?? mine[0] ?? null;
}

/**
 * ═══ "CONFIRM" (board ruling, owner 2026-10-09) ═══
 *
 * A past day with one punch. The sheet says the date and WHY in fixed words, and offers one button:
 * "Request meeting". After it: "Request sent", then "Seen", then "Closed" with the manager's note.
 *
 * NO BLIND RESEND. When the answer to the tap is lost (no network, a timeout), the sheet does not
 * send again by itself: it re-reads the person's own requests, and if the first one landed it shows
 * "Request sent". Only when it did not land does it say so and leave the button for the person.
 */
export function ConfirmSheet({ t, call, date, reason, onClose, onChanged }: {
  t: T; call: Call; date: string; reason: string | null; onClose: () => void; onChanged?: () => void;
}) {
  const [request, setRequest] = useState<MyRequest | null>(null);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reread = useCallback(async (): Promise<MyRequest | null | undefined> => {
    try {
      const found = requestFor((await attendanceApi(call).myRequests()).requests, date);
      setRequest(found); setRead(true);
      return found;
    } catch { setRead(true); return undefined; }
  }, [call, date]);
  useEffect(() => { void reread(); }, [reread]);

  const ask = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const r = await attendanceApi(call).askToMeet(date);
      setRequest(r.request); setRead(true);
      onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === "too_many_open_requests") setError(t("attendance.sheet.tooMany"));
      else if (e instanceof ApiError && e.code === "not_a_confirm_day") { setError(t("attendance.sheet.notNeeded")); onChanged?.(); }
      else {
        // The answer was lost. Did the request land? Ask — do not send again.
        const found = await reread();
        if (found != null && (found.status === "open" || found.status === "seen")) onChanged?.();
        else setError(t("attendance.sheet.failed"));
      }
    } finally { setBusy(false); }
  };

  const active = request !== null && (request.status === "open" || request.status === "seen");
  const closed = request !== null && !active;
  return (
    <KeyboardModal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(19,36,32,.45)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel={t("attendance.sheet.close")} testID="confirm-sheet-scrim" />
        <View testID="confirm-sheet" style={{ backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: space.xl, gap: space.md }}>
          <Text numberOfLines={1} style={[type.tag, { color: color.faint }]}>{t("attendance.sheet.title")}</Text>
          <Text testID="confirm-date" numberOfLines={1} style={[type.heading, { color: color.ink }]}>{dateLabel(t, date)}</Text>
          <View style={{ backgroundColor: color.goldSoft, borderWidth: 1, borderColor: color.goldLine, borderRadius: radius.md, padding: space.md }}>
            <Text testID="confirm-reason" numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: "#8a5a10" }}>{`⚠ ${t(reasonKey(reason ?? ""))}`}</Text>
          </View>
          {request !== null && (
            <View testID="confirm-state" style={{ backgroundColor: color.card, borderWidth: 1, borderColor: active ? TONE.green.line : color.line, borderRadius: radius.md, padding: space.md, gap: 4 }}>
              <Text testID="confirm-state-word" numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: active ? color.green : color.dim }}>{t(`attendance.sheet.${request.status}`)}</Text>
              {closed && request.closeNote !== null && <Text testID="confirm-close-note" style={[type.small, { color: color.ink }]}>{request.closeNote}</Text>}
            </View>
          )}
          {error !== null && <Note tone="warn" testID="confirm-error">{error}</Note>}
          {/* Offered when nothing is waiting: never asked, or the last one was closed and the day still reads Confirm. */}
          {read && !active && <Button testID="confirm-ask" label={t("attendance.sheet.ask")} busy={busy} onPress={() => { void ask(); }} />}
          <Button testID="confirm-close" kind="secondary" label={t("attendance.sheet.close")} onPress={onClose} />
        </View>
      </View>
    </KeyboardModal>
  );
}
