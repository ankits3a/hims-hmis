import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, NetworkError } from "../api";
import { useI18n } from "../i18n";
import { color, radius, space, TOUCH } from "../theme";
import { Button, MONO } from "../ui";
import { refusalText, type VitalsApi, type WireVitalsGate, type WireVitalsSaveResult } from "./api";
import {
  CONTEXT_CHIPS, TILE_KEYS, UNLOCK_REASONS, applyTake, bandFor, buildBody, emptyTiles, flagOf, leadTileFor, missingFor,
  monthLabel, operative, parseTake, rangeLabelOf, sourcePillOf, takeError, tempNote, tileDeltaOf, tileOrder, tileSetFor,
} from "./rules";
import type {
  Mirror, Take, TakeSource, TileKey, Tiles, WireBenchRow, WireDangerRanges, WirePreStage, WireUnlockReason, WireVitalKey,
} from "./rules";

/**
 * THE CAPTURE CORE, ON A PHONE — tiles, not a form. The reading model, the parsers, the gate
 * mirrors and the wire body are the web bay's own (./rules → packages/contracts/src/vitals-entry.ts);
 * this file is only how a thumb drives them.
 *
 *  - A tile becomes a reading when the keyboard's "next" is pressed OR the field is left, and Save
 *    charts whatever is still sitting in a box, so a number on screen is never a number unsaved.
 *  - The server is the authority: a `vitals_gate`, `carried_value_locked`, `vitals_incomplete` or
 *    fee refusal is drawn exactly where the mirror would have drawn it.
 *  - A save that does not reach the server is NEVER queued: the numbers stay on screen, the line
 *    says nothing was sent, and Save is pressed again (plan, "Offline rule").
 */
type Chip = "yes" | "no" | undefined;
const blankRaw = (): Record<TileKey, string> => Object.fromEntries(TILE_KEYS.map((k) => [k, ""])) as Record<TileKey, string>;
const foldKey = (k: WireVitalKey): TileKey => (k === "sbp" || k === "dbp" ? "bp" : k);
const showTake = (x: Take): string => (Array.isArray(x) ? `${x[0]}/${x[1]}` : String(x));
/*
  A BP is two numbers with a separator between them, and Android's decimal pad refuses every
  separator but ".". The phone pad carries "-", "," and "/" (and RN's Android key listener lets
  them through), so that is the BP tile's keyboard; every other tile is a plain decimal pad.
*/
const BP_KEYBOARD = Platform.OS === "ios" ? "numbers-and-punctuation" : "phone-pad";
/* The browser's own focus ring is switched off in the web export, so a screenshot shows the app's ring. */
const NO_OUTLINE = Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null;

export function CaptureCore({ api, row, preStage, ranges, resetKey, header, onSaved, onCommitted, onBusy, initialTakes }: {
  api: VitalsApi; row: WireBenchRow; preStage: WirePreStage | null; ranges: WireDangerRanges | null; resetKey: string;
  /** Everything above the tiles: who is on the stool, the banners, the danger protocol's panels. */
  header?: ReactNode;
  onSaved: (result: WireVitalsSaveResult) => void;
  /** Every committed take is offered to the danger protocol with the tiles as they now stand. */
  onCommitted?: (key: TileKey, take: Take, tiles: Tiles) => void;
  onBusy?: (busy: boolean) => void;
  /** A first BP held across a rest, restored so the recall lands as a pair. */
  initialTakes?: Partial<Record<TileKey, Take[]>>;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const set = useMemo(() => tileSetFor(preStage), [preStage]);
  const order = useMemo(() => tileOrder(leadTileFor(preStage), set), [preStage, set]);
  const band = bandFor(ranges, preStage?.band ?? null);
  const [tiles, setTiles] = useState<Tiles>(emptyTiles);
  const [raw, setRaw] = useState<Record<TileKey, string>>(blankRaw);
  // What is in the boxes, readable THIS instant: "next" charts a tile and moves the focus in one
  // breath, and the blur that causes must not chart the same number a second time.
  const rawRef = useRef(raw);
  const putRaw = useCallback((next: (r: Record<TileKey, string>) => Record<TileKey, string>): void => {
    rawRef.current = next(rawRef.current);
    setRaw(rawRef.current);
  }, []);
  const [mirror, setMirror] = useState<{ key: TileKey; m: Mirror } | null>(null);
  const [serverGates, setServerGates] = useState<WireVitalsGate[]>([]);
  const [lockedByServer, setLockedByServer] = useState<WireVitalKey[]>([]);
  const [missing, setMissing] = useState<TileKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tempTyped, setTempTyped] = useState<number | null>(null);
  const [chips, setChips] = useState<Record<string, Chip>>({});
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState<TileKey | null>(null);
  const [unlocking, setUnlocking] = useState<TileKey | null>(null);
  const refs = useRef<Partial<Record<TileKey, TextInput | null>>>({});
  const [focusReq, setFocusReq] = useState<TileKey | null>(null);

  // "A suspiciously instant RR gets a nudge and a 15-second counter, never a block."
  const rrFocusedAt = useRef<number | null>(null);
  const [rrNudge, setRrNudge] = useState<{ value: number; secondsLeft: number | null } | null>(null);
  const rrTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (rrTimer.current !== null) clearInterval(rrTimer.current); }, []);
  const startRrCounter = useCallback(() => {
    if (rrTimer.current !== null) clearInterval(rrTimer.current);
    const startedAt = Date.now();
    setRrNudge((n) => (n === null ? null : { ...n, secondsLeft: 15 }));
    rrTimer.current = setInterval(() => {
      const left = Math.max(0, 15 - Math.floor((Date.now() - startedAt) / 1000));
      setRrNudge((n) => (n === null ? null : { ...n, secondsLeft: left }));
      if (left === 0 && rrTimer.current !== null) {
        clearInterval(rrTimer.current); rrTimer.current = null;
        putRaw((r) => ({ ...r, rr: "" }));
        setFocusReq("rr");
      }
    }, 250);
  }, [putRaw]);

  useEffect(() => {
    if (focusReq === null) return;
    refs.current[focusReq]?.focus();
    setFocusReq(null);
  }, [focusReq, tiles]);

  // A new patient starts from nothing; the carried candidates arrive locked, showing the last chart.
  useEffect(() => {
    const next = emptyTiles();
    if (preStage !== null && preStage.last !== null) {
      for (const k of preStage.carryCandidates) {
        if (k === "sbp" || k === "dbp") continue;
        const v = preStage.last[k];
        if (v !== null) next[k].carried = v;
      }
    }
    for (const [k, takes] of Object.entries(initialTakes ?? {}) as [TileKey, Take[]][]) {
      if (takes.length > 0) next[k] = { ...next[k], takes: [...takes], carried: null };
    }
    setTiles(next);
    putRaw(blankRaw);
    setMirror(null); setServerGates([]); setLockedByServer([]); setMissing([]); setError(null); setChips({}); setTempTyped(null);
    setRrNudge(null); rrFocusedAt.current = null; setUnlocking(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialTakes` is read once per patient, with the reset
  }, [resetKey, preStage]);

  const focusNextEmpty = useCallback((after: TileKey, current: Tiles) => {
    const i = order.indexOf(after);
    const rest = [...order.slice(i + 1), ...order.slice(0, i)];
    const next = rest.find((k) => operative(current[k]) === null && current[k].carried === null);
    if (next !== undefined) refs.current[next]?.focus();
    else refs.current[after]?.blur();
  }, [order]);

  const gateCtx = useMemo(() => ({ ageYears: preStage?.ageYears ?? null, ranges, last: preStage?.last ?? null }), [preStage, ranges]);

  const commit = useCallback((key: TileKey, source: TakeSource, take: Take): Tiles | null => {
    const r = applyTake(tiles, key, source, take, gateCtx);
    if (r.mirror !== null) {
      // a probe error is HELD — kept out of the chart, not lost
      if (r.mirror.kind === "probe_error") { setTiles(r.tiles); setMirror({ key, m: r.mirror }); return r.tiles; }
      setMirror({ key, m: r.mirror });
      return null;
    }
    setMirror(null);
    setTiles(r.tiles);
    onCommitted?.(key, take, r.tiles);
    return r.tiles;
  }, [tiles, gateCtx, onCommitted]);

  const commitTyped = useCallback((key: TileKey, opts: { advance: boolean; demandANumber: boolean }): boolean => {
    const text = rawRef.current[key];
    if (!opts.demandANumber && text.trim() === "") return true;
    const take = parseTake(key, text);
    if (take === null) { setError(t(`vitalsBay.capture.${takeError(key, text)}`)); return false; }
    setError(null);
    setMissing((m) => m.filter((k) => k !== key));
    if (key === "tempC") { const n = tempNote(text); setTempTyped(n !== null && n.unit === "F" ? n.f : null); }
    putRaw((r) => ({ ...r, [key]: "" })); // emptied BEFORE the focus moves — see `rawRef`
    const counted = key === "rr" && rrNudge !== null && rrNudge.secondsLeft === 0;
    if (key === "rr" && typeof take === "number") {
      const instant = !counted && rrFocusedAt.current !== null && Date.now() - rrFocusedAt.current < 15_000;
      setRrNudge(instant ? { value: take, secondsLeft: null } : null);
    }
    const next = commit(key, counted ? "counted" : "typed", take);
    if (next !== null && opts.advance) focusNextEmpty(key, next);
    return next !== null;
  }, [putRaw, commit, focusNextEmpty, t, rrNudge]);

  const resolveMirror = useCallback((action: "confirm" | "fix" | "retake") => {
    if (mirror === null) return;
    const { key, m } = mirror;
    if (action === "retake") { setMirror(null); refs.current[key]?.focus(); return; }
    if (action === "fix" && m.kind === "slipped_digit" && m.suggestion !== null) {
      const fixed = m.suggestion;
      setTiles((prev) => ({ ...prev, [key]: { ...prev[key], takes: [...prev[key].takes, fixed], carried: null } }));
      setMirror(null);
      return;
    }
    // "It is real": the override is per key and travels on the wire. For a probe error this is the
    // hypoxic patient's only road — a genuine 68 % must be chartable and must reach the protocol.
    const reason = m.kind === "slipped_digit" ? "confirmed_real" : m.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
    const tile = tiles[key];
    const next = { ...tiles, [key]: { ...tile, takes: [...tile.takes, m.value], override: reason, carried: null } };
    setTiles(next);
    setMirror(null);
    onCommitted?.(key, m.value, next);
  }, [mirror, tiles, onCommitted]);

  const unlock = useCallback((key: TileKey, reason: WireUnlockReason) => {
    setTiles((prev) => ({ ...prev, [key]: { ...prev[key], unlockReason: reason, carried: null } }));
    setLockedByServer((l) => l.filter((k) => foldKey(k) !== key));
    setUnlocking(null);
    setFocusReq(key);
  }, []);

  const save = useCallback(async (emergency: boolean) => {
    // Everything still in a box is charted here, in tile order, before the set is judged.
    let current = tiles;
    const flushed: TileKey[] = [];
    let stop: { key: TileKey; mirror: Mirror | null; text?: string } | null = null;
    for (const k of order) {
      const text = rawRef.current[k];
      if (text.trim() === "") continue;
      const take = parseTake(k, text);
      if (take === null) { stop ??= { key: k, mirror: null, text }; continue; } // the text stays in the box
      if (k === "tempC") { const n = tempNote(text); setTempTyped(n !== null && n.unit === "F" ? n.f : null); }
      const r = applyTake(current, k, "typed", take, gateCtx);
      current = r.tiles;
      flushed.push(k);
      if (r.mirror !== null) { stop ??= { key: k, mirror: r.mirror }; continue; }
      onCommitted?.(k, take, current);
    }
    if (flushed.length > 0) putRaw((r) => ({ ...r, ...Object.fromEntries(flushed.map((k) => [k, ""])) }));
    if (current !== tiles) setTiles(current);
    if (stop !== null) {
      if (stop.mirror !== null) setMirror({ key: stop.key, m: stop.mirror });
      else setError(t(`vitalsBay.capture.${takeError(stop.key, stop.text ?? "")}`));
      refs.current[stop.key]?.focus();
      return;
    }
    if (flushed.length > 0) setMirror(null);
    const miss = missingFor(current, set.required, emergency);
    if (miss.length > 0) { setMissing(miss); refs.current[miss[0]!]?.focus(); return; }
    setMissing([]); setError(null); setBusy(true); onBusy?.(true);
    const chipList = CONTEXT_CHIPS.filter((c) => chips[c.key] !== undefined)
      .map((c) => ({ key: c.key, question: c.question, answer: chips[c.key] === "yes" ? c.yes : c.no }));
    try {
      onSaved(await api.postVitals(row.encounterId, buildBody(current, { emergency, chips: chipList })));
    } catch (e) {
      if (e instanceof NetworkError) { setError(t("mobile.vitals.saveNetwork")); return; }
      if (e instanceof ApiError) {
        const body = e.body as { code?: string; detail?: { gates?: WireVitalsGate[]; locked?: { key: WireVitalKey }[]; missing?: WireVitalKey[] } } | null;
        if (body?.code === "vitals_gate" && body.detail?.gates !== undefined) { setServerGates(body.detail.gates); return; }
        if (body?.code === "carried_value_locked" && body.detail?.locked !== undefined) { setLockedByServer(body.detail.locked.map((l) => l.key)); return; }
        if (body?.code === "vitals_incomplete" && body.detail?.missing !== undefined) { setMissing([...new Set(body.detail.missing.map(foldKey))]); return; }
        // The fee gate, in the nurse's language and naming the way through.
        if (body?.code === "consult_gate_refused") { setError(t("vitalsBay.capture.feeGate")); return; }
        setError(refusalText(e.body, e.code));
        return;
      }
      setError(String(e));
    } finally {
      setBusy(false); onBusy?.(false);
    }
  }, [tiles, putRaw, order, gateCtx, onCommitted, t, set.required, chips, row.encounterId, onSaved, onBusy, api]);

  const acceptServerGate = useCallback((g: WireVitalsGate, action: "confirm" | "fix") => {
    const key = foldKey(g.key);
    setTiles((prev) => {
      const tile = prev[key];
      if (action === "fix" && g.suggestion !== undefined) return { ...prev, [key]: { ...tile, takes: [...tile.takes.slice(0, -1), g.suggestion] } };
      const reason = g.kind === "slipped_digit" ? "confirmed_real" : g.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
      return { ...prev, [key]: { ...tile, override: reason } };
    });
    setServerGates((gs) => gs.filter((x) => x !== g));
  }, []);

  const unit = (k: TileKey): string => t(`vitalsBay.unit.${k}`);
  const label = (k: TileKey): string => t(`vitalsBay.tile.${k}`);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "web" ? undefined : "padding"}>
      <ScrollView testID="capture" keyboardShouldPersistTaps="handled" contentContainerStyle={c.scroll}>
        {header}
        <View testID="tiles" style={c.grid}>
          {order.map((k) => {
            const tile = tiles[k];
            const op = operative(tile);
            const tint = op !== null ? flagOf(k, op, band, ranges) : null;
            const required = set.required.includes(k);
            const isMissing = missing.includes(k);
            const locked = tile.carried !== null && tile.unlockReason === null;
            const serverLocked = lockedByServer.some((lk) => foldKey(lk) === k);
            const range = rangeLabelOf(k, preStage);
            const delta = tileDeltaOf(k, tile, preStage);
            const hot = tint === "danger" || tint === "sam";
            const fg = hot ? color.red : tint !== null ? "#8a5a10" : color.dim;
            const typing = raw[k].trim();
            const reads = (k === "bp" || k === "tempC") && typing !== "" ? parseTake(k, typing) : null;
            const tn = k === "tempC" && reads !== null ? tempNote(typing) : null;
            return (
              <View
                key={k} testID={`tile-${k}`}
                accessibilityLabel={tint === null ? undefined : `${label(k)} ${t(`vitalsBay.capture.tint.${tint}`)}`}
                style={[
                  c.tile, locked && c.tileWide,
                  tint !== null && !hot && { borderColor: color.goldLine, backgroundColor: color.goldSoft },
                  hot && { borderColor: color.redLine, backgroundColor: color.redSoft, borderWidth: 2 },
                  isMissing && { borderColor: color.red, borderWidth: 2 },
                ]}
              >
                <View style={c.tileHead}>
                  <Text style={[c.tileLabel, { color: fg }]} testID={`label-${k}`}>
                    {label(k)}{required ? " *" : ""}
                  </Text>
                  {range !== null && <Text style={c.range} testID={`range-${k}`}>{range}</Text>}
                </View>
                {set.notRoutine.includes(k) && <Text style={c.faint} testID={`not-routine-${k}`}>{t("vitalsBay.capture.notRoutine")}</Text>}

                {locked ? (
                  <View testID={`carried-${k}`} style={{ gap: 6 }}>
                    <Text style={c.value}>{tile.carried} <Text style={c.unit}>{unit(k)}</Text></Text>
                    <Text style={c.small}>{t("vitalsBay.capture.carriedLocked")}</Text>
                    {unlocking === k ? (
                      <View style={{ gap: 6 }}>
                        <Text style={c.small}>{t("vitalsBay.unlock.label")}</Text>
                        {UNLOCK_REASONS.map((r) => (
                          <Pressable key={r} testID={`unlock-${k}-${r}`} accessibilityRole="button" onPress={() => unlock(k, r)} style={c.option}>
                            <Text style={c.optionText}>{t(`vitalsBay.unlock.reason.${r}`)}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <Pressable testID={`unlock-${k}`} accessibilityRole="button" onPress={() => setUnlocking(k)} style={c.option}>
                        <Text style={c.optionText}>{t("vitalsBay.unlock.pick")}</Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <>
                    <View style={c.valueRow}>
                      <Text testID={`value-${k}`} style={[c.value, hot && { color: color.red, fontWeight: "800" }]}>{op === null ? "—" : showTake(op)}</Text>
                      <Text style={c.unit}>{unit(k)}</Text>
                    </View>
                    {k === "tempC" && op !== null && tempTyped !== null && (
                      <Text testID="temp-typed-f" style={c.small}>{t("vitalsBay.capture.tempTypedF", { f: tempTyped })}</Text>
                    )}
                    {op !== null && (
                      <Text style={c.source} testID={`source-${k}`}>
                        {t(`vitalsBay.capture.source.${sourcePillOf(k, tile.source)}`)}
                        {tile.takes.length > 1 ? `  ${tile.takes.map(showTake).join(" · ")}` : ""}
                      </Text>
                    )}
                    {delta !== null && (
                      <Text testID={`delta-${k}`} style={[c.small, delta.hot && { color: "#8a5a10", fontWeight: "700" }]}>
                        {t("vitalsBay.capture.delta", { month: monthLabel(delta.serviceDate), from: delta.from, delta: delta.delta })}
                      </Text>
                    )}
                    {tint !== null && <Text testID={`tint-${k}`} style={[c.tint, { color: hot ? color.red : "#8a5a10" }]}>{t(`vitalsBay.capture.tint.${tint}`)}</Text>}
                    {tile.held.length > 0 && <Text testID={`held-${k}`} style={c.small}>{t("vitalsBay.capture.held", { values: tile.held.join(", ") })}</Text>}
                    {tile.unlockReason !== null && k !== "bp" && (
                      <Text testID={`unlocked-${k}`} style={c.small}>{t("vitalsBay.unlock.was", { value: preStage?.last?.[k] ?? "" })}</Text>
                    )}
                    <TextInput
                      ref={(el) => { refs.current[k] = el; }}
                      testID={`input-${k}`}
                      accessibilityLabel={`${label(k)} ${unit(k)}`.trim()}
                      keyboardType={k === "bp" ? BP_KEYBOARD : "decimal-pad"}
                      inputMode={Platform.OS === "web" ? (k === "bp" ? "tel" : "decimal") : undefined}
                      returnKeyType="next" submitBehavior="submit" autoCorrect={false} autoComplete="off" selectTextOnFocus
                      placeholder={k === "bp" ? "158-96" : k === "tempC" ? "°F or °C" : ""}
                      placeholderTextColor={color.faint}
                      value={raw[k]}
                      onChangeText={(text) => putRaw((r) => ({ ...r, [k]: text }))}
                      onFocus={() => { setFocused(k); if (k === "rr" && rrFocusedAt.current === null) rrFocusedAt.current = Date.now(); }}
                      onBlur={() => { setFocused((f) => (f === k ? null : f)); commitTyped(k, { advance: false, demandANumber: false }); }}
                      onSubmitEditing={() => { commitTyped(k, { advance: true, demandANumber: true }); }}
                      style={[c.input, NO_OUTLINE, focused === k && c.inputFocus]}
                    />
                    {reads !== null && (
                      <Text testID={`reads-${k}`} style={c.reads}>
                        {Array.isArray(reads)
                          ? t("vitalsBay.capture.readsBp", { sys: reads[0], dia: reads[1] })
                          : tn !== null && tn.unit === "F"
                            ? t("vitalsBay.capture.readsTempF", { f: tn.f, c: tn.c })
                            : t("vitalsBay.capture.readsTempC", { c: reads })}
                      </Text>
                    )}
                    {k === "weightKg" && <Text testID="weight-quiet" style={c.faint}>{t("vitalsBay.capture.weightQuiet")}</Text>}
                    {k === "rr" && rrNudge !== null && (
                      <View testID="rr-nudge" style={{ gap: 6 }}>
                        <Text style={[c.small, { color: "#8a5a10" }]}>
                          {rrNudge.secondsLeft === null ? t("vitalsBay.capture.rrNudge", { value: rrNudge.value })
                            : rrNudge.secondsLeft > 0 ? t("vitalsBay.capture.rrCounting", { seconds: rrNudge.secondsLeft }) : t("vitalsBay.capture.rrCounted")}
                        </Text>
                        {rrNudge.secondsLeft === null && (
                          <Pressable testID="rr-count" accessibilityRole="button" onPress={startRrCounter} style={c.option}>
                            <Text style={c.optionText}>{t("vitalsBay.capture.rrCount")}</Text>
                          </Pressable>
                        )}
                      </View>
                    )}
                  </>
                )}
                {serverLocked && <Text accessibilityRole="alert" testID={`server-locked-${k}`} style={[c.tint, { color: color.red }]}>{t("vitalsBay.unlock.serverLocked")}</Text>}
              </View>
            );
          })}
        </View>
        <Text style={c.faint}>{t("mobile.vitals.requiredLegend")}</Text>

        {mirror !== null && (
          <View accessibilityRole="alert" testID="mirror" style={c.alert}>
            <Text style={c.alertText}>
              {mirror.m.kind === "slipped_digit" && t("vitalsBay.gate.slippedDigit", { value: mirror.m.value, suggestion: mirror.m.suggestion ?? "" })}
              {mirror.m.kind === "shrinking_adult" && t("vitalsBay.gate.shrinkingAdult", { value: mirror.m.value, last: mirror.m.last })}
              {mirror.m.kind === "probe_error" && t("vitalsBay.gate.probeError", { value: mirror.m.value })}
            </Text>
            {mirror.m.kind === "slipped_digit" && mirror.m.suggestion !== null && (
              <Button testID="mirror-fix" label={t("vitalsBay.gate.fix", { value: mirror.m.suggestion })} onPress={() => resolveMirror("fix")} />
            )}
            <Button testID="mirror-retake" kind="secondary" label={t("vitalsBay.gate.retake")} onPress={() => resolveMirror("retake")} />
            <Button testID="mirror-confirm" kind="secondary" label={t(mirror.m.kind === "probe_error" ? "vitalsBay.gate.confirmProbe" : "vitalsBay.gate.confirm")} onPress={() => resolveMirror("confirm")} />
          </View>
        )}
        {serverGates.map((g) => (
          <View key={`${g.key}-${g.kind}`} accessibilityRole="alert" testID={`server-gate-${g.key}`} style={c.alert}>
            <Text style={c.alertText}>{g.message}</Text>
            {g.suggestion !== undefined && <Button testID={`server-gate-fix-${g.key}`} label={t("vitalsBay.gate.fix", { value: g.suggestion })} onPress={() => acceptServerGate(g, "fix")} />}
            <Button testID={`server-gate-confirm-${g.key}`} kind="secondary" label={t("vitalsBay.gate.confirm")} onPress={() => acceptServerGate(g, "confirm")} />
          </View>
        ))}

        {/* The questions asked while the cuff inflates: not asked → yes → no → not asked. */}
        <View testID="chips" style={c.chips}>
          {CONTEXT_CHIPS.map((ch) => {
            const a = chips[ch.key];
            return (
              <Pressable
                key={ch.key} testID={`chip-${ch.key}`} accessibilityRole="button" accessibilityState={{ selected: a === "yes" }}
                onPress={() => setChips((p) => ({ ...p, [ch.key]: p[ch.key] === undefined ? "yes" : p[ch.key] === "yes" ? "no" : undefined }))}
                style={[c.chip, a === "yes" && c.chipOn]}
              >
                <Text style={[c.chipText, a === "yes" && { color: color.green, fontWeight: "700" }, a === "no" && { textDecorationLine: "line-through", color: color.faint }]}>
                  {t(`vitalsBay.chips.${ch.key}`)}{a !== undefined ? ` · ${t(a === "yes" ? "vitalsBay.chips.yes" : "vitalsBay.chips.no")}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* The emergency save skips the band's required set: right perhaps twice a month, so it is not the primary. */}
        <Pressable testID="save-emergency" accessibilityRole="button" disabled={busy} onPress={() => { void save(true); }} style={[c.emergency, busy && { opacity: 0.55 }]}>
          <Text style={c.emergencyText}>{t("vitalsBay.capture.saveNow")}</Text>
        </Pressable>
      </ScrollView>

      <View style={[c.bar, { paddingBottom: Math.max(insets.bottom, space.md) }]} testID="save-bar">
        {missing.length > 0 && <Text accessibilityRole="alert" testID="missing" style={c.barError}>{t("vitalsBay.capture.missing", { tiles: missing.map(label).join(", ") })}</Text>}
        {error !== null && <Text accessibilityRole="alert" testID="capture-error" style={c.barError}>{error}</Text>}
        <Button testID="save" label={t("vitalsBay.capture.save")} busy={busy} onPress={() => { void save(false); }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const c = StyleSheet.create({
  scroll: { padding: space.lg, paddingBottom: space.xl, gap: space.md },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: space.md },
  tile: { width: "48.3%", backgroundColor: color.card, borderWidth: 1, borderColor: color.line, borderRadius: radius.lg, padding: space.md, gap: 4 },
  tileWide: { width: "100%" },
  tileHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: 6 },
  tileLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  range: { fontFamily: MONO, fontSize: 11, color: color.faint },
  valueRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6, minHeight: 34 },
  value: { fontFamily: MONO, fontSize: 27, fontWeight: "700", color: color.ink },
  unit: { fontSize: 12, fontWeight: "400", color: color.dim },
  source: { fontFamily: MONO, fontSize: 10.5, fontWeight: "700", letterSpacing: 1, color: color.dim },
  small: { fontSize: 12, lineHeight: 16, color: color.dim },
  faint: { fontSize: 12, lineHeight: 16, color: color.faint },
  tint: { fontSize: 12.5, lineHeight: 16, fontWeight: "700" },
  reads: { fontFamily: MONO, fontSize: 12.5, color: color.green, fontWeight: "600" },
  input: { minHeight: TOUCH, marginTop: 2, paddingHorizontal: 12, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.card, fontFamily: MONO, fontSize: 19, color: color.ink },
  inputFocus: { borderColor: color.green, borderWidth: 2 },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: color.greenLine, borderRadius: radius.md, backgroundColor: color.card },
  optionText: { fontSize: 14, fontWeight: "600", color: color.green },
  alert: { borderWidth: 1, borderColor: color.redLine, backgroundColor: color.redSoft, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  alertText: { fontSize: 14, lineHeight: 20, color: color.ink, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  chipOn: { borderColor: color.greenLine, backgroundColor: color.greenSoft },
  chipText: { fontSize: 14, color: color.ink },
  emergency: { minHeight: TOUCH, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.redLine, backgroundColor: color.card },
  emergencyText: { fontSize: 14, fontWeight: "700", color: color.red, textAlign: "center" },
  bar: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line },
  barError: { fontSize: 13.5, lineHeight: 18, fontWeight: "700", color: color.red },
});
