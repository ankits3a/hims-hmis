import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { UNLOCK_REASONS, opdErrorMessage, postVitals } from "../lib/opd-api";
import type {
  WireBandConfig, WireBenchRow, WireDangerFlag, WireDangerRanges, WirePreStage, WireReadings, WireUnlockReason,
  WireVitalKey, WireVitalsGate, WireVitalsPostBody, WireVitalsSaveResult,
} from "../lib/opd-api";

/**
 * VD-2 T2 — THE CAPTURE CORE: tiles, not a form (stories 2, 5, 6).
 *
 * ═══ THE SCREEN MIRRORS THE GATES; THE SERVER IS THE AUTHORITY (phase doc D3) ═══
 *
 * Every rule below has a twin in `opd/vitals-rules.ts`, and the twin is the one that counts. The
 * mirrors exist so a typist is stopped BEFORE the round trip — a 4.8 kg adult never leaves the
 * tile — and a 409 `vitals_gate` / `carried_value_locked` from the server is rendered exactly as
 * the mirror would have rendered it, never as an error. A mirror that disagreed with the server
 * would be caught by the server, which is the point of having both.
 *
 * ═══ THE READING MODEL IS THE WIRE'S (VD-1 D1) ═══
 *
 * A tile holds TAKES, not a value: a re-clip after a probe error is a second take with the first
 * one `held`; a BP is `[systolic, diastolic]`. The scalars the server derives are its business.
 * `source` is `typed` or `device`, which is also the keys-vs-device score (D4): the telemetry is a
 * count of what was saved, not a second store.
 */
export type TileKey = "bp" | "pulse" | "spo2" | "tempC" | "rr" | "weightKg" | "heightCm" | "muacCm";
export const TILE_KEYS: readonly TileKey[] = ["bp", "pulse", "spo2", "tempC", "rr", "weightKg", "heightCm", "muacCm"];
const SCALAR_TILES: readonly Exclude<TileKey, "bp">[] = ["pulse", "spo2", "tempC", "rr", "weightKg", "heightCm", "muacCm"];

export type Take = number | [number, number];
export type Tile = {
  takes: Take[];
  held: number[];
  source: "typed" | "device";
  /** D7 — a carried value: shown from the last chart, sent as `carriedForward` unless unlocked. */
  carried: number | null;
  unlockReason: WireUnlockReason | null;
  override: string | null;
};
export type Tiles = Record<TileKey, Tile>;

export function emptyTiles(): Tiles {
  const t = {} as Tiles;
  for (const k of TILE_KEYS) t[k] = { takes: [], held: [], source: "typed", carried: null, unlockReason: null, override: null };
  return t;
}

/** The tiles a band asks for, in the wire's vocabulary folded to the screen's (sbp+dbp → bp). */
export function tileSetFor(pre: WirePreStage | null): { required: TileKey[]; notRoutine: TileKey[] } {
  const fold = (keys: readonly WireVitalKey[]): TileKey[] => {
    const out: TileKey[] = [];
    for (const k of keys) {
      const tk: TileKey = k === "sbp" || k === "dbp" ? "bp" : k;
      if (!out.includes(tk)) out.push(tk);
    }
    return out;
  };
  if (pre === null) return { required: ["bp", "pulse", "spo2", "tempC", "weightKg", "heightCm"], notRoutine: [] };
  return { required: fold(pre.required), notRoutine: fold(pre.notRoutine) };
}

export const EMERGENCY_TILES: readonly TileKey[] = ["bp", "pulse", "spo2"];

/**
 * The order the typing lane walks: the clinical order the tray is laid in (cuff, probe, thermometer,
 * then the scale and the tape), the lead vital pulled to the front (per-patient autofocus). MUAC is
 * a tile only where the band asks for it — "required under six, meaningless over it" (VD-1 D5).
 * A not-routine BP stays on the tray, collapsed: recorded when the doctor asks, never demanded.
 */
export function tileOrder(lead: TileKey | null, set: { required: TileKey[]; notRoutine: TileKey[] }): TileKey[] {
  const base = TILE_KEYS.filter((k) => k !== "muacCm" || set.required.includes(k));
  if (lead === null || !base.includes(lead)) return base;
  return [lead, ...base.filter((k) => k !== lead)];
}

export function leadTileFor(pre: WirePreStage | null): TileKey {
  const first = pre?.expectedFlags[0]?.vital;
  if (first !== undefined) return first === "sbp" || first === "dbp" ? "bp" : first;
  return pre !== null && pre.band !== "adult" ? "tempC" : "bp";
}

export function parseTake(key: TileKey, raw: string): Take | null {
  const s = raw.trim();
  if (s === "") return null;
  if (key === "bp") {
    const m = /^(\d{2,3})\s*\/\s*(\d{2,3})$/.exec(s);
    return m === null ? null : [Number(m[1]), Number(m[2])];
  }
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

export function operative(tile: Tile): Take | null {
  return tile.takes.length === 0 ? null : tile.takes[tile.takes.length - 1]!;
}

export function bandFor(ranges: WireDangerRanges | null, bandKey: WirePreStage["band"] | null): WireBandConfig | null {
  if (ranges === null || bandKey === null) return null;
  return ranges.bands.find((b) => b.key === bandKey) ?? null;
}

/** The tile's tint: the server's `evaluateVitals`, mirrored, for a single value. */
export function flagOf(key: TileKey, take: Take, band: WireBandConfig | null, ranges: WireDangerRanges | null): "danger" | "notice" | "sam" | "mam" | null {
  if (band === null) return null;
  if (key === "muacCm" && ranges !== null && typeof take === "number") {
    if (take < ranges.muacBands.samUnderCm) return "sam";
    if (take < ranges.muacBands.mamUnderCm) return "mam";
    return null;
  }
  const checks: [WireVitalKey, number][] = key === "bp" && Array.isArray(take)
    ? [["sbp", take[0]], ["dbp", take[1]]]
    : typeof take === "number" ? [[key as WireVitalKey, take]] : [];
  for (const [k, v] of checks) {
    if (band.notRoutine.includes(k)) continue;
    const r = band.ranges[k];
    if (r !== undefined && ((r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max))) return "danger";
  }
  for (const [k, v] of checks) {
    if (band.notRoutine.includes(k)) continue;
    const n = band.noticeRanges[k];
    if (n !== undefined && ((n.min !== undefined && v < n.min) || (n.max !== undefined && v > n.max))) return "notice";
  }
  return null;
}

export type Mirror =
  | { kind: "slipped_digit"; key: "weightKg"; value: number; suggestion: number | null }
  | { kind: "shrinking_adult"; key: "heightCm"; value: number; last: number }
  | { kind: "probe_error"; key: "spo2"; value: number };

/** `sanityGates` + `holdProbeErrors`, mirrored for ONE take as it is committed. */
export function mirrorFor(key: TileKey, take: Take, ageYears: number | null, ranges: WireDangerRanges | null, last: WirePreStage["last"], tile: Tile): Mirror | null {
  if (ranges === null || typeof take !== "number") return null;
  const g = ranges.gates;
  const isChild = ageYears !== null && ageYears < 13;
  if (key === "weightKg" && tile.override === null && !isChild && take < g.adultWeightFloorKg) {
    const shifted = Math.round(take * 100) / 10;
    return { kind: "slipped_digit", key, value: take, suggestion: shifted >= 30 && shifted <= 150 ? shifted : null };
  }
  if (key === "heightCm" && tile.override === null && last !== null && last.heightCm !== null && Math.abs(take - last.heightCm) >= g.heightDeltaCm) {
    return { kind: "shrinking_adult", key, value: take, last: last.heightCm };
  }
  if (key === "spo2" && tile.override === null && take < g.spo2ProbeFloorPct) return { kind: "probe_error", key, value: take };
  return null;
}

export function missingFor(tiles: Tiles, required: TileKey[], emergency: boolean): TileKey[] {
  const need = emergency ? EMERGENCY_TILES : required;
  return need.filter((k) => operative(tiles[k]) === null && tiles[k].carried === null);
}

export function buildBody(tiles: Tiles, opts: { emergency: boolean; chips: { key: string; question: string; answer: string }[] }): WireVitalsPostBody {
  const readings: WireReadings = {};
  const body: WireVitalsPostBody = { emergency: opts.emergency, contextChips: opts.chips };
  const carriedForward: WireVitalKey[] = [];
  const unlockReasons: NonNullable<WireVitalsPostBody["unlockReasons"]> = {};
  const overrides: NonNullable<WireVitalsPostBody["overrides"]> = {};
  const bp = tiles.bp;
  if (bp.takes.length > 0) {
    readings.bp = { takes: bp.takes.filter((t): t is [number, number] => Array.isArray(t)), source: bp.source };
    if (bp.held.length > 0) readings.bp.held = bp.held;
  }
  for (const k of SCALAR_TILES) {
    const t = tiles[k];
    const takes = t.takes.filter((x): x is number => typeof x === "number");
    if (takes.length > 0) {
      readings[k] = { takes, source: t.source };
      if (t.held.length > 0) readings[k]!.held = t.held;
    } else if (t.held.length > 0) {
      // a probe error with nothing surviving still goes in the log (the server says incomplete)
      readings[k] = { takes: [], source: t.source, held: t.held } as unknown as WireReadings[typeof k];
    }
    if (t.carried !== null && takes.length === 0) {
      carriedForward.push(k);
      body[k] = t.carried;
    }
    if (t.unlockReason !== null) unlockReasons[k] = t.unlockReason;
    if (t.override !== null) overrides[k] = t.override;
  }
  if (bp.override !== null) { overrides.sbp = bp.override; overrides.dbp = bp.override; }
  body.readings = readings;
  if (carriedForward.length > 0) body.carriedForward = carriedForward;
  if (Object.keys(unlockReasons).length > 0) body.unlockReasons = unlockReasons;
  if (Object.keys(overrides).length > 0) body.overrides = overrides;
  return body;
}

/** VD-2 D4 — the serial seam. A driver answers a tile with a take, or null. The real drivers land with the hardware. */
export type DeviceDriver = { name: string; read(key: TileKey): Promise<Take | null> };
export const nullDriver: DeviceDriver = { name: "none", read: async () => null };
export type Lane = "typing" | "serial";
const LANE_KEY = "vitalsBay.lane";
export function readLane(): Lane {
  try { return localStorage.getItem(LANE_KEY) === "serial" ? "serial" : "typing"; } catch { return "typing"; }
}
export function writeLane(lane: Lane): void {
  try { localStorage.setItem(LANE_KEY, lane); } catch { /* per-bay convenience; the typing lane is always there */ }
}

const CHIPS = [
  { key: "fasting", question: "khali pet?", yes: "fasting", no: "not fasting" },
  { key: "bp_med_taken", question: "BP ki dawa li?", yes: "BP medicine taken today", no: "BP medicine not taken today" },
  { key: "just_climbed_stairs", question: "abhi seedhi chadh kar aaye?", yes: "just climbed stairs", no: "rested" },
] as const;

export type SavedBanner = { who: string; doctorName: string; flags: WireDangerFlag[]; amended: boolean };

export function CaptureCore({ row, preStage, ranges, lane, driver = nullDriver, onSaved, onKeys, resetKey }: {
  row: WireBenchRow; preStage: WirePreStage | null; ranges: WireDangerRanges | null; lane: Lane; driver?: DeviceDriver;
  onSaved: (result: WireVitalsSaveResult) => void; onKeys?: (typed: number, device: number) => void; resetKey: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const set = useMemo(() => tileSetFor(preStage), [preStage]);
  const lead = useMemo(() => leadTileFor(preStage), [preStage]);
  const order = useMemo(() => tileOrder(lead, set), [lead, set]);
  const band = bandFor(ranges, preStage?.band ?? null);
  const [tiles, setTiles] = useState<Tiles>(emptyTiles);
  const [raw, setRaw] = useState<Record<TileKey, string>>(() => Object.fromEntries(TILE_KEYS.map((k) => [k, ""])) as Record<TileKey, string>);
  const [mirror, setMirror] = useState<{ key: TileKey; m: Mirror } | null>(null);
  const [serverGates, setServerGates] = useState<WireVitalsGate[]>([]);
  const [lockedByServer, setLockedByServer] = useState<WireVitalKey[]>([]);
  const [missing, setMissing] = useState<TileKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chips, setChips] = useState<Record<string, boolean | null>>({});
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState({ typed: 0, device: 0 });
  const refs = useRef<Partial<Record<TileKey, HTMLInputElement | null>>>({});
  // A tile that has just been unlocked has no input until the next render; the focus request waits for it.
  const [focusReq, setFocusReq] = useState<TileKey | null>(null);
  useEffect(() => {
    if (focusReq === null) return;
    refs.current[focusReq]?.focus();
    setFocusReq(null);
  }, [focusReq, tiles]);

  // The carried candidates arrive locked, showing the last chart's number (D7).
  useEffect(() => {
    const next = emptyTiles();
    if (preStage?.last !== null && preStage !== null) {
      for (const k of preStage.carryCandidates) {
        if (k === "sbp" || k === "dbp") continue;
        const v = preStage.last[k];
        if (v !== null) next[k].carried = v;
      }
    }
    setTiles(next);
    setRaw(Object.fromEntries(TILE_KEYS.map((k) => [k, ""])) as Record<TileKey, string>);
    setMirror(null); setServerGates([]); setLockedByServer([]); setMissing([]); setError(null); setChips({});
    setKeys({ typed: 0, device: 0 });
  }, [resetKey, preStage]);

  useEffect(() => { onKeys?.(keys.typed, keys.device); }, [keys, onKeys]);

  useEffect(() => {
    // per-patient lead-vital autofocus, on the first EMPTY tile of the order
    const first = order.find((k) => operative(tiles[k]) === null && tiles[k].carried === null) ?? order[0];
    if (first !== undefined) refs.current[first]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once per patient, not per keystroke
  }, [resetKey, order]);

  const focusNextEmpty = useCallback((after: TileKey, current: Tiles) => {
    const i = order.indexOf(after);
    const rest = [...order.slice(i + 1), ...order.slice(0, i)];
    const next = rest.find((k) => operative(current[k]) === null && current[k].carried === null);
    if (next !== undefined) refs.current[next]?.focus();
  }, [order]);

  /**
   * A take is applied to the CURRENT tiles synchronously — never inside a state updater, whose
   * side effects React may run later or twice — so the jump to the next empty tile reads the
   * tiles the keystroke actually produced (the first draft focused the wrong tile for this reason).
   */
  const commit = useCallback((key: TileKey, source: "typed" | "device", take: Take): Tiles | null => {
    const tile = tiles[key];
    const m = mirrorFor(key, take, preStage?.ageYears ?? null, ranges, preStage?.last ?? null, tile);
    if (m !== null && m.kind === "probe_error") {
      // held OUT of the chart until it survives a re-clip: the number is kept, not charted
      const next = { ...tiles, [key]: { ...tile, held: [...tile.held, m.value], source } };
      setTiles(next); setMirror({ key, m });
      return next;
    }
    if (m !== null) { setMirror({ key, m }); return null; }
    setMirror(null);
    const next = { ...tiles, [key]: { ...tile, takes: [...tile.takes, take], source, carried: null } };
    setTiles(next);
    return next;
  }, [tiles, preStage, ranges]);

  const onEnter = useCallback((key: TileKey) => {
    const take = parseTake(key, raw[key]);
    if (take === null) { setError(key === "bp" ? t("vitalsBay.capture.bpBoth") : t("vitalsBay.capture.notANumber")); return; }
    setError(null);
    const next = commit(key, "typed", take);
    setRaw((r) => ({ ...r, [key]: "" }));
    if (next !== null) focusNextEmpty(key, next);
  }, [raw, commit, focusNextEmpty, t]);

  const readDevice = useCallback(async (key: TileKey) => {
    const take = await driver.read(key);
    if (take === null) { setError(t("vitalsBay.capture.deviceSilent")); return; }
    setKeys((k) => ({ ...k, device: k.device + 1 }));
    const next = commit(key, "device", take);
    if (next !== null) focusNextEmpty(key, next);
  }, [driver, commit, focusNextEmpty, t]);

  const resolveMirror = useCallback((action: "confirm" | "fix" | "retake") => {
    if (mirror === null) return;
    const { key, m } = mirror;
    if (action === "retake") { setMirror(null); refs.current[key]?.focus(); return; }
    if (action === "fix" && m.kind === "slipped_digit" && m.suggestion !== null) {
      setTiles((prev) => ({ ...prev, [key]: { ...prev[key], takes: [...prev[key].takes, m.suggestion!], carried: null } }));
      setMirror(null); return;
    }
    // confirm real: the override is per key and travels on the wire (VD-1 D9)
    const reason = m.kind === "slipped_digit" ? "confirmed_real" : m.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
    setTiles((prev) => ({ ...prev, [key]: { ...prev[key], takes: [...prev[key].takes, m.value], override: reason, carried: null } }));
    setMirror(null);
  }, [mirror]);

  const unlock = useCallback((key: TileKey, reason: WireUnlockReason) => {
    setTiles((prev) => ({ ...prev, [key]: { ...prev[key], unlockReason: reason, carried: null } }));
    setLockedByServer((l) => l.filter((k) => k !== key));
    setFocusReq(key);
  }, []);

  const save = useCallback(async (emergency: boolean) => {
    const miss = missingFor(tiles, set.required, emergency);
    if (miss.length > 0) { setMissing(miss); refs.current[miss[0]!]?.focus(); return; }
    setMissing([]); setError(null); setBusy(true);
    const chipList = CHIPS.filter((c) => chips[c.key] !== undefined && chips[c.key] !== null)
      .map((c) => ({ key: c.key, question: c.question, answer: chips[c.key] === true ? c.yes : c.no }));
    try {
      const result = await postVitals(row.encounterId, buildBody(tiles, { emergency, chips: chipList }));
      onSaved(result);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { code?: string; detail?: { gates?: WireVitalsGate[]; locked?: { key: WireVitalKey }[]; missing?: WireVitalKey[] } } | null;
        if (body?.code === "vitals_gate" && body.detail?.gates !== undefined) { setServerGates(body.detail.gates); return; }
        if (body?.code === "carried_value_locked" && body.detail?.locked !== undefined) { setLockedByServer(body.detail.locked.map((l) => l.key)); return; }
        if (body?.code === "vitals_incomplete" && body.detail?.missing !== undefined) {
          setMissing(body.detail.missing.map((k) => (k === "sbp" || k === "dbp" ? "bp" : k)));
          return;
        }
      }
      setError(opdErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [tiles, set.required, chips, row.encounterId, onSaved]);

  const acceptServerGate = useCallback((g: WireVitalsGate, action: "confirm" | "fix") => {
    const key: TileKey = g.key === "sbp" || g.key === "dbp" ? "bp" : g.key;
    setTiles((prev) => {
      const tile = prev[key];
      if (action === "fix" && g.suggestion !== undefined) {
        return { ...prev, [key]: { ...tile, takes: [...tile.takes.slice(0, -1), g.suggestion] } };
      }
      const reason = g.kind === "slipped_digit" ? "confirmed_real" : g.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
      return { ...prev, [key]: { ...tile, override: reason } };
    });
    setServerGates((gs) => gs.filter((x) => x !== g));
  }, []);

  const unit = (k: TileKey): string => t(`vitalsBay.unit.${k}`);
  const label = (k: TileKey): string => t(`vitalsBay.tile.${k}`);
  const showTake = (x: Take): string => (Array.isArray(x) ? `${x[0]}/${x[1]}` : String(x));

  return (
    <div data-testid="capture" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="tiles">
        {order.map((k, idx) => {
          const tile = tiles[k];
          const op = operative(tile);
          const tint = op !== null ? flagOf(k, op, band, ranges) : null;
          const notRoutine = set.notRoutine.includes(k);
          const required = set.required.includes(k);
          const isMissing = missing.includes(k);
          const locked = tile.carried !== null && tile.unlockReason === null;
          const serverLocked = lockedByServer.some((lk) => (lk === "sbp" || lk === "dbp" ? "bp" : lk) === k);
          return (
            <div
              key={k} data-testid={`tile-${k}`} data-tint={tint ?? ""} data-locked={locked ? "true" : "false"} data-required={required ? "true" : "false"}
              className={`flex flex-col gap-1 rounded-lg border p-2 ${tint === "danger" || tint === "sam" ? "border-destructive" : isMissing ? "border-destructive" : "border-border"} bg-card`}
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span><kbd className="mr-1 rounded border px-1">{idx + 1}</kbd>{label(k)}{required ? " *" : ""}</span>
                {notRoutine && <span data-testid={`not-routine-${k}`}>{t("vitalsBay.capture.notRoutine")}</span>}
                {tile.source === "device" && <span>{t("vitalsBay.capture.fromDevice")}</span>}
              </div>
              {locked ? (
                <div data-testid={`carried-${k}`} className="flex flex-col gap-1 text-sm">
                  <span className="font-mono text-lg">{tile.carried} <span className="text-xs">{unit(k)}</span></span>
                  <span className="text-xs text-muted-foreground">{t("vitalsBay.capture.carriedLocked")}</span>
                  <select
                    aria-label={t("vitalsBay.unlock.label")} data-testid={`unlock-${k}`} className="rounded border border-input bg-card px-1 py-0.5 text-xs"
                    value="" onChange={(e) => { if (e.target.value !== "") unlock(k, e.target.value as WireUnlockReason); }}
                  >
                    <option value="">{t("vitalsBay.unlock.pick")}</option>
                    {UNLOCK_REASONS.map((r) => <option key={r} value={r}>{t(`vitalsBay.unlock.reason.${r}`)}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div className="flex items-baseline gap-1 font-mono">
                    <span data-testid={`value-${k}`} className={`text-lg ${tint === "danger" || tint === "sam" ? "font-semibold" : ""}`}>
                      {op === null ? "—" : showTake(op)}
                    </span>
                    <span className="text-xs text-muted-foreground">{unit(k)}</span>
                    {tile.takes.length > 1 && <span data-testid={`pair-${k}`} className="text-xs text-muted-foreground">{tile.takes.map(showTake).join(" · ")}</span>}
                  </div>
                  {tint !== null && <span data-testid={`tint-${k}`} className="text-xs">{t(`vitalsBay.capture.tint.${tint}`)}</span>}
                  {tile.held.length > 0 && <span data-testid={`held-${k}`} className="text-xs text-muted-foreground">{t("vitalsBay.capture.held", { values: tile.held.join(", ") })}</span>}
                  {tile.unlockReason !== null && <span data-testid={`unlocked-${k}`} className="text-xs text-muted-foreground">{t("vitalsBay.unlock.was", { value: preStage?.last?.[k === "bp" ? "sbp" : k] ?? "" })}</span>}
                  <input
                    ref={(el) => { refs.current[k] = el; }}
                    data-testid={`input-${k}`} inputMode="decimal" autoComplete="off"
                    className="w-full rounded border border-input bg-card px-2 py-1 font-mono text-sm"
                    placeholder={k === "bp" ? "158/96" : ""}
                    value={raw[k]}
                    onChange={(e) => setRaw((r) => ({ ...r, [k]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); onEnter(k); return; }
                      if (e.key.length === 1 || e.key === "Backspace") setKeys((c) => ({ ...c, typed: c.typed + 1 }));
                    }}
                  />
                  {lane === "serial" && (
                    <button type="button" data-testid={`device-${k}`} className="rounded border border-border px-1 text-xs" onClick={() => { void readDevice(k); }}>
                      {t("vitalsBay.capture.readDevice")}
                    </button>
                  )}
                </>
              )}
              {serverLocked && <span role="alert" data-testid={`server-locked-${k}`} className="text-xs">{t("vitalsBay.unlock.serverLocked")}</span>}
            </div>
          );
        })}
      </div>

      {mirror !== null && (
        <div role="alertdialog" data-testid="mirror" data-kind={mirror.m.kind} className="flex flex-wrap items-center gap-2 rounded border border-destructive p-2 text-sm">
          <span>
            {mirror.m.kind === "slipped_digit" && t("vitalsBay.gate.slippedDigit", { value: mirror.m.value, suggestion: mirror.m.suggestion ?? "" })}
            {mirror.m.kind === "shrinking_adult" && t("vitalsBay.gate.shrinkingAdult", { value: mirror.m.value, last: mirror.m.last })}
            {mirror.m.kind === "probe_error" && t("vitalsBay.gate.probeError", { value: mirror.m.value })}
          </span>
          {mirror.m.kind === "slipped_digit" && mirror.m.suggestion !== null && (
            <button type="button" data-testid="mirror-fix" className="rounded border px-2" onClick={() => resolveMirror("fix")}>{t("vitalsBay.gate.fix", { value: mirror.m.suggestion })}</button>
          )}
          <button type="button" data-testid="mirror-retake" className="rounded border px-2" onClick={() => resolveMirror("retake")}>{t("vitalsBay.gate.retake")}</button>
          {mirror.m.kind !== "probe_error" && (
            <button type="button" data-testid="mirror-confirm" className="rounded border px-2" onClick={() => resolveMirror("confirm")}>{t("vitalsBay.gate.confirm")}</button>
          )}
        </div>
      )}
      {serverGates.map((g) => (
        <div key={`${g.key}-${g.kind}`} role="alertdialog" data-testid={`server-gate-${g.key}`} className="flex flex-wrap items-center gap-2 rounded border border-destructive p-2 text-sm">
          <span>{g.message}</span>
          {g.suggestion !== undefined && <button type="button" data-testid={`server-gate-fix-${g.key}`} className="rounded border px-2" onClick={() => acceptServerGate(g, "fix")}>{t("vitalsBay.gate.fix", { value: g.suggestion })}</button>}
          <button type="button" data-testid={`server-gate-confirm-${g.key}`} className="rounded border px-2" onClick={() => acceptServerGate(g, "confirm")}>{t("vitalsBay.gate.confirm")}</button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2 text-xs" data-testid="chips">
        {CHIPS.map((c) => (
          <button
            key={c.key} type="button" data-testid={`chip-${c.key}`} aria-pressed={chips[c.key] === true}
            className={`rounded-full border px-2 py-0.5 ${chips[c.key] === true ? "bg-accent" : ""}`}
            onClick={() => setChips((p) => ({ ...p, [c.key]: p[c.key] === true ? false : true }))}
          >
            {t(`vitalsBay.chips.${c.key}`)}
          </button>
        ))}
      </div>

      {missing.length > 0 && <p role="alert" data-testid="missing">{t("vitalsBay.capture.missing", { tiles: missing.map(label).join(", ") })}</p>}
      {error !== null && <p role="alert" data-testid="capture-error">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="save" disabled={busy} className="rounded bg-primary px-3 py-1 text-primary-foreground" onClick={() => { void save(false); }}>
          {t("vitalsBay.capture.save")}
        </button>
        <button type="button" data-testid="save-emergency" disabled={busy} className="rounded border border-destructive px-3 py-1" onClick={() => { void save(true); }}>
          {t("vitalsBay.capture.saveNow")}
        </button>
        <span data-testid="keys" className="ml-auto text-xs text-muted-foreground">{t("vitalsBay.capture.keys", { typed: keys.typed, device: keys.device })}</span>
      </div>
    </div>
  );
}

export function SavedBannerView({ banner, onDismiss }: { banner: SavedBanner; onDismiss: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const dangers = banner.flags.filter((f) => f.severity !== "notice");
  const notices = banner.flags.filter((f) => f.severity === "notice");
  return (
    <div role="status" data-testid="saved-banner" className="flex flex-col gap-1 rounded border border-primary bg-card p-3">
      <p className="text-base font-semibold">✓ {t(banner.amended ? "vitalsBay.saved.amended" : "vitalsBay.saved.title", { who: banner.who, doctor: banner.doctorName })}</p>
      {dangers.length > 0 && <p data-testid="saved-danger" className="font-semibold">{t("vitalsBay.saved.danger", { vitals: dangers.map((f) => `${f.vital} ${f.value}`).join(", ") })}</p>}
      {notices.length > 0 && <p data-testid="saved-notice">{t("vitalsBay.saved.notice", { vitals: notices.map((f) => `${f.vital} ${f.value}`).join(", ") })}</p>}
      <button type="button" className="self-start text-xs underline" onClick={onDismiss}>{t("vitalsBay.saved.dismiss")}</button>
    </div>
  );
}
