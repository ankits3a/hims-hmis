import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { File } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";
import { NetworkError } from "../api";
import { Crop, type CropStatus } from "../slips/crop";
import { SlipCamera } from "../slips/camera";
import { findPage, flatten, normalize, type Photo } from "../slips/imaging";
import { frameQuad, isConvex, type Quad } from "../slips/rules";
import {
  exifTakenAt, isOldPhoto, rowsNeedingEyes, SLIP_EDGE, SLIP_POLL_LIMIT, SLIP_POLL_MS, SLIP_UPLOAD_BYTES, slipRefusal, slipSays,
  type SlipApi, type SlipCandidate, type SlipScanView, type SlipSetup,
} from "../lab/slip-scan";
import { istTime, ls, Person, type T } from "../lab/ui";
import { Text, TextInput } from "../text";
import { color, radius, space } from "../theme";
import { Button, Note } from "../ui";

/**
 * SPEC #934 — SCAN SLIP / FILL FROM SLIP on the Quick Bench. Capture (the slip camera with its torch
 * and crop, or ONE photo from the system picker, which asks for no photo-library permission), the
 * analyser, the upload — a straightened JPEG inside the budget, the phone's copies deleted afterwards —
 * then one of: attached, pick the patient, or couldn't read. Nothing is queued on the phone: with no
 * connection the bench is told so and tries again.
 *
 * `quickReportId` is Fill from slip: the report the bench has open. A slip that says someone else
 * there waits for an explicit Yes.
 */
type Step =
  | { kind: "source" }
  | { kind: "old"; photo: Photo; takenAt: Date | null }
  | { kind: "crop"; photo: Photo; original: string; source: "camera" | "gallery"; takenAt: Date | null; quad: Quad; status: CropStatus }
  | { kind: "sending" }
  | { kind: "result"; view: SlipScanView };

/** The analyser chosen last, so the chip is pre-chosen next time (in memory: one bench, one phone). */
let lastAnalyser: string | null = null;
export function _forgetSlipAnalyserForTests(): void { lastAnalyser = null; }

const forget = (uris: readonly (string | null)[]): void => {
  for (const uri of new Set(uris)) {
    if (uri === null) continue;
    try { new File(uri).delete(); } catch { /* already gone; the cache is the OS's to clear */ }
  }
};

export function SlipScan({ api, setup, quickReportId, scanId, t, onClose, onOpenReport }: {
  api: SlipApi; setup: SlipSetup; quickReportId: string | null; scanId?: string | null; t: T;
  onClose: () => void; onOpenReport: (id: string) => void;
}) {
  const [step, setStep] = useState<Step>(scanId ? { kind: "sending" } : { kind: "source" });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [analyser, setAnalyser] = useState<string | null>(() => {
    if (setup.analysers.length === 1) return setup.analysers[0]!.id;
    return setup.analysers.some((a) => a.id === lastAnalyser) ? lastAnalyser : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);

  /** A scan the server is still reading: poll until it answers. */
  const follow = async (view: SlipScanView): Promise<void> => {
    let v = view;
    for (let i = 0; v.status === "reading" && i < SLIP_POLL_LIMIT && !gone.current; i += 1) {
      await new Promise((r) => { setTimeout(r, SLIP_POLL_MS); });
      v = await api.get(v.id);
    }
    if (!gone.current) setStep({ kind: "result", view: v });
  };

  useEffect(() => {
    if (!scanId) return;
    api.get(scanId).then((v) => follow(v), (e: unknown) => { setError(slipRefusal(e, t)); setStep({ kind: "source" }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId]);

  const toCrop = async (raw: Photo, source: "camera" | "gallery", takenAt: Date | null): Promise<void> => {
    setError(null);
    try {
      const photo = await normalize(raw);
      setStep({ kind: "crop", photo, original: raw.uri, source, takenAt, quad: frameQuad(photo.width, photo.height, 0.04), status: "finding" });
      const found = await findPage(photo);
      setStep((s) => (s.kind !== "crop" || s.photo !== photo ? s
        : found === null ? { ...s, status: "none" } : { ...s, quad: found.quad, status: "found" }));
    } catch {
      forget([raw.uri]);
      setError(t("labSlip.failedOther"));
      setStep({ kind: "source" });
    }
  };

  const pickGallery = async (): Promise<void> => {
    setError(null);
    const r = await launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: false, exif: true, quality: 1 });
    const a = r.canceled ? undefined : r.assets?.[0];
    if (a === undefined) return;
    const photo: Photo = { uri: a.uri, width: a.width, height: a.height };
    const takenAt = exifTakenAt(a.exif as Record<string, unknown> | null | undefined);
    if (isOldPhoto(takenAt, Date.now())) { setStep({ kind: "old", photo, takenAt }); return; }
    await toCrop(photo, "gallery", takenAt);
  };

  const send = async (s: Extract<Step, { kind: "crop" }>): Promise<void> => {
    if (analyser === null || busy) return;
    const full = frameQuad(s.photo.width, s.photo.height);
    const untouched = s.quad.every((p, i) => Math.hypot(p.x - full[i]!.x, p.y - full[i]!.y) <= Math.max(s.photo.width, s.photo.height) * 0.005);
    setBusy(true); setError(null); setOffline(false);
    try {
      const flat = await flatten(s.photo, untouched ? null : s.quad, SLIP_EDGE, SLIP_UPLOAD_BYTES);
      if (flat === null) { setError(t("labSlip.tooLarge")); return; }
      lastAnalyser = analyser;
      setStep({ kind: "sending" });
      let view: SlipScanView;
      try {
        view = await api.scan({
          image: flat.base64, mimeType: "image/jpeg", source: s.source, instrumentId: analyser,
          photoTakenAt: s.takenAt === null ? null : s.takenAt.toISOString(), quickReportId,
        });
      } finally {
        // The phone keeps no copy of the slip (decision 0082): the photo and its upright copy go, sent or not.
        forget([s.original, s.photo.uri]);
      }
      await follow(view);
    } catch (e) {
      if (e instanceof NetworkError) setOffline(true);
      setError(slipRefusal(e, t));
      setStep({ kind: "source" });
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<SlipScanView>): Promise<void> => {
    setBusy(true); setError(null);
    try { await follow(await run()); }
    catch (e) { setError(slipRefusal(e, t)); }
    finally { setBusy(false); }
  };

  const analysers = setup.analysers.length > 1 ? (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {setup.analysers.map((a) => (
        <Pressable key={a.id} testID={`slip-analyser-${a.id}`} accessibilityRole="button" accessibilityState={{ selected: analyser === a.id }}
          onPress={() => setAnalyser(a.id)} style={[chip, analyser === a.id && chipOn]}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: analyser === a.id ? color.card : color.ink }} numberOfLines={1}>{a.name}</Text>
        </Pressable>
      ))}
    </View>
  ) : null;

  let body: React.ReactNode;
  if (step.kind === "source") {
    body = (
      <>
        {setup.analysers.length > 1 && <Text style={ls.cap}>{t("labSlip.analyser")}</Text>}
        {analysers}
        {offline && <Note tone="bad" testID="slip-offline">{t("labSlip.offline")}</Note>}
        {!offline && error !== null && <Note tone="bad" testID="slip-error">{error}</Note>}
        <Button testID="slip-src-camera" label={t("labSlip.camera")} disabled={analyser === null} onPress={() => { setError(null); setCameraOpen(true); }} />
        <Button testID="slip-src-gallery" kind="secondary" label={t("labSlip.gallery")} disabled={analyser === null} onPress={() => { void pickGallery(); }} />
        <Button testID="slip-cancel" kind="secondary" label={t("labSlip.cancel")} onPress={onClose} />
      </>
    );
  } else if (step.kind === "old") {
    body = (
      <View testID="slip-old-photo" style={{ gap: space.md }}>
        <Note tone="warn">{step.takenAt === null ? t("labSlip.noDate") : t("labSlip.oldPhoto", { date: step.takenAt.toLocaleDateString("en-IN") })}</Note>
        <Text style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{t("labSlip.oldAsk")}</Text>
        <Button testID="slip-old-yes" label={t("labSlip.yes")} onPress={() => { void toCrop(step.photo, "gallery", step.takenAt); }} />
        <Button testID="slip-old-no" kind="secondary" label={t("labSlip.no")} onPress={() => { forget([step.photo.uri]); setStep({ kind: "source" }); }} />
      </View>
    );
  } else if (step.kind === "crop") {
    const usable = isConvex(step.quad);
    body = (
      <>
        {error !== null && <Note tone="bad" testID="slip-error">{error}</Note>}
        <Crop uri={step.photo.uri} width={step.photo.width} height={step.photo.height} quad={step.quad} status={step.status}
          onQuad={(quad) => setStep((s) => (s.kind === "crop" ? { ...s, quad } : s))} />
        <Button testID="slip-crop-use" label={t("labSlip.use")} busy={busy} disabled={!usable || step.status === "finding"} onPress={() => { void send(step); }} />
        <Button testID="slip-retake" kind="secondary" label={t("labSlip.retake")} onPress={() => { forget([step.original, step.photo.uri]); setStep({ kind: "source" }); }} />
      </>
    );
  } else if (step.kind === "sending") {
    body = <Text testID="slip-reading" style={{ fontSize: 15, color: color.dim }}>{t("labSlip.reading")}</Text>;
  } else {
    body = <Outcome view={step.view} t={t} busy={busy} error={error} quickReportId={quickReportId}
      onOpen={onOpenReport} onClose={onClose} onRetake={() => setStep({ kind: "source" })}
      onAttach={(id) => act(() => api.attach(step.view.id, { quickReportId: id, confirmed: true }))}
      onReread={() => act(() => api.reread(step.view.id))}
      onDiscard={(reason) => act(() => api.discard(step.view.id, reason)).then(() => onClose())} />;
  }

  return (
    <ScrollView testID="slip-scan" contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled">
      {body}
      <SlipCamera open={cameraOpen} onClose={() => setCameraOpen(false)}
        onShot={(p) => { setCameraOpen(false); void toCrop(p, "camera", null); }} />
    </ScrollView>
  );
}

const chip = { minHeight: 40, justifyContent: "center" as const, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: color.line, backgroundColor: color.card };
const chipOn = { backgroundColor: color.green, borderColor: color.green };

function Outcome({ view, t, busy, error, quickReportId, onOpen, onClose, onRetake, onAttach, onReread, onDiscard }: {
  view: SlipScanView; t: T; busy: boolean; error: string | null; quickReportId: string | null;
  onOpen: (id: string) => void; onClose: () => void; onRetake: () => void;
  onAttach: (quickReportId: string) => Promise<void>; onReread: () => Promise<void>; onDiscard: (reason: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(() => view.candidates.find((c) => c.preselected)?.quickReportId ?? null);
  const [notThis, setNotThis] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const hint = view.match.hint === "type_sample_no" ? <Note tone="info" testID="slip-hint">{t("labSlip.hint")}</Note> : null;
  const err = error !== null ? <Note tone="bad" testID="slip-error">{error}</Note> : null;

  if (view.status === "attached" && view.attached !== null) {
    const a = view.attached;
    const test = a.tests.map((x) => x.code).join(", ");
    const n = rowsNeedingEyes(view.counts);
    return (
      <View testID="slip-attached" style={{ gap: space.md }}>
        <View style={ls.card}>
          <Person p={a.patient} t={t} sub={a.sampleNo ?? undefined} />
        </View>
        <Text style={{ fontSize: 15, fontWeight: "700", color: n > 0 ? "#8a5a10" : color.green }} numberOfLines={1}>
          {n > 0 ? t("labSlip.attached", { test, n }) : t("labSlip.attachedClean", { test })}
        </Text>
        {hint}
        <Button testID="slip-open" label={t("labSlip.open")} onPress={() => onOpen(a.quickReportId)} />
      </View>
    );
  }
  if (view.status === "failed") {
    const why = view.error === "not_a_result_slip" ? "labSlip.failedNotSlip" : view.error === "too_blurred" ? "labSlip.failedBlurred" : "labSlip.failedOther";
    return (
      <View testID="slip-failed" style={{ gap: space.md }}>
        <Note tone="bad">{t(why)}</Note>
        {err}
        <Button testID="slip-retake" label={t("labSlip.retake")} onPress={onRetake} />
        <Button testID="slip-reread" kind="secondary" label={t("labSlip.reread")} busy={busy} onPress={() => { void onReread(); }} />
      </View>
    );
  }
  if (view.status === "discarded") return <Note tone="info" testID="slip-discarded">{t("labSlip.discarded")}</Note>;

  // Fill from slip, and the slip says someone else: an explicit Yes, recorded on the scan.
  if (view.requestedReportId !== null && view.requestedReportId === quickReportId && view.differences.length > 0 && !notThis) {
    return (
      <View style={{ gap: space.md }}>
        <Note tone="warn" testID="slip-differs">{t("labSlip.differs", { says: slipSays(view) })}</Note>
        <Text style={{ fontSize: 15, fontWeight: "700", color: color.ink }}>{t("labSlip.differsAsk")}</Text>
        {err}
        <Button testID="slip-differs-yes" label={t("labSlip.yes")} busy={busy} onPress={() => { void onAttach(view.requestedReportId!); }} />
        <Button testID="slip-differs-no" kind="secondary" label={t("labSlip.no")} onPress={() => setNotThis(true)} />
      </View>
    );
  }

  return (
    <View testID="slip-pick" style={{ gap: space.md }}>
      <Text style={ls.cap}>{t("labSlip.pick")}</Text>
      {view.header?.name ? <Text style={{ fontSize: 13, color: color.dim }} numberOfLines={1}>{t("labSlip.slipName", { name: view.header.name })}</Text> : null}
      {hint}
      {view.match.noOpenReport === true && <Note tone="info" testID="slip-no-open">{t("labSlip.noOpen")}</Note>}
      {view.candidates.length === 0 && view.match.noOpenReport !== true && <Text style={ls.empty}>{t("labSlip.noCandidates")}</Text>}
      {view.candidates.map((c) => <Candidate key={c.quickReportId} c={c} t={t} on={picked === c.quickReportId} onPress={() => setPicked(c.quickReportId)} />)}
      {err}
      <Button testID="slip-confirm" label={t("labSlip.confirm")} busy={busy} disabled={picked === null} onPress={() => { if (picked !== null) void onAttach(picked); }} />
      <Button testID="slip-keep" kind="secondary" label={t("labSlip.keep")} onPress={onClose} />
      {why === null ? (
        <Button testID="slip-discard" kind="secondary" label={t("labSlip.discard")} onPress={() => setWhy("")} />
      ) : (
        <View style={{ gap: space.sm }}>
          <TextInput testID="slip-discard-reason" value={why} onChangeText={setWhy} placeholder={t("labSlip.discardWhy")}
            style={{ minHeight: 44, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: 10, color: color.ink, backgroundColor: color.card }} />
          <Button testID="slip-discard-go" kind="secondary" label={t("labSlip.discard")} disabled={why.trim() === ""} busy={busy} onPress={() => { void onDiscard(why.trim()); }} />
        </View>
      )}
    </View>
  );
}

const CHIP_STYLE: Record<string, object> = { same: ls.chip, close: ls.chip, pm1: ls.chipWarn, differs: ls.chipRed, unread: ls.chipWarn, before_print: ls.chip };

function Candidate({ c, t, on, onPress }: { c: SlipCandidate; t: T; on: boolean; onPress: () => void }) {
  const chips: [string, string][] = [
    ["name", c.chips.name], ["age", c.chips.age], ["gender", c.chips.gender],
    ...(c.chips.time === "before_print" ? [["time", "before_print"] as [string, string]] : []),
  ];
  return (
    <Pressable testID={`slip-cand-${c.quickReportId}`} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress}
      style={[ls.row, on && { borderColor: color.green, borderWidth: 2 }]}>
      <View style={{ flex: 1, gap: 6 }}>
        <Person p={c.patient} t={t} sub={[c.sampleNo, istTime(c.collectedAt), c.tests.join(", ")].filter((x) => x).join(" · ")} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {chips.map(([k, v]) => <Text key={k} testID={`slip-chip-${c.quickReportId}-${k}`} style={CHIP_STYLE[v] ?? ls.chip}>{t(`labSlip.chip.${k}.${v}`)}</Text>)}
        </View>
      </View>
    </Pressable>
  );
}
