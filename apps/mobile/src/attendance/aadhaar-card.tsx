import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { ApiError } from "../api";
import { Text, TextInput } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, Note } from "../ui";
import { aadhaarTyped, savedNotice, selfRefusal, type SelfIdentity } from "../../../../packages/contracts/src/self-identity";
import type { T } from "./views";
import type { Call } from "../doctor/api";

/**
 * ═══ "ADD YOUR AADHAAR" — THE HOME CARD (owner 2026-10-09) ═══
 *
 * "When the user logs in, a sticker on top of the window/screen will be there till the Aadhar number
 * is input and saved by the user… he/she will start seeing the attendance status in their dashboard/app."
 *
 * The phone's sticker is a card at the very top of the home, drawn while `/me/identity` says
 * `needsAadhaar`. It has no close: it goes when the number is saved. The number exists only in the
 * box while it is typed — never kept, never logged; the server answers masked. The rules and the
 * shape are the web's (`packages/contracts/src/self-identity.ts`, no imports, read by path).
 */
export function selfIdentityApi(call: Call) {
  return {
    get: () => call<SelfIdentity>("GET", "/me/identity"),
    save: (aadhaar: string) => call<SelfIdentity>("POST", "/me/identity", { aadhaar }),
  };
}

/** One read per home refresh, made by the home (`reload`), failing soft: a failed read draws nothing. */
export function useSelfIdentity(call: Call, user: string): { me: SelfIdentity | null; reload: () => Promise<void>; set: (v: SelfIdentity) => void } {
  const [me, setMe] = useState<SelfIdentity | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setMe(null); }, [user]);
  const reload = useCallback(async () => {
    if (user === "") return;
    try {
      const got = await selfIdentityApi(call).get();
      if (alive.current) setMe(got);
    } catch { /* an older server, or no signal: no card */ }
  }, [call, user]);
  return { me, reload, set: setMe };
}

export function AadhaarCard({ t, me, onOpen }: { t: T; me: SelfIdentity | null; onOpen: () => void }) {
  if (me === null || !me.needsAadhaar) return null;
  return (
    <Pressable testID="aadhaar-card" accessibilityRole="button" onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, marginBottom: space.md, padding: space.md, borderRadius: radius.lg,
        borderWidth: 1, borderColor: color.goldLine, backgroundColor: pressed ? color.wash : color.goldSoft })}>
      <Text numberOfLines={2} style={{ flex: 1, fontSize: 14.5, fontWeight: "700", color: "#8a5a10" }}>{t("attendance.aadhaar.card")}</Text>
      <View style={{ minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: color.green, alignItems: "center", justifyContent: "center" }}>
        <Text numberOfLines={1} style={{ color: "#f2faf6", fontSize: 13.5, fontWeight: "700" }}>{t("attendance.aadhaar.button")}</Text>
      </View>
    </Pressable>
  );
}

/** The sheet: one numeric box, Save, and the one-line outcome the home then shows. */
export function AadhaarSheet({ t, call, onClose, onSaved }: { t: T; call: Call; onClose: () => void; onSaved: (next: SelfIdentity, said: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = await selfIdentityApi(call).save(value);
      setValue("");
      onSaved(next, t(`attendance.aadhaar.${savedNotice(next.attendance)}`));
    } catch (e) {
      // A fixed line per refusal code; nothing the server said is shown, and the box keeps what was typed.
      setError(t(`attendance.aadhaar.error.${selfRefusal(e instanceof ApiError ? e.code : null)}`));
    } finally { setBusy(false); }
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(19,36,32,.45)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel={t("attendance.aadhaar.cancel")} testID="aadhaar-sheet-scrim" />
        <View testID="aadhaar-sheet" style={{ backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: space.xl, gap: space.md }}>
          <Text numberOfLines={1} style={[type.heading, { color: color.ink }]}>{t("attendance.aadhaar.title")}</Text>
          <TextInput testID="aadhaar-input" accessibilityLabel={t("attendance.aadhaar.label")} value={value} keyboardType="number-pad" inputMode="numeric"
            autoComplete="off" autoCorrect={false} maxLength={14} placeholder="0000 0000 0000" placeholderTextColor={color.faint}
            onChangeText={(v) => setValue(v.replace(/[^\d\s-]/g, ""))}
            style={{ minHeight: 52, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, paddingHorizontal: space.md, fontSize: 20, letterSpacing: 1, color: color.ink }} />
          <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{t("attendance.aadhaar.hint")}</Text>
          {error !== null && <Note tone="warn" testID="aadhaar-error">{error}</Note>}
          <Button testID="aadhaar-save" label={t("attendance.aadhaar.save")} busy={busy} disabled={!aadhaarTyped(value)} onPress={() => { void save(); }} />
          <Button testID="aadhaar-cancel" kind="secondary" label={t("attendance.aadhaar.cancel")} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
