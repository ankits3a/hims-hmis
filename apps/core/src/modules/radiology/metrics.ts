import { sql } from "drizzle-orm";
import { EMPTY_TIMING, STATS, istRange, num, rowsOf, timing } from "../../kernel/report/metrics";
import { IMAGING_MODALITIES } from "./kinds";
import { activeStudyTypes } from "./study-types";
import type { MetricsRow, MetricsTiming } from "../../kernel/report/metrics";
import type { Db } from "../../kernel/db/client";

/**
 * IMAGING NUMBERS (owner request 2026-10-13, issue #777) — counts and turnaround times for a date
 * range, read-only, no new tables. Held by `radiology.metrics.read`. The lab's numbers
 * (`lab/metrics.ts`) are the pattern; the range and the percentile are `kernel/report/metrics.ts`'s.
 *
 * What each figure is anchored on (Asia/Kolkata days, `from` and `to` inclusive):
 *   · orders ........... `orders.created_at` — imaging orders not cancelled, with a live item
 *   · studies done ..... `imaging_studies.acquired_at` (acquisition complete); a cancelled study or
 *                        order is counted nowhere
 *   · reports signed ... the FIRST consultant signature of the study's report chain. A version is
 *                        a signature when it is `signed`, or when a later version names it in
 *                        `supersedes_id` (an amended one). A resident's `awaiting_cosign` and the
 *                        resident's row a consultant signed over are not. One per study, so an
 *                        amended report counts once.
 *   · reports delivered  the FIRST hand-over of any version of the study's report
 *                        (`imaging_report_handovers`). It is the ONLY delivery imaging records:
 *                        there is no print, WhatsApp or portal delivery row in radiology on main
 *                        (the print route is a read; "report ready" is a notice, not the report).
 *   · times ............ placed → done for studies done in the range; done → signed, signed →
 *                        delivered and placed → signed for reports first signed in the range.
 *
 * Source: `walk_in` when the order came on an outside slip or the patient's own request
 * (`authority` `external_prescription` / `self` — DD9's walk-in leg, the north star's `OUT`); `opd` when its encounter is an OPD visit (`V…`); `ipd` for every other
 * encounter. Modality is the active study-type book's, by the item's service; a service the book
 * does not name is `other`.
 */

export type ImagingSource = "opd" | "ipd" | "walk_in";
export const IMAGING_SOURCES: readonly ImagingSource[] = ["opd", "ipd", "walk_in"];
export const METRIC_MODALITIES: readonly string[] = [...IMAGING_MODALITIES, "other"];

export type ImagingCounts = { orders: number; studies: number; signed: number; delivered: number };

export type RadiologyMetrics = {
  from: string;
  to: string;
  totals: ImagingCounts;
  bySource: (ImagingCounts & { source: ImagingSource })[];
  byModality: (ImagingCounts & { modality: string })[];
  times: { placedToDone: MetricsTiming; doneToSigned: MetricsTiming; signedToDelivered: MetricsTiming; placedToSigned: MetricsTiming };
};

/** The order's source, for an `orders` row aliased `o`. */
const SOURCE_OF_O = sql.raw(`case
  when o.authority in ('external_prescription', 'self') then 'walk_in'
  when o.encounter_no like 'V%' then 'opd'
  else 'ipd' end`);

/** service → modality, from the active study-type book; no book is every service `other`. */
async function modalityMap(db: Db): Promise<{ service_id: string; modality: string }[]> {
  try {
    return (await activeStudyTypes(db)).map((t) => ({ service_id: t.service_id, modality: String(t.modality) }));
  } catch {
    return [];
  }
}

export async function radiologyMetrics(db: Db, range: { from: string; to: string }): Promise<RadiologyMetrics> {
  const { start, end } = istRange(range.from, range.to);
  const s = start.toISOString();
  const e = end.toISOString();
  const map = await modalityMap(db);
  const MOD = sql`modmap as (
      select m.service_id, m.modality from jsonb_to_recordset(${JSON.stringify(map)}::jsonb) as m(service_id text, modality text)
    )`;

  /* ── orders, by source and by modality (an order of two modalities counts once under each) ── */
  const orderRows = await rowsOf(db, sql`
    with ${MOD}
    select grouping(x.src) as g_src, grouping(x.modality) as g_mod, x.src, x.modality, count(distinct x.order_id) as n
    from (
      select o.id as order_id, ${SOURCE_OF_O} as src, coalesce(mm.modality, 'other') as modality
      from orders o
      join order_items oi on oi.order_id = o.id
      left join modmap mm on mm.service_id = oi.service_id
      where o.kind = 'imaging' and o.status <> 'cancelled' and oi.status <> 'cancelled'
        and o.created_at >= ${s}::timestamptz and o.created_at < ${e}::timestamptz
    ) x
    group by grouping sets ((x.src), (x.modality), ())`);

  /* ── studies done ── */
  const studyRows = await rowsOf(db, sql`
    with ${MOD}
    select grouping(x.src) as g_src, grouping(x.modality) as g_mod, x.src, x.modality, count(*) as n
    from (
      select ${SOURCE_OF_O} as src, coalesce(mm.modality, 'other') as modality
      from imaging_studies st
      join orders o on o.id = st.order_id
      join order_items oi on oi.id = st.order_item_id
      left join modmap mm on mm.service_id = st.service_id
      where st.status <> 'cancelled' and o.status <> 'cancelled' and oi.status <> 'cancelled'
        and st.acquired_at >= ${s}::timestamptz and st.acquired_at < ${e}::timestamptz
    ) x
    group by grouping sets ((x.src), (x.modality), ())`);

  /* ── report chains: one row per study, first consultant signature and first hand-over ── */
  const REPS = sql`
    with ${MOD},
    chain as (
      select r.study_id, min(r.signed_at) as sig
      from imaging_reports r
      where r.signed_at is not null
        and (r.status = 'signed' or exists (select 1 from imaging_reports r2 where r2.supersedes_id = r.id))
      group by r.study_id
    ),
    reps as (
      select st.id as study_id, ${SOURCE_OF_O} as src, coalesce(mm.modality, 'other') as modality,
             o.created_at as placed, st.acquired_at as done, c.sig,
             (select min(h.handed_at) from imaging_report_handovers h where h.study_id = st.id) as del
      from chain c
      join imaging_studies st on st.id = c.study_id
      join orders o on o.id = st.order_id
      join order_items oi on oi.id = st.order_item_id
      left join modmap mm on mm.service_id = st.service_id
      where st.status <> 'cancelled' and o.status <> 'cancelled' and oi.status <> 'cancelled'
    )`;
  const reportRows = await rowsOf(db, sql`${REPS}
    select grouping(src) as g_src, grouping(modality) as g_mod, src, modality,
           count(*) filter (where sig >= ${s}::timestamptz and sig < ${e}::timestamptz) as signed,
           count(*) filter (where del >= ${s}::timestamptz and del < ${e}::timestamptz) as delivered
    from reps
    group by grouping sets ((src), (modality), ())`);
  const timeRows = await rowsOf(db, sql`${REPS}
    select v.step, ${STATS}
    from reps r
    cross join lateral (values ('done_sig', r.sig - r.done), ('sig_del', r.del - r.sig), ('placed_sig', r.sig - r.placed)) v(step, d)
    where r.sig >= ${s}::timestamptz and r.sig < ${e}::timestamptz and v.d is not null
    group by v.step
    union all
    select 'placed_done' as step, ${STATS}
    from (
      select st.acquired_at - o.created_at as d
      from imaging_studies st
      join orders o on o.id = st.order_id
      join order_items oi on oi.id = st.order_item_id
      where st.status <> 'cancelled' and o.status <> 'cancelled' and oi.status <> 'cancelled'
        and st.acquired_at >= ${s}::timestamptz and st.acquired_at < ${e}::timestamptz
    ) pd
    having count(*) > 0`);

  /* ── assemble ── */
  const blank = (): ImagingCounts => ({ orders: 0, studies: 0, signed: 0, delivered: 0 });
  const totals = blank();
  const bySource = new Map<ImagingSource, ImagingCounts>(IMAGING_SOURCES.map((src) => [src, blank()]));
  const byModality = new Map<string, ImagingCounts>(METRIC_MODALITIES.map((m) => [m, blank()]));
  const cell = (r: MetricsRow): ImagingCounts => {
    if (num(r["g_src"]) === 0) return bySource.get(r["src"] as ImagingSource)!;
    if (num(r["g_mod"]) === 0) {
      const m = String(r["modality"]);
      const c = byModality.get(m) ?? blank();
      byModality.set(m, c);
      return c;
    }
    return totals;
  };
  for (const r of orderRows) cell(r).orders = num(r["n"]);
  for (const r of studyRows) cell(r).studies = num(r["n"]);
  for (const r of reportRows) {
    const c = cell(r);
    c.signed = num(r["signed"]);
    c.delivered = num(r["delivered"]);
  }
  const step = new Map(timeRows.map((r) => [String(r["step"]), r]));
  const known = new Set(METRIC_MODALITIES);

  return {
    from: range.from,
    to: range.to,
    totals,
    bySource: IMAGING_SOURCES.map((source) => ({ source, ...bySource.get(source)! })),
    byModality: [...byModality.entries()]
      .filter(([m, c]) => m !== "other" || c.orders + c.studies + c.signed + c.delivered > 0)
      .sort(([a], [b]) => (known.has(a) ? METRIC_MODALITIES.indexOf(a) : 99) - (known.has(b) ? METRIC_MODALITIES.indexOf(b) : 99) || a.localeCompare(b))
      .map(([modality, c]) => ({ modality, ...c })),
    times: {
      placedToDone: step.has("placed_done") ? timing(step.get("placed_done")) : EMPTY_TIMING,
      doneToSigned: timing(step.get("done_sig")),
      signedToDelivered: timing(step.get("sig_del")),
      placedToSigned: timing(step.get("placed_sig")),
    },
  };
}
