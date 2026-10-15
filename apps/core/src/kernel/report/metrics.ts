import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SQL } from "drizzle-orm";
import type { Db } from "../db/client";

/**
 * HOSPITAL NUMBERS (owner 2026-10-13, #768 / #777) — the pieces every department's "numbers" read
 * shares: the IST day range, its 92-day cap, and median / 90th percentile / n of a time step.
 *
 * Lab numbers (#768) wrote these first inside `modules/lab/metrics.ts`; imaging and pharmacy (#777)
 * read the same range and the same percentile, so they live here rather than in three copies that
 * could drift (a range one module closes at midnight UTC and another at midnight IST is the F52
 * family exactly). Read-only helpers: no table, no permission.
 */

/** The longest range one request may read: a quarter. A year of rows is a report job, not a screen. */
export const METRICS_MAX_DAYS = 92;

/** Midnight IST opening `day`, as an instant. */
export function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

/** `[start, end)` for the inclusive IST day range. */
export function istRange(from: string, to: string): { start: Date; end: Date } {
  return { start: istDayStart(from), end: new Date(istDayStart(to).getTime() + 86_400_000) };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD`: IST days, inclusive, From not after To, at most 92 days. */
export const metricsRangeQuery = z.object({ from: isoDate, to: isoDate }).refine(
  (q) => {
    const days = (istDayStart(q.to).getTime() - istDayStart(q.from).getTime()) / 86_400_000;
    return Number.isFinite(days) && days >= 0 && days < METRICS_MAX_DAYS;
  },
  { message: `from must not be after to, and the range is at most ${String(METRICS_MAX_DAYS)} days` },
);

/** A time step in minutes: median and 90th percentile (`percentile_cont`), with how many it read. */
export type MetricsTiming = { n: number; medianMin: number | null; p90Min: number | null };
export const EMPTY_TIMING: MetricsTiming = { n: 0, medianMin: null, p90Min: null };

export type MetricsRow = Record<string, unknown>;
export const rowsOf = async (db: Db, q: SQL): Promise<MetricsRow[]> => (await db.execute(q)).rows as MetricsRow[];
export const num = (v: unknown): number => Number(v ?? 0);
const mins = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/** A `STATS` row (`n`, `p50`, `p90`) as a timing; an absent row is no data, never a zero. */
export const timing = (r: MetricsRow | undefined): MetricsTiming =>
  r === undefined ? EMPTY_TIMING : { n: num(r["n"]), medianMin: mins(r["p50"]), p90Min: mins(r["p90"]) };

/** median, p90 and n of `d` (an interval-valued column) per group, nulls dropped by the caller. */
export const STATS = sql.raw(`count(*) as n,
  percentile_cont(0.5) within group (order by extract(epoch from d) / 60) as p50,
  percentile_cont(0.9) within group (order by extract(epoch from d) / 60) as p90`);
