import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { color, radius, space, TOUCH, type } from "../theme";
import { Band, Button, MONO, Note, Tag } from "../ui";
import { AllergyStep } from "../vitals/allergy";
import { refusalText, vitalsApi, type VitalsApi, type WireVitalsSaveResult } from "../vitals/api";
import { CaptureCore } from "../vitals/capture";
import { heldFirstTake, holdFirstTake, releaseFirstTake, useDangerProtocol, type Protocol } from "../vitals/protocol";
import {
  REST_MINUTES, ambiguousMessage, bandFor, flagOf, humanDate, isElevated, istClock, matchOnBench, missMessage, rangesFrom, readingFrom,
  resolveDoor, todayIst,
} from "../vitals/rules";
import type { Take, TileKey, Tiles, WireBenchRow, WireDangerFlag, WirePreStage, WireVisitOnBench } from "../vitals/rules";
import { Scanner } from "../vitals/scanner";

/**
 * THE VITALS BAY, ON A PHONE (plan M1; owner 2026-10-06). The web bay's functions, on the same
 * server routes and under the same server guards — nothing is decided on the phone:
 *
 *   three doors, one box   a typed token number, a typed UHID, or a card read by the camera; all
 *                          three are a lookup on the bench the server sent (a patient who is not on
 *                          the bench is not the bay's to take)
 *   the bench              `GET /opd/bench`, re-read every few seconds while the app is open; when
 *                          the read fails the last list stays, stamped with its time
 *   on the stool           the band, what it requires, the last chart, the unpaid mark, allergies
 *   capture                ../vitals/capture.tsx — tiles, gates, the emergency save
 *   danger                 ../vitals/protocol.ts — "the other arm, now", class 0, the cancel window,
 *                          and five minutes on the rest chairs for an elevated first BP
 *
 * NOTHING BLEEDS BETWEEN PEOPLE: everything the last patient left — the offer of a rest, the
 * protocol, the tiles — is dropped in `clearDesk`, and the capture is keyed on the encounter.
 */
export const BENCH_POLL_MS = 5_000;
const RANGED: readonly TileKey[] = ["bp", "pulse", "spo2", "tempC", "rr"];
const LAST_KEYS = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm"] as const;
type T = ReturnType<typeof useI18n>["t"];
type Banner = { who: string; doctorName: string; flags: WireDangerFlag[]; rest?: string; feeWaived?: boolean };
type RowState = "escalated" | "recheck" | "due" | "resting" | "away" | "done" | "waiting";

function patientLabel(row: WireBenchRow, t: T): string {
  if (row.patient === null) return t("vitalsBay.bench.unknownPatient");
  if (row.patient.restricted) return row.patient.alias ?? t("vitalsBay.bench.restricted");
  return row.patient.name ?? row.patient.uhid;
}
function stateOf(row: WireBenchRow): RowState {
  return row.escalation === "escalated" ? "escalated"
    : row.escalation === "recheck_demanded" ? "recheck"
    : row.benchState === "resting" ? (row.recallDue ? "due" : "resting")
    : row.benchState === "away" ? "away"
    : row.vitalsDone ? "done" : "waiting";
}
const clock = (ms: number): string => istClock(new Date(ms).toISOString());
const buzz = (kind: "ok" | "warn"): void => {
  // A confirmation the hand can feel while the eyes are on the patient. Absent on web; never fatal.
  void Haptics.notificationAsync(kind === "ok" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
};

/** The bench, re-read while the app is in front. A failed read keeps the last list and says how old it is. */
function useBench(api: VitalsApi, serviceDate: string) {
  const [rows, setRows] = useState<WireBenchRow[]>([]);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [callable, setCallable] = useState<number | null>(null);
  const refresh = useCallback(async (): Promise<WireBenchRow[] | null> => {
    let fresh: WireBenchRow[] | null = null;
    try {
      const r = await api.bench(serviceDate);
      fresh = r.items;
      setRows(r.items); setAsOf(Date.now()); setFailed(false);
    } catch {
      setFailed(true);
    }
    api.summary(serviceDate).then((s) => setCallable(s.items.reduce((n, d) => n + d.waitingVitalsCount, 0))).catch(() => undefined);
    return fresh;
  }, [api, serviceDate]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (AppState.currentState !== "background") void refresh(); }, BENCH_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  return { rows, asOf, failed, callable, refresh };
}

function BenchRows({ rows, inHand, onTake, t }: { rows: WireBenchRow[]; inHand: string | null; onTake: (row: WireBenchRow) => void; t: T }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => a.seq - b.seq), [rows]);
  if (sorted.length === 0) return <Text testID="bench-empty" style={s.faint}>{t("vitalsBay.bench.empty")}</Text>;
  return (
    <View style={{ gap: space.sm }}>
      {sorted.map((row) => {
        const st = stateOf(row);
        const loud = st === "escalated" || st === "due" || st === "recheck";
        const fg = st === "escalated" || st === "recheck" ? color.red : st === "due" ? "#8a5a10" : color.dim;
        return (
          <Pressable
            key={row.entryId} testID={`bench-row-${row.tokenNo}`} accessibilityRole="button" accessibilityState={{ selected: row.encounterId === inHand }}
            onPress={() => onTake(row)}
            // The row's state is a border AND a word, never colour alone.
            style={({ pressed }) => [s.benchRow, loud && { borderColor: fg, borderWidth: 2 }, (pressed || row.encounterId === inHand) && { backgroundColor: color.wash }]}
          >
            <Text style={s.benchTok}>#{row.tokenNo}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.benchName} numberOfLines={1}>{patientLabel(row, t)}</Text>
              <Text style={s.benchDoc} numberOfLines={1}>{row.doctorName}</Text>
            </View>
            <Text testID={`bench-state-${row.tokenNo}`} style={[s.benchState, { color: fg }, loud && { fontWeight: "800" }]}>
              {st === "resting" && row.recallAt !== null ? t("vitalsBay.bench.recallAt", { time: istClock(row.recallAt) }) : t(`vitalsBay.bench.state.${st}`)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProtocolPanel({ p, doctorName, rerun, t }: { p: Protocol; doctorName: string; rerun: (() => void) | null; t: T }) {
  const state = p.view?.state ?? "none";
  if (state === "none" && p.error === null && !p.calmed && rerun === null) return null;
  const loud = state === "escalated" || state === "recheck_demanded";
  return (
    <View testID="protocol" accessibilityRole="alert" style={[s.card, loud && { borderColor: color.red, borderWidth: 2, backgroundColor: color.redSoft }]}>
      {state === "recheck_demanded" && (
        <Text testID="protocol-demand" style={s.loud}>{t(p.demandedKey === "bp" || p.demandedKey === null ? "vitalsBay.protocol.otherArm" : "vitalsBay.protocol.again")}</Text>
      )}
      {state === "none" && p.calmed && <Text testID="protocol-calmed" style={{ fontSize: 14.5, lineHeight: 20, fontWeight: "700", color: color.green }}>{t("vitalsBay.protocol.calmed")}</Text>}
      {rerun !== null && (
        <>
          <Text testID="protocol-rerun" style={s.body}>{t("vitalsBay.protocol.rerunAsk")}</Text>
          <Button testID="protocol-rerun-go" kind="secondary" label={t("vitalsBay.protocol.rerunGo")} onPress={rerun} />
        </>
      )}
      {state === "escalated" && (
        <>
          <Text testID="protocol-escalated" style={s.loud}>{t("vitalsBay.protocol.escalated", { from: p.view?.escalatedFromClass ?? "", doctor: doctorName })}</Text>
          {p.msLeft > 0 ? (
            <Pressable testID="protocol-cancel" accessibilityRole="button" disabled={p.busy} onPress={() => { void p.cancel(); }} style={s.cancel}>
              <Text style={s.cancelText}>{t("vitalsBay.protocol.cancel")} {Math.ceil(p.msLeft / 1000)}s</Text>
            </Pressable>
          ) : (
            <Text testID="protocol-committed" style={[s.body, { fontWeight: "700" }]}>{t("vitalsBay.protocol.committed")}</Text>
          )}
        </>
      )}
      {state === "cancelled" && <Text testID="protocol-cancelled" style={s.body}>{t("vitalsBay.protocol.cancelled", { from: p.view?.escalatedFromClass ?? "" })}</Text>}
      {p.error !== null && <Text testID="protocol-error" style={[s.body, { color: color.red, fontWeight: "700" }]}>{p.error}</Text>}
    </View>
  );
}

function Details({ api, row, pre, failed, t }: { api: VitalsApi; row: WireBenchRow; pre: WirePreStage | null; failed: boolean; t: T }) {
  return (
    <View testID="session" style={s.details}>
      <Text testID="who-ids" style={s.small}>
        {[row.patient !== null && !row.patient.restricted ? row.patient.uhid : null, row.visitNo ?? null].filter((x) => x !== null).join(" · ")}
      </Text>
      {failed && <Text testID="prestage-failed" style={s.small}>{t("vitalsBay.session.noHistory")}</Text>}
      {pre !== null && (
        <View testID="prestage" style={{ gap: 6 }}>
          <Text style={s.body}><Text style={s.dim}>{t("vitalsBay.session.required")} </Text>{pre.required.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</Text>
          {pre.notRoutine.length > 0 && (
            <Text style={s.body}><Text style={s.dim}>{t("vitalsBay.session.notRoutine")} </Text>{pre.notRoutine.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</Text>
          )}
          {pre.sealed && <Text testID="sealed-line" style={s.small}>{t("vitalsBay.session.sealed")}</Text>}
          {pre.last === null ? (
            <Text testID="prestage-none" style={s.body}>{t("vitalsBay.session.firstVisit")}</Text>
          ) : (
            <Text testID="prestage-last" style={s.body}>
              <Text style={s.dim}>{t("vitalsBay.session.last", { date: humanDate(pre.last.serviceDate) })} </Text>
              {LAST_KEYS.filter((k) => pre.last![k] !== null).map((k) => `${t(`vitalsBay.vital.${k}`)} ${String(pre.last![k])}`).join(" · ")}
            </Text>
          )}
          {pre.carryCandidates.length > 0 && (
            <Text testID="prestage-carry" style={s.body}>{t("vitalsBay.session.carry", { vitals: pre.carryCandidates.map((k) => t(`vitalsBay.vital.${k}`)).join(", ") })}</Text>
          )}
          {pre.expectedFlags.length > 0 && <Text testID="prestage-flags" style={s.body}>{t("vitalsBay.session.expectedFlags", { count: pre.expectedFlags.length })}</Text>}
        </View>
      )}
      {row.patient !== null && <AllergyStep key={row.patient.id} api={api} patientId={row.patient.id} />}
    </View>
  );
}

export function VitalsBay() {
  const { t } = useI18n();
  const router = useRouter();
  const { call } = useSession();
  const api = useMemo(() => vitalsApi(call), [call]);
  const today = todayIst();
  const { rows: allRows, asOf, failed: benchFailed, callable, refresh } = useBench(api, today);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const doctors = useMemo(() => [...new Map(allRows.map((r) => [r.doctorId, r.doctorName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [allRows]);
  const rows = useMemo(() => (doctorId === null ? allRows : allRows.filter((r) => r.doctorId === doctorId)), [allRows, doctorId]);

  const [taken, setTaken] = useState<WireBenchRow | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deskGen, setDeskGen] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [saving, setSaving] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const takenRef = useRef(taken);
  takenRef.current = taken;

  // The row in hand follows the bench: a state another desk changed shows here on the next read.
  const rowInHand = taken === null ? null : (allRows.find((r) => r.encounterId === taken.encounterId) ?? taken);
  const encounterId = rowInHand?.encounterId ?? null;

  const [pre, setPre] = useState<{ of: string; data: WirePreStage | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (encounterId === null) { setPre(null); return; }
    let live = true;
    setPre(null);
    api.preStage(encounterId)
      .then((data) => { if (live) setPre({ of: encounterId, data, failed: false }); })
      .catch(() => { if (live) setPre({ of: encounterId, data: null, failed: true }); });
    return () => { live = false; };
  }, [encounterId, api]);
  const preStage = pre !== null && pre.of === encounterId ? pre.data : null;
  const pending = encounterId !== null && (pre === null || pre.of !== encounterId);
  const ranges = useMemo(() => rangesFrom(preStage), [preStage]);
  const band = bandFor(ranges, preStage?.band ?? null);

  const protocol = useDangerProtocol(api, encounterId, t("mobile.network"));
  const [restOffer, setRestOffer] = useState<[number, number] | null>(null);
  const [restBusy, setRestBusy] = useState(false);
  const [rerun, setRerun] = useState<{ reading: ReturnType<typeof readingFrom>; key: TileKey } | null>(null);
  const held = useMemo(() => (encounterId === null ? null : heldFirstTake(encounterId)), [encounterId]);
  const initialTakes = useMemo<Partial<Record<TileKey, Take[]>> | undefined>(() => (held === null ? undefined : { bp: [held] }), [held]);

  const take = useCallback((row: WireBenchRow) => {
    if (row.patient === null) { setError(t("vitalsBay.identify.unknownPatient")); return; }
    if (saving) { setError(t("vitalsBay.identify.saving")); return; }
    setError(null); setRestOffer(null); setRerun(null); setWhoOpen(false); setRaw("");
    setTaken(row);
  }, [t, saving]);

  const clearDesk = useCallback(() => {
    setTaken(null); setError(null); setRestOffer(null); setRerun(null); setWhoOpen(false); setRaw("");
    setDeskGen((g) => g + 1);
  }, []);

  /** Every committed take is offered to the protocol — the web bay's rule, line for line. */
  const onCommitted = useCallback((key: TileKey, taken1: Take, tiles: Tiles) => {
    const tint = flagOf(key, taken1, band, ranges);
    const state = protocol.view?.state ?? "none";
    const reading = readingFrom(tiles);
    if (state === "recheck_demanded" && RANGED.includes(key) && (key === protocol.demandedKey || tint === "danger")) {
      setRestOffer(null);
      if (!protocol.busy) void protocol.confirm(reading);
      return;
    }
    if (state === "recheck_demanded") return;
    if (tint === "danger") {
      setRestOffer(null);
      buzz("warn");
      // After a named human's cancel the protocol is not re-run by itself: the nurse is asked.
      if (state === "cancelled") { setRerun({ reading, key }); return; }
      if (state === "none" && !protocol.busy) void protocol.demand(reading, key);
      return;
    }
    // Rest is refused at danger numbers by construction: the offer only appears when nothing is dangerous.
    if (key === "bp" && state === "none" && !protocol.calmed && tiles.bp.takes.length === 1 && Array.isArray(taken1) && isElevated(taken1, band, preStage?.last ?? null)) {
      setRestOffer(taken1);
    }
  }, [band, ranges, protocol, preStage]);

  const goRest = useCallback(async () => {
    if (rowInHand === null || restOffer === null) return;
    setRestBusy(true);
    try {
      const updated = await api.setBenchState(rowInHand.encounterId, { state: "resting", restMinutes: REST_MINUTES, note: `first reading ${restOffer[0]}/${restOffer[1]}` });
      holdFirstTake(rowInHand.encounterId, restOffer);
      setBanner({ who: patientLabel(rowInHand, t), doctorName: rowInHand.doctorName, flags: [], rest: updated.recallAt === null ? clock(Date.now() + REST_MINUTES * 60_000) : istClock(updated.recallAt) });
      void refresh();
      clearDesk();
    } catch (e) {
      setError(e instanceof ApiError ? refusalText(e.body, e.code) : e instanceof NetworkError ? t("mobile.network") : String(e));
    } finally {
      setRestBusy(false);
    }
  }, [rowInHand, restOffer, api, refresh, clearDesk, t]);

  const onSaved = useCallback((result: WireVitalsSaveResult, row: WireBenchRow) => {
    buzz(result.flags.some((f) => f.severity !== "notice") ? "warn" : "ok");
    setBanner({ who: patientLabel(row, t), doctorName: row.doctorName, flags: result.flags, feeWaived: result.feeWaived === true });
    releaseFirstTake(row.encounterId);
    void refresh();
    // A save that lands after the desk moved on clears nothing of the next patient.
    if (takenRef.current?.encounterId === row.encounterId) clearDesk();
  }, [t, refresh, clearDesk]);

  /**
   * ONE RESOLVER for whatever was typed or scanned (`resolveDoor`, shared with the web bay): a token
   * (`4`, `#4`, `ORT-4`), a UHID, the visit number the slip prints and the prescription's QR carries,
   * a printed e-prescription's code, or a patient card. A miss says what was understood, and for a
   * visit number asks the server why (owner 2026-10-06).
   */
  const identify = useCallback(async (text: string) => {
    const r = resolveDoor(allRows, text);
    if (r.outcome === "empty") return;
    setError(null);
    if (r.outcome === "row") { take(r.row); return; }
    if (r.outcome === "ambiguous") {
      const m = ambiguousMessage(r.door, r.rows);
      setError(t(`vitalsBay.identify.miss.${m.key}`, m.vars));
      return;
    }
    if (r.outcome === "verify") {
      setBusy(true);
      try {
        const verdict = await api.verifyQr(r.payload);
        if (!verdict.ok) { setError(t(`vitalsBay.identify.scanFailed.${verdict.reason}`)); return; }
        const row = matchOnBench(allRows, { kind: "patient", patientId: verdict.patient.id });
        if (row === null) { setError(t("vitalsBay.identify.miss.uhid", { uhid: verdict.patient.uhid })); return; }
        take(row);
      } catch {
        setError(t("vitalsBay.identify.scanUnavailable"));
      } finally {
        setBusy(false);
      }
      return;
    }
    let why: WireVisitOnBench | null = null;
    if (r.door.kind === "visit") {
      setBusy(true);
      try {
        why = await api.locateVisit(r.door.visitNo, today);
        if (why.onBench) {
          // The server has them on the bench and this list does not yet: read it again, then take.
          const fresh = await refresh();
          const row = fresh === null ? null : matchOnBench(fresh, { kind: "encounter", encounterId: why.encounterId });
          if (row !== null) { take(row); return; }
        }
      } catch {
        why = null; // the plain sentence still names the visit number
      } finally {
        setBusy(false);
      }
    }
    const m = missMessage(r.door, why);
    setError(t(`vitalsBay.identify.miss.${m.key}`, m.vars));
  }, [allRows, t, take, api, today, refresh]);

  const dueCount = rows.filter((r) => r.recallDue || r.escalation === "escalated" || r.escalation === "recheck_demanded").length;

  const bannerView = banner === null ? null : (
    <View testID="saved-banner" accessibilityRole="alert" style={[s.card, { borderColor: color.greenLine, backgroundColor: color.greenSoft }]}>
      {banner.rest !== undefined ? (
        <Text testID="rest-banner" style={s.bannerTitle}>{t("vitalsBay.rest.sent", { who: banner.who, time: banner.rest })}</Text>
      ) : (
        <Text style={[s.bannerTitle, { color: color.green }]}>✓ {t("vitalsBay.saved.title", { who: banner.who, doctor: banner.doctorName })}</Text>
      )}
      {banner.feeWaived === true && <Text testID="saved-fee-waived" style={[s.body, { fontWeight: "700", color: "#8a5a10" }]}>⚠ {t("vitalsBay.saved.feeWaived")}</Text>}
      {banner.flags.some((f) => f.severity !== "notice") && (
        <Text testID="saved-danger" style={[s.body, { fontWeight: "800", color: color.red }]}>
          {t("vitalsBay.saved.danger", { vitals: banner.flags.filter((f) => f.severity !== "notice").map((f) => `${t(`vitalsBay.vital.${f.vital}`)} ${f.value}`).join(", ") })}
        </Text>
      )}
      {banner.flags.some((f) => f.severity === "notice") && (
        <Text testID="saved-notice" style={[s.body, { color: "#8a5a10" }]}>
          {t("vitalsBay.saved.notice", { vitals: banner.flags.filter((f) => f.severity === "notice").map((f) => `${t(`vitalsBay.vital.${f.vital}`)} ${f.value}`).join(", ") })}
        </Text>
      )}
      <Pressable testID="banner-dismiss" accessibilityRole="button" hitSlop={8} onPress={() => setBanner(null)} style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: color.dim }}>{t("vitalsBay.saved.dismiss")}</Text>
      </Pressable>
    </View>
  );

  const who = rowInHand === null ? null : (
    <View style={s.card} testID="who">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Pressable testID="who-toggle" accessibilityRole="button" accessibilityState={{ expanded: whoOpen }} onPress={() => setWhoOpen((o) => !o)} style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH }}>
          <Text style={s.whoTok}>#{rowInHand.tokenNo}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text testID="who-name" style={s.whoName} numberOfLines={1}>{patientLabel(rowInHand, t)}</Text>
            <Text style={s.small} numberOfLines={1}>{rowInHand.doctorName}</Text>
            {preStage !== null && (
              <Text testID="who-band" style={s.small} numberOfLines={1}>
                {t(`vitalsBay.band.${preStage.band}`)}{preStage.ageYears !== null ? ` · ${t("vitalsBay.session.age", { years: preStage.ageYears })}` : ""}
              </Text>
            )}
            <Text style={s.link}>{t(whoOpen ? "vitalsBay.phone.hide" : "vitalsBay.phone.show")} {whoOpen ? "▴" : "▾"}</Text>
          </View>
        </Pressable>
        <Pressable testID="clear-desk" accessibilityRole="button" onPress={clearDesk} style={s.clear}>
          <Text style={s.clearText}>{t("vitalsBay.clearDesk")}</Text>
        </Pressable>
      </View>
      {/* The money warning sits OUTSIDE the fold: it changes what the nurse does next. */}
      {preStage !== null && preStage.feeUnpaid && (
        <View testID={preStage.feeBypass !== null ? "unpaid-bypassed" : "unpaid-mark"} style={[s.unpaid, preStage.feeBypass !== null && { borderColor: color.goldLine, backgroundColor: color.goldSoft }]}>
          <Text style={[s.unpaidText, preStage.feeBypass !== null && { color: "#8a5a10" }]}>
            {preStage.feeBypass !== null ? `⚠ ${t("unpaid.bypassed")} — ${preStage.feeBypass.reason}` : `₹ ${t("unpaid.notPaid")} — ${t("unpaid.title")}`}
          </Text>
        </View>
      )}
      {whoOpen && <Details api={api} row={rowInHand} pre={preStage} failed={pre?.failed === true} t={t} />}
    </View>
  );

  const capturing = rowInHand !== null && !rowInHand.vitalsDone && !pending;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }} testID="vitals-bay">
      <Band
        right={
          <Pressable testID="bay-back" accessibilityRole="button" hitSlop={8} onPress={() => router.back()} style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: "center" }}>
            <Text style={{ color: color.agentFg, fontSize: 13, fontWeight: "600" }}>{t("mobile.back")}</Text>
          </Pressable>
        }
      />
      <View style={s.head}>
        <View style={s.dot} />
        <Text style={s.title}>{t("vitalsBay.title")}</Text>
        <View style={{ flex: 1 }} />
        <Pressable testID="bench-toggle" accessibilityRole="button" onPress={() => setBenchOpen(true)} style={[s.benchBtn, dueCount > 0 && { borderColor: color.gold, borderWidth: 2 }]}>
          <Text style={[s.benchBtnText, dueCount > 0 && { color: "#8a5a10" }]}>
            {t("vitalsBay.phone.bench", { count: rows.length })}{dueCount > 0 ? ` · ${t("vitalsBay.phone.due", { count: dueCount })}` : ""}
          </Text>
        </Pressable>
      </View>
      {benchFailed && (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
          <Note tone="warn" testID="bench-failed">
            {asOf === null ? t("vitalsBay.bench.failed") : t("mobile.vitals.stale", { time: clock(asOf) })}
          </Note>
        </View>
      )}

      {capturing && rowInHand !== null ? (
        <CaptureCore
          key={`${deskGen}:${rowInHand.encounterId}`} resetKey={`${deskGen}:${rowInHand.encounterId}`}
          api={api} row={rowInHand} preStage={preStage} ranges={ranges}
          onSaved={(r) => onSaved(r, rowInHand)} onCommitted={onCommitted} onBusy={setSaving} initialTakes={initialTakes}
          header={
            <>
              {bannerView}
              {who}
              {error !== null && <Note tone="bad" testID="identify-error">{error}</Note>}
              {held !== null && <Text testID="held-first-take" style={s.small}>{t("vitalsBay.rest.heldFirst", { value: `${held[0]}/${held[1]}` })}</Text>}
              <ProtocolPanel p={protocol} doctorName={rowInHand.doctorName} t={t}
                rerun={rerun === null ? null : () => { const r = rerun; setRerun(null); void protocol.demand(r.reading, r.key); }} />
              {restOffer !== null && (protocol.view?.state ?? "none") === "none" && (
                <View testID="rest-offer" style={[s.card, { borderColor: color.goldLine, backgroundColor: color.goldSoft }]}>
                  <Text style={s.body}>{t("vitalsBay.rest.offer", { minutes: REST_MINUTES, time: clock(Date.now() + REST_MINUTES * 60_000) })}</Text>
                  <Button testID="rest-go" label={t("vitalsBay.rest.go", { minutes: REST_MINUTES })} busy={restBusy} onPress={() => { void goRest(); }} />
                </View>
              )}
            </>
          }
        />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}>
          {bannerView}
          {rowInHand === null ? (
            <View style={s.card}>
              <Text style={[type.heading, { color: color.ink }]}>{t("vitalsBay.identify.label")}</Text>
              <TextInput
                key={deskGen} testID="identify" accessibilityLabel={t("vitalsBay.identify.label")}
                autoCapitalize="characters" autoCorrect={false} autoComplete="off" returnKeyType="go" editable={!busy}
                placeholder={t("vitalsBay.phone.identify")} placeholderTextColor={color.faint}
                value={raw} onChangeText={setRaw} onSubmitEditing={() => { void identify(raw); }}
                style={s.identify}
              />
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <View style={{ flex: 1 }}><Button testID="scan" kind="secondary" label={t("mobile.vitals.scan")} onPress={() => { setError(null); setScanOpen(true); }} /></View>
                <View style={{ flex: 1 }}><Button testID="begin" label={t("mobile.vitals.begin")} busy={busy} disabled={raw.trim() === ""} onPress={() => { void identify(raw); }} /></View>
              </View>
              {error !== null && <Note tone="bad" testID="identify-error">{error}</Note>}
            </View>
          ) : (
            <>
              {who}
              {error !== null && <Note tone="bad" testID="identify-error">{error}</Note>}
              {pending ? <Text style={s.faint}>{t("mobile.vitals.loadingPatient")}</Text> : <Note tone="info" testID="already-charted">{t("mobile.vitals.alreadyCharted")}</Note>}
            </>
          )}
          {rowInHand === null && (
            <>
              {doctors.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} testID="doctor-filter">
                  {[[null, t("vitalsBay.allDoctors")] as const, ...doctors].map(([id, name]) => (
                    <Pressable key={id ?? "all"} testID={`doctor-${id ?? "all"}`} accessibilityRole="button" accessibilityState={{ selected: doctorId === id }}
                      onPress={() => setDoctorId(id)} style={[s.pill, doctorId === id && s.pillOn]}>
                      <Text style={[s.pillText, doctorId === id && { color: "#f2faf6" }]}>{name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
                <Tag>{t("vitalsBay.bench.title")}</Tag>
                {asOf !== null && <Text testID="bench-asof" style={s.asOf}>{t("mobile.vitals.asOf", { time: clock(asOf) })}</Text>}
              </View>
              <View testID="bench"><BenchRows rows={rows} inHand={null} onTake={take} t={t} /></View>
              <Text style={s.faint}>{t("vitalsBay.session.dignity")}</Text>
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={benchOpen} transparent animationType="slide" onRequestClose={() => setBenchOpen(false)}>
        <Pressable style={s.scrim} testID="bench-scrim" onPress={() => setBenchOpen(false)}>
          <Pressable style={s.sheet} testID="bench-sheet" onPress={() => undefined}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Tag>{t("vitalsBay.bench.title")}</Tag>
                <Text testID="valve-pill" style={s.small}>
                  {t("vitalsBay.valve.bench", { count: rows.length })}{callable === null ? "" : ` · ${t("vitalsBay.valve.callable", { count: callable })}`}
                  {asOf === null ? "" : ` · ${t("mobile.vitals.asOf", { time: clock(asOf) })}`}
                </Text>
              </View>
              <Pressable testID="bench-close" accessibilityRole="button" onPress={() => setBenchOpen(false)} style={s.clear}>
                <Text style={s.clearText}>{t("vitalsBay.phone.close")}</Text>
              </Pressable>
            </View>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingVertical: space.md }}>
              <BenchRows rows={rows} inHand={encounterId} onTake={(r) => { setBenchOpen(false); take(r); }} t={t} />
            </ScrollView>
            <Text style={s.faint}>{t("vitalsBay.bench.valveNote")}</Text>
          </Pressable>
        </Pressable>
      </Modal>
      <Scanner open={scanOpen} onClose={() => setScanOpen(false)} onRead={(data) => { setScanOpen(false); setRaw(/^(q1|rx1)\./.test(data) ? "" : data); void identify(data); }} />
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.green },
  title: { fontFamily: MONO, fontSize: 14, fontWeight: "700", letterSpacing: 1, color: color.ink },
  benchBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  benchBtnText: { fontSize: 14.5, fontWeight: "700", color: color.green },
  card: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  identify: { minHeight: 52, paddingHorizontal: 14, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, fontFamily: MONO, fontSize: 18, color: color.ink },
  faint: { fontSize: 13, lineHeight: 18, color: color.faint },
  small: { fontSize: 13, lineHeight: 18, color: color.dim },
  dim: { color: color.dim },
  body: { fontSize: 14.5, lineHeight: 20, color: color.ink },
  loud: { fontSize: 16, lineHeight: 22, fontWeight: "800", color: color.red },
  link: { fontSize: 12.5, fontWeight: "700", color: color.green, marginTop: 2 },
  asOf: { fontFamily: MONO, fontSize: 11.5, color: color.faint },
  bannerTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800", color: color.ink },
  whoTok: { fontFamily: MONO, fontSize: 24, fontWeight: "800", color: color.ink },
  whoName: { fontSize: 17, fontWeight: "700", color: color.ink },
  clear: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  clearText: { fontSize: 13.5, fontWeight: "700", color: color.dim },
  unpaid: { borderWidth: 1, borderColor: color.redLine, backgroundColor: color.redSoft, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
  unpaidText: { fontSize: 13.5, lineHeight: 18, fontWeight: "800", color: color.red },
  details: { gap: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line2 },
  benchRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg },
  benchTok: { fontFamily: MONO, fontSize: 19, fontWeight: "800", color: color.ink, minWidth: 44 },
  benchName: { fontSize: 16, fontWeight: "700", color: color.ink },
  benchDoc: { fontSize: 12.5, color: color.faint },
  benchState: { fontFamily: MONO, fontSize: 12, maxWidth: 116, textAlign: "right" },
  cancel: { minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 2, borderColor: color.red, backgroundColor: color.card },
  cancelText: { fontSize: 16, fontWeight: "800", color: color.red, letterSpacing: 1 },
  pill: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  pillOn: { backgroundColor: color.green, borderColor: color.green },
  pillText: { fontSize: 14, fontWeight: "700", color: color.green },
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(19, 36, 32, .35)" },
  sheet: { maxHeight: "82%", backgroundColor: color.paper, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: space.lg, paddingBottom: space.xl },
});
