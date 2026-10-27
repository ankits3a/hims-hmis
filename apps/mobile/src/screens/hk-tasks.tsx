import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useI18n } from "../i18n";
import { HK_WORKED_KINDS, hkApi, hkRefusal, tokenFromScan, type HkTaskCard, type HkWorkForm } from "../housekeeping/api";
import { Done, ls, RowCard, Screen, usePoll } from "../lab/ui";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Note } from "../ui";
import { Scanner } from "../vitals/scanner";

/**
 * HOUSEKEEPING ON THE STAFF APP — THE ATTENDANT (spec #974 D6; HK-1's "Staff phone · Checklist" on the web). My
 * housekeeping tasks and my floor's pool, as the task engine lists them. Open one, Start (accept and start), then at the
 * place: scan the door QR, answer every checklist item Yes or No, take one photo when the place needs it (a bed or a
 * toilet — never a patient), and Done. Done stays off until all of it is there; the server refuses anything missing.
 */
export function HkTasks() {
  const { t } = useI18n();
  const { call } = useSession();
  const api = useMemo(() => hkApi(call), [call]);
  const list = usePoll(api.mine);
  const [openId, setOpenId] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const cards = [...(list.data?.mine ?? []), ...(list.data?.pool ?? [])].filter((c) => HK_WORKED_KINDS.has(c.kind));
  const open = cards.find((c) => c.id === openId) ?? null;
  const listError = list.error !== null && list.data === null ? hkRefusal(list.error) ?? t("hkPhone.failed") : null;

  return (
    <Screen title={t("screen.hkWork.title")} onBack={open !== null ? () => setOpenId(null) : undefined}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled" testID="hk-tasks">
        {listError !== null && <Note tone="bad">{listError}</Note>}
        {finished !== null && <Done testID="hk-finished" text={t("hkPhone.finished", { place: finished })} />}
        {open !== null ? (
          <Work key={open.id} card={open} api={api} onRefresh={list.refresh}
            onFinished={() => { setFinished(open.placeName ?? open.label); setOpenId(null); void list.refresh(); }} />
        ) : (
          <>
            {cards.map((c) => (
              <RowCard key={c.id} testID={`hk-task-${c.id}`} label={c.placeName ?? c.label} onPress={() => { setFinished(null); setOpenId(c.id); }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={ls.name} numberOfLines={1}>{c.placeName ?? "—"}</Text>
                  <Text style={ls.sub} numberOfLines={1}>{`${c.label}${c.floorName === null ? "" : ` · ${c.floorName}`}`}</Text>
                </View>
              </RowCard>
            ))}
            {list.data !== null && cards.length === 0 && <Text testID="hk-empty" style={ls.empty}>{t("hkPhone.empty")}</Text>}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Work({ card, api, onFinished, onRefresh }: {
  card: HkTaskCard; api: ReturnType<typeof hkApi>; onFinished: () => void; onRefresh: () => Promise<unknown> | void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState(card.state);
  const [form, setForm] = useState<HkWorkForm | null>(null);
  const [scan, setScan] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = state === "in_progress";

  const fail = (e: unknown): void => { setError(hkRefusal(e) ?? t("hkPhone.failed")); };
  const loadForm = async (): Promise<void> => { setForm(await api.form(card.id)); };
  const start = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (state === "created" || state === "assigned") setState((await api.accept(card.id)).state);
      setState((await api.start(card.id)).state);
      await loadForm();
      void onRefresh();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  // A task already in progress (opened again) loads its checklist at once.
  useEffect(() => {
    if (card.state === "in_progress") void api.form(card.id).then(setForm, (e: unknown) => setError(hkRefusal(e) ?? t("hkPhone.failed")));
  }, [api, card.id, card.state, t]);

  const takePhoto = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setError(t("hkPhone.cameraDenied")); return; }
      const shot = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5 });
      const asset = shot.canceled ? undefined : shot.assets[0];
      if (asset?.base64 == null) return;
      setPhotoKey((await api.photo(card.id, asset.mimeType ?? "image/jpeg", asset.base64)).photoKey);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const items = form?.items ?? [];
  const left = items.filter((i) => answers[i.id] === undefined).length;
  const photoLeft = form?.photoNeeded === true && photoKey === null;
  const ready = form !== null && (!form.needsWork || (scan !== "" && left === 0 && !photoLeft));
  const finish = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await api.finish(card.id, scan, items.map((i) => ({ itemId: i.id, ok: answers[i.id]! })), photoKey ?? undefined);
      onFinished();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const doneLabel = left > 0 ? t("hkPhone.itemsLeft", { n: left }) : photoLeft ? t("hkPhone.photoLeft") : scan === "" ? t("hkPhone.scanLeft") : t("hkPhone.done");

  return (
    <View style={ls.card} testID="hk-work">
      <Text style={ls.name}>{card.placeName ?? card.label}</Text>
      <Text style={ls.sub}>{`${card.label}${card.floorName === null ? "" : ` · ${card.floorName}`}`}</Text>
      {card.note !== null && <Note tone="info">{card.note}</Note>}
      {error !== null && <Note tone="bad" testID="hk-error">{error}</Note>}
      {!working ? (
        <Button testID="hk-start" label={t("hkPhone.start")} busy={busy} onPress={() => { void start(); }} />
      ) : (
        <>
          {form?.lastReason != null && <Note tone="warn">{t("hkPhone.rework", { reason: form.lastReason })}</Note>}
          {form?.needsWork === true && (
            <>
              {scan === "" ? (
                <Button testID="hk-scan" kind="secondary" label={t("hkPhone.scan")} onPress={() => setScanOpen(true)} />
              ) : (
                <Text testID="hk-scanned" style={{ color: color.green, fontWeight: "700" }}>{`✓ ${t("hkPhone.scanned")}`}</Text>
              )}
              {items.length > 0 && <Text style={ls.cap}>{t("hkPhone.progress", { done: items.length - left, total: items.length })}</Text>}
              {items.map((i) => (
                <View key={i.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text style={{ flex: 1, fontSize: 15, color: color.ink }}>{i.text}</Text>
                  <YesNo testID={`hk-yes-${i.id}`} on={answers[i.id] === true} label="✓" a11y={t("hkPhone.yes", { item: i.text })} onPress={() => setAnswers((a) => ({ ...a, [i.id]: true }))} />
                  <YesNo testID={`hk-no-${i.id}`} on={answers[i.id] === false} label="✕" a11y={t("hkPhone.no", { item: i.text })} onPress={() => setAnswers((a) => ({ ...a, [i.id]: false }))} />
                </View>
              ))}
              {form.photoNeeded && (photoKey === null
                ? <Button testID="hk-photo" kind="secondary" label={t("hkPhone.photo")} busy={busy} onPress={() => { void takePhoto(); }} />
                : <Text testID="hk-photo-taken" style={{ color: color.green, fontWeight: "700" }}>{`✓ ${t("hkPhone.photoTaken")}`}</Text>)}
              {form.photoNeeded && <Text style={ls.sub}>{t("hkPhone.noPatient")}</Text>}
            </>
          )}
          <Button testID="hk-done" label={doneLabel} busy={busy} disabled={!ready} onPress={() => { void finish(); }} />
        </>
      )}
      <Scanner open={scanOpen} onClose={() => setScanOpen(false)} onRead={(data) => { setScanOpen(false); setScan(tokenFromScan(data)); }} />
    </View>
  );
}

export function YesNo({ testID, on, label, a11y, onPress }: { testID: string; on: boolean; label: string; a11y: string; onPress: () => void }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: on }} onPress={onPress}
      style={{ width: TOUCH, height: TOUCH, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: on ? color.green : color.line, backgroundColor: on ? color.greenSoft : color.card }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: on ? color.green : color.dim }}>{label}</Text>
    </Pressable>
  );
}
