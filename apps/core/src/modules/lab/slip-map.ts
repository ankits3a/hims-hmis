import type { SlipReply, SlipReplyRow } from "./slip-reader";

/**
 * ═══ SPEC #934 — FROM SLIP ROWS TO REPORT FIELDS, DETERMINISTICALLY ═══
 *
 * Pure: no database, no clock, no model. The same reply and the same context give the same rows,
 * which is what lets a mapping change re-map from the stored reply, and what lets the eval
 * (`slip-eval.ts`) ask "did a wrong value carry a check?" with exactly the bench's checks.
 *
 * NOTHING IS SILENTLY DROPPED (rule 2). Every printed row ends as exactly one placement:
 *   placed          its value is (or would be, with a person's typed value kept) in a field
 *   cross_check     it names a server-computed parameter (DD3): compared, never written
 *   ignored_setting the analyser's ignore list names it (counted, never printed)
 *   not_placed      shown in the panel with its reason, until a person places or ignores it
 *   ignored         a person ignored it, with a reason
 *
 * A CHECK HIGHLIGHTS, IT NEVER DROPS. Checks sit on placed and cross-check rows; a check is OPEN until
 * a person taps Checked or edits the field.
 */
export type SlipCheck =
  | "unsure_read" | "no_value" | "no_unit" | "flag_differs" | "index_mismatch" | "duplicate_row"
  | "typed_differs" | "slip_replaced" | "cross_check_differs";
export type NotPlacedReason =
  | "unmapped" | "ambiguous_code" | "unit_differs" | "not_numeric" | "not_possible" | "no_value" | "not_in_this_report";
export type SlipPlacement = "placed" | "cross_check" | "ignored_setting" | "not_placed" | "ignored";
export type SlipFlag = "L" | "H" | "LL" | "HH" | "N" | null;

export type SlipResolution =
  | { action: "place"; analyteId: string; by: string; at: string }
  | { action: "ignore"; reason: string; by: string; at: string };
export type SlipChecked = { by: string; at: string; via: "tap" | "edit" };

export type SlipRowView = {
  position: number;
  code: string; value: string | null; unit: string | null; machineFlag: "H" | "L" | null; legible: SlipReplyRow["legible"];
  analyteId: string | null; analyteCode: string | null; analyteName: string | null;
  placement: SlipPlacement;
  reason: NotPlacedReason | null;
  /** The analyser setting's reason, for an ignored_setting row. */
  settingReason: string | null;
  /** The value in OUR unit (× the mapping's factor), when there is one. */
  placedValue: string | null;
  /** For a cross-check row: what the report computed, when it has. */
  computedValue: string | null;
  checks: SlipCheck[];
  checked: SlipChecked | null;
  resolution: SlipResolution | null;
  /** The slip's value is the report's value (false when a person's typed value was kept, or nothing was written). */
  written: boolean;
};

export type SlipAnalyte = {
  id: string; code: string; nameEn: string; unit: string | null; resultType: string;
  absurdLow: string | null; absurdHigh: string | null; formula: string | null;
};
export type SlipCodeMapping = { analyteId: string; unit: string | null; factor: string };

/** What a report adds to the mapping once the slip has a target. */
export type SlipReportContext = {
  analyteIds: ReadonlySet<string>;
  /** Values a PERSON typed (a line with no slip marker, or one edited, or one kept over a slip). */
  typed: ReadonlyMap<string, string>;
  /** Values an EARLIER slip placed and nobody edited — a rerun. */
  priorSlip: ReadonlyMap<string, string>;
  /** The report's computed (formula) lines. */
  computed: ReadonlyMap<string, string>;
  /** Our flag for a number on this patient: `flagFor(resolveRange(…))`, the bench's own. */
  flagOf: (analyteId: string, value: number) => SlipFlag;
};

export type SlipMapContext = {
  codes: ReadonlyMap<string, SlipCodeMapping>;
  ignored: ReadonlyMap<string, string>;
  analytes: ReadonlyMap<string, SlipAnalyte>;
  report: SlipReportContext | null;
  /** The person's acts on the previous mapping, by row position; they survive a re-map. */
  prior: ReadonlyMap<number, { checked: SlipChecked | null; resolution: SlipResolution | null }>;
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

/**
 * The code compared on both sides: upper case, spaces removed, dashes unified, µ/μ → U, and the
 * letter O read as zero only inside a run of digits. `#`, `%` and `-` stay: `Lym#` ≠ `Lym%`,
 * `RDW-CV` ≠ `RDW-SD`.
 */
export function slipKey(code: string): string {
  return code
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[µμΜ]/g, "U")
    .replace(/(?<=\d)O|O(?=\d)/g, "0");
}

/** Units compared, not converted: superscripts → `^`, `×`/`x`/`*10` → `10^`, `uL` = `µL`, case. */
export function normaliseUnit(unit: string | null): string | null {
  if (unit === null) return null;
  let s = unit.trim().replace(/\s+/g, "").replace(/[µμ]/g, "u");
  s = s.replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_m, d: string) => `10^${[...d].map((c) => SUPERSCRIPT[c] ?? c).join("")}`);
  s = s.replace(/^[×xX*]\s*(?=10)/, "");
  s = s.replace(/10\*{1,2}(\d)/g, "10^$1");
  return s === "" ? null : s.toLowerCase();
}

const NO_VALUE = /^[\s\-–—*.]+$/;
function numberOf(s: string | null): number | null {
  if (s === null) return null;
  const t = s.trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** `value × factor`, keeping the printed string untouched when the factor is 1. */
function scaled(value: string, factor: string): string | null {
  if (Number(factor) === 1) return value.trim();
  const n = numberOf(value);
  if (n === null) return null;
  return String(Number((n * Number(factor)).toFixed(6)));
}

function sameValue(a: string, b: string): boolean {
  const x = numberOf(a), y = numberOf(b);
  return x !== null && y !== null ? x === y : a.trim() === b.trim();
}

/** The cross-check's tolerance: 5 % or 0.05, whichever is larger. */
export function crossCheckDiffers(slip: number, computed: number): boolean {
  return Math.abs(slip - computed) > Math.max(0.05 * Math.abs(computed), 0.05);
}

type Lookup<T> = { hit: T; via: "exact" | "key" } | { ambiguous: true } | null;
function lookup<T>(table: ReadonlyMap<string, T>, code: string): Lookup<T> {
  const exact = table.get(code);
  if (exact !== undefined) return { hit: exact, via: "exact" };
  const key = slipKey(code);
  const found = [...table.entries()].filter(([k]) => slipKey(k) === key);
  if (found.length === 1) return { hit: found[0]![1], via: "key" };
  if (found.length > 1) return { ambiguous: true };
  return null;
}

const low = (f: SlipFlag): boolean => f === "L" || f === "LL";
const high = (f: SlipFlag): boolean => f === "H" || f === "HH";
const WBC_PERCENT = /^\s*WBC\s*\*\s*([A-Z0-9_]+)\s*\/\s*100\s*$/;

/** One reply, one context → the rows, in printed order, and the codes this analyser's slips normally carry but this one lacks. */
export function mapSlipRows(reply: SlipReply, ctx: SlipMapContext): { rows: SlipRowView[]; rowsMissing: string[] } {
  const keyCount = new Map<string, number>();
  for (const r of reply.rows) keyCount.set(slipKey(r.code), (keyCount.get(slipKey(r.code)) ?? 0) + 1);

  const rows: SlipRowView[] = reply.rows.map((r, position) => {
    const prior = ctx.prior.get(position);
    const view: SlipRowView = {
      position, code: r.code, value: r.value, unit: r.unit, machineFlag: r.flag, legible: r.legible,
      analyteId: null, analyteCode: null, analyteName: null, placement: "not_placed", reason: "unmapped", settingReason: null,
      placedValue: null, computedValue: null, checks: [], checked: prior?.checked ?? null, resolution: prior?.resolution ?? null, written: false,
    };
    const noValue = r.legible === "unreadable" || r.value === null || NO_VALUE.test(r.value);
    if (r.legible === "unsure") view.checks.push("unsure_read");
    if (noValue) view.checks.push("no_value");
    if ((keyCount.get(slipKey(r.code)) ?? 0) > 1) view.checks.push("duplicate_row");

    const ignore = lookup(ctx.ignored, r.code);
    if (ignore !== null && "hit" in ignore) {
      return { ...view, placement: "ignored_setting", reason: null, settingReason: ignore.hit };
    }

    const resolution = view.resolution;
    const target = resolution?.action === "place"
      ? { analyteId: resolution.analyteId, unit: null, factor: "1", byPerson: true }
      : (() => {
        const m = lookup(ctx.codes, r.code);
        if (m === null) return null;
        if ("ambiguous" in m) return "ambiguous" as const;
        return { ...m.hit, byPerson: false };
      })();
    if (target === "ambiguous") return finish(view, "ambiguous_code");
    if (target === null) return finish(view, "unmapped");
    const a = ctx.analytes.get(target.analyteId);
    if (a === undefined) return finish(view, "unmapped");
    view.analyteId = a.id; view.analyteCode = a.code; view.analyteName = a.nameEn;

    if (noValue) return finish(view, "no_value");
    const value = r.value!.trim();
    // A person who PLACES a row has decided the unit question; the mapping's guard is the analyser's.
    if (!target.byPerson) {
      if (r.unit === null || r.unit.trim() === "") view.checks.push("no_unit");
      else {
        const want = normaliseUnit(target.unit ?? a.unit);
        if (want !== null && normaliseUnit(r.unit) !== want) return finish(view, "unit_differs");
      }
    }
    const numeric = a.resultType === "numeric" || a.resultType === "formula";
    const placed = numeric ? scaled(value, target.factor) : value;
    if (placed === null || (numeric && numberOf(placed) === null)) return finish(view, "not_numeric");
    if (numeric) {
      const n = numberOf(placed)!;
      if ((a.absurdLow !== null && n < Number(a.absurdLow)) || (a.absurdHigh !== null && n > Number(a.absurdHigh))) {
        view.placedValue = placed;
        return finish(view, "not_possible");
      }
    }
    view.placedValue = placed;
    const report = ctx.report;
    if (report !== null && !report.analyteIds.has(a.id)) return finish(view, "not_in_this_report");

    if (a.resultType === "formula") {
      view.placement = "cross_check"; view.reason = null;
      const computed = report?.computed.get(a.id) ?? null;
      view.computedValue = computed;
      const c = numberOf(computed), s = numberOf(placed);
      if (c !== null && s !== null && crossCheckDiffers(s, c)) view.checks.push("cross_check_differs");
      return view;
    }

    view.placement = "placed"; view.reason = null;
    if (report !== null) {
      const typed = report.typed.get(a.id);
      if (typed !== undefined) {
        if (!sameValue(typed, placed)) view.checks.push("typed_differs");
      } else {
        view.written = true;
        const before = report.priorSlip.get(a.id);
        if (before !== undefined && !sameValue(before, placed)) view.checks.push("slip_replaced");
      }
      const n = numberOf(placed);
      if (numeric && n !== null && r.flag !== null) {
        const ours = report.flagOf(a.id, n);
        if ((r.flag === "H" && low(ours)) || (r.flag === "L" && high(ours))) view.checks.push("flag_differs");
      }
    }
    return view;
  });

  indexChecks(rows, ctx.analytes);

  for (const v of rows) {
    if (v.resolution?.action === "ignore" && (v.placement === "not_placed")) { v.placement = "ignored"; }
  }

  const present = new Set(reply.rows.map((r) => slipKey(r.code)));
  const rowsMissing = [...ctx.codes.keys()].filter((c) => !present.has(slipKey(c)));
  return { rows, rowsMissing };
}

function finish(view: SlipRowView, reason: NotPlacedReason): SlipRowView {
  view.placement = "not_placed";
  view.reason = reason;
  if (view.resolution?.action === "ignore") view.placement = "ignored";
  return view;
}

/**
 * THE CHECKS THAT CATCH MOST DIGIT MISREADS. The red-cell indices are arithmetic on each other and the
 * differential sums to 100, so a 3 read as an 8 shows up as a sum that does not add. Starting
 * tolerances (spec #934 "Checks"), tuned on the synthetic set: MCHC ±1.0 g/dL, MCV ±2 fL, MCH ±1 pg,
 * the differential 100 ± 1.5, an absolute count within 5 % of WBC × % / 100 (0.015 floor, the print's
 * own rounding at two decimals).
 */
function indexChecks(rows: SlipRowView[], analytes: ReadonlyMap<string, SlipAnalyte>): void {
  const usable = rows.filter((r) => (r.placement === "placed" || r.placement === "cross_check") && r.analyteCode !== null && numberOf(r.placedValue) !== null);
  const byCode = new Map<string, SlipRowView>();
  for (const r of usable) if (!byCode.has(r.analyteCode!)) byCode.set(r.analyteCode!, r);
  const v = (code: string): number | null => numberOf(byCode.get(code)?.placedValue ?? null);
  const flag = (code: string): void => {
    const r = byCode.get(code);
    if (r !== undefined && !r.checks.includes("index_mismatch")) r.checks.push("index_mismatch");
  };
  const hb = v("HB"), hct = v("HCT"), rbc = v("RBC");
  const mchc = v("MCHC"), mcv = v("MCV"), mch = v("MCH");
  if (mchc !== null && hb !== null && hct !== null && hct > 0 && Math.abs(mchc - (hb / hct) * 100) > 1.0) flag("MCHC");
  if (mcv !== null && hct !== null && rbc !== null && rbc > 0 && Math.abs(mcv - (hct / rbc) * 10) > 2) flag("MCV");
  if (mch !== null && hb !== null && rbc !== null && rbc > 0 && Math.abs(mch - (hb / rbc) * 10) > 1) flag("MCH");

  for (const set of [["LYMPH", "GRAN", "MID"], ["NEUT", "LYMPH", "MONO", "EOS", "BASO"]]) {
    const values = set.map(v);
    if (values.every((x) => x !== null) && Math.abs(values.reduce((s, x) => s + x!, 0) - 100) > 1.5) set.forEach(flag);
  }

  const wbc = v("WBC");
  if (wbc === null) return;
  for (const r of usable) {
    const a = r.analyteId === null ? undefined : analytes.get(r.analyteId);
    const m = a?.formula == null ? null : WBC_PERCENT.exec(a.formula);
    if (m === null) continue;
    const pct = v(m[1]!);
    const abs = numberOf(r.placedValue);
    if (pct === null || abs === null) continue;
    const expected = (wbc * pct) / 100;
    if (Math.abs(abs - expected) > Math.max(0.05 * expected, 0.015) && !r.checks.includes("index_mismatch")) r.checks.push("index_mismatch");
  }
}

/** A check is OPEN on a placed or cross-check row until a person taps Checked or edits the field. */
export function openChecks(r: SlipRowView): SlipCheck[] {
  if (r.placement !== "placed" && r.placement !== "cross_check") return [];
  return r.checked === null ? r.checks : [];
}

export type SlipCounts = {
  rows: number; placed: number; crossCheck: number; ignoredBySetting: number; ignored: number; notPlaced: number; openChecks: number;
};
export function slipCounts(rows: readonly SlipRowView[]): SlipCounts {
  const n = (p: SlipPlacement) => rows.filter((r) => r.placement === p).length;
  return {
    rows: rows.length, placed: n("placed"), crossCheck: n("cross_check"), ignoredBySetting: n("ignored_setting"),
    ignored: n("ignored"), notPlaced: n("not_placed"), openChecks: rows.filter((r) => openChecks(r).length > 0).length,
  };
}
