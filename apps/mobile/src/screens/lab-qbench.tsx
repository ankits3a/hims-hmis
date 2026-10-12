import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { labRefusal, quickLabApi, refText, draftSummary, type QuickAnalyte, type QuickCatalogue, type QuickLabApi, type QuickRange, type QuickReport } from "../lab/api";
import { calculatedValues, groupByTest, isCalc, previewLines, saveLines, shownValue, type Row } from "../lab/form";
import { Done, istTime, ls, Person, RowCard, Screen, TestChips, usePoll, type T } from "../lab/ui";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space } from "../theme";
import { Button, KeyboardScrollView, MONO, Note } from "../ui";
import { AstEditor } from "../lab/ast";
import { astForSave, astProblemText, cleanAstRows, isCultureCode, isNoGrowth, type AstDraftRow } from "../../../../packages/contracts/src/lab-ast";

/**
 * QUICK BENCH ON THE PHONE (spec 2026-10-12; the web's /lab/qbench and its results form). The
 * collected samples; tap one for its form, one field per parameter, each with the patient's range and
 * a high/low flag as it is typed. Calculated values fill themselves and cannot be typed. **Save
 * draft** keeps it on the bench; **Save & Complete** sends it to Quick Reports. The colours are a
 * preview: the server resolves every range and flag again on save.
 */
export function QuickBench() {
  const { t } = useI18n();
  const { call } = useSession();
  const api = useMemo(() => quickLabApi(call), [call]);
  const queue = usePoll(api.queue);
  const [catalogue, setCatalogue] = useState<QuickCatalogue | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  useEffect(() => { api.catalogue().then(setCatalogue, () => undefined); }, [api]);
  const rows = queue.data?.waiting ?? [];
  const listError = queue.error !== null && queue.data === null ? labRefusal(queue.error, t) : null;

  if (openId !== null) {
    return (
      <Screen title={t("screen.qbench.title")} onBack={() => setOpenId(null)}>
        <BenchForm key={openId} id={openId} api={api} catalogue={catalogue} t={t}
          onCompleted={(r) => { setOpenId(null); setCompleted(r.patient.display); void queue.refresh(); }} />
      </Screen>
    );
  }
  return (
    <Screen title={t("screen.qbench.title")}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="qbench">
        {listError !== null && <Note tone="bad" testID="ql-error">{listError}</Note>}
        {completed !== null && <Done testID="qb-done" text={t("quickLab.bench.completed", { name: completed })} />}
        <Text style={ls.cap}>{t("quickLab.bench.count", { n: rows.length })}</Text>
        {rows.map((r) => (
          <RowCard key={r.id} testID={`qb-row-${r.id}`} label={r.patient.display} onPress={() => { setOpenId(r.id); setCompleted(null); }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Person p={r.patient} t={t} sub={[r.sampleNo ?? null, t("quickLab.bench.collectedAt", { at: istTime(r.collectedAt) })].filter((x) => x !== null).join(" · ")} />
              <TestChips tests={r.tests} extra={r.status === "draft" ? <Text style={ls.chipWarn}>{t("quickLab.bench.draft")}</Text> : undefined} />
            </View>
          </RowCard>
        ))}
        {queue.data !== null && rows.length === 0 && <Text testID="qb-empty" style={ls.empty}>{t("quickLab.bench.empty")}</Text>}
      </ScrollView>
    </Screen>
  );
}

const FLAG_FG: Record<string, string> = { L: "#8a5a10", H: "#8a5a10", LL: color.red, HH: color.red };

function BenchForm({ id, api, catalogue, t, onCompleted }: {
  id: string; api: QuickLabApi; catalogue: QuickCatalogue | undefined; t: T; onCompleted: (r: QuickReport) => void;
}) {
  const [report, setReport] = useState<QuickReport | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ranges, setRanges] = useState<Map<string, QuickRange>>(new Map());
  const [summary, setSummary] = useState("");
  const [summaryEdited, setSummaryEdited] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Owner 2026-10-12 — each culture test's antibiotic rows, by service id. */
  const [ast, setAst] = useState<Record<string, AstDraftRow[]>>({});

  useEffect(() => {
    let gone = false;
    api.report(id).then((r) => {
      if (gone) return;
      const typed = new Map(r.lines.map((l) => [l.analyteId, l.value]));
      setReport(r);
      setRows(r.analyteIds.map((analyteId) => ({ analyteId, value: typed.get(analyteId) ?? "" })));
      setAst(Object.fromEntries((r.ast ?? []).map((b) => [b.serviceId, b.rows])));
      // A draft keeps its typed summary, so a draft saved and reopened says what it said.
      if (r.summary !== "") { setSummary(r.summary); setSummaryEdited(true); }
      if (r.analyteIds.length > 0) {
        api.ranges(r.patient.id, r.analyteIds).then((x) => { if (!gone) setRanges(new Map(x.items.map((i) => [i.analyteId, i]))); }, () => undefined);
      }
    }, (e: unknown) => { if (!gone) setError(labRefusal(e, t)); });
    return () => { gone = true; };
  }, [api, id, t]);

  const byId = useMemo(() => new Map<string, QuickAnalyte>((catalogue?.analytes ?? []).map((a) => [a.analyteId, a])), [catalogue]);
  const list = useMemo(() => rows ?? [], [rows]);
  const calc = useMemo(() => calculatedValues(list, byId), [list, byId]);
  const lines = useMemo(() => previewLines(list, byId, calc, ranges), [list, byId, calc, ranges]);
  const shownSummary = summaryEdited ? summary : draftSummary(lines);

  if (report === null || rows === null) {
    return <View style={{ padding: space.lg }}>{error !== null ? <Note tone="bad" testID="ql-error">{error}</Note> : <Text style={ls.sub}>{t("quickLab.loading")}</Text>}</View>;
  }
  const filled = list.filter((r) => r.value.trim() !== "").length;
  /** "No growth" / "Sterile" in the organism line hides the antibiotic table and saves none. */
  const cultures = report.tests.filter((x) => isCultureCode(x.code));
  const organism = list.find((x) => byId.get(x.analyteId)?.code === "MIC_ORG")?.value ?? "";
  const sterile = isNoGrowth(organism);

  const save = async (complete: boolean): Promise<void> => {
    const astOut = astForSave(cultures, ast, organism);
    for (const b of astOut) {
      const c = cleanAstRows(b.rows);
      if (!c.ok) { setError(astProblemText(c.problem)); return; }
    }
    setBusy(true); setDraftSaved(false);
    try {
      const out = await api.save(id, { lines: saveLines(list, byId), summary: shownSummary, complete, ...(cultures.length > 0 ? { ast: astOut } : {}) });
      setError(null);
      if (complete && out.status === "reported") onCompleted(out);
      else setDraftSaved(true);
    } catch (e) { setError(labRefusal(e, t)); }
    finally { setBusy(false); }
  };
  const type = (analyteId: string, value: string): void => {
    setRows((prev) => (prev ?? []).map((x) => (x.analyteId === analyteId ? { ...x, value } : x)));
    setDraftSaved(false);
  };

  return (
    <KeyboardScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled" testID="qb-form">
      <View style={ls.card}>
        <Person p={report.patient} t={t} sub={[report.sampleNo ?? null, t("quickLab.bench.collectedAt", { at: istTime(report.collectedAt) })].filter((x) => x !== null).join(" · ")} />
      </View>
      {groupByTest(report.tests, catalogue, list.map((x) => x.analyteId), t("quickLab.otherParams")).map((g) => (
        <View key={g.title} style={ls.card}>
          <Text style={ls.cap} numberOfLines={1}>{g.title}</Text>
          {g.ids.map((analyteId) => {
            const row = list.find((x) => x.analyteId === analyteId)!;
            const a = byId.get(analyteId);
            const calcRow = isCalc(a);
            const value = shownValue(row, byId, calc);
            const flag = lines.find((l) => l.analyteId === analyteId)?.flag ?? null;
            const out = flag !== null && flag !== "N";
            const range = ranges.get(analyteId);
            const notNumber = calcRow && value !== "" && !Number.isFinite(Number(value));
            return (
              <View key={analyteId} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.sm }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: "600", color: color.ink }} numberOfLines={1}>{a?.nameEn ?? analyteId}</Text>
                  <Text testID={`qb-range-${analyteId}`} style={{ fontSize: 12, color: color.dim }} numberOfLines={1}>
                    {[refText(range), a?.unit ?? ""].filter((x) => x !== "").join(" · ")}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 2 }}>
                  <TextInput
                    testID={`qb-input-${analyteId}`}
                    accessibilityLabel={a?.nameEn ?? analyteId}
                    value={value}
                    editable={!calcRow}
                    onChangeText={(v) => type(analyteId, v)}
                    keyboardType={a?.resultType === "numeric" ? "decimal-pad" : "default"}
                    style={{
                      width: notNumber ? 150 : 92, minHeight: 44, borderWidth: out ? 2 : 1, borderColor: out ? FLAG_FG[flag ?? ""] : color.line, borderRadius: radius.md,
                      paddingHorizontal: 10, fontFamily: MONO, fontSize: notNumber ? 11 : 16, textAlign: "right",
                      color: out ? FLAG_FG[flag ?? ""] : color.ink, backgroundColor: calcRow ? color.wash : color.card,
                    }}
                  />
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {calcRow && <Text style={{ fontSize: 10, letterSpacing: 0.8, color: color.faint }}>{t("quickLab.bench.calc")}</Text>}
                    {out && <Text testID={`qb-flag-${analyteId}`} style={{ fontSize: 12, fontWeight: "800", color: FLAG_FG[flag ?? ""] }}>{flag}</Text>}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ))}
      {cultures.map((x) => (sterile ? (
        <Text key={x.serviceId} testID={`qb-ast-nogrowth-${x.code}`} style={ls.sub} numberOfLines={1}>{t("quickLab.ast.noGrowth")}</Text>
      ) : (
        <AstEditor key={x.serviceId} testCode={x.code} testName={x.nameEn} rows={ast[x.serviceId] ?? []} t={t}
          onChange={(rows) => { setAst((prev) => ({ ...prev, [x.serviceId]: rows })); setDraftSaved(false); }} />
      )))}
      <View style={{ gap: 6 }}>
        <Text style={ls.cap}>{t("quickLab.summary")}</Text>
        <TextInput testID="qb-summary" multiline value={shownSummary} onChangeText={(v) => { setSummary(v); setSummaryEdited(true); setDraftSaved(false); }}
          style={{ minHeight: 96, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: 10, fontSize: 14, color: color.ink, backgroundColor: color.card, textAlignVertical: "top" }} />
      </View>
      {error !== null && <Note tone="bad" testID="ql-error">{error}</Note>}
      {draftSaved && <Done testID="qb-draft-saved" text={t("quickLab.bench.draftSaved")} />}
      <Button testID="qb-complete" label={t("quickLab.bench.saveComplete")} busy={busy} disabled={filled === 0} onPress={() => { void save(true); }} />
      <Button testID="qb-draft" kind="secondary" label={t("quickLab.bench.saveDraft")} disabled={busy} onPress={() => { void save(false); }} />
    </KeyboardScrollView>
  );
}
