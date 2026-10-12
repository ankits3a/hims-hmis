import { IPD_PROVENANCE_SOURCES } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../kernel/db/client";
import {
  BED_AVAILABLE, BED_CLEANING, EV, EWS_ACK_KINDS, IPD_ACT_EVENTS, IPD_GOAL_CLEAN_REASONS, IPD_GOAL_EVENTS,
  IPD_GOAL_TEMPLATES, TIMED_INTENTS,
} from "./goal-events";
import type { GoalBreakdownRow, GoalMeasured, GoalNotInstrumented, GoalQuery, GoalRunArgs } from "./types";

/**
 * E0.5 (#717) — ONE NAMED QUERY PER IPD GOAL (plan §1 goal table, §6 ledger; decision 0072).
 *
 * Read-only. Every query takes its window [from, to) from the caller and never reads the clock. Medians and
 * p90 are Postgres `percentile_cont`; minutes are plain numbers rounded to 2 decimals; an empty population
 * gives `value: null` (no evidence), never 0 or NaN. A goal whose instrument does not exist yet answers
 * `not_instrumented` with the missing source named.
 *
 * Correlation: IPD event payloads carry `admissionId` (DECIDED, E0.5: every IPD intent's input names its
 * admission, and the emitting lane copies it into the payload).
 */

type Row = Record<string, unknown>;
const IST_DAY = (col: SQL): SQL => sql`to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const r2 = (n: unknown): number | null => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
const pct = (num: number, den: number): number | null => (den === 0 ? null : r2((100 * num) / den));

async function rows<T extends Row>(db: Db, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

function notInstrumented(source: string): (db: Db, a: GoalRunArgs) => Promise<GoalNotInstrumented> {
  return async () => ({ status: "not_instrumented", source, value: null, rows: [] });
}

/**
 * A time goal. `measures` selects one row per measured item: `item`, `grp` (the goal's own split), `at` (the
 * instant that closes the measure, in the window) and `minutes`.
 */
async function durationGoal(db: Db, a: GoalRunArgs, measures: SQL): Promise<GoalMeasured> {
  const key = a.groupBy === "day" ? IST_DAY(sql`at`) : sql`grp`;
  const stats = await rows<{ k: string | null; total: boolean; n: number; p50: number | null; p90: number | null }>(db, sql`
    with m as (${measures})
    select ${key} as k, grouping(${key}) = 1 as total, count(*)::int as n,
           percentile_cont(0.5) within group (order by minutes) as p50,
           percentile_cont(0.9) within group (order by minutes) as p90
    from m group by grouping sets ((), (${key})) order by 2 desc, 1`);
  const items = await rows<Row>(db, sql`with m as (${measures}) select item, grp, at, round(minutes::numeric, 2)::float8 as minutes from m order by at, item`);
  const total = stats.find((s) => s.total);
  const n = total?.n ?? 0;
  return {
    status: "measured",
    value: n === 0 ? null : r2(total!.p50),
    p90: n === 0 ? null : r2(total!.p90),
    denominator: n,
    breakdown: stats.filter((s) => !s.total).map((s) => ({ key: s.k ?? "unknown", value: r2(s.p50), p90: r2(s.p90), n: s.n })),
    rows: items,
  };
}

/**
 * A share goal. `measures` selects one row per item in the population: `item`, `grp`, `at`, `hit` (boolean).
 * `rows` are the misses, the items to chase.
 */
async function shareGoal(db: Db, a: GoalRunArgs, measures: SQL): Promise<GoalMeasured> {
  const key = a.groupBy === "day" ? IST_DAY(sql`at`) : sql`grp`;
  const stats = await rows<{ k: string | null; total: boolean; n: number; hits: number }>(db, sql`
    with m as (${measures})
    select ${key} as k, grouping(${key}) = 1 as total, count(*)::int as n, (count(*) filter (where hit))::int as hits
    from m group by grouping sets ((), (${key})) order by 2 desc, 1`);
  const misses = await rows<Row>(db, sql`with m as (${measures}) select item, grp, at from m where not hit order by at, item`);
  const total = stats.find((s) => s.total);
  const n = total?.n ?? 0;
  const hits = total?.hits ?? 0;
  return {
    status: "measured",
    value: pct(hits, n),
    numerator: hits,
    denominator: n,
    breakdown: stats.filter((s) => !s.total).map((s) => ({ key: s.k ?? "unknown", value: pct(s.hits, s.n), n: s.n })),
    rows: misses,
  };
}

const inWindow = (col: SQL, a: GoalRunArgs): SQL => sql`${col} >= ${ts(a.from)} and ${col} < ${ts(a.to)}`;
const ADM = sql`payload->>'admissionId'`;

// ─────────────────────────────────────────── the goals ───────────────────────────────────────────

/** G1 — new admissions recorded in HMIS ÷ all new admissions (HMIS + incumbent) per the midnight census. */
async function g1(db: Db, a: GoalRunArgs): Promise<GoalMeasured> {
  const census = await rows<{ item: string; at: Date; hmis: number; incumbent: number; beds: number | null }>(db, sql`
    select payload->>'censusDate' as item, occurred_at as at,
           coalesce((payload->>'hmisAdmissions')::int, 0) as hmis,
           coalesce((payload->>'incumbentAdmissions')::int, 0) as incumbent,
           (payload->>'incumbentOccupiedBeds')::int as beds
    from events where name = ${IPD_GOAL_EVENTS.censusTaken} and ${inWindow(sql`occurred_at`, a)}
    order by occurred_at, seq`);
  const num = census.reduce((s, c) => s + c.hmis, 0);
  const den = census.reduce((s, c) => s + c.hmis + c.incumbent, 0);
  const latest = census.at(-1);
  const breakdown: GoalBreakdownRow[] = census.map((c) => ({ key: c.item, value: pct(c.hmis, c.hmis + c.incumbent), n: c.hmis + c.incumbent }));
  if (latest) breakdown.push({ key: "incumbent_beds_latest", value: latest.beds, n: census.length });
  return { status: "measured", value: pct(num, den), numerator: num, denominator: den, breakdown, rows: census };
}

/** G2 — request → first bed act (reserve, assign, or a direct admit onto a bed), by request source. */
const g2 = (db: Db, a: GoalRunArgs) => durationGoal(db, a, sql`
  select r.adm as item, coalesce(r.src, 'unknown') as grp, f.at,
         extract(epoch from (f.at - r.req_at)) / 60.0 as minutes
  from (
    select ${ADM} as adm, min(occurred_at) as req_at, (array_agg(payload->>'source' order by occurred_at))[1] as src
    from events where name = ${EV.admissionRequested} and occurred_at < ${ts(a.to)} group by 1
  ) r
  cross join lateral (
    select min(e.occurred_at) as at from events e
    where e.name in (${EV.bedReserved}, ${EV.bedAssigned}, ${EV.admitted})
      and e.payload->>'admissionId' = r.adm and e.occurred_at >= r.req_at
  ) f
  where ${inWindow(sql`f.at`, a)}`);

/**
 * G3 — a bed's move into cleaning → its next move, when that move is cleaning → available; routine and
 * terminal by the reason on the move into cleaning. Looks back 7 days before the window for the start.
 */
const g3 = (db: Db, a: GoalRunArgs) => durationGoal(db, a, sql`
  select resource_id as item, grp, next_at as at, extract(epoch from (next_at - h_at)) / 60.0 as minutes
  from (
    select h.resource_id, h.to_status, h.at as h_at,
           case when h.reason = ${IPD_GOAL_CLEAN_REASONS.terminal} then 'terminal' else 'routine' end as grp,
           lead(h.at) over w as next_at, lead(h.from_status) over w as next_from, lead(h.to_status) over w as next_to
    from resource_status_history h join resources r on r.id = h.resource_id and r.kind = 'bed'
    where h.at >= ${ts(a.from)} - interval '7 days' and h.at < ${ts(a.to)}
    window w as (partition by h.resource_id order by h.seq)
  ) t
  where to_status = ${BED_CLEANING} and next_from = ${BED_CLEANING} and next_to = ${BED_AVAILABLE}
    and ${inWindow(sql`next_at`, a)}`);

/** G4 — the latest fit declaration before the gate scan → the scan; cashless = a payer authorisation on file. */
const g4 = (db: Db, a: GoalRunArgs) => durationGoal(db, a, sql`
  select s.adm as item, s.at, extract(epoch from (s.at - f.fit_at)) / 60.0 as minutes,
         case when exists (select 1 from events p where p.name = ${EV.payerAuthRecorded} and p.payload->>'admissionId' = s.adm)
              then 'cashless' else 'cash' end as grp
  from (
    select ${ADM} as adm, min(occurred_at) as at from events
    where name = ${EV.gatePassScanned} and ${inWindow(sql`occurred_at`, a)} group by 1
  ) s
  cross join lateral (
    select max(e.occurred_at) as fit_at from events e
    where e.name = ${EV.fitDeclared} and e.payload->>'admissionId' = s.adm and e.occurred_at <= s.at
  ) f
  where f.fit_at is not null`);

/** G5b — rent lines beyond the first for one admission and one night. */
async function g5b(db: Db, a: GoalRunArgs): Promise<GoalMeasured> {
  const groups = await rows<{ admission_id: string; rent_date: string; lines: number }>(db, sql`
    select ${ADM} as admission_id, payload->>'rentDate' as rent_date, count(*)::int as lines
    from events where name = ${IPD_GOAL_EVENTS.rentPosted} and ${inWindow(sql`occurred_at`, a)}
    group by 1, 2 order by 2, 1`);
  const lines = groups.reduce((s, g) => s + g.lines, 0);
  const dupes = groups.reduce((s, g) => s + g.lines - 1, 0);
  return { status: "measured", value: lines === 0 ? null : dupes, denominator: lines, rows: groups.filter((g) => g.lines > 1) };
}

/** G6a — doses given with a wristband scan and a label scan ÷ all doses given, by ward. */
const g6a = (db: Db, a: GoalRunArgs) => shareGoal(db, a, sql`
  select event_id as item, coalesce(payload->>'wardId', 'unknown') as grp, occurred_at as at,
         (payload->'patientCheck'->>'kind' = 'scan' and coalesce(btrim(payload->>'labelCode'), '') <> '') as hit
  from events where name = ${EV.doseGiven} and ${inWindow(sql`occurred_at`, a)}`);

/** G7 — early-warning breaches acknowledged by a doctor within 30 minutes (inclusive) ÷ all breaches. */
const g7 = (db: Db, a: GoalRunArgs) => shareGoal(db, a, sql`
  select b.payload->>'alertId' as item, coalesce(b.payload->>'wardId', 'unknown') as grp, b.occurred_at as at,
         exists (
           select 1 from events k
           where k.name = ${IPD_GOAL_EVENTS.ewsAcknowledged} and k.payload->>'alertId' = b.payload->>'alertId'
             and k.payload->>'byKind' in (${sql.join(EWS_ACK_KINDS.map((k) => sql`${k}`), sql`, `)})
             and k.occurred_at >= b.occurred_at and k.occurred_at <= b.occurred_at + interval '30 minutes'
         ) as hit
  from events b where b.name = ${IPD_GOAL_EVENTS.ewsBreached} and ${inWindow(sql`b.occurred_at`, a)}`);

/** G8 — medians of the client's act timings: admission minutes and taps, dose seconds, vitals typed / voice. */
async function g8(db: Db, a: GoalRunArgs): Promise<GoalMeasured> {
  const measures: { key: string; where: SQL; expr: SQL }[] = [
    { key: "admit_minutes", where: sql`intent = ${TIMED_INTENTS.admit}`, expr: sql`ms / 60000.0` },
    { key: "admit_taps", where: sql`intent = ${TIMED_INTENTS.admit} and taps is not null`, expr: sql`taps` },
    { key: "dose_seconds", where: sql`intent = ${TIMED_INTENTS.dose}`, expr: sql`ms / 1000.0` },
    { key: "vitals_typed_seconds", where: sql`intent = ${TIMED_INTENTS.vitals} and mode = 'typed'`, expr: sql`ms / 1000.0` },
    { key: "vitals_voice_seconds", where: sql`intent = ${TIMED_INTENTS.vitals} and mode = 'voice'`, expr: sql`ms / 1000.0` },
  ];
  const cols = sql.join(measures.map((m, i) => sql`
    (count(*) filter (where ${m.where}))::int as ${sql.raw(`n${i}`)},
    percentile_cont(0.5) within group (order by ${m.expr}) filter (where ${m.where}) as ${sql.raw(`p${i}`)}`), sql`,`);
  const [agg] = await rows<Row>(db, sql`
    with t as (
      select payload->>'intent' as intent, (payload->>'durationMs')::numeric as ms, (payload->>'taps')::numeric as taps,
             payload->>'inputMode' as mode
      from events where name = ${IPD_GOAL_EVENTS.intentTimed} and ${inWindow(sql`occurred_at`, a)}
    )
    select ${cols} from t`);
  const breakdown = measures
    .map((m, i) => ({ key: m.key, value: r2(agg?.[`p${i}`]), n: Number(agg?.[`n${i}`] ?? 0) }))
    .filter((b) => b.n > 0);
  const admit = breakdown.find((b) => b.key === "admit_minutes");
  return { status: "measured", value: admit?.value ?? null, breakdown, rows: breakdown };
}

/**
 * G10 — daily-totals messages sent ÷ settled (sent, expired, undeliverable); queued/sending are still in flight
 * and suppressed means the family opted out. Breakdown `tracker_opened`: discharges whose tracker link was opened.
 */
async function g10(db: Db, a: GoalRunArgs): Promise<GoalMeasured> {
  const share = await shareGoal(db, a, sql`
    select id as item, template_key as grp, occurred_at as at, status = 'sent' as hit
    from notifications
    where template_key = ${IPD_GOAL_TEMPLATES.dailyTotals} and status in ('sent', 'expired', 'undeliverable')
      and ${inWindow(sql`occurred_at`, a)}`);
  const [t] = await rows<{ n: number; opened: number }>(db, sql`
    select count(distinct d.adm)::int as n,
           (count(distinct d.adm) filter (where exists (
             select 1 from events o where o.name = ${IPD_GOAL_EVENTS.trackerOpened} and o.payload->>'admissionId' = d.adm)))::int as opened
    from (select ${ADM} as adm from events where name = ${EV.discharged} and ${inWindow(sql`occurred_at`, a)}) d`);
  const breakdown = (share.breakdown ?? []).filter(() => a.groupBy === "day");
  if ((t?.n ?? 0) > 0) breakdown.push({ key: "tracker_opened", value: pct(t!.opened, t!.n), n: t!.n });
  return { ...share, breakdown };
}

/** G11b — IPD acts whose event has a blank actor or no §0B provenance (`payload.provenance`). */
async function g11b(db: Db, a: GoalRunArgs): Promise<GoalMeasured> {
  const names = sql.join(IPD_ACT_EVENTS.map((n) => sql`${n}`), sql`, `);
  const sources = sql.join(IPD_PROVENANCE_SOURCES.map((s) => sql`${s}`), sql`, `);
  const [pop] = await rows<{ n: number }>(db, sql`
    select count(*)::int as n from events where name in (${names}) and ${inWindow(sql`occurred_at`, a)}`);
  const bad = await rows<Row>(db, sql`
    select event_id as item, name, occurred_at as at, actor_type, actor_id
    from events where name in (${names}) and ${inWindow(sql`occurred_at`, a)}
      and (btrim(actor_id) = '' or coalesce(payload->>'provenance', '') not in (${sources}))
    order by occurred_at, seq`);
  const n = pop?.n ?? 0;
  return { status: "measured", value: n === 0 ? null : bad.length, denominator: n, rows: bad };
}

// ─────────────────────────────────────────── the registry ───────────────────────────────────────────

const minutes = (measure: string, op: "<=" | ">=" | "==", value: number) => ({ measure, op, value, unit: "minutes" });
const percent = (measure: string, op: "<=" | ">=" | "==", value: number) => ({ measure, op, value, unit: "percent" });

export const IPD_GOAL_QUERIES: Record<string, GoalQuery> = {
  G1: {
    id: "G1", title: "Every admission lives in HMIS", unit: "percent", window: "4 weeks after cutover",
    metric: "Admissions created in HMIS ÷ admissions in the midnight census (HMIS + incumbent), after cutover.",
    target: [percent("value", ">=", 100), { measure: "incumbent_beds_latest", op: "==", value: 0, unit: "count" }],
    run: g1,
  },
  G2: {
    id: "G2", title: "Beds found fast", unit: "minutes", window: "4 weeks",
    metric: "Bed request → bed assigned, median and p90, by source (OPD, OT, ER, transfer).",
    target: [minutes("median", "<=", 30), minutes("p90", "<=", 90)],
    run: g2,
  },
  G3: {
    id: "G3", title: "Beds turn fast", unit: "minutes", window: "4 weeks",
    metric: "Bed released → verified available, median; routine and terminal separately.",
    target: [minutes("routine", "<=", 45), minutes("terminal", "<=", 90)],
    run: g3,
  },
  G4: {
    id: "G4", title: "Discharge without waiting", unit: "minutes", window: "4 weeks",
    metric: "Fit declared → gate pass scanned, median, cash and cashless separately.",
    target: [minutes("cash", "<=", 180)], targetNote: "Cashless reported; target set after baseline.",
    run: g4,
  },
  G5a: {
    id: "G5a", title: "No leakage — issued but uncharged", unit: "rupees", window: "every month",
    metric: "Issued items with no charge line or cost centre, rupees open past 48 hours.",
    target: [{ measure: "value", op: "==", value: 0, unit: "rupees" }],
    run: notInstrumented("IPD charge capture (ipd-charges lane): no link from an issued item to its charge line or cost centre yet — the variance report needs it"),
  },
  G5b: {
    id: "G5b", title: "No leakage — duplicate rent", unit: "count", window: "every month (target: 0 ever)",
    metric: "Duplicate nightly rent lines (more than one line for one admission and one night).",
    target: [{ measure: "value", op: "==", value: 0, unit: "count" }],
    run: g5b,
  },
  G5c: {
    id: "G5c", title: "No leakage — unbilled implants", unit: "rupees", window: "every month (at month close)",
    metric: "Unbilled implants or consumables found by the Leakage Auditor.",
    target: [{ measure: "value", op: "==", value: 0, unit: "rupees" }],
    run: notInstrumented("Leakage Auditor agent (M5): no findings store exists yet"),
  },
  G6a: {
    id: "G6a", title: "Right patient, right drug — scanned doses", unit: "percent", window: "4 weeks per ward",
    metric: "Doses recorded with wristband and label scan ÷ all doses, live wards.",
    target: [percent("value", ">=", 98)],
    run: g6a,
  },
  G6b: {
    id: "G6b", title: "Right patient, right drug — wrong administrations", unit: "count", window: "permanent",
    metric: "Wrong-patient or wrong-drug administrations (incident register).",
    target: [{ measure: "value", op: "==", value: 0, unit: "count" }],
    run: notInstrumented("pharmacy medication-incident register: modules/pharmacy/index.ts exports no count of administration-stage wrong_patient / wrong_drug errors to read"),
  },
  G7: {
    id: "G7", title: "Deterioration answered", unit: "percent", window: "4 weeks per live ward",
    metric: "Early-warning breaches acknowledged by a doctor within 30 min ÷ all breaches.",
    target: [percent("value", ">=", 95)],
    run: g7,
  },
  G8: {
    id: "G8", title: "Fast for staff", unit: "minutes", window: "4 weeks",
    metric: "Planned admission time and taps; scan → dose recorded; vitals entry (medians).",
    target: [
      minutes("admit_minutes", "<=", 4),
      { measure: "admit_taps", op: "<=", value: 8, unit: "count" },
      { measure: "dose_seconds", op: "<=", value: 15, unit: "seconds" },
      { measure: "vitals_typed_seconds", op: "<=", value: 20, unit: "seconds" },
      { measure: "vitals_voice_seconds", op: "<=", value: 10, unit: "seconds" },
    ],
    run: g8,
  },
  G9a: {
    id: "G9a", title: "Waste law kept — bags tagged", unit: "percent", window: "every month",
    metric: "Bags with barcode and weight ÷ bags handed over.",
    target: [percent("value", ">=", 100)],
    run: notInstrumented("BMW bag register (companions spec, bmw lane): no bag table yet"),
  },
  G9b: {
    id: "G9b", title: "Waste law kept — bags stored too long", unit: "count", window: "every month",
    metric: "Bags stored more than 48 hours.",
    target: [{ measure: "value", op: "==", value: 0, unit: "count" }],
    run: notInstrumented("BMW bag register (companions spec, bmw lane): no bag table yet"),
  },
  G9c: {
    id: "G9c", title: "Waste law kept — reports", unit: "yesno", window: "every month",
    metric: "Monthly and annual reports produced with no typing.",
    target: [{ measure: "value", op: "==", value: 1, unit: "yesno" }],
    run: notInstrumented("BMW monthly/annual report generator (bmw lane): nothing records a produced report yet"),
  },
  G10: {
    id: "G10", title: "Families informed", unit: "percent", window: "4 weeks",
    metric: "Daily totals message delivered ÷ eligible admissions; discharge tracker link opened ÷ discharges.",
    target: [percent("value", ">=", 95)], targetNote: "Tracker opened: reported, no target.",
    run: g10,
  },
  G11a: {
    id: "G11a", title: "Safe and auditable — no money for doctors", unit: "count", window: "every release",
    metric: "Money shown on any doctor surface.",
    target: [{ measure: "value", op: "==", value: 0, unit: "count" }],
    run: notInstrumented("UI test suite result per release (CI): a test outcome, not a database row"),
  },
  G11b: {
    id: "G11b", title: "Safe and auditable — every act attributed", unit: "count", window: "monthly",
    metric: "Acts without actor or source.",
    target: [{ measure: "value", op: "==", value: 0, unit: "count" }],
    run: g11b,
  },
  G11c: {
    id: "G11c", title: "Safe and auditable — downtime drill", unit: "yesno", window: "quarterly",
    metric: "Quarterly downtime drill with paper and back-fill.",
    target: [{ measure: "value", op: "==", value: 1, unit: "yesno" }],
    run: notInstrumented("downtime drill record: operating_mode_changes logs mode switches but no drill or back-fill outcome"),
  },
};
