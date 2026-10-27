import { sql } from "drizzle-orm";
import { IpdBedAttributesSchema } from "./bed-attributes";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * HK-2 (#974) — OCCUPIED BED-DAYS under a place (a floor, a ward), by the MIDNIGHT CENSUS (the standard inpatient-day
 * count): every 00:00 IST in [from, to) that is not after `now` counts each bed stay holding a bed under the place at that
 * instant. `beds` is how many IPD beds lie under the place (kernel `bed` rows whose attributes are IPD bed attributes;
 * an OT recovery bay is not one). Read-only; housekeeping reaches it through `ipd/index.ts` for its cost per bed-day.
 */
const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

/** The 00:00 IST instants in [from, to), not after `now`. */
export function istMidnights(from: Date, to: Date, now: Date): Date[] {
  const first = Math.ceil((from.getTime() + IST_MS) / DAY_MS) * DAY_MS - IST_MS;
  const out: Date[] = [];
  for (let t = first; t < to.getTime() && t <= now.getTime(); t += DAY_MS) out.push(new Date(t));
  return out;
}

export async function occupiedBedDays(
  exec: Db | Tx, placeId: string, from: Date, to: Date, now: Date = new Date(),
): Promise<{ beds: number; occupiedBedDays: number }> {
  const bedRows = await (exec as Db).execute<{ id: string; attributes: unknown }>(sql`
    with recursive tree(id, depth) as (
      select id, 0 from resources where id = ${placeId}
      union all
      select r.id, t.depth + 1 from resources r join tree t on r.parent_id = t.id where t.depth < 8
    )
    select r.id, r.attributes from tree join resources r on r.id = tree.id where r.kind = 'bed'`);
  const bedIds = bedRows.rows.filter((b) => IpdBedAttributesSchema.safeParse(b.attributes ?? {}).success).map((b) => b.id);
  const nights = istMidnights(from, to, now);
  if (bedIds.length === 0 || nights.length === 0) return { beds: bedIds.length, occupiedBedDays: 0 };
  const ids = sql.join(bedIds.map((b) => sql`${b}`), sql`, `);
  const ms = sql.join(nights.map((m) => sql`${m.toISOString()}::timestamptz`), sql`, `);
  const res = await (exec as Db).execute<{ n: string }>(sql`
    select count(*) as n
      from ipd_bed_stays s
      join unnest(array[${ms}]) as night(m) on s.started_at <= night.m and (s.ended_at is null or s.ended_at > night.m)
     where s.bed_id in (${ids})`);
  return { beds: bedIds.length, occupiedBedDays: Number(res.rows[0]?.n ?? 0) };
}
