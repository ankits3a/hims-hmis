import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

// IST is a fixed UTC+05:30 design-law constant (no DST) — the same fact scheduler.ts:67 keeps
// locally rather than importing, and for the same reason: one constant is not a dependency.
const IST_OFFSET_MS = 330 * 60_000;

/**
 * How far ahead `createEventPartitions` keeps months: the CURRENT IST month PLUS this many.
 *
 * THE CURRENT MONTH IS IN THE SET DELIBERATELY, and it is not padding. Every append lands in the
 * month it is recorded in, so a missing current month sends live traffic to `events_default` —
 * and the DEFAULT partition is the one partition the dispatcher's floor predicate can NEVER prune
 * (it may hold any month, so the planner must always keep it). Pre-created months are what keeps
 * `events_default` near-empty, which is what keeps the floor meaningful: measured in the Plan 11a
 * spike, not assumed.
 */
export const EVENT_PARTITION_MONTHS_AHEAD = 3;

/**
 * The catch-all partition, created by migration 0016 and never created or dropped by this module.
 * Retention (Plan 11a T5) must never drop it either: it is the only thing standing between a row
 * whose month nobody pre-created and a failed INSERT on the hospital's write path.
 */
export const EVENTS_DEFAULT_PARTITION = "events_default";

/** One monthly partition: its table name and its half-open IST bounds, `from` inclusive. */
export type EventPartition = { name: string; from: string; to: string };

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Normalises a possibly-overflowing month index (13 → next year's January). */
function normalise(year: number, monthIndex: number): { year: number; monthIndex: number } {
  return {
    year: year + Math.floor(monthIndex / 12),
    monthIndex: ((monthIndex % 12) + 12) % 12,
  };
}

/** Midnight on the 1st of that month, IN IST, written with the offset spelled out. */
function istMonthStart(year: number, monthIndex: number): string {
  const m = normalise(year, monthIndex);
  return `${m.year}-${pad2(m.monthIndex + 1)}-01T00:00:00+05:30`;
}

/**
 * The months that should exist at `now`, oldest first — a pure function, so the month arithmetic
 * (year rollover included) is testable without a database.
 *
 * MONTH BOUNDARIES ARE IST, NOT UTC (Plan 11a D5). The retention unit is an IST concept — the
 * daily jobs are `dailyIst`, the statute is Indian, and a "month of records" a hospital is asked
 * to produce is an IST month. A UTC boundary would put 5.5 hours of every month-end in the
 * neighbouring partition and make a dropped month drop the wrong rows.
 */
export function eventPartitionsFor(
  now: Date,
  monthsAhead: number = EVENT_PARTITION_MONTHS_AHEAD,
): EventPartition[] {
  const ist = new Date(now.getTime() + IST_OFFSET_MS); // read with getUTC* below: IST wall clock
  const baseYear = ist.getUTCFullYear();
  const baseMonth = ist.getUTCMonth();
  const out: EventPartition[] = [];
  for (let i = 0; i <= monthsAhead; i += 1) {
    const m = normalise(baseYear, baseMonth + i);
    out.push({
      name: `events_${m.year}_${pad2(m.monthIndex + 1)}`,
      from: istMonthStart(baseYear, baseMonth + i),
      to: istMonthStart(baseYear, baseMonth + i + 1),
    });
  }
  return out;
}

/** The monthly partitions that currently exist, oldest first. The DEFAULT one is not among them. */
export async function listEventPartitions(db: Db): Promise<string[]> {
  const rows = (await db.execute(sql`
    select c.relname as "name"
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'events'
    order by c.relname asc
  `)).rows as { name: string }[];
  return rows.map((r) => r.name).filter((n) => n !== EVENTS_DEFAULT_PARTITION);
}

/**
 * `createEventPartitions` — the eighth job on the clock (Plan 11a D5), a `dailyIst` registration
 * at 00:15 IST. It creates the current IST month and the next `EVENT_PARTITION_MONTHS_AHEAD`,
 * IF NOT EXISTS, and returns the names it ensured.
 *
 * IT EMITS NO EVENT, and that is a decision rather than an omission. A monthly
 * create-if-not-exists is not a fact the hospital record needs: the PARTITIONS' EXISTENCE is the
 * record, and it is queryable (`listEventPartitions`). An event per run would append 365 rows a
 * year saying nothing changed — into the very table this job exists to keep prunable.
 *
 * IDEMPOTENT BY `IF NOT EXISTS`, not by a pre-read. Two workers may hold different opinions about
 * which months exist for the ~1 ms between a read and a create; only the DDL's own guard is
 * atomic. The advisory lock the Scheduler takes is noise reduction and never correctness (D3).
 *
 * THE BOUNDS ARE INLINED, NOT PARAMETERS, and they have to be: a partition bound must be a
 * constant expression, so `$1` is rejected by Postgres outright. The strings are built by
 * `eventPartitionsFor` from integer date arithmetic — digits, hyphens and `+05:30` — so nothing
 * a caller supplies reaches the statement text.
 */
export async function createEventPartitions(db: Db, now: Date = new Date()): Promise<string[]> {
  const wanted = eventPartitionsFor(now);
  for (const p of wanted) {
    await db.execute(sql.raw(
      `create table if not exists "${p.name}" partition of events ` +
        `for values from ('${p.from}') to ('${p.to}')`,
    ));
  }
  return wanted.map((p) => p.name);
}
