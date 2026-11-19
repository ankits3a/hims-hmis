import type { StoresPar, StoresPlannerWord } from "@hmis/contracts";

/**
 * STORES S7 (#1117) — THE PLANNER'S ARITHMETIC, AND NOTHING ELSE (decisions 2, 3, 5, 6, 7, 8; ruling 0101 Q8).
 *
 * Pure functions over numbers the caller read from rows, so every figure a warning, a draft, a purchase request or a par
 * suggestion carries can be recomputed from the forecast row it names. No model writes a number: the "why" text is a
 * template filled from the forecast (spec principle 6), so a copilot halt or a model outage changes nothing here.
 */
export const HISTORY_WEEKS = 8;
export const WARN_HOURS = 48;
export const URGENT_HOURS = 24;
const DAY_MS = 86_400_000;

/** Ruling 0101 Q8: safety days on top of lead time by VED, and the review period (cover) by ABC. */
export const DEFAULT_SAFETY_DAYS = { V: 15, E: 7, D: 3 } as const;
export const DEFAULT_COVER_DAYS = { A: 7, B: 15, C: 30 } as const;
export type SafetyDays = { V: number; E: number; D: number };
export type CoverDays = { A: number; B: number; C: number };
/** DECIDED: an item with no lead time and no PO-to-GRN history waits 7 days; one with no supply history is delivered weekly. */
export const DEFAULT_LEAD_DAYS = 7;
export const DEFAULT_SUPPLY_INTERVAL_DAYS = 7;
/** Decision 7: a dated consumable is never ordered beyond what is used before expiry less 30 days. */
export const EXPIRY_MARGIN_DAYS = 30;

export const round1 = (n: number): number => Math.round(n * 10) / 10;
const fmt = (n: number): string => String(round1(n));

/**
 * Decision 2: use per day over the last 8 weeks, net of reversals, the last 4 weeks weighted 2 : 1 against the 4 before.
 * `weekly[0]` is the most recent week.
 */
export function weightedUsePerDay(weekly: readonly number[]): number {
  const w = (i: number): number => Math.max(0, weekly[i] ?? 0);
  const recent = w(0) + w(1) + w(2) + w(3);
  const before = w(4) + w(5) + w(6) + w(7);
  return (2 * recent + before) / (2 * 28 + 28);
}

/** Whole weeks of history since the first ledger row of the item at the place (capped at 8). */
export function weeksOfHistory(firstAt: Date | null, now: Date): number {
  if (firstAt === null) return 0;
  return Math.max(0, Math.min(HISTORY_WEEKS, Math.floor((now.getTime() - firstAt.getTime()) / (7 * DAY_MS))));
}

/** "Learning, 3 of 8 weeks / सीख रहा, 8 में 3 हफ़्ते" while an item has under 8 weeks of history. */
export function learningWords(weeks: number): [string, string] {
  return [`Learning, ${String(weeks)} of ${String(HISTORY_WEEKS)} weeks`, `सीख रहा, ${String(HISTORY_WEEKS)} में ${String(weeks)} हफ़्ते`];
}

/** The one-line why, every number from the forecast row: "uses 6 a day, 9 left / रोज़ 6, बचे 9". */
export function whyOf(usePerDay: number, onHand: number): [string, string] {
  return [`uses ${fmt(usePerDay)} a day, ${String(onHand)} left`, `रोज़ ${fmt(usePerDay)}, बचे ${String(onHand)}`];
}

export const PLANNER_WORDS: Record<StoresPlannerWord, [string, string]> = {
  low: ["Low", "कम"],
  runs_out_soon: ["Runs out soon", "जल्द खत्म"],
  learning: ["Learning", "सीख रहा"],
};

/** Mean absolute error of a prediction against what was used, day by day. */
export function meanAbsError(actual: readonly number[], predicted: readonly number[]): number {
  if (actual.length === 0) return 0;
  return actual.reduce((s, a, i) => s + Math.abs(a - (predicted[i] ?? 0)), 0) / actual.length;
}

export type Verdict = { warn: boolean; rule: "hours" | "reorder" | null; hoursToZero: number | null; urgent: boolean };

/**
 * Decision 5: warn when hours to zero ≤ 48, or on hand ≤ reorder, whichever comes first. On hand here includes what is
 * already on its way on an open ticket. A learning item (decision 2) is warned only at its reorder level (S1's par rule).
 */
export function verdictOf(input: { learning: boolean; usePerDay: number; onHand: number; onWay: number; par: StoresPar | null }): Verdict {
  const total = input.onHand + input.onWay;
  const hours = input.usePerDay > 0 ? total / (input.usePerDay / 24) : null;
  const byReorder = input.par !== null && total <= input.par.reorderBase;
  const byHours = !input.learning && hours !== null && hours <= WARN_HOURS;
  const warn = byHours || byReorder;
  return {
    warn, rule: !warn ? null : byHours ? "hours" : "reorder", hoursToZero: hours,
    urgent: warn && (total <= 0 || (hours !== null && hours <= URGENT_HOURS)),
  };
}

/**
 * When does a warning end? When the shelf itself (not what is on its way) is back above reorder — or, with no par, above
 * 48 hours of use. A ticket sent is not stock on the shelf, so sending never ends a warning by itself.
 */
export function recovered(input: { usePerDay: number; onHand: number; par: StoresPar | null }): boolean {
  if (input.par !== null) return input.onHand > input.par.reorderBase;
  if (input.usePerDay <= 0) return input.onHand > 0;
  return input.onHand / (input.usePerDay / 24) > WARN_HOURS;
}

/**
 * Decision 6 (D3): max − on hand − on its way, rounded UP to the issue pack only when that stays within max; else the
 * whole packs that fit (else the bare quantity, when not even one pack fits). Never above max. 0 = nothing to draft.
 */
export function topUpQty(par: StoresPar, onHand: number, onWay: number, pack: number): number {
  const want = par.maxBase - onHand - onWay;
  if (want <= 0) return 0;
  const p = Math.max(1, Math.trunc(pack));
  const up = Math.ceil(want / p) * p;
  if (up <= want) return up;
  const down = Math.floor(want / p) * p;
  return down > 0 ? down : want;
}

/** Ruling 0101 Q8 by class letter. Unknown VED is Essential, unknown ABC is B (DECIDED: the middle row). */
export function safetyDaysOf(ved: string | null, t: SafetyDays): number {
  const k = (ved ?? "").trim().toUpperCase().charAt(0);
  return k === "V" ? t.V : k === "D" ? t.D : t.E;
}
export function coverDaysOf(abc: string | null, t: CoverDays): number {
  const k = (abc ?? "").trim().toUpperCase().charAt(0);
  return k === "A" ? t.A : k === "C" ? t.C : t.B;
}

/**
 * Decision 7: reorder point = use per day × (lead time + safety days); order up to = reorder point + use per day ×
 * review period; the order is up-to less on hand, on order and open asks, only when that position is at or under the
 * reorder point; rounded up to the purchase pack; a dated item capped at the use before expiry − 30 days.
 */
export function centralOrderQty(input: {
  usePerDay: number; leadDays: number; safetyDays: number; coverDays: number; position: number; pack: number; lifeDays: number | null;
}): { reorderPoint: number; orderUpTo: number; qty: number; cap: number | null } {
  const reorderPoint = input.usePerDay * (input.leadDays + input.safetyDays);
  const orderUpTo = reorderPoint + input.usePerDay * input.coverDays;
  const cap = input.lifeDays === null ? null : Math.floor(input.usePerDay * (input.lifeDays - EXPIRY_MARGIN_DAYS));
  if (input.usePerDay <= 0 || input.position > reorderPoint) return { reorderPoint, orderUpTo, qty: 0, cap };
  let qty = Math.ceil(orderUpTo - input.position);
  const p = Math.max(1, Math.trunc(input.pack));
  qty = Math.ceil(qty / p) * p;
  if (cap !== null && qty > cap) qty = Math.floor(cap / p) * p > 0 ? Math.floor(cap / p) * p : Math.max(0, cap);
  return { reorderPoint, orderUpTo, qty: Math.max(0, qty), cap };
}

/** Decision 8: min = use × 1 day, reorder = use × (supply interval + 1), max = reorder + use × supply interval; whole units up. */
export function suggestedPar(usePerDay: number, supplyIntervalDays: number): StoresPar {
  const minBase = Math.ceil(usePerDay * 1);
  const reorderBase = Math.ceil(usePerDay * (supplyIntervalDays + 1));
  const maxBase = reorderBase + Math.ceil(usePerDay * supplyIntervalDays);
  return { minBase, reorderBase, maxBase };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The IST calendar quarter of an IST day string: `2026-Q4`. */
export function quarterOfDay(day: string): string {
  const m = Number(day.slice(5, 7));
  return `${day.slice(0, 4)}-Q${String(Math.floor((m - 1) / 3) + 1)}`;
}
