import { sql } from "drizzle-orm";
import { EMPTY_TIMING, STATS, istRange, num, rowsOf, timing } from "../../kernel/report/metrics";
import type { MetricsRow } from "../../kernel/report/metrics";
import type { Db } from "../../kernel/db/client";

/**
 * LAB NUMBERS (owner request 2026-10-13, issue #768) — counts and turnaround times for a date range,
 * read-only, no new tables. Held by `lab.metrics.read`.
 *
 * What each figure is anchored on (dates are Asia/Kolkata days, `from` and `to` inclusive):
 *   · orders created ............ `orders.created_at` (lab orders, not cancelled)
 *   · tests ordered ............. `order_items.created_at` (lab items, not cancelled, order not cancelled)
 *   · reports published ......... the FIRST publication of an order's report chain (an amendment
 *                                 is a later version of the same chain and is not counted again);
 *                                 a quick-mode report counts at `lab_quick_reports.reported_at`
 *   · reports delivered ......... the FIRST delivery row of the chain, any version, any channel;
 *                                 a quick-mode report counts at `handed_over_at`
 *   · report times .............. reports first published in the range
 *   · test and parameter times .. tests ordered in the range (full lab only: quick mode keeps no
 *                                 tube, result or verification rows)
 *
 * Source: `walk_in` when any lab item of the order carries `charge_reason = 'lab_walkin'`; `opd`
 * when the order's encounter is an OPD visit (`V…`); `ipd` for every other encounter (day care `D…`
 * today, admissions when they exist). A quick report with no order: `V…` → opd, none → walk_in.
 *
 * Every time is minutes, median and 90th percentile (`percentile_cont`), with n. A step with a
 * missing timestamp is left out of THAT step only. `lab_items.tat_stopped_at` is never written and
 * is not read here: "all verified" is `order_items.completed_at`, which `verify.ts` stamps when the
 * last analyte of the test is verified.
 */

export type LabSource = "opd" | "ipd" | "walk_in";
export const LAB_SOURCES: readonly LabSource[] = ["opd", "ipd", "walk_in"];

export type LabTiming = { n: number; medianMin: number | null; p90Min: number | null };
export type LabCounts = { orders: number; tests: number; published: number; delivered: number };

export type LabMetrics = {
  from: string;
  to: string;
  totals: LabCounts;
  bySource: (LabCounts & { source: LabSource })[];
  byTest: (LabCounts & { serviceId: string; code: string; name: string })[];
  reportTimes: { placedToPublished: LabTiming; receivedToPublished: LabTiming; publishedToDelivered: LabTiming };
  testTimes: {
    serviceId: string; code: string; name: string;
    placedToCollected: LabTiming; collectedToReceived: LabTiming; receivedToEntered: LabTiming;
    enteredToVerified: LabTiming; placedToVerified: LabTiming;
  }[];
  parameterTimes: {
    analyteId: string; code: string; name: string; mode: "machine" | "manual";
    receivedToEntered: LabTiming; enteredToVerified: LabTiming;
  }[];
};

export { istDayStart, istRange } from "../../kernel/report/metrics";

/** The order's source, for an `orders` row aliased `o`. */
const SOURCE_OF_O = sql.raw(`case
  when exists (select 1 from order_items woi join lab_items wli on wli.order_item_id = woi.id
               where woi.order_id = o.id and wli.charge_reason = 'lab_walkin') then 'walk_in'
  when o.encounter_no like 'V%' then 'opd'
  else 'ipd' end`);

type Row = MetricsRow;
const EMPTY: LabTiming = EMPTY_TIMING;

export async function labMetrics(db: Db, range: { from: string; to: string }): Promise<LabMetrics> {
  const { start, end } = istRange(range.from, range.to);
  const s = start.toISOString();
  const e = end.toISOString();

  /* ── orders and tests, by source and by test ── */
  const orderRows = await rowsOf(db, sql`
    select grouping(x.src) as g_src, grouping(x.service_id) as g_svc, x.src, x.service_id, count(distinct x.order_id) as n
    from (
      select o.id as order_id, ${SOURCE_OF_O} as src, oi.service_id
      from orders o
      join order_items oi on oi.order_id = o.id
      join lab_items li on li.order_item_id = oi.id
      where o.kind = 'lab' and o.status <> 'cancelled' and oi.status <> 'cancelled'
        and o.created_at >= ${s}::timestamptz and o.created_at < ${e}::timestamptz
    ) x
    group by grouping sets ((x.src), (x.service_id), ())`);
  const testRows = await rowsOf(db, sql`
    select grouping(x.src) as g_src, grouping(x.service_id) as g_svc, x.src, x.service_id, count(*) as n
    from (
      select ${SOURCE_OF_O} as src, oi.service_id
      from order_items oi
      join lab_items li on li.order_item_id = oi.id
      join orders o on o.id = oi.order_id
      where o.status <> 'cancelled' and oi.status <> 'cancelled'
        and oi.created_at >= ${s}::timestamptz and oi.created_at < ${e}::timestamptz
    ) x
    group by grouping sets ((x.src), (x.service_id), ())`);

  /*
    ── reports: one row per report chain (full lab: per order) and per quick report ──
    `placed`, `received`, `pub`, `del` and the tests it carries; only chains published or delivered
    inside the range are read.
  */
  const REPORTS = sql`
    with full_chain as (
      select r.order_id, min(r.published_at) as pub,
             (select min(d.at) from lab_report_deliveries d join lab_reports r2 on r2.id = d.report_id
               where r2.order_id = r.order_id) as del
      from lab_reports r
      where r.published_at is not null
      group by r.order_id
    ),
    reps as (
      select 'o:' || o.id as key, ${SOURCE_OF_O} as src, o.created_at as placed,
             (select max(sp.received_at) from order_items soi
                join lab_specimen_items si on si.order_item_id = soi.id and si.active
                join lab_specimens sp on sp.id = si.specimen_id
               where soi.order_id = o.id and soi.status <> 'cancelled') as received,
             fc.pub, fc.del,
             array(select soi.service_id from order_items soi join lab_items sli on sli.order_item_id = soi.id
                    where soi.order_id = o.id and soi.status <> 'cancelled') as services
      from full_chain fc join orders o on o.id = fc.order_id
      where o.status <> 'cancelled'
        and ((fc.pub >= ${s}::timestamptz and fc.pub < ${e}::timestamptz)
          or (fc.del >= ${s}::timestamptz and fc.del < ${e}::timestamptz))
      union all
      select 'q:' || q.id as key,
             case when o.id is not null then ${SOURCE_OF_O}
                  when q.encounter_no like 'V%' then 'opd'
                  when q.encounter_no is null then 'walk_in'
                  else 'ipd' end as src,
             o.created_at as placed, q.collected_at as received, q.reported_at as pub, q.handed_over_at as del,
             array(select t ->> 'serviceId' from jsonb_array_elements(q.tests) t) as services
      from lab_quick_reports q left join orders o on o.id = q.order_id
      where q.reported_at is not null and (o.id is null or o.status <> 'cancelled')
        and ((q.reported_at >= ${s}::timestamptz and q.reported_at < ${e}::timestamptz)
          or (q.handed_over_at >= ${s}::timestamptz and q.handed_over_at < ${e}::timestamptz))
    )`;
  const reportCountRows = await rowsOf(db, sql`${REPORTS}
    select grouping(x.src) as g_src, grouping(x.service_id) as g_svc, x.src, x.service_id,
           count(distinct x.key) filter (where x.pub >= ${s}::timestamptz and x.pub < ${e}::timestamptz) as published,
           count(distinct x.key) filter (where x.del >= ${s}::timestamptz and x.del < ${e}::timestamptz) as delivered
    from (select r.key, r.src, r.pub, r.del, svc as service_id from reps r cross join lateral unnest(r.services) svc) x
    group by grouping sets ((x.src), (x.service_id))`);
  /* The totals are counted on chains, not on (chain, test) pairs — a report with no test row still counts once. */
  const [reportTotals] = await rowsOf(db, sql`${REPORTS}
    select count(*) filter (where pub >= ${s}::timestamptz and pub < ${e}::timestamptz) as published,
           count(*) filter (where del >= ${s}::timestamptz and del < ${e}::timestamptz) as delivered
    from reps`);
  const reportTimeRows = await rowsOf(db, sql`${REPORTS}
    select v.step, ${STATS}
    from reps r
    cross join lateral (values ('placed_pub', r.pub - r.placed), ('received_pub', r.pub - r.received), ('pub_del', r.del - r.pub)) v(step, d)
    where r.pub >= ${s}::timestamptz and r.pub < ${e}::timestamptz and v.d is not null
    group by v.step`);

  /* ── test step times, per orderable (full lab) ── */
  const ITEMS = sql`
    with items as (
      select oi.id as item_id, oi.service_id, oi.created_at as placed,
             sp.collected_at as collected, coalesce(sp.received_at, li.tat_started_at) as received,
             (select min(lr.entered_at) from lab_results lr where lr.order_item_id = oi.id) as entered,
             case when oi.status = 'completed' then oi.completed_at end as verified
      from order_items oi
      join lab_items li on li.order_item_id = oi.id
      join orders o on o.id = oi.order_id
      left join lab_specimen_items si on si.order_item_id = oi.id and si.active
      left join lab_specimens sp on sp.id = si.specimen_id
      where o.status <> 'cancelled' and oi.status <> 'cancelled'
        and oi.created_at >= ${s}::timestamptz and oi.created_at < ${e}::timestamptz
    )`;
  const testTimeRows = await rowsOf(db, sql`${ITEMS}
    select i.service_id, lo.code, lo.name_en, v.step, ${STATS}
    from items i
    join lab_orderables lo on lo.service_id = i.service_id
    cross join lateral (values
      ('placed_collected', i.collected - i.placed), ('collected_received', i.received - i.collected),
      ('received_entered', i.entered - i.received), ('entered_verified', i.verified - i.entered),
      ('placed_verified', i.verified - i.placed)) v(step, d)
    where v.d is not null
    group by i.service_id, lo.code, lo.name_en, v.step`);

  /* ── parameter times, per analyte and entry mode (full lab) ── */
  const paramRows = await rowsOf(db, sql`${ITEMS}
    select lr.analyte_id, la.code, la.name_en,
           case when lr.entry_mode = 'interface' then 'machine' else 'manual' end as mode, v.step, ${STATS}
    from items i
    join lab_results lr on lr.order_item_id = i.item_id
    join lab_analytes la on la.id = lr.analyte_id
    left join lab_specimens rsp on rsp.id = lr.specimen_id
    cross join lateral (values
      ('received_entered', lr.entered_at - coalesce(rsp.received_at, i.received)),
      ('entered_verified', lr.verified_at - lr.entered_at)) v(step, d)
    where v.d is not null
    group by lr.analyte_id, la.code, la.name_en, mode, v.step`);

  /* ── assemble ── */
  const names = new Map<string, { code: string; name: string }>();
  const svcIds = new Set<string>();
  for (const r of [...orderRows, ...testRows, ...reportCountRows]) {
    if (num(r["g_svc"]) === 0 && r["service_id"] !== null) svcIds.add(String(r["service_id"]));
  }
  if (svcIds.size > 0) {
    const named = await rowsOf(db, sql`select service_id, code, name_en from lab_orderables
      where service_id in (${sql.join([...svcIds].map((id) => sql`${id}`), sql`, `)})`);
    for (const r of named) names.set(String(r["service_id"]), { code: String(r["code"]), name: String(r["name_en"]) });
  }

  const blank = (): LabCounts => ({ orders: 0, tests: 0, published: 0, delivered: 0 });
  const bySource = new Map<LabSource, LabCounts>(LAB_SOURCES.map((src) => [src, blank()]));
  const byTest = new Map<string, LabCounts>();
  const totals = blank();
  const put = (rows: Row[], field: "orders" | "tests"): void => {
    for (const r of rows) {
      const gSrc = num(r["g_src"]);
      const gSvc = num(r["g_svc"]);
      if (gSrc === 1 && gSvc === 1) totals[field] = num(r["n"]);
      else if (gSrc === 0) bySource.get(r["src"] as LabSource)![field] = num(r["n"]);
      else {
        const id = String(r["service_id"]);
        const c = byTest.get(id) ?? blank();
        c[field] = num(r["n"]);
        byTest.set(id, c);
      }
    }
  };
  put(orderRows, "orders");
  put(testRows, "tests");
  for (const r of reportCountRows) {
    if (num(r["g_src"]) === 0) {
      const c = bySource.get(r["src"] as LabSource)!;
      c.published = num(r["published"]);
      c.delivered = num(r["delivered"]);
    } else if (r["service_id"] !== null) {
      const id = String(r["service_id"]);
      const c = byTest.get(id) ?? blank();
      c.published = num(r["published"]);
      c.delivered = num(r["delivered"]);
      byTest.set(id, c);
    }
  }
  totals.published = num(reportTotals?.["published"]);
  totals.delivered = num(reportTotals?.["delivered"]);

  const reportStep = new Map(reportTimeRows.map((r) => [String(r["step"]), r]));

  const tests = new Map<string, LabMetrics["testTimes"][number]>();
  for (const r of testTimeRows) {
    const id = String(r["service_id"]);
    const t = tests.get(id) ?? {
      serviceId: id, code: String(r["code"]), name: String(r["name_en"]),
      placedToCollected: EMPTY, collectedToReceived: EMPTY, receivedToEntered: EMPTY, enteredToVerified: EMPTY, placedToVerified: EMPTY,
    };
    const key = ({
      placed_collected: "placedToCollected", collected_received: "collectedToReceived", received_entered: "receivedToEntered",
      entered_verified: "enteredToVerified", placed_verified: "placedToVerified",
    } as const)[String(r["step"]) as "placed_collected"];
    t[key] = timing(r);
    tests.set(id, t);
  }

  const params = new Map<string, LabMetrics["parameterTimes"][number]>();
  for (const r of paramRows) {
    const mode = r["mode"] === "machine" ? "machine" : "manual";
    const k = `${String(r["analyte_id"])}|${mode}`;
    const p = params.get(k) ?? {
      analyteId: String(r["analyte_id"]), code: String(r["code"]), name: String(r["name_en"]), mode,
      receivedToEntered: EMPTY, enteredToVerified: EMPTY,
    };
    if (r["step"] === "received_entered") p.receivedToEntered = timing(r);
    else p.enteredToVerified = timing(r);
    params.set(k, p);
  }

  return {
    from: range.from,
    to: range.to,
    totals,
    bySource: LAB_SOURCES.map((source) => ({ source, ...bySource.get(source)! })),
    byTest: [...byTest.entries()]
      .map(([serviceId, c]) => ({ serviceId, code: names.get(serviceId)?.code ?? serviceId, name: names.get(serviceId)?.name ?? serviceId, ...c }))
      .sort((a, b) => b.tests - a.tests || b.orders - a.orders || a.name.localeCompare(b.name)),
    reportTimes: {
      placedToPublished: timing(reportStep.get("placed_pub")),
      receivedToPublished: timing(reportStep.get("received_pub")),
      publishedToDelivered: timing(reportStep.get("pub_del")),
    },
    testTimes: [...tests.values()].sort((a, b) => a.name.localeCompare(b.name)),
    parameterTimes: [...params.values()].sort((a, b) => a.name.localeCompare(b.name) || a.mode.localeCompare(b.mode)),
  };
}
