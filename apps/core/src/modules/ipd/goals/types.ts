import type { Db } from "../../../kernel/db/client";

/** E0.5 (#717) — the shape of one goal query in the IPD goal ledger (plan §1, §6). */
export type GoalUnit = "percent" | "minutes" | "count" | "rupees" | "yesno";

/**
 * The window is always passed in, [from, to): a query never reads the wall clock, so a test can seed any
 * instant and the ledger can be re-read for any past period. `groupBy: "day"` splits by IST calendar day
 * instead of the goal's own split (source, routine/terminal, cash/cashless, ward …).
 */
export type GoalRunArgs = { from: Date; to: Date; groupBy?: "day" };

export type GoalBreakdownRow = { key: string; value: number | null; n: number; p90?: number | null };

/**
 * A measured result. `value` is null when the population is empty (no admissions, no doses …): an empty week
 * is "no evidence", never "target met". `rows` are the items to chase (misses, offenders) or, for time
 * goals, the measured items themselves.
 */
export type GoalMeasured = {
  status: "measured";
  value: number | null;
  numerator?: number;
  denominator?: number;
  /** For time goals: the 90th percentile beside the median in `value`. */
  p90?: number | null;
  breakdown?: GoalBreakdownRow[];
  rows: Record<string, unknown>[];
};

/** The instrument the goal needs does not exist yet. Never a fake 0. */
export type GoalNotInstrumented = { status: "not_instrumented"; source: string; value: null; rows: [] };

export type GoalResult = GoalMeasured | GoalNotInstrumented;

/** A target as data: `measure` names which figure (value, p90, a breakdown key) the comparison applies to. */
export type GoalTarget = { measure: string; op: "<=" | ">=" | "=="; value: number; unit: string };

export type GoalQuery = {
  id: string;
  title: string;
  metric: string;
  unit: GoalUnit;
  /** Empty when the plan sets no target (reported only). */
  target: readonly GoalTarget[];
  targetNote?: string;
  window: string;
  run(db: Db, args: GoalRunArgs): Promise<GoalResult>;
};
