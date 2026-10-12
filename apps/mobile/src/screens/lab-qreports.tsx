import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { labRefusal, quickLabApi, refText, type QuickLabApi, type QuickReport } from "../lab/api";
import { Done, istTime, ls, Person, RowCard, Screen, TestChips, usePoll, type T } from "../lab/ui";
import { useSession } from "../session";
import { Text } from "../text";
import { color, space } from "../theme";
import { Button, MONO, Note } from "../ui";

/**
 * QUICK REPORTS ON THE PHONE (spec 2026-10-12; the web's /lab/qreports). Completed reports; open one
 * for a read-only preview. **Hand over** marks it handed over — the same POST the web sends after
 * printing; the phone does not print (that stays on the desk PC or the HMIS Print program). **Send
 * back to bench** returns it as a draft, and is offered only to a holder of the results grant (the
 * route's own guard). No signing, no bill.
 */
export function QuickReports() {
  const { t } = useI18n();
  const { state, call } = useSession();
  const api = useMemo(() => quickLabApi(call), [call]);
  const desk = usePoll(api.ready, 30_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const mayEnter = state.status === "signedIn" && state.me.permissions.hospital.includes("lab.results.enter");
  const ready = desk.data?.ready ?? [];
  const handed = desk.data?.handedOverToday ?? [];
  const listError = desk.error !== null && desk.data === null ? labRefusal(desk.error, t) : null;

  if (openId !== null) {
    return (
      <Screen title={t("screen.qreports.title")} onBack={() => setOpenId(null)}>
        <ReportView key={openId} id={openId} api={api} t={t} mayEnter={mayEnter}
          onDone={(text) => { setOpenId(null); setSaid(text); void desk.refresh(); }} />
      </Screen>
    );
  }
  return (
    <Screen title={t("screen.qreports.title")}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="qreports">
        {listError !== null && <Note tone="bad" testID="ql-error">{listError}</Note>}
        {said !== null && <Done testID="qr-done" text={said} />}
        <Text style={ls.cap}>{t("quickLab.reports.count", { n: ready.length })}</Text>
        {ready.map((r) => (
          <RowCard key={r.id} testID={`qr-row-${r.id}`} label={r.patient.display} onPress={() => { setOpenId(r.id); setSaid(null); }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Person p={r.patient} t={t} sub={[r.sampleNo ?? null, r.reportedAt === null ? null : t("quickLab.reports.completedAt", { at: istTime(r.reportedAt) })].filter((x) => x !== null).join(" · ")} />
              <TestChips tests={r.tests} />
            </View>
          </RowCard>
        ))}
        {desk.data !== null && ready.length === 0 && <Text testID="qr-empty" style={ls.empty}>{t("quickLab.reports.empty")}</Text>}
        {handed.length > 0 && (
          <View style={ls.card} testID="qr-handed">
            <Text style={ls.cap}>{t("quickLab.reports.handedToday", { n: handed.length })}</Text>
            {handed.map((r) => <Text key={r.id} style={{ fontSize: 14, color: color.dim }} numberOfLines={1}>{r.patient.display}{r.handedOverAt ? ` · ${istTime(r.handedOverAt)}` : ""}</Text>)}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const FLAG_FG: Record<string, string> = { L: "#8a5a10", H: "#8a5a10", LL: color.red, HH: color.red };

function ReportView({ id, api, t, mayEnter, onDone }: { id: string; api: QuickLabApi; t: T; mayEnter: boolean; onDone: (said: string) => void }) {
  const one = usePoll(() => api.readyReport(id), 60_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r: QuickReport | null = one.data;
  if (r === null) {
    return <View style={{ padding: space.lg }}>{one.error !== null ? <Note tone="bad" testID="ql-error">{labRefusal(one.error, t)}</Note> : <Text style={ls.sub}>{t("quickLab.loading")}</Text>}</View>;
  }
  const act = async (what: "handOver" | "sendBack"): Promise<void> => {
    setBusy(true);
    try {
      const row = what === "handOver" ? await api.handOver(r.id) : await api.sendBack(r.id);
      onDone(t(what === "handOver" ? "quickLab.reports.handedOver" : "quickLab.reports.sentBack", { name: row.patient.display }));
    } catch (e) { setError(labRefusal(e, t)); }
    finally { setBusy(false); }
  };
  const byId = new Map(r.lines.map((l) => [l.analyteId, l]));
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="qr-view">
      <View style={ls.card}>
        <Person p={r.patient} t={t} sub={[r.sampleNo ?? null, r.reportedAt === null ? null : t("quickLab.reports.completedAt", { at: istTime(r.reportedAt) })].filter((x) => x !== null).join(" · ")} />
      </View>
      <View style={ls.card} testID="qr-preview">
        {r.groups.map((g, gi) => {
          const lines = g.analyteIds.map((x) => byId.get(x)).filter((l) => l !== undefined);
          if (lines.length === 0) return null;
          return (
            <View key={gi} style={{ gap: 4 }}>
              <Text style={ls.cap} numberOfLines={1}>{g.title ?? t("quickLab.otherParams")}</Text>
              {lines.map((l) => {
                const out = l.flag !== null && l.flag !== "N";
                const ref = l.refText ?? refText({ low: l.low, high: l.high, text: null });
                return (
                  <View key={l.analyteId} testID={`qr-line-${l.analyteId}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: 1, borderTopColor: color.line2, paddingTop: 4 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14, color: color.ink }} numberOfLines={1}>{l.nameEn}</Text>
                      <Text style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>{[ref, l.unit ?? ""].filter((x) => x !== "").join(" · ")}</Text>
                    </View>
                    <Text style={{ fontFamily: MONO, fontSize: 15, fontWeight: "700", color: out ? FLAG_FG[l.flag ?? ""] : color.ink }}>
                      {l.value}{out ? ` ${l.flag}` : ""}
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        })}
        {r.summary !== "" && <Text style={{ fontSize: 13.5, color: color.ink }}><Text style={{ fontWeight: "700" }}>{t("quickLab.summary")}: </Text>{r.summary}</Text>}
        <Text style={{ fontSize: 11.5, color: color.faint }}>{t("quickLab.reports.notSigned")}</Text>
      </View>
      {error !== null && <Note tone="bad" testID="ql-error">{error}</Note>}
      <Button testID="qr-handover" label={t("quickLab.reports.handOver")} busy={busy} onPress={() => { void act("handOver"); }} />
      {mayEnter && <Button testID="qr-sendback" kind="secondary" label={`↩ ${t("quickLab.reports.sendBack")}`} disabled={busy} onPress={() => { void act("sendBack"); }} />}
      <Text style={{ fontSize: 12, color: color.faint, textAlign: "center" }} numberOfLines={1}>{t("quickLab.reports.printOnPc")}</Text>
    </ScrollView>
  );
}
