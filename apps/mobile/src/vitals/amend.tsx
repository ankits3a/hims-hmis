import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../text";
import { useI18n } from "../i18n";
import { ApiError } from "../api";
import { color, radius, space, TOUCH } from "../theme";
import { Button, Note } from "../ui";
import { AMEND_KEYS, AMEND_REASONS, GLUCOSE_TIMINGS, UNLOCK_REASONS, amendedReadings, diffOf, istClock, parseTake, tempNote } from "./rules";
import { refusalText } from "./api";
import type { Change, GlucoseTiming, WireUnlockReason, WireVitalKey, WireVitalsPostBody } from "./rules";
import type { VitalsApi, WireChart, WireVitalsGate } from "./api";

/**
 * ═══ AMEND A SAVED CHART, ON THE PHONE (mobile §3i, owner 2026-10-07 "move ahead") ═══
 *
 * M1 told a nurse to "use the vitals bay on a computer" for this. It is the web bay's amendment
 * (VD-2 T4, owner ruling 4: "a wrong entry is fixable at the desk"), on the SAME two routes and
 * with the SAME rules file: she works on a COPY, nothing changes until she saves WITH A REASON, the
 * old row is superseded and kept, a value carried forward needs its own re-measure reason, and a
 * sanity gate the server raises again is confirmed here, never silently passed.
 *
 * NEVER QUEUED. A correction that did not reach the server stays on screen and says that the saved
 * chart stands — a nurse must never believe she corrected a chart the doctor is still reading wrong.
 *
 * Temperature may be typed in °F: the shared `tempNote` reads it exactly as the capture tile does,
 * and the chart is corrected in °C.
 */
type Values = Record<WireVitalKey, string>;
const text = (n: number | null | undefined): string => (n === null || n === undefined ? "" : String(n));

export function AmendPanel({ api, vitalsId, onAmended, onLeave }: {
  api: VitalsApi; vitalsId: string;
  onAmended: (changes: Change[]) => void; onLeave: () => void;
}) {
  const { t } = useI18n();
  const [chart, setChart] = useState<WireChart | null>(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState<Values | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gates, setGates] = useState<WireVitalsGate[]>([]);
  const [overrides, setOverrides] = useState<Partial<Record<WireVitalKey, string>>>({});
  const [locked, setLocked] = useState<WireVitalKey[]>([]);
  const [unlocks, setUnlocks] = useState<Partial<Record<WireVitalKey, WireUnlockReason>>>({});
  /** Owner 2026-10-08 — when the glucose was taken; corrected like a number, and never sent away from a value. */
  const [timing, setTiming] = useState<GlucoseTiming | null>(null);

  useEffect(() => {
    let live = true;
    api.chart(vitalsId).then((r) => {
      if (!live) return;
      setChart(r.vitals);
      setTiming(r.vitals.glucoseTiming ?? null);
      setValues(Object.fromEntries(AMEND_KEYS.map((k) => [k, text(r.vitals[k])])) as Values);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, vitalsId]);

  if (failed) return <Note tone="bad" testID="amend-failed">{t("vitalsBay.amend.readFailed")}</Note>;
  if (chart === null || values === null) return <Text style={s.faint} testID="amend-loading">{t("mobile.vitals.loadingPatient")}</Text>;
  if (chart.status !== "active") return <Note tone="warn" testID="amend-stale">{t("vitalsBay.amend.stale")}</Note>;

  const carried = (chart.carriedForward ?? []) as WireVitalKey[];
  const changed = AMEND_KEYS.filter((k) => values[k].trim() !== text(chart[k]));
  const needsReason = changed.filter((k) => carried.includes(k) && unlocks[k] === undefined);
  const timingMoved = values.glucoseMgDl.trim() !== "" && timing !== (chart.glucoseTiming ?? null) && !changed.includes("glucoseMgDl");
  const changeCount = changed.length + (timingMoved ? 1 : 0);

  /** What the copy reads as: a number, an emptied box (null), or not a number at all. °F is read for the temperature. */
  const read = (k: WireVitalKey): number | null | "bad" => {
    const raw = values[k].trim();
    if (raw === "") return null;
    if (k === "tempC") { const n = tempNote(raw); return n === null ? "bad" : n.c; }
    if (k === "glucoseMgDl") { const g = parseTake("glucoseMgDl", raw); return typeof g === "number" ? g : "bad"; }
    return /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : "bad";
  };

  const submit = async (): Promise<void> => {
    if (reason.trim() === "") { setError(t("vitalsBay.amend.reasonRequired")); return; }
    if (needsReason.length > 0) { setLocked(needsReason); return; }
    const next: Partial<Record<WireVitalKey, number | null>> = {};
    for (const k of AMEND_KEYS) {
      const v = read(k);
      if (v === "bad") { setError(`${t(`vitalsBay.vital.${k}`)}: ${t(k === "tempC" ? "vitalsBay.capture.tempUnit" : k === "glucoseMgDl" ? "vitalsBay.capture.glucoseRange" : "vitalsBay.capture.notANumber")}`); return; }
      next[k] = v;
    }
    const glucose = next.glucoseMgDl ?? null;
    if (glucose !== null && timing === null) { setError(t("vitalsBay.glucose.timingNeeded")); return; }
    const body: WireVitalsPostBody & { reason: string } = {
      ...next, glucoseTiming: glucose === null ? null : timing, reason: reason.trim(), emergency: chart.emergency, notes: chart.notes,
      readings: amendedReadings(chart, next),
      contextChips: Array.isArray(chart.contextChips) ? (chart.contextChips as { key: string; question: string; answer: string }[]) : [],
      carriedForward: carried.filter((k) => !changed.includes(k)),
    };
    if (Object.keys(unlocks).length > 0) body.unlockReasons = unlocks;
    if (Object.keys(overrides).length > 0) body.overrides = overrides;
    setBusy(true); setError(null);
    try {
      const result = await api.amend(chart.id, body);
      onAmended(diffOf(chart, result.vitals));
    } catch (e) {
      if (e instanceof ApiError) {
        const b = e.body as { code?: string; detail?: { gates?: WireVitalsGate[]; locked?: { key: WireVitalKey }[] } } | null;
        if (b?.code === "vitals_gate" && b.detail?.gates !== undefined) { setGates(b.detail.gates); return; }
        if (b?.code === "carried_value_locked" && b.detail?.locked !== undefined) { setLocked(b.detail.locked.map((l) => l.key)); return; }
        setError(refusalText(e.body, t("mobile.vitals.amendNothingSent")));
      } else {
        setError(t("mobile.vitals.amendNothingSent"));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmGate = (g: WireVitalsGate): void => {
    const reasonKey = g.kind === "slipped_digit" ? "confirmed_real" : g.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
    setOverrides((o) => ({ ...o, [g.key]: reasonKey, ...(g.key === "sbp" || g.key === "dbp" ? { sbp: reasonKey, dbp: reasonKey } : {}) }));
    setGates((gs) => gs.filter((x) => x !== g));
  };

  return (
    <View testID="amend" style={s.card}>
      <Text style={s.title}>{t("vitalsBay.amend.title", { at: istClock(chart.recordedAt) })}</Text>
      <Text style={s.faint}>{t("vitalsBay.amend.hint").replace(/ ?Esc[^.।]*[.।]?$/, "")}</Text>
      <View style={s.grid} testID="amend-fields">
        {AMEND_KEYS.map((k) => {
          const moved = values[k].trim() !== text(chart[k]);
          return (
            <View key={k} style={[s.cell, k === "glucoseMgDl" && { width: "100%" }]}>
              <Text style={s.label}>
                {t(`vitalsBay.vital.${k}`)}{carried.includes(k) ? ` · ${t("vitalsBay.amend.carried")}` : ""}
              </Text>
              <TextInput
                testID={`amend-${k}`} accessibilityLabel={t(`vitalsBay.vital.${k}`)} keyboardType="decimal-pad" returnKeyType="done"
                value={values[k]} onChangeText={(v) => { setValues((c) => (c === null ? c : { ...c, [k]: v })); setError(null); }}
                style={[s.input, moved && { borderColor: color.green, borderWidth: 2 }]}
              />
              {moved && chart[k] !== null && chart[k] !== undefined && <Text testID={`amend-was-${k}`} style={s.was}>{t("vitalsBay.amend.was", { value: chart[k] ?? "" })}</Text>}
              {k === "glucoseMgDl" && (
                <View testID="amend-glucose-timing" accessibilityLabel={t("vitalsBay.glucose.timingLabel")} style={s.reasons}>
                  {GLUCOSE_TIMINGS.map((g) => {
                    const on = timing === g;
                    return (
                      <Pressable key={g} testID={`amend-glucose-timing-${g}`} accessibilityRole="button" accessibilityState={{ selected: on }}
                        onPress={() => { setTiming(on ? null : g); setError(null); }} style={[s.reasonChip, on && s.reasonOn]}>
                        <Text style={[s.reasonText, on && { color: "#fff" }]}>{t(`vitalsBay.glucose.timing.${g}`)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {k === "tempC" && <Text style={s.was}>{t("mobile.vitals.amendTemp")}</Text>}
              {locked.includes(k) && (
                <View testID={`amend-unlock-${k}`} style={{ gap: 4 }}>
                  <Text style={[s.was, { color: "#8a5a10" }]}>{t("vitalsBay.unlock.serverLocked")}</Text>
                  {UNLOCK_REASONS.map((r) => (
                    <Pressable key={r} testID={`amend-unlock-${k}-${r}`} accessibilityRole="button" style={s.reasonChip}
                      onPress={() => { setUnlocks((u) => ({ ...u, [k]: r })); setLocked((l) => l.filter((x) => x !== k)); }}>
                      <Text style={s.reasonText}>{t(`vitalsBay.unlock.reason.${r}`)}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </View>
      {gates.map((g) => (
        <View key={`${g.key}-${g.kind}`} testID={`amend-gate-${g.key}`} accessibilityRole="alert" style={s.gate}>
          <Text style={s.gateText}>{g.message}</Text>
          <Button testID={`amend-gate-confirm-${g.key}`} kind="secondary" label={t("vitalsBay.gate.confirm")} onPress={() => confirmGate(g)} />
        </View>
      ))}
      <Text style={s.label}>{t("vitalsBay.amend.reason")}</Text>
      <View style={s.reasons} testID="amend-reason-presets">
        {AMEND_REASONS.map((r) => {
          const on = reason === r.text;
          return (
            <Pressable key={r.key} testID={`amend-reason-${r.key}`} accessibilityRole="button" accessibilityState={{ selected: on }}
              onPress={() => { setReason(on ? "" : r.text); setError(null); }} style={[s.reasonChip, on && s.reasonOn]}>
              <Text style={[s.reasonText, on && { color: "#fff" }]}>{t(`vitalsBay.amend.reasonPreset.${r.key}`)}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        testID="amend-reason" accessibilityLabel={t("vitalsBay.amend.reason")} placeholder={t("vitalsBay.amend.reasonPlaceholder")} placeholderTextColor={color.faint}
        value={reason} onChangeText={(v) => { setReason(v); setError(null); }} style={s.input}
      />
      {error !== null && <Note tone="bad" testID="amend-error">{error}</Note>}
      <Button testID="amend-save" label={t("vitalsBay.amend.save", { count: changeCount })} busy={busy} disabled={changeCount === 0} onPress={() => { void submit(); }} />
      <Button testID="amend-leave" kind="secondary" label={t("mobile.vitals.amendLeave")} onPress={onLeave} />
    </View>
  );
}

const s = StyleSheet.create({
  card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, backgroundColor: color.card },
  title: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: color.ink },
  faint: { fontSize: 13, lineHeight: 18, color: color.dim },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  cell: { width: "47%", flexGrow: 1, gap: 4 },
  label: { fontSize: 12.5, color: color.dim },
  input: { minHeight: TOUCH, paddingHorizontal: 12, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, fontSize: 18, color: color.ink },
  was: { fontSize: 12, lineHeight: 16, color: color.faint },
  gate: { gap: space.sm, padding: space.sm, borderWidth: 1, borderColor: color.redLine, borderRadius: radius.md, backgroundColor: color.redSoft },
  gateText: { fontSize: 14, lineHeight: 20, color: color.ink },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  reasonChip: { minHeight: 40, justifyContent: "center", paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: color.greenLine, backgroundColor: color.card },
  reasonOn: { backgroundColor: color.green, borderColor: color.green },
  reasonText: { fontSize: 13.5, fontWeight: "600", color: color.green },
});
