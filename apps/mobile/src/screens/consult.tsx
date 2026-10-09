import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeleCallPanel, hasSpoken, isTele } from "../consult/tele-call";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { consultApi } from "../consult/api";
import { draftStore } from "../consult/draft";
import { useVoiceRecorder } from "../consult/recorder";
import {
  addLine, adviceOf, applySet, emptyDraft, isEmptyDraft, issuedCounts, lineComplete, lineSignals, lineSub, lineText, linesFrom, noteBody, overridesOf, repeatLast, setBodyOf,
  unanswered, warningsOf, wireLine,
} from "../consult/rules";
import { AdviceDrawer, DiagnosisDrawer, MedicinesDrawer, NotesDrawer, SetsDrawer, type Patch } from "../consult/sheets";
import { ageSexOf, ageYearsOn, followUpChoices, guardianBrief, reportsCard, rowName, visitKind } from "../doctor/rules";
import type { ReportsCard } from "../doctor/rules";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { Text } from "../text";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO, Note, keyboardScrollInsets } from "../ui";
import { refusalText } from "../vitals/api";
import type { ConsultApi, WireConsultVisit, WireRxSet } from "../consult/api";
import type { Band, ConsultDraft, WireLastLine, WirePrecheck } from "../consult/rules";
import { bandOf, childDoseMissing } from "../consult/rules";
import { SUGGEST_DEFAULT, type SuggestState } from "../consult/signals";
import type { DoctorApi, WireAllergyRow, WireVisitDetail, WireVisitVitals } from "../doctor/api";
import type { WireFollowUpConfig, WireQueueEntryView, WireQueuePatient } from "../doctor/rules";
import { TestsDrawer } from "../consult/sheets";

/**
 * THE DOCTOR'S CONSULTATION, ON A PHONE (decision 0048; board "Phone consult", owner 2026-10-07:
 * "keep the screen clean and minimal and yet give full control to the doctor").
 *
 * ONE SCREEN, FIVE DRAWERS. The patient, what the desks recorded, and one card — "This visit" —
 * that fills up as the doctor works. Notes, Diagnosis, Medicines, Tests and Advice each open a
 * sheet and close back to this screen. Nothing here decides anything clinical:
 *
 *   the note        `PUT consult/note` — the web consultation's own autosave route
 *   the checks      `POST rx-precheck` while writing, and the issue route runs every one again
 *   issue           `POST prescriptions`, with the reasons the doctor typed for hard warnings
 *   complete        `POST consult/complete`, naming `rxDraft: null` — nothing is left behind
 *
 * NOTHING TYPED IS LOST, AND NOTHING IS SENT BY ITSELF: the draft is kept in the phone's secure
 * store on every change; an Issue that the network drops stays on screen and says what did and did
 * not go; a retry re-reads the visit first so a prescription is never issued twice.
 *
 * NO PRINTING AND NO "AFTER" SCREEN (owner, 2026-10-07): issuing returns to the line, which says
 * what was sent for a few seconds.
 */
type Drawer = null | "notes" | "dx" | "meds" | "tests" | "advice" | "sets";
type T = ReturnType<typeof useI18n>["t"];

const says = (e: unknown, t: T): string => (e instanceof NetworkError ? t("mobile.network") : e instanceof ApiError ? refusalText(e.body, e.code) : String(e));
const buzz = (ok: boolean): void => { void Haptics.notificationAsync(ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined); };

/** What the server already holds for this visit, as a draft — a visit begun on the computer opens on the phone as it stands. */
export function draftFromVisit(v: WireConsultVisit, now: number): ConsultDraft {
  const e = v.encounter;
  const d = emptyDraft(e.id, now);
  const rows: WireLastLine[] = (Array.isArray(e.rxDraft) ? e.rxDraft : []).filter((r) => typeof r.drug === "string" && r.drug.trim() !== "").map((r) => ({
    drug: r.drug ?? "", dose: r.dose ?? "", route: r.route ?? "oral", frequency: r.frequency ?? "",
    durationDays: typeof r.durationDays === "number" ? r.durationDays : Number.isInteger(Number(r.durationDays)) && Number(r.durationDays) > 0 ? Number(r.durationDays) : null,
    instructions: r.instructions ?? null, medicineId: r.medicineId ?? null,
  }));
  return {
    ...d,
    complaints: (e.chiefComplaint ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "").slice(0, 12),
    notes: e.doctorNote ?? "",
    diagnoses: (e.diagnosis ?? "").trim() === "" ? [] : [{ text: (e.diagnosis ?? "").trim(), icd10Code: null }],
    adviceText: e.advice ?? "",
    tests: Array.isArray(e.advisedTests) ? e.advisedTests : [],
    lines: linesFrom(rows),
  };
}

export function ConsultScreen({ doctorApi, encounterId, patientId, tokenNo, entry, summary, cfg, onDone, onPaper, onHistory, onPark, parkBusy }: {
  doctorApi: DoctorApi; encounterId: string; patientId: string; tokenNo: number;
  entry: WireQueueEntryView | null; summary: WireQueuePatient | null; cfg: WireFollowUpConfig | null;
  /** Issued and completed: back to the line, which says this for a few seconds. */
  onDone: (line: string) => void;
  /** "I wrote on paper" — the paper road's own completion (slip desk and scribe), unchanged. */
  onPaper: () => void;
  onHistory: () => void; onPark: () => void; parkBusy: boolean;
}) {
  const { t } = useI18n();
  const { call } = useSession();
  const insets = useSafeAreaInsets();
  const api: ConsultApi = useMemo(() => consultApi(call), [call]);
  const recorder = useVoiceRecorder();
  const now = useMemo(() => new Date(), []);

  const [draft, setDraft] = useState<ConsultDraft | null>(null);
  const [visit, setVisit] = useState<WireVisitDetail | null>(null);
  const [reports, setReports] = useState<ReportsCard | null>(null);
  const [allergies, setAllergies] = useState<WireAllergyRow[]>([]);
  const [last, setLast] = useState<{ serviceDate: string; lines: WireLastLine[] } | null>(null);
  const [setsCount, setSetsCount] = useState<{ mine: number; hospital: number } | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [medStart, setMedStart] = useState<{ medicineId: string | null; name: string } | "new" | null>(null);
  const [precheck, setPrecheck] = useState<WirePrecheck | null>(null);
  /**
   * Suggestions are offered when the hospital's switch AND this doctor's own are on (decision 0050 P0),
   * less what the doctor has crossed off three times. Read once as the visit opens — nothing re-ranks
   * while the doctor is working. Unknown ⇒ on; a server older than the route answers the hospital's switch.
   */
  const [suggest, setSuggest] = useState<SuggestState>(SUGGEST_DEFAULT);
  useEffect(() => {
    api.suggestionState().then((v) => setSuggest({ on: v.on && v.hospitalOn, hidden: v.hidden }))
      .catch(() => api.voiceStatus().then((v) => setSuggest({ on: v.suggestionsEnabled !== false, hidden: [] })).catch(() => undefined));
  }, [api]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Paper with medicines typed here asks once: those lines will not be issued. */
  const [paperAsk, setPaperAsk] = useState(false);
  /** Set once this screen's issue has reached the server — a retry then re-reads the visit before issuing again. */
  const issueSent = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * ADULT OR CHILD, as the server bands it: the charted weight first, else the age. For a child a set
   * or "Repeat last" brings the medicines WITHOUT dose (owner 2026-10-07) — the doctor enters each.
   */
  const bandNow = (): Band => {
    const w = visit === null ? null : [...visit.vitals].filter((x) => x.status === "active" && x.weightKg !== null).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0]?.weightKg ?? null;
    const dob = summary !== null && !summary.restricted && typeof summary.dob === "string" && summary.dob !== "" ? summary.dob : null;
    return bandOf({ ageYears: dob === null ? null : ageYearsOn(dob, now), weightKg: w });
  };
  const days = useCallback((n: number): string => t("mobile.consult.days", { count: n }), [t]);
  const food = useMemo(() => ({ before: t("mobile.consult.foodBefore"), after: t("mobile.consult.foodAfter") }), [t]);
  const review = useCallback((n: number): string => t("mobile.consult.reviewLine", { count: n }), [t]);

  // ——— open: the phone's own draft first, else what the server holds ———
  useEffect(() => {
    let live = true;
    void (async () => {
      const kept = await draftStore.load(encounterId);
      try {
        const v = await call<WireVisitDetail & WireConsultVisit>("GET", `/opd/visits/${encodeURIComponent(encounterId)}`);
        if (!live) return;
        setVisit(v);
        setDraft(kept ?? draftFromVisit(v, Date.now()));
      } catch (e) {
        if (!live) return;
        if (kept !== null) { setDraft(kept); setOffline(e instanceof NetworkError); } else setLoadError(says(e, t));
      }
    })();
    doctorApi.allergies(patientId).then((a) => { if (live) setAllergies(a.items.filter((x) => x.status === "active")); }).catch(() => undefined);
    api.lastPrescriptions(patientId).then((items) => {
      const l = [...items].filter((r) => r.status === "active" && r.encounterId !== encounterId).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1))[0];
      if (live && l !== undefined && l.lines.length > 0) setLast({ serviceDate: l.serviceDate, lines: l.lines });
    }).catch(() => undefined);
    api.sets().then((r) => { if (live) setSetsCount({ mine: r.items.filter((x) => x.mine).length, hospital: r.items.filter((x) => !x.mine && x.signed).length }); }).catch(() => undefined);
    return () => { live = false; if (saveTimer.current !== null) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId]);

  const guardianNow = visit?.patientAbsent ?? entry?.encounter.patientAbsent ?? null;
  /*
    THE REPORTS THE GUARDIAN CAME TO SHOW (owner 2026-10-09) — read only on a guardian's visit, through
    the three reads the patient page already makes (each gated and logged on its own route): the lab's
    and radiology's signed results and the timeline that says when the last visit was. A read this
    login is refused is simply empty; no result since the last visit draws no card.
  */
  const isGuardianVisit = guardianNow !== null;
  useEffect(() => {
    if (!isGuardianVisit) return;
    let live = true;
    const or = <D,>(p: Promise<D>, d: D): Promise<D> => p.catch(() => d);
    void Promise.all([
      or(doctorApi.labResults(patientId), { items: [] }), or(doctorApi.imaging(patientId), { items: [] }), or(doctorApi.timeline(patientId), { items: [] }),
    ]).then(([lab, imaging, timeline]) => {
      if (!live) return;
      // "Last visit" exactly as the patient page's results block reads it (doctor/brief.tsx `lastSeen`).
      const lastSeen = timeline.items.filter((i) => i.encounterId !== encounterId).sort((a, b) => (a.serviceDate < b.serviceDate ? 1 : -1))
        .find((i) => i.status === "completed" || i.status === "awaiting_results") ?? null;
      setReports(reportsCard(t, lab.items, imaging.items, lastSeen?.serviceDate ?? null));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuardianVisit, encounterId, patientId, t]);

  /** Every change is kept on the phone at once (debounced) — the draft is the screen's truth. */
  const patch: Patch = useCallback((next) => {
    setDraft((d) => {
      if (d === null) return d;
      const out = { ...next(d), updatedAt: Date.now() };
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { void draftStore.save(out); }, 300);
      return out;
    });
    setError(null); setPaperAsk(false);
  }, []);

  const complete = useMemo(() => (draft === null ? [] : draft.lines.map((l, i) => ({ l, i })).filter((x) => lineComplete(x.l))), [draft]);
  /** The server's pre-check, with its line numbers mapped back onto the draft's own. */
  const runPrecheck = useCallback(async (d: ConsultDraft): Promise<WirePrecheck | null> => {
    const ready = d.lines.map((l, i) => ({ l, i })).filter((x) => lineComplete(x.l));
    if (ready.length === 0) { setPrecheck(null); return null; }
    setChecking(true);
    try {
      const p = await api.precheck(encounterId, ready.map((x) => wireLine(x.l, food)));
      const at = (n: number): number => ready[n]?.i ?? n;
      const mapped: WirePrecheck = {
        allergyMatches: p.allergyMatches.map((h) => ({ ...h, lineIndex: at(h.lineIndex) })),
        interactions: p.interactions.map((h) => ({ ...h, lineIndex: at(h.lineIndex) })),
        duplicates: p.duplicates.map((h) => ({ ...h, lineIndex: at(h.lineIndex) })),
        drugDisease: p.drugDisease.map((h) => ({ ...h, lineIndex: at(h.lineIndex) })),
      };
      setPrecheck(mapped); setOffline(false);
      return mapped;
    } catch (e) {
      if (e instanceof NetworkError) setOffline(true);
      return null;
    } finally {
      setChecking(false);
    }
  }, [api, encounterId, food]);

  const linesKey = draft === null ? "" : draft.lines.map((l) => `${l.drug}|${l.dose}|${l.frequency}|${String(l.durationDays)}|${String(l.medicineId)}`).join(";");
  useEffect(() => { if (draft !== null) void runPrecheck(draft); }, [linesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const warnings = useMemo(() => warningsOf(precheck, draft?.lines ?? []), [precheck, draft]);
  const open = unanswered(warnings, draft?.reasons ?? {});

  /** Closing a drawer saves the note on the server too when there is a network — the computer then shows the same visit. */
  const closeDrawer = (): void => {
    setDrawer(null); setMedStart(null);
    if (draft === null || isEmptyDraft(draft)) return;
    api.saveNote(encounterId, noteBody(draft, review, food, "draft")).then(() => setOffline(false)).catch((e) => { if (e instanceof NetworkError) setOffline(true); });
  };

  const issue = async (): Promise<void> => {
    const d = draft;
    if (d === null || busy !== null) return;
    setError(null);
    if (isEmptyDraft(d)) { setError(t("mobile.consult.nothingYet")); return; }
    if (d.lines.some((l) => !lineComplete(l))) { setError(t("mobile.consult.incomplete")); setDrawer("meds"); return; }
    setBusy("issue");
    try {
      let rxIssued = false;
      if (issueSent.current) {
        // The last attempt's answer was lost. Ask the server what it holds before sending anything again.
        const v = await api.visit(encounterId);
        rxIssued = v.prescriptions.some((p) => p.status === "active");
        if (v.encounter.status !== "in_consultation") { await finish(d); return; }
      }
      const wire = d.lines.map((l) => wireLine(l, food));
      if (wire.length > 0 && !rxIssued) {
        const p = await runPrecheck(d);
        const ws = warningsOf(p, d.lines);
        if (unanswered(ws, d.reasons).length > 0) { buzz(false); setError(t("mobile.consult.reasonsMissing", { count: unanswered(ws, d.reasons).length })); setDrawer("meds"); return; }
        await api.saveNote(encounterId, noteBody(d, review, food, "draft"));
        issueSent.current = true;
        await api.issue(encounterId, { lines: wire, ...overridesOf(ws, d.reasons) });
      }
      issueSent.current = true;
      if (!rxIssued) void api.signals({ suggestions: lineSignals(d.lines, encounterId) }).catch(() => undefined);
      await api.complete(encounterId, {
        note: noteBody(d, review, food, "issued"),
        testsOrderedReturnToday: d.returnToday === true,
        ...(d.returnToday === true || d.followUpSend === null ? {} : { followUpDays: d.followUpSend }),
      });
      await finish(d);
    } catch (e) {
      buzz(false);
      if (e instanceof NetworkError) { setOffline(true); setError(t(issueSent.current ? "mobile.consult.lostAnswer" : "mobile.consult.notSent")); } else {
        // A refusal: the server said no, so nothing of this attempt stands and the next one starts clean.
        if (e instanceof ApiError && e.status < 500) issueSent.current = false;
        setError(says(e, t));
        if (e instanceof ApiError && /conflict$/.test(e.code) && e.code !== "encounter_state_conflict") { await runPrecheck(d); setDrawer("meds"); }
      }
    } finally {
      setBusy(null);
    }
  };
  const finish = async (d: ConsultDraft): Promise<void> => {
    await draftStore.clear(encounterId);
    buzz(true);
    const c = issuedCounts(d);
    onDone([
      t("mobile.consult.doneHead", { token: tokenNo }),
      c.medicines > 0 ? t("mobile.consult.doneMedicines", { count: c.medicines }) : null,
      c.tests > 0 ? t("mobile.consult.doneTests", { count: c.tests }) : null,
      c.reviewDays === null ? null : t("mobile.consult.doneReview", { count: c.reviewDays }),
    ].filter((x) => x !== null).join(" · "));
  };

  /** Paper: what was typed for medicines here is withdrawn (the paper is the prescription), then the paper road's own completion. */
  const paper = async (): Promise<void> => {
    if (draft === null || busy !== null) return;
    if (draft.lines.length > 0 && !paperAsk) { setPaperAsk(true); return; }
    setPaperAsk(false);
    setBusy("paper"); setError(null);
    try {
      if (draft.lines.length > 0) await api.saveNote(encounterId, { rxDraft: [] });
      await draftStore.clear(encounterId);
      onPaper();
    } catch (e) {
      setError(says(e, t));
    } finally {
      setBusy(null);
    }
  };

  const useSet = (set: WireRxSet): void => {
    patch((d) => applySet(d, set.name, set.body, (id) => d.tests.find((x) => x.serviceId === id)?.pricePaise ?? 0, Date.now(), bandNow()));
    setDrawer(null);
  };

  if (loadError !== null) return <View style={{ padding: space.lg }}><Note tone="bad" testID="consult-load-error">{loadError}</Note></View>;
  if (draft === null) return <View style={{ padding: space.lg }}><Text testID="consult-loading" style={{ color: color.dim }}>{t("mobile.doctor.loading")}</Text></View>;

  const name = rowName(summary);
  const demo = ageSexOf(summary, now);
  const kind = entry === null ? null : visitKind(entry);
  const vit: WireVisitVitals | null = visit === null ? null : [...visit.vitals].filter((x) => x.status === "active").sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0] ?? null;
  const flagged = (k: string): boolean => vit?.dangerFlags.some((f) => (f as { key?: string }).key === k) === true;
  const empty = isEmptyDraft(draft);
  // Owner 2026-10-09 — a tele-call is completed, and its prescription issued, only after the doctor has spoken (the server's rule).
  const tele = isTele(visit?.encounter);
  const teleLocked = tele && !hasSpoken(visit?.encounter);
  const advice = adviceOf(draft, review);
  const counts = [
    draft.complaints.length > 0 || draft.notes.trim() !== "" ? "✓" : null, draft.diagnoses.length > 0 ? String(draft.diagnoses.length) : null,
    draft.lines.length > 0 ? String(draft.lines.length) : null, draft.tests.length > 0 ? String(draft.tests.length) : null, advice !== null ? "✓" : null,
  ];
  const five: { key: Exclude<Drawer, null | "sets">; glyph: string; label: string }[] = [
    { key: "notes", glyph: "✎", label: t("mobile.consult.five.notes") }, { key: "dx", glyph: "◎", label: t("mobile.consult.five.dx") },
    { key: "meds", glyph: "℞", label: t("mobile.consult.five.meds") }, { key: "tests", glyph: "⚗", label: t("mobile.consult.five.tests") },
    { key: "advice", glyph: "☰", label: t("mobile.consult.five.advice") },
  ];
  const row = (label: string, body: React.ReactNode, to: Exclude<Drawer, null>, testID: string) => (
    <Pressable testID={testID} accessibilityRole="button" onPress={() => setDrawer(to)} style={s.ln}>
      <Text style={s.lnKey}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{body}</View>
    </Pressable>
  );
  const fromLabel = draft.from === null ? null : draft.from.startsWith("repeat:") ? t("mobile.consult.fromRepeat", { date: draft.from.slice(7) }) : t("mobile.consult.fromSet", { name: draft.from });

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView {...keyboardScrollInsets()} contentContainerStyle={{ padding: space.lg, paddingBottom: 190, gap: space.md }} keyboardShouldPersistTaps="handled">
        <View style={s.card} testID="consult-who">
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text style={s.token}>#{tokenNo}</Text>
            <Text testID="consult-name" style={s.name} numberOfLines={1}>{name.text ?? t(name.sealed ? "mobile.doctor.sealed" : "mobile.doctor.noName")}</Text>
            {demo !== null && <Text style={s.demo}>{demo}</Text>}
          </View>
          <View style={s.pills}>
            {kind !== null && <Text style={s.pill}>{t(`opdConsultV2.vtShort.${kind}`)}</Text>}
            {allergies.map((a) => <Text key={a.id} testID="consult-allergy" style={[s.pill, s.pillRed]}>{t("mobile.consult.allergy", { substance: a.substance })}</Text>)}
          </View>
          {guardianNow !== null && (
            // Owner 2026-10-09 — only a guardian came with the reports: one line under the chips, where the eye starts.
            <Text testID="consult-guardian" accessibilityRole="text" numberOfLines={1} style={s.guardian}>{guardianBrief(t, guardianNow).compact}</Text>
          )}
          {vit !== null && (
            <View style={s.vitals} testID="consult-vitals">
              {vit.sbp !== null && vit.dbp !== null && <Text style={[s.vit, flagged("bp") && s.vitHi]}>BP {vit.sbp}/{vit.dbp}</Text>}
              {vit.pulse !== null && <Text style={[s.vit, flagged("pulse") && s.vitHi]}>{t("mobile.consult.pulse")} {vit.pulse}</Text>}
              {vit.spo2 !== null && <Text style={[s.vit, flagged("spo2") && s.vitHi]}>SpO₂ {vit.spo2}</Text>}
              {vit.tempC !== null && <Text style={[s.vit, flagged("tempC") && s.vitHi]}>{t("mobile.consult.temp")} {vit.tempC} °C</Text>}
              {vit.weightKg !== null && <Text style={s.vit}>{vit.weightKg} kg</Text>}
              {vit.glucoseMgDl != null && (
                <Text testID="consult-glucose" style={s.vit}>{t("vitalsBay.tile.glucoseMgDl")} {vit.glucoseMgDl} mg/dL{vit.glucoseTiming == null ? "" : ` · ${t(`vitalsBay.glucose.timing.${vit.glucoseTiming}`)}`}</Text>
              )}
            </View>
          )}
          {(visit?.deskComplaint ?? null) !== null && <Text testID="consult-desk-words" style={s.said}>{t("mobile.consult.toldDesk", { words: visit!.deskComplaint!.text })}</Text>}
          <Pressable testID="consult-history" accessibilityRole="button" hitSlop={8} onPress={onHistory} style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}>
            <Text style={s.link}>{t("mobile.consult.history")}</Text>
          </Pressable>
        </View>

        {guardianNow !== null && reports !== null && (
          // What the guardian came to show: the in-house results signed since the last visit (the patient page's own rule).
          <View style={[s.card, { gap: 2 }]} testID="consult-reports">
            <Text style={s.cardTitle} numberOfLines={1}>{reports.title}</Text>
            {reports.lines.map((r, i) => (
              <View key={i} testID={`consult-report-${i}`} style={{ flexDirection: "row" }}>
                <Text style={[s.report, { flexShrink: 1 }, r.abnormal && s.reportHi]} numberOfLines={1}>{r.name}</Text>
                {/* No line limit here: it never shrinks, so it never wraps — and a one-line limit makes a browser drop its leading space. */}
                <Text style={[s.report, { flexShrink: 0 }, r.abnormal && s.reportHi]}>{r.rest}</Text>
              </View>
            ))}
            {reports.more > 0 && <Text testID="consult-reports-more" style={s.reportMore}>+{reports.more}</Text>}
          </View>
        )}

        {tele && visit !== null && (
          <TeleCallPanel
            api={api} encounterId={encounterId} visit={visit.encounter} slotAt={visit.teleSlotAt}
            onSpoke={(e) => setVisit((v) => (v === null ? v : { ...v, encounter: { ...v.encounter, ...e } }))}
            onLeft={onDone}
          />
        )}
        {offline && <Note tone="warn" testID="consult-offline">{t("mobile.consult.offline")}</Note>}

        <View style={s.quick}>
          <Pressable testID="repeat-last" accessibilityRole="button" disabled={last === null} onPress={() => { if (last !== null) patch((d) => repeatLast(d, last, Date.now(), bandNow())); }} style={[s.quickBtn, last === null && { opacity: 0.5 }]}>
            <Text style={s.quickTitle}>{t("mobile.consult.repeatLast")}</Text>
            <Text style={s.quickSub}>{last === null ? t("mobile.consult.repeatNone") : t("mobile.consult.repeatSub", { date: last.serviceDate, count: last.lines.length })}</Text>
          </Pressable>
          <Pressable testID="my-sets" accessibilityRole="button" onPress={() => setDrawer("sets")} style={s.quickBtn}>
            <Text style={s.quickTitle}>{t("mobile.consult.sets.title")}</Text>
            <Text style={s.quickSub}>{setsCount === null ? " " : t("mobile.consult.sets.count", { mine: setsCount.mine, hospital: setsCount.hospital })}</Text>
          </Pressable>
        </View>

        <View style={s.card} testID="this-visit">
          <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <Text style={s.cardTitle}>{t("mobile.consult.thisVisit")}</Text>
            <Text testID="visit-state" style={s.corner} numberOfLines={1}>{empty ? t("mobile.consult.nothing") : fromLabel ?? t(offline ? "mobile.consult.draftNotSent" : "mobile.consult.draftSaved")}</Text>
          </View>
          {empty && <Text testID="visit-empty" style={s.emptyText}>{t("mobile.consult.emptyHint")}</Text>}
          {childDoseMissing(draft, bandNow()) && <Note tone="warn" testID="visit-child-no-dose">{t("mobile.consult.childNoDose")}</Note>}
          {(draft.complaints.length > 0 || draft.notes.trim() !== "") && row(t("mobile.consult.five.notes"),
            <Text style={s.lnText}>{[draft.complaints.join(", "), draft.notes.trim()].filter((x) => x !== "").join(". ")}</Text>, "notes", "visit-notes")}
          {draft.diagnoses.length > 0 && row(t("mobile.consult.five.dx"), <>{draft.diagnoses.map((d) => (
            <Text key={d.text} style={s.lnText}><Text style={{ fontWeight: "700" }}>{d.text}</Text>{d.icd10Code === null ? "" : `  ${d.icd10Code}`}</Text>))}</>, "dx", "visit-dx")}
          {draft.lines.map((l, i) => {
            const w = warnings.filter((x) => x.lineIndex === i);
            const hard = w.some((x) => x.hard);
            return (
              <Pressable key={`${String(i)}-${l.drug}`} testID={`visit-line-${String(i)}`} accessibilityRole="button" onPress={() => setDrawer("meds")} style={s.ln}>
                <Text style={s.lnKey}>{i === 0 ? t("mobile.consult.five.meds") : ""}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.lnText}><Text style={{ fontWeight: "700" }}>{l.drug}</Text>{lineText({ ...l, drug: "" }, days) === "" ? "" : ` · ${lineText({ ...l, drug: "" }, days)}`}
                    {l.mark === "new" ? <Text style={s.mark}>  {t("mobile.consult.markNew")}</Text> : null}</Text>
                  {lineSub(l, food) !== "" && <Text style={s.lnSub}>{lineSub(l, food)}</Text>}
                  {l.mark === "changed" && l.was !== null && l.was !== undefined && <Text style={[s.lnSub, { color: "#8a5a10" }]}>{t("mobile.consult.markChanged", { was: l.was })}</Text>}
                  {!lineComplete(l) && <Text style={[s.lnSub, { color: color.red, fontWeight: "700" }]}>{t("mobile.consult.lineIncomplete")}</Text>}
                  {w.length > 0 && <Text testID={`visit-warn-${String(i)}`} style={[s.lnSub, { color: hard ? color.red : "#8a5a10", fontWeight: "700" }]}>
                    {t(hard ? "mobile.consult.warnHard" : "mobile.consult.warnSoft", { count: w.length })}</Text>}
                </View>
              </Pressable>
            );
          })}
          {draft.tests.length > 0 && row(t("mobile.consult.five.tests"), <Text style={s.lnText}>{draft.tests.map((x) => x.name).join(" · ")}</Text>, "tests", "visit-tests")}
          {advice !== null && row(t("mobile.consult.five.advice"), <Text style={s.lnText}>{advice}</Text>, "advice", "visit-advice")}
          {draft.returnToday === true && row("", <Text style={[s.lnText, { color: "#8a5a10", fontWeight: "700" }]}>{t("mobile.consult.returnTodayShort")}</Text>, "advice", "visit-return")}
        </View>

        <Pressable testID="consult-park" accessibilityRole="button" disabled={parkBusy} hitSlop={6} onPress={onPark} style={{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }}>
          <Text style={[s.link, { color: color.dim }]}>{t("opdConsult.park")}</Text>
        </Pressable>
      </ScrollView>

      <View style={[s.foot, { paddingBottom: insets.bottom + space.sm }]} testID="consult-foot">
        {error !== null && <Note tone="bad" testID="consult-error">{error}</Note>}
        {paperAsk && <Note tone="warn" testID="paper-ask">{t("mobile.consult.paperAsk", { count: draft.lines.length })}</Note>}
        <View style={s.five}>
          {five.map((f, i) => (
            <Pressable key={f.key} testID={`open-${f.key}`} accessibilityRole="button" accessibilityLabel={f.label} onPress={() => { setMedStart(null); setDrawer(f.key); }} style={[s.fiveBtn, counts[i] !== null && s.fiveOn]}>
              <Text style={s.fiveGlyph}>{f.glyph}</Text>
              <Text style={s.fiveLabel} numberOfLines={1}>{f.label}</Text>
              {counts[i] !== null && <Text testID={`count-${f.key}`} style={s.fiveCount}>{counts[i]}</Text>}
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Pressable testID="wrote-on-paper" accessibilityRole="button" accessibilityState={{ disabled: busy !== null || teleLocked }} disabled={busy !== null || teleLocked} hitSlop={6} onPress={() => { void paper(); }} style={{ minHeight: TOUCH, justifyContent: "center", paddingRight: 4, opacity: teleLocked ? 0.4 : 1 }}>
            <Text style={[s.link, { color: paperAsk ? color.red : color.dim, textDecorationLine: "underline" }]}>{t(paperAsk ? "mobile.consult.paperConfirm" : "mobile.consult.paper")}</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Button testID="issue-complete" busy={busy === "issue"} disabled={empty || busy !== null || teleLocked}
              label={open.length > 0 ? t("mobile.consult.issueBlocked", { count: open.length }) : t(draft.lines.length === 0 ? "mobile.consult.completeOnly" : "mobile.consult.issue")}
              onPress={() => { if (open.length > 0) setDrawer("meds"); else void issue(); }} />
          </View>
        </View>
      </View>

      {drawer === "notes" && <NotesDrawer api={api} encounterId={encounterId} draft={draft} patch={patch} onClose={closeDrawer} recorder={recorder} deskWords={visit?.deskComplaint?.text ?? null}
        // A heard medicine becomes a line with no dose yet: it is flagged, it cannot be issued until the
        // doctor finishes it, and what was heard stays on the screen meanwhile.
        onAddMedicine={(h) => patch((d) => (d.lines.some((l) => l.medicineId === h.medicineId) ? d : addLine(d, { drug: h.name, dose: "", frequency: "", durationDays: null, food: null, instructions: "", route: "oral", medicineId: h.medicineId, source: "voice" }, Date.now())))}
        onAddTest={(x) => patch((d) => (d.tests.some((y) => y.serviceId === x.serviceId) ? d : { ...d, tests: [...d.tests, x] }))} />}
      {drawer === "dx" && <DiagnosisDrawer api={api} draft={draft} patch={patch} onClose={closeDrawer} suggest={suggest} />}
      {drawer === "meds" && <MedicinesDrawer api={api} draft={draft} patch={patch} warnings={warnings} checking={checking} onClose={closeDrawer} startWith={medStart} childNoDose={childDoseMissing(draft, bandNow())} />}
      {drawer === "tests" && <TestsDrawer api={api} draft={draft} patch={patch} onClose={closeDrawer} suggest={suggest} />}
      {drawer === "advice" && <AdviceDrawer api={api} draft={draft} patch={patch} onClose={closeDrawer} followChoices={followUpChoices(cfg)} />}
      {drawer === "sets" && <SetsDrawer api={api} onClose={() => setDrawer(null)} onUse={useSet} canSave={draft.lines.some(lineComplete) || draft.tests.length > 0}
        onSave={async (setName) => { await api.saveSet(setName, setBodyOf(draft, food)); setSetsCount((c) => (c === null ? c : { ...c, mine: c.mine + 1 })); }} />}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 6 },
  token: { fontFamily: MONO, fontSize: 20, fontWeight: "700", color: color.ink },
  name: { flexShrink: 1, fontSize: 19, fontWeight: "700", color: color.ink },
  demo: { fontSize: 14, color: color.dim },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: { fontSize: 12.5, fontWeight: "700", color: color.dim, backgroundColor: color.wash, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, overflow: "hidden" },
  pillRed: { color: color.red, backgroundColor: color.redSoft, borderWidth: 1, borderColor: color.redLine },
  vitals: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2 },
  vit: { fontFamily: MONO, fontSize: 13, color: color.ink },
  vitHi: { color: color.red, fontWeight: "700" },
  said: { fontSize: 13.5, lineHeight: 19, color: color.dim, borderLeftWidth: 3, borderLeftColor: color.line, paddingLeft: 8 },
  link: { color: color.green, fontSize: 14, fontWeight: "700" },
  quick: { flexDirection: "row", gap: space.sm },
  quickBtn: { flex: 1, minHeight: 56, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, backgroundColor: color.card, alignItems: "center", justifyContent: "center", paddingVertical: 8, paddingHorizontal: 6 },
  quickTitle: { fontSize: 14.5, fontWeight: "700", color: color.ink },
  quickSub: { fontSize: 11.5, color: color.dim, marginTop: 1 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: color.ink },
  report: { fontSize: 14.5, lineHeight: 21, color: color.ink },
  reportHi: { color: color.red, fontWeight: "700" },
  reportMore: { fontSize: 13, lineHeight: 19, color: color.dim, fontWeight: "700" },
  guardian: { alignSelf: "flex-start", maxWidth: "100%", fontSize: 14, lineHeight: 20, fontWeight: "700", color: "#8a5a10", borderWidth: 1.5, borderColor: color.gold, backgroundColor: color.goldSoft, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, overflow: "hidden" },
  corner: { flexShrink: 1, fontFamily: MONO, fontSize: 11, color: color.faint },
  emptyText: { fontSize: 13.5, lineHeight: 19, color: color.dim, paddingVertical: 6 },
  ln: { flexDirection: "row", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line2, minHeight: 40 },
  lnKey: { width: 74, fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.6, color: color.faint, textTransform: "uppercase", paddingTop: 3 },
  lnText: { fontSize: 14.5, lineHeight: 20, color: color.ink },
  lnSub: { fontSize: 12.5, lineHeight: 17, color: color.dim },
  mark: { fontSize: 11.5, fontWeight: "700", color: "#8a5a10" },
  foot: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line, paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  five: { flexDirection: "row", gap: 6 },
  fiveBtn: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.paper, paddingVertical: 4 },
  fiveOn: { borderColor: color.greenLine, backgroundColor: color.greenSoft },
  fiveGlyph: { fontSize: 16, color: color.green, lineHeight: 20 },
  fiveLabel: { fontSize: 11, fontWeight: "700", color: color.ink },
  fiveCount: { fontFamily: MONO, fontSize: 10, fontWeight: "700", color: color.green },
});
