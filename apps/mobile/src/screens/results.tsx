import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, type } from "../theme";
import { Band, Button, Note } from "../ui";
import {
  imagingSections, outOfRange, refOf, resultsApi,
  type ImagingReport, type ImagingRow, type LabReport, type LabRow, type ResultsKind,
} from "../results/api";

/**
 * #681 — LAB AND IMAGING REPORTS ON THE PHONE, read-only (see `src/results/api.ts`). A list, newest or
 * most urgent first as the server orders it; one tap opens the report in place; Back returns to the
 * list and reads it again, so an imaging report just opened shows as read. Nothing is acknowledged,
 * acted on or printed from here — a critical says it is acknowledged on the computer.
 */
type Opened =
  | { kind: "imaging"; row: ImagingRow; report: ImagingReport | null | "loading" | "gone" }
  | { kind: "lab"; row: LabRow; report: LabReport | "loading" | "gone" };

export function ResultsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind: ResultsKind = params.kind === "lab" ? "lab" : "imaging";
  const api = useMemo(() => resultsApi(call), [call]);
  const [rows, setRows] = useState<ImagingRow[] | LabRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<Opened | null>(null);

  const say = useCallback((e: unknown) => setProblem(t(e instanceof NetworkError ? "results.offline" : "results.failed")), [t]);
  const load = useCallback(async () => {
    setProblem(null);
    try { setRows(kind === "lab" ? await api.labList() : await api.imagingList()); } catch (e) { say(e); }
  }, [api, kind, say]);
  useEffect(() => { void load(); }, [load]);

  const openImaging = async (row: ImagingRow) => {
    setOpen({ kind: "imaging", row, report: "loading" });
    try { const report = await api.imagingOpen(row.reportId); setOpen({ kind: "imaging", row, report }); } catch (e) { setOpen({ kind: "imaging", row, report: "gone" }); say(e); }
  };
  const openLab = async (row: LabRow) => {
    setOpen({ kind: "lab", row, report: "loading" });
    try { const report = await api.labOpen(row.reportId); setOpen({ kind: "lab", row, report }); } catch (e) { setOpen({ kind: "lab", row, report: "gone" }); say(e); }
  };
  const close = () => { setOpen(null); void load(); };

  const card = { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 4 } as const;
  const one = (testID: string, s: string, style: object = {}) => <Text testID={testID} numberOfLines={1} style={[type.small, { color: color.dim }, style]}>{s}</Text>;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <Band right={<Button kind="secondary" label={t("results.back")} onPress={() => (open !== null ? close() : router.back())} testID="results-back" />} />
      <ScrollView testID="results" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.sm }}>
        <Text style={[type.title, { color: color.ink }]} numberOfLines={1}>{t(kind === "lab" ? "results.lab" : "results.imaging")}</Text>
        {problem !== null && <Note tone="warn" testID="results-problem">{problem}</Note>}

        {open === null && rows !== null && rows.length === 0 && one("results-none", t("results.none"))}

        {open === null && kind === "imaging" && (rows as ImagingRow[] | null)?.map((r) => (
          <Pressable key={r.reportId} testID={`results-row-${r.reportId}`} accessibilityRole="button" onPress={() => { void openImaging(r); }}
            style={({ pressed }) => [card, pressed && { backgroundColor: color.wash }]}>
            <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{r.patientName}</Text>
            {one(`results-what-${r.reportId}`, `${r.studyName} · ${r.uhid}`)}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {r.critical !== null && r.critical.acknowledgedAt === null && one(`results-critical-${r.reportId}`, t("results.critical"), { color: color.red, fontWeight: "700" })}
              {one(`results-state-${r.reportId}`, t(`results.state.${r.state}`), r.state === "unread" ? { color: color.gold, fontWeight: "700" } : {})}
              {r.amended && one(`results-amended-${r.reportId}`, t("results.amended"))}
            </View>
          </Pressable>
        ))}

        {open === null && kind === "lab" && (rows as LabRow[] | null)?.map((r) => (
          <Pressable key={r.reportId} testID={`results-row-${r.reportId}`} accessibilityRole="button" onPress={() => { void openLab(r); }}
            style={({ pressed }) => [card, pressed && { backgroundColor: color.wash }]}>
            <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{r.patientName}</Text>
            {one(`results-what-${r.reportId}`, `${r.tests.join(", ")} · ${r.uhid}`)}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {r.abnormal > 0 && one(`results-abnormal-${r.reportId}`, t("results.abnormal", { count: r.abnormal }), { color: color.red, fontWeight: "700" })}
              {r.amended && one(`results-amended-${r.reportId}`, t("results.amended"))}
            </View>
          </Pressable>
        ))}

        {open?.kind === "imaging" && (
          <View testID="results-report" style={card}>
            <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{open.row.patientName}</Text>
            {one("results-report-what", `${open.row.studyName} · ${open.row.accessionNo}`)}
            {open.report === "loading" && one("results-loading", "…")}
            {(open.report === null || open.report === "gone") && one("results-gone", t("results.gone"))}
            {typeof open.report === "object" && open.report !== null && (
              <>
                {open.report.criticalCategory !== null && one("results-report-critical", t("results.ackOnComputer"), { color: color.red, fontWeight: "700" })}
                {imagingSections(open.report).map((s) => (
                  <View key={s.key} style={{ gap: 2 }}>
                    <Text style={[type.tag, { color: color.faint }]} numberOfLines={1}>{s.key}</Text>
                    <Text testID={`results-section-${s.key}`} style={[type.body, { color: color.ink }]}>{s.text}</Text>
                  </View>
                ))}
                {open.report.impression !== null && (
                  <View style={{ gap: 2 }}>
                    <Text style={[type.tag, { color: color.faint }]} numberOfLines={1}>{t("results.impression")}</Text>
                    <Text testID="results-impression" style={[type.body, { color: color.ink, fontWeight: "600" }]}>{open.report.impression}</Text>
                  </View>
                )}
                {open.report.amendmentReason !== null && one("results-amended-why", t("results.amended"), { color: color.gold })}
                {open.row.signerName !== null && one("results-signed", t("results.signed", { who: open.row.signerName }))}
              </>
            )}
          </View>
        )}

        {open?.kind === "lab" && (
          <View testID="results-report" style={card}>
            <Text numberOfLines={1} style={[type.body, { color: color.ink, fontWeight: "700" }]}>{open.row.patientName}</Text>
            {one("results-report-what", `${open.row.orderNo} · ${open.row.uhid}`)}
            {open.report === "loading" && one("results-loading", "…")}
            {open.report === "gone" && one("results-gone", t("results.gone"))}
            {typeof open.report === "object" && (
              <>
                {open.report.partial && one("results-partial", t("results.partial"), { color: color.gold })}
                {open.report.panels.map((p, pi) => (
                  <View key={`${p.name}-${String(pi)}`} style={{ gap: 2, marginTop: space.xs }}>
                    <Text style={[type.tag, { color: color.faint }]} numberOfLines={1}>{p.name}</Text>
                    {p.lines.map((l, li) => {
                      const ref = refOf(l);
                      const id = `results-line-${String(pi)}-${String(li)}`;
                      return (
                        <View key={id} testID={id} style={{ flexDirection: "row", gap: space.sm, alignItems: "baseline" }}>
                          <Text numberOfLines={1} style={[type.small, { flex: 1, color: color.ink }]}>{l.name}</Text>
                          <Text numberOfLines={1} style={[type.small, { color: outOfRange(l) ? color.red : color.ink, fontWeight: outOfRange(l) ? "700" : "400" }]}>
                            {`${l.value}${l.unit !== null ? ` ${l.unit}` : ""}${outOfRange(l) && l.flag !== null ? ` ${l.flag}` : ""}`}
                          </Text>
                          {ref !== null && <Text numberOfLines={1} style={[type.small, { color: color.faint }]}>{ref}</Text>}
                        </View>
                      );
                    })}
                  </View>
                ))}
                {open.report.amended && one("results-amended-why", t("results.amended"), { color: color.gold })}
                {open.report.signedBy !== null && one("results-signed", t("results.signed", { who: open.report.signedBy }))}
              </>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
