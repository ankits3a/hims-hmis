import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useI18n } from "../i18n";
import { labRefusal, quickLabApi, refText, draftSummary, type QuickAnalyte, type QuickCatalogue, type QuickLabApi, type QuickRange, type QuickReport } from "../lab/api";
import { calculatedValues, groupByTest, isCalc, previewLines, saveLines, shownValue, type Row } from "../lab/form";
import { Done, istTime, ls, Person, RowCard, Screen, TestChips, usePoll, type T } from "../lab/ui";
import { useSession } from "../session";
import { Text, TextInput } from "../text";
import { color, radius, space } from "../theme";
import { Button, KeyboardScrollView, MONO, Note } from "../ui";
import { AstEditor } from "../lab/ast";
import { slipApi, slipRefusal, type LineSlip, type SlipApi, type SlipBench, type SlipSetup } from "../lab/slip-scan";
import { SlipScan } from "./lab-slip-scan";
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
  /** #934 — Scan slip: offered only while the server reads slips and an analyser has a code map. */
  const slips = useMemo(() => slipApi(call), [call]);
  const [setup, setSetup] = useState<SlipSetup | null>(null);
  useEffect(() => { slips.setup().then(setSetup, () => setSetup(null)); }, [slips]);
  const reading = setup !== null && setup.reading && setup.analysers.length > 0;
  const [slipFlow, setSlipFlow] = useState<{ quickReportId: string | null; scanId: string | null } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const rows = queue.data?.waiting ?? [];
  const listError = queue.error !== null && queue.data === null ? labRefusal(queue.error, t) : null;

  if (slipFlow !== null && setup !== null) {
    return (
      <Screen title={t("labSlip.title")} onBack={() => setSlipFlow(null)}>
        <SlipScan api={slips} setup={setup} quickReportId={slipFlow.quickReportId} scanId={slipFlow.scanId} t={t}
          onClose={() => { setSlipFlow(null); void queue.refresh(); }}
          onOpenReport={(id) => { setSlipFlow(null); setOpenId(id); setFormKey((k) => k + 1); void queue.refresh(); }} />
      </Screen>
    );
  }
  if (openId !== null) {
    return (
      <Screen title={t("screen.qbench.title")} onBack={() => setOpenId(null)}>
        <BenchForm key={`${openId}:${String(formKey)}`} id={openId} api={api} catalogue={catalogue} t={t}
          slips={reading ? slips : null} onFillFromSlip={() => setSlipFlow({ quickReportId: openId, scanId: null })}
          onCompleted={(r) => { setOpenId(null); setCompleted(r.patient.display); void queue.refresh(); }} />
      </Screen>
    );
  }
  return (
    <Screen title={t("screen.qbench.title")}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} testID="qbench">
        {listError !== null && <Note tone="bad" testID="ql-error">{listError}</Note>}
        {completed !== null && <Done testID="qb-done" text={t("quickLab.bench.completed", { name: completed })} />}
        {reading && <Button testID="qb-scan" label={t("labSlip.scan")} onPress={() => { setCompleted(null); setSlipFlow({ quickReportId: null, scanId: null }); }} />}
        {reading && <SlipsWaiting api={slips} t={t} onOpen={(id) => setSlipFlow({ quickReportId: null, scanId: id })} />}
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
const AMBER = "#8a5a10";

/** #934 — "Slips waiting (n)": scans that still need a patient, newest first. */
function SlipsWaiting({ api, t, onOpen }: { api: SlipApi; t: T; onOpen: (scanId: string) => void }) {
  const waiting = usePoll(api.waiting);
  const [open, setOpen] = useState(false);
  const items = waiting.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      <Button testID="qb-slips-waiting" kind="secondary" label={t("labSlip.waiting", { n: items.length })} onPress={() => setOpen((v) => !v)} />
      {open && items.map((w) => (
        <RowCard key={w.id} testID={`qb-slip-${w.id}`} label={w.name ?? w.instrumentName} onPress={() => onOpen(w.id)}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={ls.name} numberOfLines={1}>{w.name ?? t("labSlip.noName")}</Text>
            <Text style={ls.sub} numberOfLines={1}>{w.instrumentName} · {istTime(w.capturedAt)}</Text>
          </View>
        </RowCard>
      ))}
    </View>
  );
}

/** A slip check in plain words, as the bench reads it. */
function checkText(t: T, check: string, slip: LineSlip, value: string): string {
  if (check === "typed_differs") return t("labSlip.check.typed_differs", { typed: value, slip: slip.slipValue ?? "" });
  if (check === "cross_check_differs") return t("labSlip.check.cross_check_differs", { slip: slip.slipValue ?? "" });
  return t(`labSlip.check.${check}`);
}

/** The slip's "not placed" rows (Ignore needs a reason), the rows its analyser setting ignored, and View slip. */
function SlipPanel({ bench, slips, t, onChanged }: { bench: SlipBench; slips: SlipApi; t: T; onChanged: () => void }) {
  const [ignoring, setIgnoring] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ignore = async (row: number): Promise<void> => {
    try { await slips.row(bench.scanId, row, { action: "ignore", reason: why.trim() }); setIgnoring(null); setWhy(""); setError(null); onChanged(); }
    catch (e) { setError(slipRefusal(e, t)); }
  };
  const view = async (): Promise<void> => {
    if (image !== null) { setImage(null); return; }
    try { const img = await slips.image(bench.scanId); setImage(`data:${img.mimeType};base64,${img.imageBase64}`); }
    catch (e) { setError(slipRefusal(e, t)); }
  };
  return (
    <View style={ls.card} testID={`qb-slip-panel-${bench.scanId}`}>
      <Pressable testID={`qb-view-slip-${bench.scanId}`} accessibilityRole="button" onPress={() => { void view(); }} style={{ minHeight: 36, justifyContent: "center" }}>
        <Text style={{ fontSize: 14, fontWeight: "700", color: color.green }}>{t("labSlip.viewSlip")}</Text>
      </Pressable>
      {image !== null && <ScrollView maximumZoomScale={4} style={{ maxHeight: 520 }}><Image source={{ uri: image }} style={{ width: "100%", aspectRatio: 0.38 }} resizeMode="contain" /></ScrollView>}
      {bench.notPlaced.length > 0 && <Text style={[ls.cap, { color: AMBER }]}>{t("labSlip.notPlaced")}</Text>}
      {bench.notPlaced.map((r) => (
        <View key={r.position} testID={`qb-slip-np-${r.code}`} style={{ gap: 6, borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.sm }}>
          <Text style={{ fontFamily: MONO, fontSize: 13, color: color.ink }} numberOfLines={1}>{[r.code, r.value ?? "—", r.unit ?? ""].join("  ")}</Text>
          <Text style={{ fontSize: 12, color: AMBER }} numberOfLines={1}>{t(`labSlip.reason.${r.reason ?? "unmapped"}`)}</Text>
          {ignoring === r.position ? (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <TextInput testID={`qb-slip-why-${r.code}`} value={why} onChangeText={setWhy} placeholder={t("labSlip.ignoreWhy")}
                style={{ flex: 1, minHeight: 40, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 10, color: color.ink }} />
              <Button testID={`qb-slip-ignore-go-${r.code}`} kind="secondary" label={t("labSlip.ignore")} disabled={why.trim() === ""} onPress={() => { void ignore(r.position); }} />
            </View>
          ) : (
            <Pressable testID={`qb-slip-ignore-${r.code}`} accessibilityRole="button" onPress={() => { setIgnoring(r.position); setWhy(""); }} style={{ minHeight: 32, justifyContent: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: color.dim }}>{t("labSlip.ignore")}</Text>
            </Pressable>
          )}
        </View>
      ))}
      {bench.ignoredBySetting.length > 0 && (
        <Text style={ls.sub} numberOfLines={1}>{t("labSlip.ignoredBySetting", { n: bench.ignoredBySetting.length })}</Text>
      )}
      {error !== null && <Note tone="bad">{error}</Note>}
    </View>
  );
}

function BenchForm({ id, api, catalogue, t, slips, onFillFromSlip, onCompleted }: {
  id: string; api: QuickLabApi; catalogue: QuickCatalogue | undefined; t: T;
  slips: SlipApi | null; onFillFromSlip: () => void; onCompleted: (r: QuickReport) => void;
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

  /** #934 — a slip check closed on the server: the markers are read again; what was typed here stays. */
  const refreshSlips = (): void => { api.report(id).then((r) => setReport(r), () => undefined); };
  const checked = (slip: LineSlip): void => {
    if (slips === null) return;
    slips.row(slip.scanId, slip.row, { action: "checked" }).then(refreshSlips, (e: unknown) => setError(slipRefusal(e, t)));
  };

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
      {slips !== null && <Button testID="qb-fill-slip" kind="secondary" label={t("labSlip.fill")} onPress={onFillFromSlip} />}
      {slips !== null && (report.slips ?? []).map((b) => <SlipPanel key={b.scanId} bench={b} slips={slips} t={t} onChanged={refreshSlips} />)}
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
            const slip = report.lines.find((l) => l.analyteId === analyteId)?.slip;
            const open = slip !== undefined && slip.edited !== true ? slip.checks : [];
            return (
              <View key={analyteId} style={{ borderTopWidth: 1, borderTopColor: color.line2, paddingTop: space.sm, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
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
                    {slip !== undefined && slip.edited !== true && <Text testID={`qb-slip-tag-${analyteId}`} style={{ fontSize: 10, letterSpacing: 0.8, color: open.length > 0 ? AMBER : color.faint }}>{t("labSlip.tag")}</Text>}
                    {calcRow && <Text style={{ fontSize: 10, letterSpacing: 0.8, color: color.faint }}>{t("quickLab.bench.calc")}</Text>}
                    {out && <Text testID={`qb-flag-${analyteId}`} style={{ fontSize: 12, fontWeight: "800", color: FLAG_FG[flag ?? ""] }}>{flag}</Text>}
                  </View>
                </View>
              </View>
              {open.length > 0 && slip !== undefined && (
                <View testID={`qb-slip-check-${analyteId}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text style={{ flex: 1, fontSize: 12, color: AMBER }} numberOfLines={2}>{open.map((c) => checkText(t, c, slip, value)).join(" · ")}</Text>
                  <Pressable testID={`qb-slip-checked-${analyteId}`} accessibilityRole="button" onPress={() => checked(slip)}
                    style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center", borderWidth: 1, borderColor: AMBER, borderRadius: radius.md }}>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: AMBER }}>{t("labSlip.checked")}</Text>
                  </Pressable>
                </View>
              )}
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
