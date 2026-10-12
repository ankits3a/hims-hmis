import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, Field, KeyboardScrollView, Note } from "../ui";
import { rosterRefusal } from "../roster/api";

/**
 * E2.2 (decision 0069) — MY LEAVE on the phone: the web's `screens/my-leave.tsx`, same routes, same
 * words. Ask (kind, first day, how many days, an optional reason), see each request and why a refused
 * one was refused, take one back; a department head also sees TO DECIDE — Approve, or Refuse with a
 * reason the person reads. Few words per line, one line at 390 px (owner 2026-10-09).
 */
export const SELF_LEAVE_KINDS = ["CL", "EL", "ML", "comp_off"] as const;
type Kind = (typeof SELF_LEAVE_KINDS)[number];
type Status = "requested" | "approved" | "rejected" | "cancelled";
export type WireMyLeave = {
  id: string; kind: string; from: string; to: string; days: number; status: Status;
  reason: string | null; refusal: string | null; decidedBy: string | null; decidedAt: string | null; canCancel: boolean;
};
export type WireLeaveToDecide = {
  id: string; userId: string; name: string; department: string | null;
  kind: string; from: string; to: string; days: number; reason: string | null; requestedAt: string;
};
const DAY_CHOICES = [1, 2, 3, 4, 5, 7] as const;
const enc = encodeURIComponent;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string): string => `${String(Number(d.slice(8, 10)))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""}`;
const istToday = (nowMs: number): string => new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "12 Nov" → the next 12 Nov on or after today (IST). Accepts "12/11", "12-11", "12 11". Null when it is not a day. */
export function dayFromTyped(typed: string, nowMs: number): string | null {
  const m = /^\s*(\d{1,2})\s*[/\-. ]\s*(\d{1,2})\s*$/.exec(typed);
  if (m === null) return null;
  const today = istToday(nowMs);
  const [dd, mm] = [Number(m[1]), Number(m[2])];
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const d = `${String(year)}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) return null;
    if (d >= today) return d;
  }
  return null;
}

export function MyLeaveScreen({ nowMs = Date.now }: { nowMs?: () => number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const [mine, setMine] = useState<WireMyLeave[] | null>(null);
  const [toDecide, setToDecide] = useState<WireLeaveToDecide[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = useMemo(() => istToday(nowMs()), [nowMs]);
  const [kind, setKind] = useState<Kind>("CL");
  const [fromTyped, setFromTyped] = useState("");
  const [days, setDays] = useState<number>(1);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setMine(await call<WireMyLeave[]>("GET", "/roster/leave/mine"));
      setToDecide(await call<WireLeaveToDecide[]>("GET", "/roster/leave/to-decide"));
    } catch (e) { setProblem(rosterRefusal(e, t)); }
  }, [call, t]);
  useEffect(() => { void load(); }, [load]);

  const act = async (f: () => Promise<unknown>, ok: string | null): Promise<void> => {
    setBusy(true); setProblem(null); setSaid(null);
    try { await f(); if (ok !== null) setSaid(ok); await load(); }
    catch (e) { setProblem(e instanceof NetworkError || e instanceof ApiError ? rosterRefusal(e, t) : t("roster.refusal.network")); }
    finally { setBusy(false); }
  };
  const send = (): void => {
    const from = fromTyped.trim() === "" ? today : dayFromTyped(fromTyped, nowMs());
    if (from === null) { setProblem(t("myLeave.badDay")); return; }
    void act(() => call("POST", "/roster/leave", { kind, from, to: addDays(from, days - 1), ...(reason.trim() === "" ? {} : { reason: reason.trim() }) }), t("myLeave.sent"))
      .then(() => { setReason(""); setFromTyped(""); });
  };
  const span = (l: { from: string; to: string; days: number }): string =>
    l.from === l.to ? short(l.from) : t("myLeave.span", { from: short(l.from), to: short(l.to), count: l.days });
  const chip = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable key={key} testID={key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ minHeight: 40, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: on ? 2 : 1, borderColor: on ? color.ink : color.line, backgroundColor: on ? color.wash : color.card }}>
      <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "700", color: on ? color.ink : color.dim }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("myLeave.back")} onPress={() => router.back()} testID="my-leave-back" />} />
      <KeyboardScrollView testID="my-leave" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t("myLeave.title")}</Text>
        {problem !== null && <Note tone="bad" testID="my-leave-problem">{problem}</Note>}
        {said !== null && <Note tone="info" testID="my-leave-said">{said}</Note>}

        {toDecide.length > 0 && (
          <View testID="leave-to-decide" style={{ gap: space.sm }}>
            <Text style={[type.tag, { color: color.faint }]} numberOfLines={1}>{t("myLeave.toDecide")}</Text>
            {toDecide.map((r) => <DecideRow key={r.id} r={r} span={span(r)} busy={busy}
              onDecide={(approve, note) => act(() => call("POST", `/roster/leave/${enc(r.id)}/decide`, approve ? { approve } : { approve, note }), null)} />)}
          </View>
        )}

        <Text style={[type.tag, { color: color.faint }]} numberOfLines={1}>{t("myLeave.mine")}</Text>
        {mine !== null && mine.length === 0 && <Text testID="my-leave-none" style={[type.small, { color: color.dim }]} numberOfLines={1}>{t("myLeave.none")}</Text>}
        {(mine ?? []).map((l) => (
          <View key={l.id} testID={`my-leave-${l.id}`} style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: "700", color: color.ink }}>{`${t(`myLeave.kind.${l.kind}`)} · ${span(l)}`}</Text>
              <Text testID={`my-leave-${l.id}-status`} numberOfLines={1} style={{ fontSize: 13, fontWeight: "700", color: l.status === "approved" ? color.green : l.status === "rejected" ? color.red : color.dim }}>{t(`myLeave.status.${l.status}`)}</Text>
            </View>
            {l.refusal !== null && <Text testID={`my-leave-${l.id}-refusal`} numberOfLines={3} style={[type.small, { color: color.ink }]}>{t("myLeave.refusedBecause", { who: l.decidedBy ?? "", why: l.refusal })}</Text>}
            {l.canCancel && <Button kind="secondary" label={t("myLeave.cancel")} disabled={busy} testID={`my-leave-${l.id}-cancel`}
              onPress={() => { void act(() => call("POST", `/roster/leave/${enc(l.id)}/cancel`), null); }} />}
          </View>
        ))}

        <View style={{ borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.md }}>
          <Text style={[type.tag, { color: color.faint, marginBottom: space.sm }]} numberOfLines={1}>{t("myLeave.ask")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
            {SELF_LEAVE_KINDS.map((k) => chip(`leave-kind-${k}`, t(`myLeave.kind.${k}`), k === kind, () => setKind(k)))}
          </View>
          <Field label={t("myLeave.from")} value={fromTyped} onChangeText={(v) => { setFromTyped(v); setProblem(null); }} placeholder={t("myLeave.fromHint")} keyboardType="numbers-and-punctuation" maxLength={8} testID="leave-from" />
          <Text style={[type.small, { color: color.faint, marginBottom: space.sm }]} numberOfLines={1}>{t("myLeave.daysLabel")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md }}>
            {DAY_CHOICES.map((n) => chip(`leave-days-${String(n)}`, String(n), n === days, () => setDays(n)))}
          </View>
          <Field label={t("myLeave.reason")} value={reason} onChangeText={setReason} maxLength={500} testID="leave-reason" />
          <Text style={[type.small, { color: color.faint, marginTop: -space.md, marginBottom: space.md }]} numberOfLines={1}>{t("myLeave.reasonHint")}</Text>
          <Button label={t("myLeave.send")} onPress={send} busy={busy} testID="leave-send" />
        </View>
      </KeyboardScrollView>
    </View>
  );
}

function DecideRow({ r, span, busy, onDecide }: { r: WireLeaveToDecide; span: string; busy: boolean; onDecide: (approve: boolean, note?: string) => Promise<void> }) {
  const { t } = useI18n();
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <View testID={`decide-${r.id}`} style={{ backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 6 }}>
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{r.name}</Text>
      <Text numberOfLines={1} style={[type.small, { color: color.dim }]}>{`${t(`myLeave.kind.${r.kind}`)} · ${span}`}</Text>
      {r.reason !== null && <Text numberOfLines={3} style={[type.small, { color: color.ink }]}>{t("myLeave.theirReason", { why: r.reason })}</Text>}
      {!refusing ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button label={t("myLeave.approve")} disabled={busy} testID={`decide-${r.id}-approve`} onPress={() => { void onDecide(true); }} />
          <Button kind="secondary" label={t("myLeave.refuse")} disabled={busy} testID={`decide-${r.id}-refuse`} onPress={() => setRefusing(true)} />
        </View>
      ) : (
        <>
          <Field label={t("myLeave.refuseWhy")} value={note} onChangeText={setNote} maxLength={280} testID={`decide-${r.id}-note`} />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button label={t("myLeave.refuseSend")} disabled={busy || note.trim() === ""} testID={`decide-${r.id}-refuse-send`} onPress={() => { void onDecide(false, note.trim()); }} />
            <Button kind="secondary" label={t("myLeave.back")} onPress={() => { setRefusing(false); setNote(""); }} />
          </View>
        </>
      )}
    </View>
  );
}
