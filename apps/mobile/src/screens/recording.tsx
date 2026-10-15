import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, MONO, Note } from "../ui";
import type { RecordingCounts, RecordingReport } from "../home/recorded";

/**
 * "RECORDED TODAY", BY DOCTOR AND BY DEPARTMENT (owner 2026-10-07) — the owner's list behind the home
 * card. The server sends doctors' names only to a login that holds the staff figures; anybody else who
 * lands here sees the hospital line and the departments, or a plain sentence.
 */
function Row({ name, c, t, testID }: { name: string; c: RecordingCounts; t: (k: string, v?: Record<string, string | number>) => string; testID: string }) {
  return (
    <View testID={testID} style={{ paddingVertical: 9, borderTopWidth: 1, borderTopColor: color.line2, gap: 2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
        <Text style={{ fontSize: 14, fontWeight: "700", color: color.ink, flex: 1 }} numberOfLines={1}>{name}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: "700", color: c.notRecorded > 0 ? color.red : color.green }}>
          {c.consulted === 0 ? t("recorded.row.none") : c.notRecorded > 0 ? t("recorded.row.missing", { n: c.notRecorded }) : t("recorded.row.all")}
        </Text>
      </View>
      <Text style={[type.small, { color: color.dim }]}>{t("recorded.row.line", { consulted: c.consulted, issued: c.issued, photographed: c.photographed, typed: c.typed })}</Text>
    </View>
  );
}

export function RecordingScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const [r, setR] = useState<RecordingReport | null>(null);
  const [failed, setFailed] = useState<"offline" | "refused" | null>(null);
  const load = useCallback(async () => {
    try { setR(await call<RecordingReport>("GET", "/opd/reports/recording")); setFailed(null); } catch (e) { setFailed(e instanceof NetworkError ? "offline" : "refused"); }
  }, [call]);
  useEffect(() => { void load(); }, [load]);
  const card = { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm } as const;
  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("recorded.back")} onPress={() => router.back()} testID="recording-back" />} />
      <ScrollView testID="recording-scroll" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Text style={[type.title, { color: color.ink }]}>{t("recorded.title")}</Text>
        <Text style={[type.small, { color: color.dim }]}>{t("recorded.note")}</Text>
        {failed !== null && <Note tone="warn" testID="recording-failed">{t(failed === "offline" ? "recorded.offline" : "recorded.refused")}</Note>}
        {failed !== null && <Button kind="secondary" label={t("recorded.again")} onPress={() => { void load(); }} testID="recording-again" />}
        {r !== null && r.totals !== null && (
          <View style={card} testID="recording-total"><Row testID="recording-row-total" name={t(r.scope === "mine" ? "recorded.scopeMine" : "recorded.scopeHospital")} c={r.totals} t={t} /></View>
        )}
        {r !== null && r.doctors !== null && r.doctors.length > 0 && (
          <View style={card} testID="recording-doctors">
            <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink, paddingVertical: 6 }}>{t("recorded.byDoctorHead")}</Text>
            {r.doctors.map((d) => <Row key={d.id} testID={`recording-doctor-${d.id}`} name={d.name} c={d} t={t} />)}
          </View>
        )}
        {r !== null && r.departments !== null && r.departments.length > 0 && (
          <View style={card} testID="recording-departments">
            <Text style={{ fontSize: 13.5, fontWeight: "700", color: color.ink, paddingVertical: 6 }}>{t("recorded.byDepartment")}</Text>
            {r.departments.map((d) => <Row key={d.id} testID={`recording-dept-${d.id}`} name={d.name} c={d} t={t} />)}
          </View>
        )}
        {r !== null && r.scope === "none" && <Note tone="info" testID="recording-none">{t("recorded.noAccess")}</Note>}
        <Text style={{ fontSize: 11.5, color: color.faint }}>{t("recorded.screenNote")}</Text>
      </ScrollView>
    </View>
  );
}
