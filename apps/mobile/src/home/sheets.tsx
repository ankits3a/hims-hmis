import { useState } from "react";
import { Pressable, View } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { biometricReady } from "../session";
import { fineMoneyKey, useBiometricWord } from "../biometric";
import { Text, TextInput } from "../text";
import { color, radius, space, type } from "../theme";
import { Button, MONO, Note, KeyboardModal } from "../ui";
import { clockWords, isMoneyApproval } from "./rules";
import { approvalWho, rupees, type WireApproval } from "./model";
import type { Call } from "../doctor/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

export function clockText(t: T, c: { key: string; span: { hours: number; minutes: number } }): string {
  const span = c.span.hours > 0 ? t("home.clock.hm", { h: c.span.hours, m: c.span.minutes }) : t("home.clock.m", { m: c.span.minutes });
  return t(c.key, { span });
}

/**
 * PROVE IT IS YOU, before a money approval leaves the phone (owner 2026-10-07: "fingerprint before
 * every money approval"). The phone's own fingerprint check first; a phone with none enrolled, or a
 * person who cancels it, types the account password instead and the SERVER checks that. Either way
 * the server is told (`POST /auth/step-up`) and will refuse the decision without it.
 */
export async function stepUp(call: Call, password: string | null): Promise<"ok" | "needPassword" | "wrongPassword" | "offline" | "refused"> {
  try {
    if (password !== null) {
      await call("POST", "/auth/step-up", { method: "password", password });
      return "ok";
    }
    if (!(await biometricReady())) return "needPassword";
    const r = await LocalAuthentication.authenticateAsync({ disableDeviceFallback: true });
    if (!r.success) return "needPassword";
    await call("POST", "/auth/step-up", { method: "biometric" });
    return "ok";
  } catch (e) {
    if (e instanceof NetworkError) return "offline";
    if (e instanceof ApiError && e.code === "step_up_refused") return "wrongPassword";
    return "refused";
  }
}

/**
 * THE APPROVAL, OPENED FROM ITS CARD: what is asked, by whom, how long it has waited, the amount in
 * full, a REQUIRED note, then Approve or Decline. Nothing is sent while offline, and a failed send
 * says nothing was decided — an approval is never queued.
 */
export function ApprovalSheet({ approval, call, online, nowMs, onClose, onDone }: {
  approval: WireApproval; call: Call; online: boolean; nowMs: number; onClose: () => void; onDone: (verdict: "approved" | "declined") => void;
}) {
  const { t } = useI18n();
  const lock = useBiometricWord();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const money = isMoneyApproval(approval.typeKey, approval.amountPaise);
  const since = new Date(approval.requestedAt).getTime();
  const due = approval.dueAt === null ? null : new Date(approval.dueAt).getTime();
  const who = approvalWho(approval);

  async function decide(verb: "approve" | "reject"): Promise<void> {
    if (note.trim() === "") { setError(t("home.sheet.noteNeeded")); return; }
    if (!online) { setError(t("home.offline.noApproval")); return; }
    setBusy(verb); setError(null);
    try {
      if (money) {
        const s = await stepUp(call, askPassword ? password : null);
        if (s === "needPassword") { setAskPassword(true); setBusy(null); return; }
        if (s === "wrongPassword") { setError(t("home.sheet.wrongPassword")); setBusy(null); return; }
        if (s === "offline") { setError(t("home.sheet.notSent")); setBusy(null); return; }
        if (s === "refused") { setError(t("home.sheet.stepUpRefused")); setBusy(null); return; }
      }
      await call("POST", `/approvals/${encodeURIComponent(approval.id)}/${verb}`, { note: note.trim() });
      onDone(verb === "approve" ? "approved" : "declined");
    } catch (e) {
      if (e instanceof NetworkError) setError(t("home.sheet.notSent"));
      else if (e instanceof ApiError && e.code === "step_up_required") { setAskPassword(true); setError(t("home.sheet.stepUpAgain")); }
      else if (e instanceof ApiError && e.status === 409) setError(t("home.sheet.alreadyDecided"));
      else if (e instanceof ApiError && e.status === 403) setError(t("home.sheet.notYours"));
      else setError(t("home.sheet.failed"));
    } finally { setBusy(null); }
  }

  const row = (label: string, value: string, testID?: string) => (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <Text style={[type.small, { color: color.dim, width: 96 }]}>{label}</Text>
      <Text testID={testID} style={[type.small, { color: color.ink, fontWeight: "600", flex: 1 }]}>{value}</Text>
    </View>
  );

  return (
    <KeyboardModal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(12,22,19,.45)" }} onPress={onClose} accessibilityLabel={t("home.sheet.close")} />
      <View testID="approval-sheet" style={{ backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space.lg, gap: space.sm }}>
        <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: color.line, alignSelf: "center" }} />
        <Text style={[type.heading, { color: color.ink }]}>{t(`home.kind.${approval.typeKey}`, { amount: "" }).replace(/\s+·/, " ·").replace(/\s{2,}/g, " ").trim()}</Text>
        {approval.amountPaise !== null && <Text testID="approval-amount" style={{ fontFamily: MONO, fontSize: 26, fontWeight: "700", color: color.ink }}>{rupees(approval.amountPaise, true)}</Text>}
        {who !== null && row(t("home.sheet.patient"), who)}
        {approval.requesterName !== null && row(t("home.sheet.askedBy"), approval.requesterName)}
        {approval.requestNote !== null && approval.requestNote !== "" && row(t("home.sheet.reason"), approval.requestNote)}
        {row(t("home.sheet.waiting"), clockText(t, clockWords(nowMs, since, due)), "approval-clock")}
        <TextInput testID="approval-note" value={note} onChangeText={setNote} placeholder={t("home.sheet.notePlaceholder")} placeholderTextColor={color.faint}
          accessibilityLabel={t("home.sheet.note")} multiline
          style={{ borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, minHeight: 64, color: color.ink, backgroundColor: color.paper, fontSize: 15 }} />
        {askPassword && (
          <TextInput testID="approval-password" value={password} onChangeText={setPassword} secureTextEntry placeholder={t("home.sheet.password")} placeholderTextColor={color.faint}
            accessibilityLabel={t("home.sheet.password")} autoCapitalize="none"
            style={{ borderWidth: 1, borderColor: color.goldLine, borderRadius: radius.md, padding: space.md, color: color.ink, backgroundColor: color.paper, fontSize: 15 }} />
        )}
        {error !== null && <Note tone="bad" testID="approval-error">{error}</Note>}
        {!online && <Note tone="warn" testID="approval-offline">{t("home.offline.noApproval")}</Note>}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}><Button testID="approval-decline" kind="secondary" label={t("home.sheet.decline")} busy={busy === "reject"} disabled={busy !== null || !online} onPress={() => { void decide("reject"); }} /></View>
          <View style={{ flex: 1.6 }}><Button testID="approval-approve" label={t("home.sheet.approve")} busy={busy === "approve"} disabled={busy !== null || !online} onPress={() => { void decide("approve"); }} /></View>
        </View>
        <Text testID="approval-fine" style={[type.small, { color: color.faint }]}>{money ? t(fineMoneyKey(lock)) : t("home.sheet.fine")}</Text>
      </View>
    </KeyboardModal>
  );
}

/**
 * "NO" TO A COVER REQUEST CARRIES A REASON (app home round 2, decision 0043): the colleague who
 * asked reads it. "Yes" may carry a word too, and needs none. Nothing is sent offline or queued.
 */
export function CoverSheet({ who, accept, online, busy, error, onClose, onSend }: {
  who: string; accept: boolean; online: boolean; busy: boolean; error: string | null; onClose: () => void; onSend: (note: string) => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [need, setNeed] = useState(false);
  const send = (): void => {
    if (!accept && note.trim().length < 3) { setNeed(true); return; }
    onSend(note);
  };
  return (
    <KeyboardModal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(12,22,19,.45)" }} onPress={onClose} accessibilityLabel={t("home.sheet.close")} />
      <View testID="cover-sheet" style={{ backgroundColor: color.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: space.lg, gap: space.sm }}>
        <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: color.line, alignSelf: "center" }} />
        <Text style={[type.heading, { color: color.ink }]}>{t(accept ? "home.coverSheet.yesTitle" : "home.coverSheet.noTitle", { name: who })}</Text>
        <TextInput testID="cover-note" value={note} onChangeText={(v) => { setNote(v); setNeed(false); }} multiline maxLength={500}
          placeholder={t(accept ? "home.coverSheet.yesPlaceholder" : "home.coverSheet.noPlaceholder")} placeholderTextColor={color.faint}
          accessibilityLabel={t(accept ? "home.coverSheet.yesPlaceholder" : "home.coverSheet.noPlaceholder")}
          style={{ borderWidth: 1, borderColor: need ? color.red : color.line, borderRadius: radius.md, padding: space.md, minHeight: 64, color: color.ink, backgroundColor: color.paper, fontSize: 15 }} />
        {need && <Note tone="bad" testID="cover-note-needed">{t("home.coverSheet.noteNeeded")}</Note>}
        {error !== null && <Note tone="bad" testID="cover-error">{error}</Note>}
        {!online && <Note tone="warn" testID="cover-offline">{t("home.offline.noApproval")}</Note>}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}><Button testID="cover-cancel" kind="secondary" label={t("home.coverSheet.cancel")} disabled={busy} onPress={onClose} /></View>
          <View style={{ flex: 1.6 }}><Button testID="cover-send" label={t(accept ? "home.coverSheet.sendYes" : "home.coverSheet.sendNo")} busy={busy} disabled={busy || !online} onPress={send} /></View>
        </View>
        <Text style={[type.small, { color: color.faint }]}>{t("home.coverSheet.fine")}</Text>
      </View>
    </KeyboardModal>
  );
}
