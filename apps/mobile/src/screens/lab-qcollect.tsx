import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { labRefusal, quickLabApi, type QuickCollectRow, type QuickRow } from "../lab/api";
import { Done, ls, minutesSince, Person, RowCard, Screen, TestChips, usePoll } from "../lab/ui";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO, Note, ScanMark } from "../ui";
import { Scanner } from "../vitals/scanner";

/**
 * QUICK COLLECT ON THE PHONE (spec 2026-10-12; the web's /lab/qcollect). Who waits for a blood
 * sample, oldest first, as the server orders them. Tap a patient, see their tests, press **Blood
 * collected**: the server stamps the sample number and the patient moves to the bench. A typed UHID
 * or a scanned card opens that patient; a card is verified by the server before it is trusted.
 */
export function QuickCollect() {
  const { t } = useI18n();
  const { call } = useSession();
  const api = useMemo(() => quickLabApi(call), [call]);
  const queue = usePoll(api.collectQueue);
  const rows = queue.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<QuickRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const open = rows.find((r) => r.orderId === openId) ?? null;

  const openPatient = (match: (r: QuickCollectRow) => boolean): void => {
    const hit = rows.find(match);
    if (hit === undefined) { setNote(t("quickLab.collect.notWaiting")); return; }
    setNote(null); setDone(null); setError(null); setOpenId(hit.orderId); setFind("");
  };

  const identify = async (raw: string): Promise<void> => {
    const q = raw.trim();
    if (q === "") return;
    if (/^q1\./.test(q)) {
      try {
        const v = await api.verifyQr(q);
        if (!v.ok) { setNote(t("quickLab.collect.badCard")); return; }
        openPatient((r) => r.patient.id === v.patient.id);
      } catch (e) { setError(labRefusal(e, t)); }
      return;
    }
    const up = q.toUpperCase();
    openPatient((r) => r.patient.uhid.toUpperCase() === up || r.orderNo.toUpperCase() === up || r.encounterNo.toUpperCase() === up);
  };

  const collect = async (r: QuickCollectRow): Promise<void> => {
    setBusy(true);
    try {
      const out = await api.collect(r.orderId);
      setDone(out); setOpenId(null); setError(null);
      await queue.refresh();
    } catch (e) { setError(labRefusal(e, t)); }
    finally { setBusy(false); }
  };

  const listError = queue.error !== null && queue.data === null ? labRefusal(queue.error, t) : null;

  return (
    <Screen title={t("screen.qcollect.title")} onBack={open !== null ? () => setOpenId(null) : undefined}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled" testID="qcollect">
        {(error ?? listError) !== null && <Note tone="bad" testID="ql-error">{error ?? listError}</Note>}
        {note !== null && <Note tone="warn" testID="ql-note">{note}</Note>}
        {done !== null && <Done testID="qc-done" text={t("quickLab.collect.done", { name: done.patient.display, sample: done.sampleNo ?? "" })} />}
        {open !== null ? (
          <View testID="qc-open" style={ls.card}>
            <Person p={open.patient} t={t} sub={`${open.orderNo} · ${t("quickLab.collect.waiting", { minutes: minutesSince(open.placedAt) })}`} />
            {open.priority !== "routine" && <Text style={[ls.chipRed, { alignSelf: "flex-start" }]}>{open.priority.toUpperCase()}</Text>}
            <View testID="qc-tests" style={{ gap: 4 }}>
              {open.tests.map((x) => (
                <Text key={x.serviceId} style={{ fontSize: 15, color: color.ink }} numberOfLines={1}>
                  <Text style={{ fontFamily: MONO, fontWeight: "700", color: color.green }}>{x.code}</Text>  {x.nameEn}
                </Text>
              ))}
            </View>
            <Button testID="qc-collect" label={`✓ ${t("quickLab.collect.collected")}`} busy={busy} onPress={() => { void collect(open); }} />
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <TextInput testID="qc-find" value={find} onChangeText={setFind} placeholder={t("quickLab.collect.find")} placeholderTextColor={color.faint}
                autoCapitalize="characters" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => { void identify(find); }}
                style={{ flex: 1, minHeight: TOUCH, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 12, fontFamily: MONO, fontSize: 15, color: color.ink }} />
              <Pressable testID="qc-scan" accessibilityRole="button" accessibilityLabel={t("quickLab.collect.scan")} onPress={() => setScanOpen(true)}
                style={{ width: TOUCH, height: TOUCH, borderRadius: radius.md, backgroundColor: color.agent, alignItems: "center", justifyContent: "center" }}>
                <ScanMark />
              </Pressable>
            </View>
            <Text style={ls.cap}>{t("quickLab.collect.waitingCount", { n: rows.length })}</Text>
            {rows.map((r) => (
              <RowCard key={r.orderId} testID={`qc-row-${r.orderId}`} label={r.patient.display}
                onPress={() => { setOpenId(r.orderId); setDone(null); setNote(null); setError(null); }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Person p={r.patient} t={t} sub={t("quickLab.collect.waiting", { minutes: minutesSince(r.placedAt) })} />
                  <TestChips tests={r.tests} extra={r.priority !== "routine" ? <Text style={ls.chipRed}>{r.priority.toUpperCase()}</Text> : undefined} />
                </View>
              </RowCard>
            ))}
            {queue.data !== null && rows.length === 0 && <Text testID="qc-empty" style={ls.empty}>{t("quickLab.collect.empty")}</Text>}
          </>
        )}
      </ScrollView>
      <Scanner open={scanOpen} onClose={() => setScanOpen(false)} onRead={(data) => { setScanOpen(false); void identify(data); }} />
    </Screen>
  );
}
