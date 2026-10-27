import { sql } from "drizzle-orm";
import { ICU_RAW_RETENTION_MS } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984) — `icu_numerics` is partitioned by RANGE (observed_at), ONE PARTITION PER UTC DAY (migration 0262, the
 * one hand edit). A partition is created the first time a sample of its day arrives (under an advisory lock: two batches
 * racing for a new day create it once) and DROPPED once its whole day is older than 72 hours — dropping a day is one
 * catalogue act, never a row-by-row delete, so the raw feed costs no vacuum. One value per minute stays with the record
 * in `icu_numerics_minute`; the signed hour is the legal record. A legal hold copies a day before its drop (no hold
 * register exists yet — the retention sweep owes it; until then nothing raw is under a hold).
 */
const DAY_MS = 86_400_000;
const PREFIX = "icu_numerics_p";

export const partitionNameOf = (day: Date): string => `${PREFIX}${day.toISOString().slice(0, 10).replace(/-/g, "")}`;
const dayStart = (at: Date): Date => new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);

/** Per process: the days already known to exist (a batch every 30 s per hall must not ask the catalogue each time). */
const known = new WeakMap<Db, Set<string>>();

export async function ensureNumericsPartitions(db: Db, instants: readonly Date[]): Promise<void> {
  const seen = known.get(db) ?? new Set<string>();
  known.set(db, seen);
  const days = [...new Set(instants.map((i) => dayStart(i).getTime()))].filter((d) => !seen.has(String(d)));
  for (const d of days) {
    const from = new Date(d);
    const to = new Date(d + DAY_MS);
    const name = partitionNameOf(from);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`icu:partition:${name}`}))`);
      await tx.execute(sql.raw(
        `create table if not exists "${name}" partition of "icu_numerics" for values from ('${from.toISOString()}') to ('${to.toISOString()}')`,
      ));
    });
    seen.add(String(d));
  }
}

/** Drops every daily partition whose day ended more than 72 hours before `now`. Answers the names dropped. */
export async function dropExpiredNumericsPartitions(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = (await db.execute(sql`
    select c.relname as name from pg_inherits i
      join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
     where p.relname = 'icu_numerics'`)).rows as { name: string }[];
  const dropped: string[] = [];
  for (const { name } of rows) {
    const m = /^icu_numerics_p(\d{4})(\d{2})(\d{2})$/.exec(name);
    if (m === null) continue;
    const end = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) + DAY_MS;
    if (end <= now.getTime() - ICU_RAW_RETENTION_MS) {
      await db.execute(sql.raw(`drop table if exists "${name}"`));
      known.get(db)?.delete(String(end - DAY_MS));
      dropped.push(name);
    }
  }
  return dropped.sort();
}
