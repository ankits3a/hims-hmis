import { useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { Text } from "../text";
import { color, radius, space, TOUCH, type } from "../theme";
import { Button, MONO, Note, Tag } from "../ui";
import { humanDate, istClock } from "../vitals/rules";
import type { WireDangerFlag } from "../vitals/rules";
import type { DoctorApi, WireAllergyRow, WireDocument, WireRxHistoryItem, WireTimelineItem, WireVisitDetail, WireVisitVitals } from "./api";
import { ageSexOf, ageYearsOn, briefRefill, briefResults, isUnpaid, rowName, shortDay, visitKind } from "./rules";
import type { WirePatientDispense, WirePatientImaging, WirePatientResult, WireQueueEntryView, WireQueuePatient } from "./rules";

/**
 * THE PATIENT, BEFORE THE DOCTOR SPEAKS TO THEM (board `OpdDesk`: "NEXT · TOKEN 13"). What four desks
 * already entered, in the order a doctor asks for it — allergy, why they came in their own words,
 * today's vitals, what the lab and radiology signed since the last visit, what they are on, the past
 * visits and the papers the slip desk filed. Nothing on this card is a suggestion.
 *
 * Every block is its owning module's route under the permission the server already checks. A block
 * the login may not read (403) is simply absent, with one line saying parts are hidden; a sealed
 * record (the patient read answers 404) shows its alias and no demographics.
 */
type T = ReturnType<typeof useI18n>["t"];
type Load<D> = { status: "loading" } | { status: "ok"; data: D } | { status: "hidden" } | { status: "failed" };

/** One read, four outcomes. 403 (and a sealed 404) is "not yours to see" — a state, not an error on the screen. */
function useLoad<D>(run: (() => Promise<D>) | null, key: string): Load<D> {
  const [state, setState] = useState<Load<D>>({ status: "loading" });
  useEffect(() => {
    if (run === null) return;
    let gone = false;
    setState({ status: "loading" });
    run().then(
      (data) => { if (!gone) setState({ status: "ok", data }); },
      (e: unknown) => {
        if (gone) return;
        setState(e instanceof ApiError && (e.status === 403 || e.status === 404) ? { status: "hidden" } : { status: "failed" });
      },
    );
    return () => { gone = true; };
    // `key` names the read; `run` is rebuilt every render and must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

const TILES: readonly { key: "bp" | "pulse" | "spo2" | "tempC" | "rr" | "weightKg"; unit: string }[] = [
  { key: "bp", unit: "mmHg" }, { key: "pulse", unit: "/min" }, { key: "spo2", unit: "%" },
  { key: "tempC", unit: "°C" }, { key: "rr", unit: "/min" }, { key: "weightKg", unit: "kg" },
];

function tileValue(v: WireVisitVitals, key: (typeof TILES)[number]["key"]): string | null {
  if (key === "bp") return v.sbp === null || v.dbp === null ? null : `${v.sbp}/${v.dbp}`;
  const n = v[key];
  return n === null ? null : String(n);
}
/** The flag a tile carries: the bay's own verdict off the saved chart, never a second opinion made here. */
function tileFlag(v: WireVisitVitals, key: (typeof TILES)[number]["key"]): WireDangerFlag | null {
  const of = (k: WireDangerFlag["vital"]) => v.dangerFlags.find((f) => f.vital === k) ?? null;
  const hit = key === "bp" ? (of("sbp") ?? of("dbp")) : key === "weightKg" ? null : of(key);
  return hit;
}

function VitalsCard({ vitals, t }: { vitals: WireVisitVitals | null; t: T }) {
  if (vitals === null) return <Text testID="brief-vitals-none" style={s.dimLine}>{t("mobile.doctor.vitalsNone")}</Text>;
  return (
    <View>
      <View style={s.tiles} testID="brief-vitals">
        {TILES.map(({ key, unit }) => {
          const value = tileValue(vitals, key);
          if (value === null) return null;
          const flag = tileFlag(vitals, key);
          const danger = flag !== null && flag.severity !== "notice";
          const fg = flag === null ? color.ink : danger ? color.red : "#8a5a10";
          return (
            <View key={key} testID={`brief-vital-${key}`}
              // The verdict is a border AND a word, never colour alone.
              style={[s.tile, flag !== null && { borderColor: fg, borderWidth: 2, backgroundColor: danger ? color.redSoft : color.goldSoft }]}>
              <Text style={s.tileKey}>{t(`mobile.doctor.vital.${key}`)}</Text>
              <Text style={[s.tileValue, { color: fg }]}>{value}<Text style={s.tileUnit}> {unit}</Text></Text>
              {flag !== null && (
                <Text testID={`brief-flag-${key}`} style={[s.tileFlag, { color: fg }]}>
                  {t(flag.bound === "max" ? "mobile.doctor.flagHigh" : "mobile.doctor.flagLow").toUpperCase()}
                </Text>
              )}
            </View>
          );
        })}
      </View>
      <Text style={[s.source, { marginTop: space.sm }]}>
        {t("opdConsultV2.vitalsBy", { by: vitals.recordedByName ?? "—", at: istClock(vitals.recordedAt) })}
        {vitals.emergency === true ? ` · ${t("mobile.doctor.emergencySave")}` : ""}
      </Text>
    </View>
  );
}

/** A filed paper, opened large: zoom with the buttons or a double tap, move it with a finger. */
export function PaperViewer({ api, doc, onClose, t }: { api: DoctorApi; doc: WireDocument; onClose: () => void; t: T }) {
  const insets = useSafeAreaInsets();
  const bytes = useLoad(() => api.document(doc.id), `doc:${doc.id}`);
  const [zoom, setZoom] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const step = (by: number) => setZoom((z) => Math.min(4, Math.max(1, Math.round((z + by) * 2) / 2)));
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: "#0c1512", paddingTop: insets.top }} testID="paper-viewer">
        <View style={s.viewerBar}>
          <Text style={s.viewerTitle} numberOfLines={1}>{t(`slipCapture.kinds.${doc.kind}`)} · {shortDay(doc.capturedAt)}</Text>
          <Pressable testID="paper-zoom-out" accessibilityRole="button" accessibilityLabel={t("mobile.doctor.zoomOut")} onPress={() => step(-0.5)} style={s.viewerBtn}><Text style={s.viewerBtnText}>−</Text></Pressable>
          <Text testID="paper-zoom" style={s.viewerZoom}>{Math.round(zoom * 100)}%</Text>
          <Pressable testID="paper-zoom-in" accessibilityRole="button" accessibilityLabel={t("mobile.doctor.zoomIn")} onPress={() => step(0.5)} style={s.viewerBtn}><Text style={s.viewerBtnText}>+</Text></Pressable>
          <Pressable testID="paper-close" accessibilityRole="button" onPress={onClose} style={[s.viewerBtn, { paddingHorizontal: 12, width: undefined }]}><Text style={[s.viewerBtnText, { fontSize: 14 }]}>{t("mobile.doctor.viewerClose")}</Text></Pressable>
        </View>
        <View style={{ flex: 1 }} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {bytes.status === "loading" && <Text style={s.viewerNote}>…</Text>}
          {(bytes.status === "failed" || bytes.status === "hidden") && <Text testID="paper-failed" style={s.viewerNote}>{t("mobile.doctor.paperFailed")}</Text>}
          {bytes.status === "ok" && box.w > 0 && (
            <ScrollView maximumZoomScale={4} minimumZoomScale={1} contentContainerStyle={{ minHeight: box.h }}>
              <ScrollView horizontal contentContainerStyle={{ minWidth: box.w }}>
                <Pressable onPress={() => undefined} onLongPress={() => setZoom(1)} delayLongPress={350}>
                  <Image
                    testID="paper-image" accessibilityLabel={t(`slipCapture.kinds.${doc.kind}`)}
                    source={{ uri: `data:${bytes.data.mimeType};base64,${bytes.data.imageBase64}` }}
                    resizeMode="contain" style={{ width: box.w * zoom, height: box.h * zoom }}
                  />
                </Pressable>
              </ScrollView>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={s.card} testID={testID}>
      <Tag>{title}</Tag>
      <View style={{ marginTop: space.sm, gap: 6 }}>{children}</View>
    </View>
  );
}

export type BriefActions = {
  start: () => void; recall: () => void; skip: () => void; openUnpaid: () => void; undoSkip: () => void;
  park: () => void; resume: () => void; complete: () => void;
};

/** Where the row stands in the line the server sent — the parent reads it off the queue view; nothing is re-derived here. */
export type BriefGroup = "called" | "line" | "held" | "left" | "with" | "parked" | "gone";

export function PatientBrief({ api, entry, group, encounterId, patientId, summary, tokenNo, isHead, busy, error, flash, actions, onBack }: {
  api: DoctorApi;
  /** The row as the line has it NOW — null once the visit has left the line (completed, moved, abandoned). */
  entry: WireQueueEntryView | null; group: BriefGroup;
  encounterId: string; patientId: string; summary: WireQueuePatient | null; tokenNo: number;
  /** First in the callable order with nobody called: starting them is in turn, not ahead of it. */
  isHead: boolean;
  busy: string | null; error: string | null; flash: string | null;
  actions: BriefActions; onBack: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const now = useMemo(() => new Date(), []);

  const visit = useLoad<WireVisitDetail>(() => api.visit(encounterId), `visit:${encounterId}:${group}`);
  const patient = useLoad(() => api.patient(patientId), `patient:${patientId}`);
  const sealed = summary?.restricted === true || patient.status === "hidden";
  const allergies = useLoad(() => api.allergies(patientId), `allergies:${patientId}`);
  const timeline = useLoad(() => api.timeline(patientId), `timeline:${patientId}`);
  const rx = useLoad(() => api.prescriptions(patientId), `rx:${patientId}`);
  const lab = useLoad(() => api.labResults(patientId), `lab:${patientId}`);
  const imaging = useLoad(() => api.imaging(patientId), `imaging:${patientId}`);
  const dispenses = useLoad(() => api.dispenses(patientId), `dispenses:${patientId}`);

  // The papers are metadata until asked for, and each opened page is its own read (its own access-log row).
  const [papersAsked, setPapersAsked] = useState(false);
  const papers = useLoad(papersAsked ? () => api.documents(patientId) : null, `papers:${patientId}:${papersAsked ? 1 : 0}`);
  const [openDoc, setOpenDoc] = useState<WireDocument | null>(null);
  const [allVisits, setAllVisits] = useState(false);

  const name = rowName(summary);
  const demo = sealed ? null
    : patient.status === "ok"
      ? [patient.data.patient.dob === null ? null : (() => { const y = ageYearsOn(patient.data.patient.dob!, now); return y === null ? null : String(y); })(),
        patient.data.patient.administrativeGender === "male" ? "M" : patient.data.patient.administrativeGender === "female" ? "F" : null]
        .filter((x): x is string => x !== null).join(" ") || null
      : ageSexOf(summary, now);

  const v = visit.status === "ok" ? visit.data : null;
  const latestVitals = v === null ? null
    : [...v.vitals].filter((x) => x.status === "active").sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0] ?? null;
  const active: WireAllergyRow[] = allergies.status === "ok" ? allergies.data.items.filter((a) => a.status === "active") : [];

  const past: WireTimelineItem[] = timeline.status === "ok"
    ? timeline.data.items.filter((i) => i.encounterId !== encounterId).sort((a, b) => (a.serviceDate < b.serviceDate ? 1 : -1))
    : [];
  const lastSeen = past.find((i) => i.status === "completed" || i.status === "awaiting_results") ?? null;
  const labRows: WirePatientResult[] = lab.status === "ok" ? lab.data.items : [];
  const imagingRows: WirePatientImaging[] = imaging.status === "ok" ? imaging.data.items : [];
  const results = briefResults(labRows, imagingRows, lastSeen?.serviceDate ?? null);
  const resultsReadable = lab.status === "ok" || imaging.status === "ok";

  const lastRx: WireRxHistoryItem | null = rx.status === "ok"
    ? [...rx.data.items].filter((r) => r.status === "active" && r.encounterId !== encounterId).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1))[0] ?? null
    : null;
  const dispenseRows: WirePatientDispense[] = dispenses.status === "ok" ? dispenses.data.items : [];
  const refill = lastRx === null || dispenses.status !== "ok" ? null : briefRefill(lastRx.prescriptionId, dispenseRows);

  const hiddenParts = [allergies, timeline, rx, lab, imaging].some((l) => l.status === "hidden") && !sealed;
  const kind = entry === null ? null : visitKind(entry);
  const unpaid = (entry !== null && isUnpaid(entry)) || v?.feeUnpaid === true;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Pressable testID="brief-back" accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ minHeight: 36, justifyContent: "center", alignSelf: "flex-start" }}>
          <Text style={{ color: color.green, fontSize: 15, fontWeight: "700" }}>{t("mobile.doctor.backToLine")}</Text>
        </Pressable>

        <View style={s.card} testID="brief-who">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Text style={s.token}>#{tokenNo}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text testID="brief-name" style={s.name} numberOfLines={2}>
                {name.text ?? t(name.sealed ? "mobile.doctor.sealed" : "mobile.doctor.noName")}
                {demo !== null && <Text style={s.demo}>  {demo}</Text>}
              </Text>
              <Text style={s.sub} numberOfLines={1}>
                {[summary?.uhid ?? null, v?.encounter.visitNo ?? null].filter((x) => x !== null).join(" · ")}
              </Text>
              {kind !== null && <Text testID="brief-kind" style={s.sub}>{t(`opdConsultV2.vtShort.${kind}`)}</Text>}
            </View>
          </View>
          {sealed && <Text testID="brief-sealed" style={[s.sub, { marginTop: space.sm, color: "#8a5a10", fontWeight: "700" }]}>{t("opdConsult.restricted")}</Text>}
          {unpaid && (
            <View testID="brief-unpaid" style={s.unpaid}>
              <Text style={s.unpaidText}>₹ {t("unpaid.notPaid")} — {t("unpaid.title")}</Text>
              {(entry?.encounter.consultFeeOverrideReason ?? entry?.encounter.feeBypassReason ?? null) !== null && (
                <Text style={[s.sub, { color: color.red }]}>{t("opdConsult.heldWhy", { reason: entry?.encounter.consultFeeOverrideReason ?? entry?.encounter.feeBypassReason ?? "" })}</Text>
              )}
            </View>
          )}
          {(entry?.encounter.dangerFlagged === true || entry?.danger === true) && (
            <Text testID="brief-danger" style={s.danger}>{t("opdConsult.danger").toUpperCase()}</Text>
          )}
        </View>

        {!sealed && (
          <View testID="brief-allergy"
            style={[s.card, active.length > 0 && { borderColor: color.red, borderWidth: 2, backgroundColor: color.redSoft }]}>
            {allergies.status === "loading" ? <Text style={s.dimLine}>…</Text>
              : allergies.status === "failed" ? <Text style={s.dimLine}>{t("mobile.doctor.allergyTitle")} — {t("mobile.doctor.partFailed")}</Text>
              : allergies.status === "hidden" ? <Text style={s.dimLine}>{t("mobile.doctor.allergyTitle")} —</Text>
              : active.length === 0 ? <Text style={s.dimLine}>{t("mobile.doctor.allergyNone")}</Text>
              : <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: "700", color: color.red }}>
                  {t("opdConsultV2.allergyList", { list: active.map((a) => (a.severity === "severe" ? `${a.substance} (severe)` : a.substance)).join(", ") })}
                </Text>}
          </View>
        )}

        <Section title={t("opdConsultV2.whyCame")} testID="brief-why">
          {visit.status === "loading" ? <Text style={s.dimLine}>…</Text>
            : v?.deskComplaint == null ? <Text style={s.dimLine}>{t("opdConsultV2.noDeskWords")}</Text>
            : (
              <>
                <Text style={s.words}>“{v.deskComplaint.text}”</Text>
                <Text style={s.source}>{t("opdConsultV2.typedBy", { by: v.deskComplaint.by, at: istClock(v.deskComplaint.at) })}</Text>
              </>
            )}
        </Section>

        <Section title={t("mobile.doctor.vitalsTitle")} testID="brief-vitals-card">
          {visit.status === "loading" ? <Text style={s.dimLine}>…</Text>
            : visit.status !== "ok" ? <Text style={s.dimLine}>{t("mobile.doctor.partFailed")}</Text>
            : <VitalsCard vitals={latestVitals} t={t} />}
        </Section>

        {!sealed && resultsReadable && (
          <Section title={t("opdConsultV2.sinceThen")} testID="brief-results">
            {results.lines.length === 0 ? <Text style={s.dimLine}>{t("opdConsultV2.noResults")}</Text>
              : results.lines.map((l, i) => (
                <Text key={i} testID={`brief-result-${i}`} style={[s.line, l.abnormal && { color: color.red, fontWeight: "700" }]}>
                  {l.what}
                  <Text style={s.lineMeta}>  · {l.kind === "lab" ? "lab" : "radiology"} {shortDay(l.day)}{results.noneSince ? ` · ${t("opdConsultV2.noneSince")}` : ""}</Text>
                </Text>
              ))}
          </Section>
        )}

        {!sealed && rx.status !== "hidden" && (
          <Section title={t("opdConsultV2.onNow")} testID="brief-rx">
            {rx.status === "loading" ? <Text style={s.dimLine}>…</Text>
              : rx.status === "failed" ? <Text style={s.dimLine}>{t("mobile.doctor.partFailed")}</Text>
              : lastRx === null ? <Text style={s.dimLine}>{t("mobile.doctor.lastRxNone")}</Text>
              : (
                <>
                  {lastRx.lines.map((l, i) => (
                    <Text key={i} style={s.line}>
                      {l.drug}
                      <Text style={s.lineMeta}>  {[l.dose, l.frequency, l.durationDays === null ? null : `${l.durationDays} d`].filter((x) => x !== null && x !== "").join(" · ")}</Text>
                    </Text>
                  ))}
                  <Text style={s.source}>{t("mobile.doctor.lastRxBy", { date: shortDay(lastRx.serviceDate), doctor: lastRx.doctorName ?? "—" })}</Text>
                  {refill !== null && (
                    <Text testID="brief-refill" style={s.source}>
                      {refill.kind === "none" ? t("opdConsultV2.refillNone")
                        : refill.days === null ? t("opdConsultV2.refillNoDays", { date: shortDay(refill.lastDay) })
                        : refill.times === 1 ? t("opdConsultV2.refillOnce", { days: refill.days, date: shortDay(refill.lastDay), due: refill.dueDay === null ? "—" : shortDay(refill.dueDay) })
                        : t("opdConsultV2.refillTimes", { n: refill.times, date: shortDay(refill.lastDay), days: refill.days, due: refill.dueDay === null ? "—" : shortDay(refill.dueDay) })}
                    </Text>
                  )}
                </>
              )}
          </Section>
        )}

        {timeline.status !== "hidden" && (
          <Section title={t("mobile.doctor.visitsTitle")} testID="brief-visits">
            {timeline.status === "loading" ? <Text style={s.dimLine}>…</Text>
              : timeline.status === "failed" ? <Text style={s.dimLine}>{t("mobile.doctor.partFailed")}</Text>
              : past.length === 0 ? <Text style={s.dimLine}>{t("mobile.doctor.visitsNone")}</Text>
              : (
                <>
                  {(allVisits ? past : past.slice(0, 3)).map((p) => (
                    <View key={p.encounterId} style={s.visitRow}>
                      <Text style={s.visitDay}>{humanDate(p.serviceDate)}</Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={s.line} numberOfLines={2}>{p.diagnosis ?? t("mobile.doctor.noDiagnosis")}</Text>
                        <Text style={s.lineMeta} numberOfLines={1}>{[p.departmentName, p.doctorName].filter((x) => x !== null).join(" · ")}</Text>
                      </View>
                    </View>
                  ))}
                  {!allVisits && past.length > 3 && (
                    <Pressable testID="brief-visits-more" accessibilityRole="button" onPress={() => setAllVisits(true)} hitSlop={8} style={{ minHeight: 36, justifyContent: "center" }}>
                      <Text style={s.link}>{t("mobile.doctor.visitsMore", { count: past.length })}</Text>
                    </Pressable>
                  )}
                </>
              )}
          </Section>
        )}

        {!sealed && (
          <Section title={t("mobile.doctor.papersTitle")} testID="brief-papers">
            {!papersAsked ? <Button testID="brief-papers-show" kind="secondary" label={t("mobile.doctor.papersShow")} onPress={() => setPapersAsked(true)} />
              : papers.status === "loading" ? <Text style={s.dimLine}>…</Text>
              : papers.status !== "ok" ? <Text style={s.dimLine}>{t("mobile.doctor.partFailed")}</Text>
              : papers.data.items.length === 0 ? <Text testID="brief-papers-none" style={s.dimLine}>{t("mobile.doctor.papersNone")}</Text>
              : papers.data.items.map((d) => (
                <Pressable key={d.id} testID={`brief-paper-${d.id}`} accessibilityRole="button" onPress={() => setOpenDoc(d)}
                  style={({ pressed }) => [s.paperRow, pressed && { backgroundColor: color.wash }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.line} numberOfLines={1}>{t(`slipCapture.kinds.${d.kind}`)}</Text>
                    <Text style={s.lineMeta} numberOfLines={1}>{humanDate(d.capturedAt.slice(0, 10))} · {istClock(d.capturedAt)}{d.encounterId === encounterId ? " · ●" : ""}</Text>
                  </View>
                  <Text style={s.link}>{t("mobile.doctor.paperOpen")} ›</Text>
                </Pressable>
              ))}
          </Section>
        )}

        {hiddenParts && <Text testID="brief-hidden" style={s.source}>{t("mobile.doctor.hiddenParts")}</Text>}
        <Text style={s.source}>{t("mobile.doctor.onComputer")}</Text>
      </ScrollView>

      <View style={[s.bar, { paddingBottom: insets.bottom + space.md }]} testID="brief-bar">
        {flash !== null && <Text testID="brief-flash" style={s.flash}>{flash}</Text>}
        {error !== null && <Note tone="bad" testID="brief-error">{error}</Note>}
        {group === "called" && (
          <>
            <Button testID="act-start" label={t("opdConsult.start")} busy={busy === "start"} disabled={busy !== null} onPress={actions.start} />
            <View style={s.barRow}>
              <View style={{ flex: 1 }}><Button testID="act-recall" kind="secondary" label={t("mobile.doctor.recallShort")} busy={busy === "recall"} disabled={busy !== null} onPress={actions.recall} /></View>
              <View style={{ width: 110 }}><Button testID="act-skip" kind="secondary" label={t("opdConsult.skip")} disabled={busy !== null} onPress={actions.skip} /></View>
            </View>
          </>
        )}
        {group === "held" && (
          <Button testID="act-open-unpaid" label={t("opdConsult.openUnpaid")} disabled={busy !== null} onPress={actions.openUnpaid} />
        )}
        {group === "line" && (
          <>
            {!isHead && <Text style={s.barHint}>{t("mobile.doctor.startAheadHint")}</Text>}
            <Button testID="act-start" kind={isHead ? "primary" : "secondary"} label={t(isHead ? "opdConsult.start" : "mobile.doctor.startAhead")} busy={busy === "start"} disabled={busy !== null} onPress={actions.start} />
          </>
        )}
        {group === "left" && <Button testID="act-undo-skip" label={t("opdConsult.undoSkip")} busy={busy === "undo"} disabled={busy !== null} onPress={actions.undoSkip} />}
        {group === "parked" && <Button testID="act-resume" label={t("opdConsultV2.resumeConsult")} busy={busy === "resume"} disabled={busy !== null} onPress={actions.resume} />}
        {group === "with" && (
          <>
            <Button testID="act-complete" label={t("opdConsult.complete")} busy={busy === "complete"} disabled={busy !== null} onPress={actions.complete} />
            <Button testID="act-park" kind="secondary" label={t("opdConsult.park")} busy={busy === "park"} disabled={busy !== null} onPress={actions.park} />
          </>
        )}
        {group === "gone" && <Button testID="act-back" kind="secondary" label={t("mobile.doctor.backToLine").replace("‹ ", "")} onPress={onBack} />}
      </View>

      {openDoc !== null && <PaperViewer api={api} doc={openDoc} onClose={() => setOpenDoc(null)} t={t} />}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.lg },
  token: { fontFamily: MONO, fontSize: 30, fontWeight: "700", color: color.ink },
  name: { fontSize: 20, lineHeight: 25, fontWeight: "700", color: color.ink },
  demo: { fontSize: 16, fontWeight: "500", color: color.dim },
  sub: { ...type.small, color: color.dim, marginTop: 2 },
  unpaid: { marginTop: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.redLine, backgroundColor: color.redSoft, gap: 4 },
  unpaidText: { fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.red },
  danger: { marginTop: space.md, alignSelf: "flex-start", fontFamily: MONO, fontSize: 12, fontWeight: "700", letterSpacing: 1, color: color.red, borderWidth: 2, borderColor: color.red, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  dimLine: { ...type.body, color: color.dim },
  words: { fontSize: 17, lineHeight: 24, color: color.ink },
  source: { fontSize: 12.5, lineHeight: 18, color: color.faint },
  line: { fontSize: 15, lineHeight: 21, color: color.ink },
  lineMeta: { fontSize: 13, lineHeight: 19, color: color.dim, fontWeight: "400" },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: { flexBasis: "47%", flexGrow: 1, minWidth: 130, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: color.card },
  tileKey: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, color: color.dim, textTransform: "uppercase" },
  tileValue: { fontFamily: MONO, fontSize: 20, fontWeight: "700", marginTop: 2 },
  tileUnit: { fontSize: 11, fontWeight: "400", color: color.dim },
  tileFlag: { fontFamily: MONO, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 2 },
  visitRow: { flexDirection: "row", gap: space.md, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 },
  visitDay: { fontFamily: MONO, fontSize: 12, color: color.dim, width: 92, paddingTop: 3 },
  paperRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 4, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line2 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  barRow: { flexDirection: "row", gap: space.sm },
  barHint: { fontSize: 12.5, lineHeight: 18, color: color.dim },
  flash: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: color.green },
  viewerBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: space.md, paddingVertical: space.sm },
  viewerTitle: { flex: 1, color: "#d9efe4", fontSize: 14, fontWeight: "600" },
  viewerBtn: { minHeight: 40, width: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: "rgba(217,239,228,.25)" },
  viewerBtnText: { color: "#f2faf6", fontSize: 20, fontWeight: "700" },
  viewerZoom: { color: "#7fa392", fontFamily: MONO, fontSize: 12, width: 44, textAlign: "center" },
  viewerNote: { color: "#d9efe4", textAlign: "center", marginTop: 80, fontSize: 15 },
});
