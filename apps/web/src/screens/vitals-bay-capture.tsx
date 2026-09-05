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
  source: "typed" | "device" | "counted";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `31-Aug-2026` — the seat-pass ruling for dates on staff screens (EXECUTE prompt, ruling 9). */
export function humanDate(serviceDate: string): string {
  const [y, m, d] = serviceDate.split("-");
  const month = MONTHS[Number(m) - 1];
  return month === undefined ? serviceDate : `${d}-${month}-${y}`;
}

/**
 * Just the month, for the tile's delta line. The seat-pass ruling ("31-Aug-2026") governs dates a
 * clerk reads as dates; a delta is read as a comparison — "Jun 132/84 → +26/+12" — and a full date
 * inside it crowds out the numbers that are the point of the line.
 */
export function monthLabel(serviceDate: string): string {
  return MONTHS[Number(serviceDate.split("-")[1]) - 1] ?? serviceDate;
}

/** HH:MM on the hospital's clock (IST, fixed +05:30), from an ISO instant. */
export function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function operative(tile: Tile): Take | null {
  return tile.takes.length === 0 ? null : tile.takes[tile.takes.length - 1]!;
}

export function bandFor(ranges: WireDangerRanges | null, bandKey: WirePreStage["band"] | null): WireBandConfig | null {
  if (ranges === null || bandKey === null) return null;
  return ranges.bands.find((b) => b.key === bandKey) ?? null;
}

/**
 * CLOSE pass 1 CRITICAL — the mirrors' limits come from the PRE-STAGE, which carries this
 * patient's band with its ranges, the gate numbers and the MUAC zones (`opd.vitals.history.read`,
 * a permission the desk holds). `GET /opd/config` is `opd.masters.read`, which it does not.
 */
export function rangesFrom(pre: WirePreStage | null): WireDangerRanges | null {
  if (pre === null || pre.gates === undefined) return null;
  return {
    weightRequiredUnderYears: 18,
    bands: [{ key: pre.band, upToAgeYears: null, required: pre.required, notRoutine: pre.notRoutine, ranges: pre.ranges, noticeRanges: pre.noticeRanges }],
    gates: pre.gates, muacBands: pre.muacBands,
  };
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
  // pass 2 / F4 — a confirmed 68 does not switch the hold OFF: a later slip to 40 is held again
  if (key === "spo2" && take < g.spo2ProbeFloorPct && !tile.takes.includes(take)) return { kind: "probe_error", key, value: take };
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
    }
    // a held value with no surviving take is NOT sent: the wire needs one take, and the save is
    // refused as incomplete before it is built (a held-only SpO₂ stays in the tile, not the log)
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE THREE THINGS AN ARTBOARD TILE SAYS THAT THE SHIPPED TILE DID NOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The build spec's charge against `vitals-bay-capture.tsx:474-539` was precise: "a generic bordered
 * grid with no big value, no source pill, no delta, no ✎ and no range label". Three of those five
 * are DERIVATIONS, not styling, and a wrong derivation looks exactly like a right one on a monitor
 * across a bay — which is why they are pure functions with tests rather than JSX.
 *
 * None of them changes a single byte that reaches the server. `buildBody` is untouched.
 */

/**
 * WHERE THE NUMBER CAME FROM. A nurse reading a chart later cannot tell a typed 68 from a monitor's
 * 68, and the two are not equally trustworthy: a cuff that has slipped reports confidently.
 *
 * `RODE THE CUFF` is not decoration. An oscillometric cuff returns a pulse with the pressure — one
 * capture, two vitals (the build spec's own words for the PULSE tile) — so a device-sourced pulse
 * was never independently counted, and that is worth saying on the tile where somebody might
 * otherwise read agreement between two instruments as corroboration.
 */
export type SourcePill = "auto" | "typed" | "counted" | "rodeCuff";
export function sourcePillOf(k: TileKey, source: Tile["source"]): SourcePill {
  if (source === "device") return k === "pulse" ? "rodeCuff" : "auto";
  return source === "counted" ? "counted" : "typed";
}

/**
 * THE BAND'S OWN LIMITS, top-right in mono. `preStage.ranges` is per-band and server-sent (the bay
 * holds no `GET /opd/config` permission), so an infant tile shows an infant's range and the nurse
 * never has to remember which band the patient is in — the tile says it.
 *
 * BP folds two wire keys into one tile, so it prints two ranges. A range with one bound prints the
 * bound it has: `≥ 90` is the whole truth about SpO₂ and inventing an upper limit would be a lie.
 */
export function rangeLabelOf(k: TileKey, pre: WirePreStage | null): string | null {
  if (pre === null) return null;
  const one = (key: WireVitalKey): string | null => {
    const r = pre.ranges[key];
    if (r === undefined) return null;
    if (r.min !== undefined && r.max !== undefined) return `${String(r.min)}–${String(r.max)}`;
    if (r.min !== undefined) return `≥ ${String(r.min)}`;
    if (r.max !== undefined) return `≤ ${String(r.max)}`;
    return null;
  };
  if (k === "bp") {
    const sys = one("sbp");
    const dia = one("dbp");
    if (sys === null && dia === null) return null;
    return `${sys ?? "—"} / ${dia ?? "—"}`;
  }
  return one(k);
}

/**
 * THE DELTA — "Jun 132/84 → +26/+12", gold when |Δsys| > 15 or |Δdia| > 10.
 *
 * ═══ WHY THIS IS THE MOST CLINICALLY LOAD-BEARING LINE ON THE TILE ═══
 *
 * A single 158/96 is a number. A 158/96 that was 132/84 in June is a TREND, and the difference
 * between those two readings is the difference between "slightly high, common, recheck sometime"
 * and "this person's pressure has moved 26 points since we last saw them". The bay already fetches
 * `preStage.last` — the previous chart, in full — and the shipped tile showed none of it.
 *
 * The thresholds are the build spec's and they are asymmetric on purpose: systolic wanders more
 * than diastolic across a day, a cuff and a season, so 15/10 marks the point where the movement is
 * more likely the patient than the measurement.
 *
 * ═══ WHY IT RETURNS PARTS AND NOT A SENTENCE ═══
 *
 * The month is the only localisable fragment, and a pure function that formats it would either pin
 * English into a Hindi desk or take `t` as an argument and stop being testable. So the caller
 * formats the date and this returns everything else assembled.
 */
export type TileDelta = { serviceDate: string; from: string; delta: string; hot: boolean };

const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n));
/* One decimal only where the vital actually has one — a temperature moves by 0.4, a weight by 1.5. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function tileDeltaOf(k: TileKey, tile: Tile, pre: WirePreStage | null): TileDelta | null {
  const last = pre?.last;
  if (last === null || last === undefined) return null;
  const op = operative(tile);
  if (op === null) return null;

  if (k === "bp") {
    if (!Array.isArray(op) || last.sbp === null || last.dbp === null) return null;
    const dSys = round1(op[0] - last.sbp);
    const dDia = round1(op[1] - last.dbp);
    return {
      serviceDate: last.serviceDate,
      from: `${String(last.sbp)}/${String(last.dbp)}`,
      delta: `${signed(dSys)}/${signed(dDia)}`,
      hot: Math.abs(dSys) > 15 || Math.abs(dDia) > 10,
    };
  }
  if (Array.isArray(op)) return null;
  const was = last[k];
  if (was === null || was === undefined) return null;
  return { serviceDate: last.serviceDate, from: String(was), delta: signed(round1(op - was)), hot: false };
}

export type SavedBanner = { who: string; doctorName: string; flags: WireDangerFlag[]; amended: boolean; rest?: string };

export function CaptureCore({ row, preStage, ranges, lane, driver = nullDriver, onSaved, onKeys, resetKey, onCommitted, initialTakes, protocol, onBusy }: {
  row: WireBenchRow; preStage: WirePreStage | null; ranges: WireDangerRanges | null; lane: Lane; driver?: DeviceDriver;
  onSaved: (result: WireVitalsSaveResult) => void; onKeys?: (typed: number, device: number) => void; resetKey: string;
  /** CLOSE pass 1 — a save in flight is a fact the bay must know before it lets anyone else be taken. */
  onBusy?: (busy: boolean) => void;
  /** VD-2 T3 — every committed take is offered to the danger protocol with the tiles as they now stand. */
  onCommitted?: (key: TileKey, take: Take, tiles: Tiles) => void;
  /** VD-2 T3 — a first take held across a rest, restored so the recall lands as a pair. */
  initialTakes?: Partial<Record<TileKey, Take[]>>;
  /** VD-2 T3 — the protocol's own panels, rendered above the tiles where the nurse is looking. */
  protocol?: React.ReactNode;
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
  /** Ruling: a chip is ASKED (yes / no) or not asked. Cycle null → yes → no → null; a mis-click never fabricates an answer. */
  const [chips, setChips] = useState<Record<string, "yes" | "no" | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState({ typed: 0, device: 0 });
  const refs = useRef<Partial<Record<TileKey, HTMLInputElement | null>>>({});
  // A tile that has just been unlocked has no input until the next render; the focus request waits for it.
  const [focusReq, setFocusReq] = useState<TileKey | null>(null);
  /**
   * Ruling 8 — "a suspiciously instant RR gets a nudge and a 15-second counter, never a block."
   * The RR tile remembers when it was focused; a rate committed inside fifteen seconds of that
   * is charted (never blocked) and nudged: the counter runs fifteen seconds and re-takes as
   * `counted`. A nudge is a sentence beside the tile, not a dialog.
   */
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
        setRaw((r) => ({ ...r, rr: "" }));
        setFocusReq("rr");
      }
    }, 250);
  }, []);

  /**
   * Ruling 3 — `1`–`8` address a tile when nobody is typing (a bare digit inside a tile is a value).
   * The window listener reads the tile order of THIS patient, so `1` is always the lead vital.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target;
      if (el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 8) return;
      const key = order[n - 1];
      if (key === undefined) return;
      e.preventDefault();
      refs.current[key]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order]);
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
    for (const [k, takes] of Object.entries(initialTakes ?? {}) as [TileKey, Take[]][]) {
      if (takes.length > 0) next[k] = { ...next[k], takes: [...takes], carried: null };
    }
    setTiles(next);
    setRaw(Object.fromEntries(TILE_KEYS.map((k) => [k, ""])) as Record<TileKey, string>);
    setMirror(null); setServerGates([]); setLockedByServer([]); setMissing([]); setError(null); setChips({});
    setKeys({ typed: 0, device: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialTakes` is read once per patient, with the reset
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
  const commit = useCallback((key: TileKey, source: "typed" | "device" | "counted", take: Take): Tiles | null => {
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
    onCommitted?.(key, take, next);
    return next;
  }, [tiles, preStage, ranges, onCommitted]);

  const onEnter = useCallback((key: TileKey) => {
    const take = parseTake(key, raw[key]);
    if (take === null) { setError(key === "bp" ? t("vitalsBay.capture.bpBoth") : t("vitalsBay.capture.notANumber")); return; }
    setError(null);
    if (key === "rr" && typeof take === "number") {
      const instant = rrFocusedAt.current !== null && Date.now() - rrFocusedAt.current < 15_000 && (rrNudge === null || rrNudge.secondsLeft !== 0);
      setRrNudge(instant ? { value: take, secondsLeft: null } : null);
    }
    const next = commit(key, rrNudge !== null && rrNudge.secondsLeft === 0 && key === "rr" ? "counted" : "typed", take);
    setRaw((r) => ({ ...r, [key]: "" }));
    if (next !== null) focusNextEmpty(key, next);
  }, [raw, commit, focusNextEmpty, t, rrNudge]);

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
    // confirm real: the override is per key and travels on the wire (VD-1 D9). For the probe
    // error this is the HYPOXIC patient's only road (CLOSE pass 1 CRITICAL): a genuine 68 % must be
    // chartable, must reach the protocol, and must be sendable with "Save & send NOW".
    const reason = m.kind === "slipped_digit" ? "confirmed_real" : m.kind === "shrinking_adult" ? "confirmed_after_remeasure" : "confirmed_reclip";
    const tile = tiles[key];
    // the earlier hold stays in the log (`held`); only the confirmed take is charted
    const next = { ...tiles, [key]: { ...tile, takes: [...tile.takes, m.value], override: reason, carried: null } };
    setTiles(next);
    setMirror(null);
    onCommitted?.(key, m.value, next);
  }, [mirror, tiles, onCommitted]);

  const unlock = useCallback((key: TileKey, reason: WireUnlockReason) => {
    setTiles((prev) => ({ ...prev, [key]: { ...prev[key], unlockReason: reason, carried: null } }));
    setLockedByServer((l) => l.filter((k) => k !== key));
    setFocusReq(key);
  }, []);

  const save = useCallback(async (emergency: boolean) => {
    const miss = missingFor(tiles, set.required, emergency);
    if (miss.length > 0) { setMissing(miss); refs.current[miss[0]!]?.focus(); return; }
    setMissing([]); setError(null); setBusy(true); onBusy?.(true);
    const chipList = CHIPS.filter((c) => chips[c.key] !== undefined)
      .map((c) => ({ key: c.key, question: c.question, answer: chips[c.key] === "yes" ? c.yes : c.no }));
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
      setBusy(false); onBusy?.(false);
    }
  }, [tiles, set.required, chips, row.encounterId, onSaved, onBusy]);

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
    <div data-testid="capture" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {protocol}
      <div data-testid="tiles" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 8 }}>
        {order.map((k, idx) => {
          const tile = tiles[k];
          const op = operative(tile);
          const tint = op !== null ? flagOf(k, op, band, ranges) : null;
          const notRoutine = set.notRoutine.includes(k);
          const required = set.required.includes(k);
          const isMissing = missing.includes(k);
          const locked = tile.carried !== null && tile.unlockReason === null;
          const serverLocked = lockedByServer.some((lk) => (lk === "sbp" || lk === "dbp" ? "bp" : lk) === k);
          const range = rangeLabelOf(k, preStage);
          const pill = sourcePillOf(k, tile.source);
          const delta = tileDeltaOf(k, tile, preStage);
          const hot = tint === "danger" || tint === "sam";
          /* The label wears the level: dim when nothing is wrong, gold for a notice, red for a danger. */
          const labelColour = hot ? "var(--red)" : tint !== null ? "var(--gold)" : "var(--dim)";
          return (
            <div
              key={k} data-testid={`tile-${k}`} data-tint={tint ?? ""} data-locked={locked ? "true" : "false"} data-required={required ? "true" : "false"}
              className="box"
              style={{
                display: "flex", flexDirection: "column", gap: 5, padding: "9px 10px 10px",
                borderColor: hot || isMissing ? "var(--red-line)" : tint !== null ? "var(--gold-line)" : undefined,
                background: hot ? "var(--red-soft)" : tint !== null ? "var(--gold-soft)" : undefined,
              }}
            >
              {/* ROW 1 — what this is, and what the BAND says it should be. Mono, right, faint: it is a reference, not a reading. */}
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: labelColour }}>
                  <span className="kb" style={{ marginRight: 4 }}>{idx + 1}</span>{label(k)}{required ? " *" : ""}
                </span>
                {range !== null && <span className="mo" data-testid={`range-${k}`} style={{ fontSize: 10, color: "var(--faint)", whiteSpace: "nowrap" }}>{range}</span>}
              </div>
              {notRoutine && <span data-testid={`not-routine-${k}`} style={{ fontSize: 10, color: "var(--faint)" }}>{t("vitalsBay.capture.notRoutine")}</span>}

              {locked ? (
                <div data-testid={`carried-${k}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mo" style={{ fontSize: 25, fontWeight: 600, lineHeight: 1.05 }}>
                    {tile.carried} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--dim)" }}>{unit(k)}</span>
                  </span>
                  <span style={{ fontSize: 10, color: "var(--dim)" }}>{t("vitalsBay.capture.carriedLocked")}</span>
                  <select
                    aria-label={t("vitalsBay.unlock.label")} data-testid={`unlock-${k}`} className="in" style={{ fontSize: 11, padding: "3px 5px" }}
                    value="" onChange={(e) => { if (e.target.value !== "") unlock(k, e.target.value as WireUnlockReason); }}
                  >
                    <option value="">{t("vitalsBay.unlock.pick")}</option>
                    {UNLOCK_REASONS.map((r) => <option key={r} value={r}>{t(`vitalsBay.unlock.reason.${r}`)}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  {/*
                    THE BIG VALUE. It is the reason a nurse looks at this tile, and on the shipped
                    screen it was `text-lg` — the same size as the label beside it. A number read
                    across a bay, sometimes over a shoulder, is not a body-copy number.
                  */}
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5, minHeight: 30 }}>
                    <span data-testid={`value-${k}`} className="mo" style={{ fontSize: 25, lineHeight: 1.05, fontWeight: hot ? 700 : 600, color: hot ? "var(--red)" : "var(--ink)" }}>
                      {op === null ? "—" : showTake(op)}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--dim)" }}>{unit(k)}</span>
                    {op !== null && (
                      <button
                        type="button" data-testid={`reenter-${k}`} aria-label={t("vitalsBay.capture.reenter", { tile: label(k) })}
                        style={{ marginLeft: "auto", border: "none", background: "none", color: "var(--faint)", fontSize: 13, lineHeight: 1, padding: 2 }}
                        onClick={() => refs.current[k]?.focus()}
                      >✎</button>
                    )}
                  </div>

                  {/* WHERE IT CAME FROM, and — for a pulse — the fact that it was never counted separately. */}
                  {op !== null && (
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                      <span className="tag" data-testid={`source-${k}`} data-source={pill}>{t(`vitalsBay.capture.source.${pill}`)}</span>
                      {tile.takes.length > 1 && <span data-testid={`pair-${k}`} className="mo" style={{ fontSize: 10, color: "var(--dim)" }}>{tile.takes.map(showTake).join(" · ")}</span>}
                    </div>
                  )}

                  {/*
                    THE TREND. Gold when the movement is more likely the patient than the cuff —
                    the one line on this tile that a single reading cannot give you.
                  */}
                  {delta !== null && (
                    <span
                      data-testid={`delta-${k}`} data-hot={delta.hot ? "true" : "false"} className="mo"
                      style={{ fontSize: 10.5, color: delta.hot ? "var(--gold)" : "var(--dim)", fontWeight: delta.hot ? 700 : 400 }}
                    >
                      {t("vitalsBay.capture.delta", { month: monthLabel(delta.serviceDate), from: delta.from, delta: delta.delta })}
                    </span>
                  )}

                  {tint !== null && <span data-testid={`tint-${k}`} style={{ fontSize: 10.5, fontWeight: 600, color: hot ? "var(--red)" : "var(--gold)" }}>{t(`vitalsBay.capture.tint.${tint}`)}</span>}
                  {tile.held.length > 0 && <span data-testid={`held-${k}`} style={{ fontSize: 10, color: "var(--dim)" }}>{t("vitalsBay.capture.held", { values: tile.held.join(", ") })}</span>}
                  {tile.unlockReason !== null && <span data-testid={`unlocked-${k}`} style={{ fontSize: 10, color: "var(--dim)" }}>{t("vitalsBay.unlock.was", { value: preStage?.last?.[k === "bp" ? "sbp" : k] ?? "" })}</span>}
                  <input
                    ref={(el) => { refs.current[k] = el; }}
                    data-testid={`input-${k}`} inputMode="decimal" autoComplete="off"
                    className="in mo" style={{ padding: "4px 7px", fontSize: 13 }}
                    placeholder={k === "bp" ? "158/96" : ""}
                    value={raw[k]}
                    onChange={(e) => setRaw((r) => ({ ...r, [k]: e.target.value }))}
                    onFocus={() => { if (k === "rr" && rrFocusedAt.current === null) rrFocusedAt.current = Date.now(); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); onEnter(k); return; }
                      if (e.key.length === 1 || e.key === "Backspace") setKeys((c) => ({ ...c, typed: c.typed + 1 }));
                    }}
                  />
                  {/*
                    THE OWNER'S DIGNITY RULING, ON THE TILE THAT NEEDS IT. A weight is the one
                    number at this desk that a patient can be humiliated by, and the bay is a
                    curtained bay in a corridor, not a room.
                  */}
                  {k === "weightKg" && <span data-testid="weight-quiet" style={{ fontSize: 10, color: "var(--faint)" }}>{t("vitalsBay.capture.weightQuiet")}</span>}
                  {k === "rr" && rrNudge !== null && (
                    <span data-testid="rr-nudge" style={{ fontSize: 10.5, color: "var(--gold)" }}>
                      {rrNudge.secondsLeft === null
                        ? <>{t("vitalsBay.capture.rrNudge", { value: rrNudge.value })} <button type="button" data-testid="rr-count" className="sec" style={{ padding: "1px 6px", fontSize: 10.5 }} onClick={startRrCounter}>{t("vitalsBay.capture.rrCount")}</button></>
                        : rrNudge.secondsLeft > 0 ? t("vitalsBay.capture.rrCounting", { seconds: rrNudge.secondsLeft }) : t("vitalsBay.capture.rrCounted")}
                    </span>
                  )}
                  {lane === "serial" && (
                    <button type="button" data-testid={`device-${k}`} className="sec" style={{ padding: "2px 7px", fontSize: 10.5 }} onClick={() => { void readDevice(k); }}>
                      {t("vitalsBay.capture.readDevice")}
                    </button>
                  )}
                </>
              )}
              {serverLocked && <span role="alert" data-testid={`server-locked-${k}`} style={{ fontSize: 10.5, color: "var(--red)", fontWeight: 600 }}>{t("vitalsBay.unlock.serverLocked")}</span>}
            </div>
          );
        })}
      </div>

      {mirror !== null && (
        <div role="alertdialog" data-testid="mirror" data-kind={mirror.m.kind} className="box" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "9px 11px", fontSize: 12.5, borderColor: "var(--red-line)", background: "var(--red-soft)" }}>
          <span>
            {mirror.m.kind === "slipped_digit" && t("vitalsBay.gate.slippedDigit", { value: mirror.m.value, suggestion: mirror.m.suggestion ?? "" })}
            {mirror.m.kind === "shrinking_adult" && t("vitalsBay.gate.shrinkingAdult", { value: mirror.m.value, last: mirror.m.last })}
            {mirror.m.kind === "probe_error" && t("vitalsBay.gate.probeError", { value: mirror.m.value })}
          </span>
          {mirror.m.kind === "slipped_digit" && mirror.m.suggestion !== null && (
            <button type="button" data-testid="mirror-fix" className="pri" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => resolveMirror("fix")}>{t("vitalsBay.gate.fix", { value: mirror.m.suggestion })}</button>
          )}
          <button type="button" data-testid="mirror-retake" className="sec" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => resolveMirror("retake")}>{t("vitalsBay.gate.retake")}</button>
          <button type="button" data-testid="mirror-confirm" className="sec" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => resolveMirror("confirm")}>
            {t(mirror.m.kind === "probe_error" ? "vitalsBay.gate.confirmProbe" : "vitalsBay.gate.confirm")}
          </button>
        </div>
      )}
      {serverGates.map((g) => (
        <div key={`${g.key}-${g.kind}`} role="alertdialog" data-testid={`server-gate-${g.key}`} className="box" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "9px 11px", fontSize: 12.5, borderColor: "var(--red-line)", background: "var(--red-soft)" }}>
          <span>{g.message}</span>
          {g.suggestion !== undefined && <button type="button" data-testid={`server-gate-fix-${g.key}`} className="pri" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => acceptServerGate(g, "fix")}>{t("vitalsBay.gate.fix", { value: g.suggestion })}</button>}
          <button type="button" data-testid={`server-gate-confirm-${g.key}`} className="sec" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => acceptServerGate(g, "confirm")}>{t("vitalsBay.gate.confirm")}</button>
        </div>
      ))}

      {/*
        THE CHIPS ARE THE QUESTIONS ASKED WHILE THE CUFF INFLATES, and they are written in the words
        a nurse actually uses at this bay — "khali pet?", not "Fasting status". Three states on one
        tap-cycle (unasked → yes → no → unasked), because a nurse's hand is on a cuff and "not asked"
        has to stay distinguishable from "asked, and the answer was no".
      */}
      <div data-testid="chips" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {CHIPS.map((c) => (
          <button
            key={c.key} type="button" data-testid={`chip-${c.key}`} aria-pressed={chips[c.key] === "yes"} data-answer={chips[c.key] ?? ""}
            className={`pill${chips[c.key] === "yes" ? " on" : ""}`}
            style={chips[c.key] === "no" ? { textDecoration: "line-through", color: "var(--faint)" } : undefined}
            onClick={() => setChips((p) => ({ ...p, [c.key]: p[c.key] === undefined ? "yes" : p[c.key] === "yes" ? "no" : undefined }))}
          >
            {t(`vitalsBay.chips.${c.key}`)}{chips[c.key] !== undefined ? ` · ${t(chips[c.key] === "yes" ? "vitalsBay.chips.yes" : "vitalsBay.chips.no")}` : ""}
          </button>
        ))}
      </div>

      {missing.length > 0 && <p role="alert" data-testid="missing" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{t("vitalsBay.capture.missing", { tiles: missing.map(label).join(", ") })}</p>}
      {error !== null && <p role="alert" data-testid="capture-error" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p>}

      {/*
        THE EMERGENCY SAVE IS DELIBERATELY NOT THE PRIMARY. It skips the band's required set, so it
        is the right button perhaps twice a month and the wrong one the rest of the time: a secondary
        in the colour of what it costs, beside a primary that does the ordinary thing.
      */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <button type="button" data-testid="save" disabled={busy} className="pri" onClick={() => { void save(false); }}>
          {t("vitalsBay.capture.save")}
        </button>
        <button type="button" data-testid="save-emergency" disabled={busy} className="sec" style={{ borderColor: "var(--red-line)", color: "var(--red)" }} onClick={() => { void save(true); }}>
          {t("vitalsBay.capture.saveNow")}
        </button>
        <span data-testid="keys" className="mo" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>{t("vitalsBay.capture.keys", { typed: keys.typed, device: keys.device })}</span>
      </div>
    </div>
  );
}

export function SavedBannerView({ banner, onDismiss }: { banner: SavedBanner; onDismiss: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const dangers = banner.flags.filter((f) => f.severity !== "notice");
  const notices = banner.flags.filter((f) => f.severity === "notice");
  return (
    <div role="status" data-testid="saved-banner" className="box" style={{ display: "flex", flexDirection: "column", gap: 5, padding: "12px 14px", borderColor: "var(--green-line)", background: "var(--green-soft)" }}>
      {banner.rest !== undefined ? (
        <p data-testid="rest-banner" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{t("vitalsBay.rest.sent", { who: banner.who, time: banner.rest })}</p>
      ) : (
        <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--green)" }}>✓ {t(banner.amended ? "vitalsBay.saved.amended" : "vitalsBay.saved.title", { who: banner.who, doctor: banner.doctorName })}</p>
      )}
      {dangers.length > 0 && <p data-testid="saved-danger" style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--red)" }}>{t("vitalsBay.saved.danger", { vitals: dangers.map((f) => `${f.vital} ${f.value}`).join(", ") })}</p>}
      {notices.length > 0 && <p data-testid="saved-notice" style={{ margin: 0, fontSize: 12.5, color: "var(--gold)" }}>{t("vitalsBay.saved.notice", { vitals: notices.map((f) => `${f.vital} ${f.value}`).join(", ") })}</p>}
      <button type="button" className="sec" style={{ alignSelf: "flex-start", padding: "2px 9px", fontSize: 11 }} onClick={onDismiss}>{t("vitalsBay.saved.dismiss")}</button>
    </div>
  );
}
