/**
 * THE VITALS DESK'S READING RULES — one copy, read by the web bay (apps/web/src/screens/vitals-bay*)
 * and by the phone app (apps/mobile/src/vitals). Owner 2026-10-06: "build the next mobile app
 * screen, vitals bay"; the plan's rule is one parser, two screens.
 *
 * PURE: no React, no DOM, no fetch, no imports. Both apps import THIS SOURCE FILE by path (the web
 * through Vite, the phone through Metro's `watchFolders`), so it is deliberately NOT exported from
 * `index.ts` — nothing here needs the built `dist`, and nothing here may grow a dependency.
 *
 * The server stays the authority for every rule (`apps/core/src/modules/opd/vitals-rules.ts`):
 * these are the mirrors that stop a typist before the round trip.
 */

// ——— the wire shapes the desk reads and writes (moved from apps/web/src/lib/opd-api.ts) ———

export type WirePatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null;
  restricted: boolean; administrativeGender: string; dob: string | null;
  /**
   * FD-25 — present ONLY on `GET /opd/appointments?needsRebooking=true&contact=true`, and null on a
   * restricted row. Optional because it is absent from every other read of this shape: a display
   * surface has never needed a contact number and still does not. See the server type for why this
   * is a second narrow surface rather than a widening of `PatientSummary`.
   */
  phone?: string | null;
};

// VD-1 T1 — `muacCm` appended, because the SERVER can now emit it: a supplied MUAC under six is
// flagged at the zone it breached (11.5 SAM, 12.5 MAM). Widened here in the same task that made
// the server able to send it — a wire union narrower than its producer is a type that lies, and it
// lies silently until the first child is measured.
// VD-1 CLOSE / F1 — `severity` appended for the same reason `muacCm` was in T1: the SERVER can now
// emit it, and a wire union narrower than its producer is a type that lies until the first case
// arrives. `danger` moves the queue; `notice` reaches the doctor and does not — a paediatric fever
// is flagged ahead of the call without seating a toddler ahead of a stroke. Optional so every flag
// already persisted reads back unchanged; absent means `danger`, which is the shipped meaning.
export type WireDangerFlag = { vital: "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC" | "muacCm"; value: number; bound: "min" | "max"; limit: number; severity?: "danger" | "notice" };

export type WireBenchState = "resting" | "away";
export type WireEscalationState = "none" | "recheck_demanded" | "escalated" | "cancelled";
export type WireBenchRow = {
  encounterId: string; entryId: string; tokenNo: number; seq: number;
  /** What the paper says (owner 2026-10-06): the visit number, and the code the token is printed with (`ORT-4`). Optional: an older server sends neither. */
  visitNo?: string; departmentCode?: string | null;
  doctorId: string; doctorName: string; serviceDate: string;
  /** Owner 2026-10-07 — "new" | "revisit" | "renewal"; the bay offers "guardian with reports" on a revisit or renewal, never a new visit. Optional: an older server sends none. */
  visitType?: string;
  patient: WirePatientSummary | null;
  benchState: WireBenchState | null;
  recallAt: string | null;
  vitalsDone: boolean;
  vitalsId: string | null;
  escalation: WireEscalationState;
  cancelMsRemaining: number;
  recallDue: boolean;
};

export type WireRange = { min?: number; max?: number };
// OWNER 2026-10-08 — `glucoseMgDl` appended: a finger-prick capillary glucose, charted behind "+".
export type WireVitalKey = "heightCm" | "weightKg" | "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC" | "muacCm" | "glucoseMgDl";
/**
 * WHEN the glucose was taken. A value without it is not a reading a doctor can use (a fasting 186 and
 * an after-food 186 are different findings), so the form will not save one without the other and the
 * server refuses the same body. Stored English keys; the label a nurse reads is translated.
 */
export const GLUCOSE_TIMINGS = ["fasting", "random", "after_food"] as const;
export type GlucoseTiming = (typeof GLUCOSE_TIMINGS)[number];
/** What a glucometer strip can read, in mg/dL, whole numbers only — the server's own bound. */
export const GLUCOSE_MIN = 20;
export const GLUCOSE_MAX = 600;
export type WireBandKey = "infant" | "child_1_5" | "child_6_12" | "adult";
export type WirePreStage = {
  patientId: string;
  ageYears: number | null;
  band: WireBandKey;
  /** CLOSE pass 1 — the band's limits travel with the pre-stage; the bay mirrors nothing from `GET /opd/config` (a permission `vitals_desk` does not hold). */
  ranges: Partial<Record<WireVitalKey, WireRange>>;
  noticeRanges: Partial<Record<WireVitalKey, WireRange>>;
  gates: { adultWeightFloorKg: number; heightDeltaCm: number; spo2ProbeFloorPct: number };
  muacBands: { samUnderCm: number; mamUnderCm: number };
  /** The patient is confidential to this actor: the band is answered, the history is not. */
  sealed: boolean;
  required: WireVitalKey[];
  notRoutine: WireVitalKey[];
  /**
   * FD-32 / owner ruling 2026-09-13 — *"A symbol to symbolize in the vital dashboard that the user
   * has not yet paid."* The LEDGER's answer, not the draft's: false on an unconfigured hospital,
   * which has no fee policy to warn about. `feeBypass` is the front desk's waiver carried as the
   * clerk's own sentence, so each desk shows WHY rather than a bare icon — and it never clears
   * `feeUnpaid`, because a bypass waives the ORDER of payment and not the fee.
   */
  feeUnpaid: boolean;
  feeBypass: { by: string; reason: string; at: string } | null;
  last: {
    vitalsId: string; recordedAt: string; serviceDate: string;
    heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
    pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null; muacCm: number | null;
  } | null;
  carryCandidates: WireVitalKey[];
  expectedFlags: WireDangerFlag[];
};

export type WireBandConfig = {
  key: WireBandKey; upToAgeYears: number | null;
  required: WireVitalKey[]; notRoutine: WireVitalKey[];
  ranges: Partial<Record<WireVitalKey, WireRange>>;
  noticeRanges: Partial<Record<WireVitalKey, WireRange>>;
};
/** `GET /opd/config`'s `dangerRanges`, typed at last — the bay's client-side mirrors read it; the server stays the authority. */
export type WireDangerRanges = {
  weightRequiredUnderYears: number;
  bands: WireBandConfig[];
  gates: { adultWeightFloorKg: number; heightDeltaCm: number; spo2ProbeFloorPct: number };
  muacBands: { samUnderCm: number; mamUnderCm: number };
};
export type WireReadingSource = "typed" | "device" | "counted";
export type WireReading = { takes: number[]; source: WireReadingSource; held?: number[]; note?: string };
export type WireBpReading = { takes: [number, number][]; source: WireReadingSource; held?: number[]; note?: string };
export type WireReadings = Partial<Record<Exclude<WireVitalKey, "sbp" | "dbp">, WireReading>> & { bp?: WireBpReading };
export const UNLOCK_REASONS = ["yearly_remeasure_due", "patient_disputes_old_value", "posture_or_device_changed", "surgical_or_limb_change"] as const;
export type WireUnlockReason = (typeof UNLOCK_REASONS)[number];
export type WireVitalsPostBody = Partial<Record<WireVitalKey, number | null>> & {
  notes?: string | null;
  /** Sent with a glucose value, never without one. */
  glucoseTiming?: GlucoseTiming | null;
  readings?: WireReadings;
  contextChips?: { key: string; question: string; answer: string }[];
  carriedForward?: WireVitalKey[];
  emergency?: boolean;
  overrides?: Partial<Record<WireVitalKey, string>>;
  unlockReasons?: Partial<Record<WireVitalKey, WireUnlockReason>>;
};

export type WireEscalationReading = Partial<Record<Exclude<WireVitalKey, "heightCm" | "weightKg" | "glucoseMgDl">, number>>;

// ——— the hospital clock ———

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
/** The IST calendar date ('YYYY-MM-DD') of an instant — fixed +05:30, no DST, no Intl. */
export function todayIst(at: Date = new Date()): string {
  return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

// ——— the doors: whatever was typed or scanned, resolved on the bench ———

/**
 * OWNER 2026-10-06 — *"searching or scanning the visit id isn't enabling me to select the patient"*.
 * He typed `V2610060001`, the Encounter ID printed on every slip and prescription, for a patient
 * who WAS on the bench; it was read as a UHID and the bay said "not on this bench".
 *
 * WHAT THE PAPER ACTUALLY CARRIES (measured in the renderers, not assumed):
 *   - prescription sheet (kernel/printing/render.ts)  QR = the bare visit number, `V2610060001`
 *   - thermal token slip (same file)                  no scannable code (`barField` is a picture);
 *                                                     text: the token as `<dept code>-<n>`, the visit number
 *   - token slip drawn by the web, and the patient card   QR = `q1.<patientId>.<uhid>.<ver>.<sig>`
 *   - printed e-prescription (opd/prescriptions.ts)   QR = `rx1.<rxId>.<encounterId>.<ver>.<sig>`
 *
 * Every one of them, and everything a person types from them, lands in ONE box and is read here.
 * A card (`q1.`) is the only payload that must be verified by the server before it is trusted; the
 * rest are a lookup in the bench the server already sent, which grants nothing a tap on the row
 * would not.
 */
export type Door =
  | { kind: "token"; tokenNo: number; departmentCode?: string }
  | { kind: "uhid"; uhid: string }
  | { kind: "visit"; visitNo: string }
  | { kind: "encounter"; encounterId: string }
  | { kind: "scan"; payload: string };

const VISIT_RE = /^V\d{6,}$/;
/** A visit number as typed or scanned: any case, spaces tolerated — the server's `normalizeVisitNo`. */
export function normalizeVisitNo(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** Every reading of the text, most likely first. `classifyDoor` is the first; the rest are fallbacks. */
export function doorsOf(raw: string): Door[] {
  const s = raw.trim();
  if (s === "") return [];
  if (s.startsWith("q1.")) return [{ kind: "scan", payload: s }];
  if (s.startsWith("rx1.")) {
    const encounterId = s.split(".")[2];
    return encounterId === undefined || encounterId === "" ? [] : [{ kind: "encounter", encounterId }];
  }
  const compact = normalizeVisitNo(s);
  const uhid: Door = { kind: "uhid", uhid: compact };
  let m = /^#?(\d{1,6})$/.exec(compact);
  if (m !== null) return [{ kind: "token", tokenNo: Number(m[1]) }, uhid];
  if (VISIT_RE.test(compact)) return [{ kind: "visit", visitNo: compact }, uhid];
  // The slip prints the token with its department: `ORT-4`, or `T-4` when the desk had no code.
  m = /^([A-Z]{1,5})[-#]?(\d{1,4})$/.exec(compact);
  if (m !== null) {
    const token: Door = m[1] === "T" ? { kind: "token", tokenNo: Number(m[2]) } : { kind: "token", tokenNo: Number(m[2]), departmentCode: m[1]! };
    return [token, uhid];
  }
  // A scanner app that wraps the code in a sentence or a link still carries the visit number in it.
  m = /(?:^|[^A-Z0-9])(V\d{10})(?:$|[^A-Z0-9])/.exec(s.toUpperCase());
  if (m !== null) return [{ kind: "visit", visitNo: m[1]! }];
  return [uhid];
}

/** How the text is READ — what an error names back ("visit V2610060001 is not on today's bench"). */
export function classifyDoor(raw: string): Door | null {
  return doorsOf(raw)[0] ?? null;
}

/** `U00110049` typed as `u00110049`, or as its digits alone (`110049`, `00110049`). */
function uhidIs(rowUhid: string, typed: string): boolean {
  const a = rowUhid.toUpperCase();
  if (a === typed) return true;
  if (!/^\d+$/.test(typed)) return false;
  const digits = a.replace(/^\D+/, "");
  return /^\d+$/.test(digits) && Number(digits) === Number(typed);
}

type By = Exclude<Door, { kind: "scan" }> | { kind: "patient"; patientId: string };

/** Every bench row the reading names. Tokens are per doctor's queue, so a bare number can name several. */
export function benchMatches(rows: readonly WireBenchRow[], by: By): WireBenchRow[] {
  return rows.filter((r) => {
    switch (by.kind) {
      case "token": return r.tokenNo === by.tokenNo && (by.departmentCode === undefined || (r.departmentCode ?? "").toUpperCase() === by.departmentCode);
      case "uhid": return r.patient !== null && uhidIs(r.patient.uhid, by.uhid);
      case "visit": return r.visitNo !== undefined && r.visitNo.toUpperCase() === by.visitNo;
      case "encounter": return r.encounterId === by.encounterId;
      case "patient": return r.patient !== null && r.patient.id === by.patientId;
    }
  });
}

export function matchOnBench(rows: readonly WireBenchRow[], by: By): WireBenchRow | null {
  return benchMatches(rows, by)[0] ?? null;
}

export type DoorResult =
  /** Exactly one person on the bench. */
  | { outcome: "row"; row: WireBenchRow; door: Door }
  /** A card: the server verifies it, then `matchOnBench(rows, { kind: "patient", … })`. */
  | { outcome: "verify"; payload: string }
  /** A bare token number that more than one doctor's queue holds — never guessed. */
  | { outcome: "ambiguous"; door: Extract<Door, { kind: "token" }>; rows: WireBenchRow[] }
  /** Nobody. `door` is how the text was read, so the refusal can say what was understood. */
  | { outcome: "miss"; door: Door }
  | { outcome: "empty" };

/** THE ONE RESOLVER — the web bay and the phone both call this with what was typed or scanned. */
export function resolveDoor(rows: readonly WireBenchRow[], raw: string): DoorResult {
  const doors = doorsOf(raw);
  const first = doors[0];
  if (first === undefined) return { outcome: "empty" };
  if (first.kind === "scan") return { outcome: "verify", payload: first.payload };
  for (const door of doors) {
    if (door.kind === "scan") continue;
    const hits = benchMatches(rows, door);
    if (hits.length === 1) return { outcome: "row", row: hits[0]!, door };
    if (hits.length > 1) {
      // Rows of ONE visit seen twice are one person; anything else is a real ambiguity.
      if (hits.every((h) => h.encounterId === hits[0]!.encounterId)) return { outcome: "row", row: hits[0]!, door };
      if (door.kind === "token") return { outcome: "ambiguous", door, rows: hits };
      return { outcome: "row", row: hits[0]!, door };
    }
  }
  return { outcome: "miss", door: first };
}

/** The token as the slip prints it — `ORT-4`, or `#4` when the bench sent no department code. */
export function tokenText(door: Extract<Door, { kind: "token" }>): string {
  return door.departmentCode === undefined ? `#${String(door.tokenNo)}` : `${door.departmentCode}-${String(door.tokenNo)}`;
}

/** Why a visit number is not on today's bench — `GET /opd/bench/locate` (opd/bench.ts `locateVisit`). */
export type WireVisitOnBench =
  | { onBench: true; visitNo: string; encounterId: string }
  | { onBench: false; visitNo: string; reason: "unknown_visit" | "other_day" | "abandoned" | "completed" | "not_queued"; serviceDate?: string };

/**
 * WHAT TO SAY when nobody on the bench answers — the i18n key under `vitalsBay.identify.miss` and
 * its values. It names what was UNDERSTOOD (a token, a visit, a UHID), and for a visit number the
 * server's reason when there is one. Pure, so the counter PC and the phone cannot word it apart.
 */
export function missMessage(door: Door, why: WireVisitOnBench | null = null): { key: string; vars: Record<string, string> } {
  switch (door.kind) {
    case "token": return { key: "token", vars: { token: tokenText(door) } };
    case "visit":
      if (why !== null && !why.onBench) {
        return { key: `visit.${why.reason}`, vars: { visitNo: door.visitNo, date: why.serviceDate === undefined ? "" : humanDate(why.serviceDate) } };
      }
      return { key: "visit.plain", vars: { visitNo: door.visitNo } };
    case "encounter": return { key: "prescription", vars: {} };
    case "uhid": return { key: "uhid", vars: { uhid: door.uhid } };
    case "scan": return { key: "uhid", vars: { uhid: "" } };
  }
}

/** A bare token that several doctors' queues hold: the refusal shows how the slip spells one of them. */
export function ambiguousMessage(door: Extract<Door, { kind: "token" }>, rows: readonly WireBenchRow[]): { key: string; vars: Record<string, string> } {
  const coded = rows.find((r) => r.departmentCode !== undefined && r.departmentCode !== null && r.departmentCode !== "");
  return coded === undefined
    ? { key: "ambiguousPlain", vars: { token: tokenText(door), count: String(rows.length) } }
    : { key: "ambiguous", vars: { token: tokenText(door), count: String(rows.length), example: `${coded.departmentCode!}-${String(door.tokenNo)}` } };
}

// ——— the tiles: takes, parsers, gate mirrors, the wire body ———

export type TileKey = "bp" | "pulse" | "spo2" | "tempC" | "rr" | "weightKg" | "heightCm" | "muacCm" | "glucoseMgDl";
export const TILE_KEYS: readonly TileKey[] = ["bp", "pulse", "spo2", "tempC", "rr", "weightKg", "heightCm", "muacCm", "glucoseMgDl"];
const SCALAR_TILES: readonly Exclude<TileKey, "bp">[] = ["pulse", "spo2", "tempC", "rr", "weightKg", "heightCm", "muacCm", "glucoseMgDl"];

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
  // No pre-stage (it failed, or an older server): the routine four. OWNER 2026-10-08 — SpO₂ is not one of them.
  if (pre === null) return { required: [...ROUTINE_TILES], notRoutine: [] };
  return { required: fold(pre.required), notRoutine: fold(pre.notRoutine) };
}

export const EMERGENCY_TILES: readonly TileKey[] = ["bp", "pulse", "spo2"];

/**
 * ═══ OWNER 2026-10-08 — FOUR BOXES, AND A "+" FOR THE REST ═══
 *
 * *"In the Vitals screen, we should keep BP, Weight, height & Pulse as the primary and add a '+'
 * icon to add more vitals like RR, Temperature, Glucose"*; then *"Move SpO2 behind '+'. Add Glucose
 * behind '+'."* ONE function decides which boxes a screen opens with and what the "+" row offers;
 * the web bay and the phone both call it and neither carries a list of its own.
 *
 * A box is on the screen WITHOUT "+" when any of these holds — and only then:
 *   required   the server's protocol for this patient demands it (`WirePreStage.required`: the
 *              routine four for an adult, the arm band under six, whatever a band is edited to ask)
 *   asked      a child's temperature — never mandatory (owner 2026-10-05), always in front of the nurse
 *   flagged    the last chart was out of range on it (`expectedFlags`), so it is taken again today
 *   missing    a save was refused for want of it — the emergency save's SpO₂ arrives here
 *   value      it already holds a number (a held first BP, a carried height, text still in the box)
 *   added      the nurse tapped it in the "+" list
 * Everything else that can be charted at this desk is behind "+", in `PLUS_ORDER`. MUAC is never
 * offered there: "required under six, meaningless over it" (VD-1 D5).
 */
export const ROUTINE_TILES: readonly TileKey[] = ["bp", "pulse", "weightKg", "heightCm"];
/** The order the boxes are laid in: the cuff first for an adult, the scale first for a child (the dose is by weight). */
const ADULT_ORDER: readonly TileKey[] = ["bp", "pulse", "weightKg", "heightCm", "spo2", "tempC", "glucoseMgDl", "rr", "muacCm"];
const CHILD_ORDER: readonly TileKey[] = ["weightKg", "heightCm", "pulse", "tempC", "muacCm", "spo2", "glucoseMgDl", "rr", "bp"];
/** The "+" list, top to bottom. */
export const PLUS_ORDER: readonly TileKey[] = ["spo2", "tempC", "glucoseMgDl", "rr", "bp", "pulse", "weightKg", "heightCm"];

export type BoxWhy = "required" | "asked" | "flagged" | "missing" | "value" | "added";
export type VitalsLayout = {
  /** The boxes on screen, in order. */
  boxes: TileKey[];
  /** What the "+" row still offers; empty means the row is not drawn. */
  behindPlus: TileKey[];
  /** Why each box is there — the first reason that holds, in the order of `BoxWhy`. */
  why: Partial<Record<TileKey, BoxWhy>>;
  /** Boxes the PROTOCOL brought up beyond the routine four (required or asked) — the amber line names them. */
  auto: TileKey[];
  /** Which sentence the amber line uses. */
  autoWhy: "underSix" | "child" | "protocol" | null;
};

const foldVital = (k: WireVitalKey): TileKey => (k === "sbp" || k === "dbp" ? "bp" : k);

/** The tiles that hold something: a take, a held value, a carried number, or text not yet charted. */
export function holdingOf(tiles: Tiles, raw: Partial<Record<TileKey, string>> = {}): TileKey[] {
  return TILE_KEYS.filter((k) => tiles[k].takes.length > 0 || tiles[k].held.length > 0 || tiles[k].carried !== null || (raw[k] ?? "").trim() !== "");
}

export function vitalsLayout(
  pre: WirePreStage | null,
  state: { added?: readonly TileKey[]; holding?: readonly TileKey[]; missing?: readonly TileKey[] } = {},
): VitalsLayout {
  const set = tileSetFor(pre);
  const child = pre !== null && pre.band !== "adult";
  const asked: TileKey[] = child ? ["tempC"] : [];
  const flagged = pre === null ? [] : pre.expectedFlags.map((f) => foldVital(f.vital));
  const why: Partial<Record<TileKey, BoxWhy>> = {};
  const mark = (keys: readonly TileKey[], w: BoxWhy): void => { for (const k of keys) why[k] ??= w; };
  mark(set.required, "required"); mark(asked, "asked"); mark(flagged, "flagged");
  mark(state.missing ?? [], "missing"); mark(state.holding ?? [], "value"); mark(state.added ?? [], "added");
  const boxes = (child ? CHILD_ORDER : ADULT_ORDER).filter((k) => why[k] !== undefined);
  const auto = boxes.filter((k) => (why[k] === "required" || why[k] === "asked") && !ROUTINE_TILES.includes(k));
  return {
    boxes,
    behindPlus: PLUS_ORDER.filter((k) => why[k] === undefined),
    why,
    auto,
    autoWhy: auto.length === 0 ? null : pre !== null && (pre.band === "infant" || pre.band === "child_1_5") ? "underSix" : child ? "child" : "protocol",
  };
}

/**
 * ON A TWO-COLUMN SCREEN (the phone, and the web bay below 900 px): the boxes that take a whole row.
 * BP (two numbers) and glucose (three chips) always do; `alsoNeedsRow` adds the screen's own (a
 * carried height showing its reason picker); and a box that would otherwise sit beside nothing is
 * widened rather than left next to a hole.
 */
export function fullRowBoxes(boxes: readonly TileKey[], alsoNeedsRow: (k: TileKey) => boolean = () => false): TileKey[] {
  const needs = (k: TileKey | undefined): boolean => k === undefined || k === "bp" || k === "glucoseMgDl" || alsoNeedsRow(k);
  const out: TileKey[] = [];
  let col = 0;
  boxes.forEach((k, i) => {
    if (needs(k) || (col === 0 && needs(boxes[i + 1]))) { out.push(k); col = 0; } else col = (col + 1) % 2;
  });
  return out;
}

/*
  OWNER 2026-10-05 — A PHONE'S NUMBER PAD HAS NO "/". The field opens the decimal pad on purpose
  (no letters), and Gboard's offers "-" "," "." and space while iOS's offers "." — so any one of
  them, or "/", separates the two numbers: 150/90 = 150-90 = 150,90 = 150.90 = 150 90.
*/
const BP_RE = /^(\d{2,3})\s*[/,.\- ]\s*(\d{2,3})$/;

/*
  OWNER 2026-10-05 — °F OR °C, SENSED FROM THE NUMBER. The two plausible bands do not overlap
  (25–45 °C is 77–113 °F), so the number alone says which scale it is in and no unit switch is
  needed. The chart keeps °C, so a fever flag reads the converted value. Anything between or
  outside the bands is refused — the server's own plausibility bound is 25–45 °C.
*/
const TEMP_C: readonly [number, number] = [25, 45];
const TEMP_F: readonly [number, number] = [77, 113];
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A typed temperature, read: which scale it was in, and both readings (to one decimal). */
export function tempNote(raw: string): { unit: "C" | "F"; f: number; c: number } | null {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (n >= TEMP_C[0] && n <= TEMP_C[1]) return { unit: "C", c: n, f: round1(n * 9 / 5 + 32) };
  if (n >= TEMP_F[0] && n <= TEMP_F[1]) return { unit: "F", f: n, c: round1((n - 32) * 5 / 9) };
  return null;
}

export function parseTake(key: TileKey, raw: string): Take | null {
  const s = raw.trim();
  if (s === "") return null;
  if (key === "bp") {
    const m = BP_RE.exec(s);
    if (m === null) return null;
    const sys = Number(m[1]), dia = Number(m[2]);
    return sys > dia ? [sys, dia] : null;   // 80-120 is the numbers swapped, not a reading
  }
  if (key === "tempC") return tempNote(s)?.c ?? null;
  if (key === "glucoseMgDl") {
    // a strip reads whole mg/dL; anything else is a slip of the thumb, said on the box itself
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n >= GLUCOSE_MIN && n <= GLUCOSE_MAX ? n : null;
  }
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/** Why `parseTake` said no — the i18n key under `vitalsBay.capture`. */
export function takeError(key: TileKey, raw: string): "bpBoth" | "bpOrder" | "tempUnit" | "glucoseRange" | "notANumber" {
  if (key === "glucoseMgDl") return "glucoseRange";
  if (key === "bp") return BP_RE.test(raw.trim()) ? "bpOrder" : "bpBoth";
  if (key === "tempC" && /^\d+(\.\d+)?$/.test(raw.trim())) return "tempUnit";
  return "notANumber";
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

export type TakeSource = "typed" | "device" | "counted";
export type GateContext = { ageYears: number | null; ranges: WireDangerRanges | null; last: WirePreStage["last"] };

/**
 * ONE take against the tiles as they stand, plus the gate it trips — the pure half of the bay's
 * `commit`. It is pure because the save commits every still-typed tile in one pass, and each of
 * those must see the tiles the one before it produced: `tiles` in a callback's closure is a render
 * old by the second key, and a loop over the setter would chart the last number only.
 */
export function applyTake(tiles: Tiles, key: TileKey, source: TakeSource, take: Take, ctx: GateContext): { tiles: Tiles; mirror: Mirror | null } {
  const tile = tiles[key];
  const m = mirrorFor(key, take, ctx.ageYears, ctx.ranges, ctx.last, tile);
  if (m !== null && m.kind === "probe_error") {
    // held OUT of the chart until it survives a re-clip: the number is kept, not charted
    return { tiles: { ...tiles, [key]: { ...tile, held: [...tile.held, m.value], source } }, mirror: m };
  }
  if (m !== null) return { tiles, mirror: m };
  return { tiles: { ...tiles, [key]: { ...tile, takes: [...tile.takes, take], source, carried: null } }, mirror: null };
}

export function missingFor(tiles: Tiles, required: TileKey[], emergency: boolean): TileKey[] {
  const need = emergency ? EMERGENCY_TILES : required;
  const missing = need.filter((k) => operative(tiles[k]) === null && tiles[k].carried === null);
  // OWNER 2026-10-08 — SpO₂ is no longer demanded, and a HELD one is still not skippable: a reading
  // kept out of the chart (a 45 % on a talking patient) is owed a re-clip, a "it is real", or a
  // deliberate Clear of the box — never a silent save that loses it. The server refuses the same.
  for (const k of TILE_KEYS) {
    if (tiles[k].held.length > 0 && operative(tiles[k]) === null && !missing.includes(k)) missing.push(k);
  }
  return missing;
}

/** A glucose value with no timing chosen: the one thing about the glucose box that stops a save. */
export function glucoseNeedsTiming(tiles: Tiles, timing: GlucoseTiming | null): boolean {
  return operative(tiles.glucoseMgDl) !== null && timing === null;
}

export function buildBody(tiles: Tiles, opts: { emergency: boolean; chips: { key: string; question: string; answer: string }[]; glucoseTiming?: GlucoseTiming | null }): WireVitalsPostBody {
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
  if (readings.glucoseMgDl !== undefined && opts.glucoseTiming !== undefined && opts.glucoseTiming !== null) body.glucoseTiming = opts.glucoseTiming;
  if (carriedForward.length > 0) body.carriedForward = carriedForward;
  if (Object.keys(unlockReasons).length > 0) body.unlockReasons = unlockReasons;
  if (Object.keys(overrides).length > 0) body.overrides = overrides;
  return body;
}

/** The questions asked while the cuff inflates, in the words a nurse uses at the bay. */
export const CONTEXT_CHIPS = [
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
  // NO glucose delta: a fasting value against an after-food one is not a trend, and this version
  // interprets nothing about glucose (a clinical threshold is an owner ruling not yet made).
  if (Array.isArray(op) || k === "glucoseMgDl") return null;
  const was = last[k];
  if (was === null || was === undefined) return null;
  return { serviceDate: last.serviceDate, from: String(was), delta: signed(round1(op - was)), hot: false };
}

// ——— the danger protocol's pure half ———

export const REST_MINUTES = 5;

/**
 * "Elevated but not dangerous": inside the band, but within 20 / 10 mmHg of its ceiling, or 20 mmHg
 * above the last chart's systolic. DECIDED here (a threshold, not money): the standard corporate-OPD
 * rest-and-recheck trigger, and the server never sees it — it is the bay's offer, not a chart fact.
 */
export function isElevated(take: Take, band: WireBandConfig | null, last: WirePreStage["last"]): boolean {
  if (!Array.isArray(take) || band === null || band.notRoutine.includes("sbp")) return false;
  const [s, d] = take;
  const sMax = band.ranges.sbp?.max; const dMax = band.ranges.dbp?.max;
  if (sMax !== undefined && s > sMax) return false;
  if (dMax !== undefined && d > dMax) return false;
  if (sMax !== undefined && s >= sMax - 20) return true;
  if (dMax !== undefined && d >= dMax - 10) return true;
  if (last !== null && last.sbp !== null && s >= last.sbp + 20) return true;
  return false;
}

/** The numbers on the tiles right now, in the wire's vocabulary, for the protocol's routes. */
/**
 * The same reading, taken off a SAVED chart instead of the tiles — what an amendment has to hand
 * the protocol. A corrected BP is the answer to "the other arm, now" as surely as a second take
 * typed at the bay is, and the server judges both by the same rule.
 */
export function readingFromVitals(v: Record<"sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC" | "muacCm", number | null>): WireEscalationReading {
  const r: WireEscalationReading = {};
  if (v.sbp !== null && v.dbp !== null) { r.sbp = v.sbp; r.dbp = v.dbp; }
  for (const k of ["pulse", "rr", "spo2", "tempC", "muacCm"] as const) {
    const x = v[k];
    if (typeof x === "number") r[k] = x;
  }
  return r;
}

export function readingFrom(tiles: Tiles): WireEscalationReading {
  const r: WireEscalationReading = {};
  const bp = operative(tiles.bp);
  if (Array.isArray(bp)) { r.sbp = bp[0]; r.dbp = bp[1]; }
  for (const k of ["pulse", "rr", "spo2", "tempC", "muacCm"] as const) {
    const v = operative(tiles[k]);
    if (typeof v === "number") r[k] = v;
  }
  return r;
}


/* ═══════════════ amend a saved chart — the rules both bays share (mobile §3i, 2026-10-07) ═══════════════ */

/** The scalars a correction may touch, in the order the copy lists them. */
export const AMEND_KEYS: readonly WireVitalKey[] = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm", "glucoseMgDl"];

/**
 * ═══ THE REASONS A VITAL IS ACTUALLY CORRECTED, AS ONE TAP ═══
 *
 * DECIDED (standard Indian corporate-hospital practice; not a money, procurement or law question,
 * so not an owner ruling). A nurse at the bay corrects a chart for a small, closed set of reasons,
 * and making her type one of them every time is the kind of friction that ends in "correction" and
 * "x" being the two most common entries in an audit column. The presets fill the box; anything
 * genuinely different is still typed, and the box stays the source of truth.
 *
 * `text` is stored, and it is ENGLISH ON PURPOSE. The label a nurse reads is translated; the
 * sentence the audit keeps must mean the same thing to whoever opens it later, which a string that
 * silently changes language with the browser does not.
 */
export const AMEND_REASONS: readonly { key: string; text: string }[] = [
  { key: "otherArm", text: "Rechecked on the other arm" },
  { key: "remeasured", text: "Re-measured at the bay" },
  { key: "keyed", text: "Typing error — wrong number keyed" },
  { key: "device", text: "Device misread — taken again" },
  { key: "wrongVital", text: "Entered against the wrong vital" },
  { key: "wrongChart", text: "Entered on the wrong patient's chart" },
];

/** What a saved chart must carry for a correction to be built from it — the web's `WireVitals` is one. */
export type ChartScalars = Record<Exclude<WireVitalKey, "glucoseMgDl">, number | null> & {
  /** Optional on the wire: a chart from before 2026-10-08, or an older server, carries neither. */
  glucoseMgDl?: number | null; glucoseTiming?: GlucoseTiming | null;
};
export type Change = { key: WireVitalKey; from: number | null; to: number | null };
export function diffOf(prior: ChartScalars, next: ChartScalars): Change[] {
  const out: Change[] = [];
  for (const k of AMEND_KEYS) {
    const from = prior[k] ?? null; const to = next[k] ?? null;
    if (from !== to) out.push({ key: k, from, to });
  }
  return out;
}

function isReadings(x: unknown): x is WireReadings {
  return typeof x === "object" && x !== null;
}

/** The prior readings with each changed key's OPERATIVE take replaced — the pair, the held values and the source stay. */
export function amendedReadings(prior: ChartScalars & { readings: unknown }, next: Partial<Record<WireVitalKey, number | null>>): WireReadings {
  const base: WireReadings = isReadings(prior.readings) ? { ...prior.readings } : {};
  const replace = (takes: number[], value: number): number[] => (takes.length === 0 ? [value] : [...takes.slice(0, -1), value]);
  for (const k of AMEND_KEYS) {
    if (k === "sbp" || k === "dbp") continue;
    const v = next[k];
    if (v === undefined || v === (prior[k] ?? null)) continue;
    if (v === null) { delete base[k]; continue; }
    const r = base[k];
    base[k] = r === undefined ? { takes: [v], source: "typed" } : { ...r, takes: replace(r.takes, v) };
  }
  const s = next.sbp; const d = next.dbp;
  if ((s !== undefined && s !== prior.sbp) || (d !== undefined && d !== prior.dbp)) {
    const sbp = s === undefined ? prior.sbp : s; const dbp = d === undefined ? prior.dbp : d;
    if (sbp === null || dbp === null) delete base.bp;
    else {
      const r = base.bp;
      base.bp = r === undefined ? { takes: [[sbp, dbp]], source: "typed" } : { ...r, takes: r.takes.length === 0 ? [[sbp, dbp]] : [...r.takes.slice(0, -1), [sbp, dbp]] };
    }
  }
  return base;
}
