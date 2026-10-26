import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { HK_FAIL_REASONS, hkApi, hkRefusal, type HkProof, type HkToCheck } from "../housekeeping/api";
import { Done, istTime, ls, RowCard, Screen, usePoll } from "../lab/ui";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space } from "../theme";
import { Button, Note } from "../ui";

/**
 * HOUSEKEEPING ON THE STAFF APP — THE CHECK (spec #974 D6; HK-1's "Nurse / supervisor · Confirm" on the web). What
 * waits for a Pass or Fail, oldest first. Open one: the photo, the checklist (any item answered No in red), who did it
 * and for which company, then Fail (a reason is required) or Pass. The server refuses the person who did any round of
 * the work and, for a terminal clean, anyone but the supervisor or infection control; its words are shown as they come.
 */
export function HkCheck() {
  const { t } = useI18n();
  const { call } = useSession();
  const api = useMemo(() => hkApi(call), [call]);
  const list = usePoll(api.toCheck);
  const [open, setOpen] = useState<HkToCheck | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const rows = list.data ?? [];
  const listError = list.error !== null && list.data === null ? hkRefusal(list.error) ?? t("hkPhone.failed") : null;

  return (
    <Screen title={t("screen.hkCheck.title")} onBack={open !== null ? () => setOpen(null) : undefined}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="hk-check">
        {listError !== null && <Note tone="bad">{listError}</Note>}
        {confirmed !== null && <Done testID="hk-confirmed" text={confirmed} />}
        {open !== null ? (
          <Confirm key={open.taskId} item={open} api={api} onDone={(msg) => { setConfirmed(msg); setOpen(null); void list.refresh(); }} />
        ) : (
          <>
            {rows.map((r) => (
              <RowCard key={r.taskId} testID={`hk-check-${r.taskId}`} label={r.placeName ?? r.kindLabel} onPress={() => { setConfirmed(null); setOpen(r); }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={ls.name} numberOfLines={1}>{r.placeName ?? "—"}</Text>
                  <Text style={ls.sub} numberOfLines={1}>
                    {`${r.kindLabel}${r.doneAt === null ? "" : ` · ${istTime(r.doneAt)}`}${r.fails > 0 ? ` · ${t("hkPhone.failedTimes", { n: r.fails })}` : ""}`}
                  </Text>
                </View>
                {r.terminal && <Text style={ls.chipRed}>{t("hkPhone.terminal")}</Text>}
              </RowCard>
            ))}
            {list.data !== null && rows.length === 0 && <Text testID="hk-check-empty" style={ls.empty}>{t("hkPhone.nothingToCheck")}</Text>}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Confirm({ item, api, onDone }: { item: HkToCheck; api: ReturnType<typeof hkApi>; onDone: (msg: string) => void }) {
  const { t } = useI18n();
  const [proof, setProof] = useState<HkProof | null | undefined>(undefined);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState(false);
  useEffect(() => {
    void api.proof(item.taskId).then((r) => setProof(r.proof), (e: unknown) => setError(hkRefusal(e) ?? t("hkPhone.failed")));
  }, [api, item.taskId, t]);

  const send = async (result: "pass" | "fail"): Promise<void> => {
    if (result === "fail" && reason === null) { setNeedReason(true); return; }
    setBusy(true); setError(null);
    try {
      await api.confirm(item.taskId, result, result === "fail" ? reason! : undefined);
      onDone(result === "pass" ? t("hkPhone.passed") : t("hkPhone.failedSent"));
    } catch (e) { setError(hkRefusal(e) ?? t("hkPhone.failed")); } finally { setBusy(false); }
  };
  const noItems = proof?.answers.filter((a) => !a.ok) ?? [];

  return (
    <View style={ls.card} testID="hk-confirm">
      <Text style={ls.name}>{item.placeName ?? item.kindLabel}</Text>
      <Text style={ls.sub}>{item.kindLabel}</Text>
      {proof != null && <Text style={ls.sub}>{t("hkPhone.by", { who: proof.doneByName, company: proof.company, at: istTime(proof.scannedAt) })}</Text>}
      {proof?.photo != null && (
        <Image testID="hk-proof-photo" accessibilityLabel={t("hkPhone.photoAlt")} source={{ uri: `data:${proof.photo.mimeType};base64,${proof.photo.imageBase64}` }}
          style={{ height: 200, borderRadius: radius.md, backgroundColor: color.wash }} resizeMode="cover" />
      )}
      {proof != null && proof.answers.length > 0 && (
        <Text style={{ fontWeight: "700", color: color.ink }}>{t("hkPhone.checklist", { ok: proof.answers.length - noItems.length, total: proof.answers.length })}</Text>
      )}
      {noItems.map((a) => <Text key={a.text} style={{ color: color.red }}>{`✕ ${a.text}`}</Text>)}
      {proof === null && <Note tone="info">{t("hkPhone.noProof")}</Note>}
      {proof != null && proof.fails > 0 && <Note tone="warn">{t("hkPhone.failedBefore", { n: proof.fails, reason: proof.lastReason ?? "" })}</Note>}
      <Text style={ls.cap}>{t("hkPhone.why")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {HK_FAIL_REASONS.map((r) => (
          <Pressable key={r} testID={`hk-reason-${r.replace(/\s+/g, "_").toLowerCase()}`} accessibilityRole="button" accessibilityState={{ selected: reason === r }}
            onPress={() => { setReason(r); setNeedReason(false); }}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: reason === r ? color.red : color.line, backgroundColor: reason === r ? color.redSoft : color.card }}>
            <Text style={{ color: reason === r ? color.red : color.ink }}>{t(`hkPhone.reason.${r.replace(/\s+/g, "_").toLowerCase()}`)}</Text>
          </Pressable>
        ))}
      </View>
      {needReason && <Note tone="warn" testID="hk-need-reason">{t("hkPhone.needReason")}</Note>}
      {error !== null && <Note tone="bad" testID="hk-error">{error}</Note>}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }}><Button testID="hk-fail" kind="secondary" label={t("hkPhone.fail")} busy={busy} onPress={() => { void send("fail"); }} /></View>
        <View style={{ flex: 1 }}><Button testID="hk-pass" label={t("hkPhone.pass")} busy={busy} onPress={() => { void send("pass"); }} /></View>
      </View>
    </View>
  );
}
