import { sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { istDayString } from "../../kernel/approvals/cumulative";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { qaDueList, attentionList } from "../aerb";
import { displayName } from "../patients";
import { listPriceList } from "../tariff";
import { onDutyNow, orgDepartmentByCode, resolverEnabled } from "../roster";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { imagingDevices } from "./devices";
import { escalationCauses, openEscalations } from "./escalations";
import { northStar, percentiles, sourceOf } from "./north-star";
import { READING_WRITE, TAT_MINUTES, tatClassOf } from "./reading";
import { roomRejects } from "./room";
import { activeStudyTypes } from "./study-types";
import { clearanceOf } from "./read";
import { RADIOLOGY_APPROVAL_TYPES } from "./approval-types";
import { RadiologyError } from "./errors";
import type { CriticalCategoriesBody } from "./definitions";
import type { NorthStarSource } from "./north-star";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PLAN 18-S RS10 — THE SUPERVISOR & HOD's READS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything here is a READ of rows other seats write — the stores are the spine; the HOD keeps no
 * private copy of anything. Grant: `radiology.definitions.manage` (the department head's; the
 * controller says why).
 *
 * **No patient on the floor, the quality, the equipment or the money reads** (DECIDED): a supervisory
 * dashboard names the accession and the study type, which is enough to act, and the seat a link opens
 * shows the patient and logs the read there. The ACCESS LOG is the one read that must name the
 * patient (it answers "who saw whose scans"), so it goes through `displayName` and writes one PHI row
 * per patient it discloses.
 */

type Row = Record<string, unknown>;
const rowsOf = async (db: Db, q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const minsBetween = (a: Date, b: Date): number => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));
const istStart = (day: string): Date => new Date(`${day}T00:00:00.000+05:30`);
const addDays = (day: string, n: number): string => istDayString(new Date(istStart(day).getTime() + n * 86_400_000 + 3_600_000));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayRange(from: string, to: string, maxDays: number): { lo: Date; hi: Date; days: string[] } {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new RadiologyError("invalid_date", "from and to are calendar days, YYYY-MM-DD");
  const lo = istStart(from);
  const hi = new Date(istStart(to).getTime() + 86_400_000);
  if (Number.isNaN(lo.getTime()) || Number.isNaN(hi.getTime()) || hi <= lo) {
    throw new RadiologyError("invalid_date", "the window must run forwards: from on or before to");
  }
  const n = Math.round((hi.getTime() - lo.getTime()) / 86_400_000);
  if (n > maxDays) throw new RadiologyError("invalid_date", `a window is at most ${String(maxDays)} days`);
  const days: string[] = [];
  for (let i = 0; i < n; i += 1) days.push(addDays(from, i));
  return { lo, hi, days };
}

/* ═══════════════════════════════ T1 · the floor ═══════════════════════════════ */

export const FLOOR_STAGES = [
  "scheduled", "checked_in", "ready", "in_acquisition", "to_read", "drafted", "reported", "published",
] as const;
export type FloorStage = (typeof FLOOR_STAGES)[number];

export type FloorStageRow = {
  stage: FloorStage;
  count: number;
  /** Checked-in studies with a safety gate still open. */
  held: number;
  /** The longest wait in this stage: minutes since the study entered it (scheduled: minutes past its slot). */
  oldest: { studyId: string; accessionNo: string; studyTypeCode: string; waitMin: number } | null;
};

export type FloorRoom = {
  deviceId: string; code: string; name: string; modality: string; room: string | null;
  status: string; licensedNow: boolean | null;
  /** Booked today and not yet on the table, plus arrived and ready. */
  queue: number;
  onTable: string | null;
  /** The first instant from now not covered by a booking today; null when the machine is out of service. */
  nextFreeAt: string | null;
  /** The roster has no technologist position and no room on an assignment (RS10 spike c). */
  technologist: null;
};

export type TurnaroundRow = {
  modality: string; source: NorthStarSource; n: number; medianMin: number | null; p90Min: number | null;
  targetMin: number; withinTarget: boolean | null;
};

export type SupervisorFloor = {
  generatedAt: string;
  day: string;
  pipeline: FloorStageRow[];
  rooms: FloorRoom[];
  readers: {
    toRead: number; stat: number; drafted: number;
    /** Derived exactly as the reading room derives it: the latest image view on an unsigned study in the last hour. */
    claimed: { userId: string; name: string; studies: number }[];
    unclaimed: number;
  };
  turnaround: {
    from: string; to: string; rows: TurnaroundRow[];
    northStar: { orderToActed: { n: number; medianMin: number | null; p90Min: number | null }; signedUnreadOver24h: number; publishedNotActedOver72h: number };
  };
  leakage: {
    open: number; estimatedPaise: number; unpriced: number;
    rows: { billDecisionId: string; studyId: string; accessionNo: string; studyTypeCode: string; raisedAt: string; ageMin: number; listPricePaise: number | null }[];
  };
  criticals: { openRed: number; openAll: number; oldestRedMin: number | null };
  /** The PACS inbox (RS12). `measured: false` until the inbox store exists on this database. */
  unmatchedPacs: { measured: boolean; open: number; olderThan24h: number };
  licenceGaps: { deviceId: string; code: string; name: string; booked: number }[];
  qaOverdue: { deviceCode: string; qaType: string; dueOn: string; daysOverdue: number; state: string }[];
  escalations: { open: number; raised: number };
  approvals: { pending: number };
};

/** Target turnaround by north-star source: ER = STAT (30 min), IPD 6 h, OPD and outside 24 h (RS8a DECIDED). */
export function targetFor(source: NorthStarSource): number {
  if (source === "ER") return TAT_MINUTES.stat;
  if (source === "IPD") return TAT_MINUTES.ipd;
  return TAT_MINUTES.opd;
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const r = await rowsOf(db, sql`select to_regclass(${`public.${name}`}) is not null as "exists"`);
  return r[0]?.exists === true;
}

export async function supervisorFloor(db: Db, now: Date = new Date()): Promise<SupervisorFloor> {
  const day = istDayString(now);
  const dayLo = istStart(day);
  const dayHi = new Date(dayLo.getTime() + 86_400_000);

  // ── the pipeline: every live study with the instant it entered its state (its workflow instance).
  // The instant a stage began is the STUDY's own domain column where it has one (they carry a late
  // entry's paper time); `ready` has none, so its workflow instance's state entry answers.
  const live = await rowsOf(db, sql`
    select * from (
      select s.id, s.accession_no, s.study_type_code, s.status, s.scheduled_at, s.duration_min, s.device_resource_id,
             s.checked_in_at, s.acquisition_started_at, s.acquired_at, w.state_entered_at,
             (select max(r.signed_at) from imaging_reports r where r.study_id = s.id and r.status = 'signed') as signed_at,
             (select max(r.published_at) from imaging_reports r where r.study_id = s.id) as published_at,
             exists (select 1 from imaging_reports r where r.study_id = s.id) as has_report,
             exists (select 1 from imaging_safety_screenings g join workflow_instances gw on gw.id = g.workflow_instance_id
                      where g.study_id = s.id and gw.current_state = 'open') as held
        from imaging_studies s join workflow_instances w on w.id = s.workflow_instance_id
       where s.status in ('scheduled', 'checked_in', 'ready', 'in_acquisition', 'acquired', 'reported', 'published')
    ) x
     where x.status <> 'published' or (x.published_at >= ${dayLo} and x.published_at < ${dayHi})
  `);
  const entered = (r: Row, stage: FloorStage): Date | null => {
    const pick = stage === "checked_in" ? r.checked_in_at
      : stage === "in_acquisition" ? r.acquisition_started_at
        : stage === "to_read" || stage === "drafted" ? r.acquired_at
          : stage === "reported" ? r.signed_at
            : r.state_entered_at;
    return pick === null || pick === undefined ? (r.state_entered_at ? asDate(r.state_entered_at) : null) : asDate(pick);
  };
  type Live = { id: string; acc: string; code: string; stage: FloorStage; since: Date | null; held: boolean };
  const staged: Live[] = [];
  for (const r of live) {
    const status = String(r.status);
    const scheduledAt = r.scheduled_at === null ? null : asDate(r.scheduled_at);
    let stage: FloorStage;
    if (status === "scheduled") {
      // Only today's bookings are on the floor; tomorrow's are the diary's.
      if (scheduledAt === null || scheduledAt < dayLo || scheduledAt >= dayHi) continue;
      stage = "scheduled";
    } else if (status === "acquired") stage = r.has_report === true ? "drafted" : "to_read";
    else stage = status as FloorStage;
    const since = stage === "scheduled"
      ? (scheduledAt !== null && scheduledAt < now ? scheduledAt : null)
      : entered(r, stage);
    staged.push({ id: String(r.id), acc: String(r.accession_no), code: String(r.study_type_code), stage, since, held: stage === "checked_in" && r.held === true });
  }
  const pipeline: FloorStageRow[] = FLOOR_STAGES.map((stage) => {
    const inStage = staged.filter((s) => s.stage === stage);
    const waiting = stage === "published" ? [] : inStage.filter((s) => s.since !== null).sort((a, b) => a.since!.getTime() - b.since!.getTime());
    const o = waiting[0];
    return {
      stage, count: inStage.length, held: inStage.filter((s) => s.held).length,
      oldest: o ? { studyId: o.id, accessionNo: o.acc, studyTypeCode: o.code, waitMin: minsBetween(o.since!, now) } : null,
    };
  });

  // ── rooms: status, queue, on the table, next free slot.
  const devices = await imagingDevices(db, day);
  const booked = live.filter((r) => r.device_resource_id !== null);
  const rooms: FloorRoom[] = devices.map((d) => {
    const mine = booked.filter((r) => r.device_resource_id === d.id);
    const queue = mine.filter((r) => {
      const st = String(r.status);
      if (st === "checked_in" || st === "ready") return true;
      if (st !== "scheduled" || r.scheduled_at === null) return false;
      const at = asDate(r.scheduled_at);
      return at >= dayLo && at < dayHi;
    }).length;
    const onTable = mine.find((r) => String(r.status) === "in_acquisition");
    let nextFreeAt: string | null = null;
    if (d.status === "available" || d.status === "in_use") {
      const spans = mine
        .filter((r) => ["scheduled", "checked_in", "ready"].includes(String(r.status)) && r.scheduled_at !== null)
        .map((r) => ({ from: asDate(r.scheduled_at), to: new Date(asDate(r.scheduled_at).getTime() + Number(r.duration_min ?? 15) * 60_000) }))
        .sort((a, b) => a.from.getTime() - b.from.getTime());
      let t = now;
      if (onTable) t = new Date(now.getTime() + 15 * 60_000);
      for (const s of spans) {
        if (s.to <= t) continue;
        if (s.from <= t) { t = s.to; continue; }
        break;
      }
      nextFreeAt = t.toISOString();
    }
    return {
      deviceId: d.id, code: d.code, name: d.name, modality: d.modality, room: d.room, status: d.status,
      licensedNow: d.licensedNow, queue, onTable: onTable ? String(onTable.accession_no) : null, nextFreeAt, technologist: null,
    };
  });

  // ── readers' load: the reading room's own derivation of "is reading".
  const toRead = staged.filter((s) => s.stage === "to_read" || s.stage === "drafted");
  const stat = (await rowsOf(db, sql`
    select count(*)::int as n from imaging_studies s where s.status = 'acquired' and s.priority = 'stat'
  `))[0]?.n;
  const views = toRead.length === 0 ? [] : await rowsOf(db, sql`
    select distinct on (v.study_id) v.study_id, v.viewer_id, u.full_name
      from imaging_image_views v join users u on u.id = v.viewer_id
     where v.study_id in (${sql.join(toRead.map((s) => sql`${s.id}`), sql`, `)})
       and v.viewed_at >= ${new Date(now.getTime() - 3_600_000)} and v.viewed_at <= ${now}
     order by v.study_id, v.viewed_at desc
  `);
  const claimedBy = new Map<string, { name: string; studies: number }>();
  for (const v of views) {
    const id = String(v.viewer_id);
    if (!(await hasPermission(db, id, READING_WRITE, "hospital"))) continue;
    const c = claimedBy.get(id) ?? { name: String(v.full_name), studies: 0 };
    c.studies += 1;
    claimedBy.set(id, c);
  }
  const claimedTotal = [...claimedBy.values()].reduce((t, c) => t + c.studies, 0);

  // ── turnaround: the last seven IST days through RS9's north star, against the RS8a targets.
  const from = addDays(day, -6);
  const ns = await northStar(db, { from, to: day, now });
  const turnaround = {
    from, to: day,
    rows: ns.rows.map((r): TurnaroundRow => ({
      modality: r.modality, source: r.source, n: r.orderToSigned.n, medianMin: r.orderToSigned.medianMin,
      p90Min: r.orderToSigned.p90Min, targetMin: targetFor(r.source),
      withinTarget: r.orderToSigned.p90Min === null ? null : r.orderToSigned.p90Min <= targetFor(r.source),
    })),
    northStar: {
      orderToActed: ns.total.orderToActed, signedUnreadOver24h: ns.total.signedUnreadOver24h,
      publishedNotActedOver72h: ns.total.publishedNotActedOver72h,
    },
  };

  // ── leakage: open `acquired_unbilled` decisions, estimated at the active list price.
  const unbilled = await rowsOf(db, sql`
    select b.id, b.raised_at, s.id as study_id, s.accession_no, s.study_type_code, s.service_id
      from imaging_bill_decisions b join imaging_studies s on s.id = b.study_id
     where b.resolved_at is null and b.kind = 'acquired_unbilled' order by b.raised_at
  `);
  const prices = new Map((await listPriceList(db, now)).map((p) => [p.serviceId, p.pricePaise] as const));
  const leakRows = unbilled.map((r) => ({
    billDecisionId: String(r.id), studyId: String(r.study_id), accessionNo: String(r.accession_no),
    studyTypeCode: String(r.study_type_code), raisedAt: asDate(r.raised_at).toISOString(),
    ageMin: minsBetween(asDate(r.raised_at), now), listPricePaise: prices.get(String(r.service_id)) ?? null,
  }));

  // ── criticals open.
  const crit = (await rowsOf(db, sql`
    select count(*) filter (where f.category = 'red')::int as red, count(*)::int as all_open,
           min(f.created_at) filter (where f.category = 'red') as oldest_red
      from imaging_critical_findings f where f.acknowledged_at is null
  `))[0] ?? {};

  // ── the PACS inbox (RS12's `imaging_unmatched_studies`), read only where it exists.
  let unmatchedPacs = { measured: false, open: 0, olderThan24h: 0 };
  if (await tableExists(db, "imaging_unmatched_studies")) {
    const u = (await rowsOf(db, sql`
      select count(*)::int as open, count(*) filter (where created_at < ${new Date(now.getTime() - 86_400_000)})::int as old
        from imaging_unmatched_studies where status = 'open'
    `))[0] ?? {};
    unmatchedPacs = { measured: true, open: Number(u.open ?? 0), olderThan24h: Number(u.old ?? 0) };
  }

  const bookedByDevice = new Map<string, number>();
  for (const r of booked) {
    const st = String(r.status);
    if (st === "checked_in" || st === "ready" || (st === "scheduled" && r.scheduled_at !== null && asDate(r.scheduled_at) >= dayLo)) {
      bookedByDevice.set(String(r.device_resource_id), (bookedByDevice.get(String(r.device_resource_id)) ?? 0) + 1);
    }
  }
  const licenceGaps = devices.filter((d) => d.licensedNow === false)
    .map((d) => ({ deviceId: d.id, code: d.code, name: d.name, booked: bookedByDevice.get(d.id) ?? 0 }));
  const qaOverdue = (await qaDueList(db, { onDate: day }))
    .filter((q) => q.state === "overdue" || q.state === "failed")
    .map((q) => ({ deviceCode: q.deviceCode, qaType: q.qaType, dueOn: q.dueOn, daysOverdue: q.daysOverdue, state: q.state }));

  const causes = await escalationCauses(db, now);
  const openEsc = await openEscalations(db);
  const typeKeys = RADIOLOGY_APPROVAL_TYPES.map((t) => t.typeKey);
  const pending = (await rowsOf(db, sql`
    select count(*)::int as n from approvals where status = 'pending'
       and type_key in (${sql.join(typeKeys.map((k) => sql`${k}`), sql`, `)})
  `))[0]?.n;

  return {
    generatedAt: now.toISOString(), day, pipeline, rooms,
    readers: {
      toRead: toRead.filter((s) => s.stage === "to_read").length, stat: Number(stat ?? 0),
      drafted: toRead.filter((s) => s.stage === "drafted").length,
      claimed: [...claimedBy.entries()].map(([userId, c]) => ({ userId, ...c })).sort((a, b) => b.studies - a.studies),
      unclaimed: toRead.length - claimedTotal,
    },
    turnaround,
    leakage: {
      open: leakRows.length,
      estimatedPaise: leakRows.reduce((t, r) => t + (r.listPricePaise ?? 0), 0),
      unpriced: leakRows.filter((r) => r.listPricePaise === null).length,
      rows: leakRows,
    },
    criticals: {
      openRed: Number(crit.red ?? 0), openAll: Number(crit.all_open ?? 0),
      oldestRedMin: crit.oldest_red === null || crit.oldest_red === undefined ? null : minsBetween(asDate(crit.oldest_red), now),
    },
    unmatchedPacs, licenceGaps, qaOverdue,
    escalations: { open: causes.length, raised: openEsc.length },
    approvals: { pending: Number(pending ?? 0) },
  };
}

/* ═══════════════════════════════ approvals ═══════════════════════════════ */

export type SupervisorApproval = {
  approvalId: string; typeKey: string; approverRole: string; urgencyClass: string;
  requesterName: string | null; requestedAt: string; ageMin: number; note: string | null;
  /** Plain words: which gate on which accession; which book. No patient. */
  subject: string;
  studyId: string | null;
  gateKind: string | null;
  accessionNo: string | null;
  studyTypeCode: string | null;
};

/** Pending approvals of radiology's own types, oldest first — gate overrides the HOD decides, books the MS decides. */
export async function supervisorApprovals(db: Db, now: Date = new Date()): Promise<{ rows: SupervisorApproval[]; billDecisions: BillDecisionRow[] }> {
  const typeKeys = RADIOLOGY_APPROVAL_TYPES.map((t) => t.typeKey);
  const rows = await rowsOf(db, sql`
    select a.id, a.type_key, a.approver_role, a.urgency_class, a.requested_at, a.request_note, a.subject_type, a.subject_id,
           u.full_name as requester, g.kind as gate_kind, s.id as study_id, s.accession_no, s.study_type_code
      from approvals a
      left join users u on u.id = a.requester_id
      left join imaging_safety_screenings g on a.subject_type = 'imaging_gate' and g.id = a.subject_id
      left join imaging_studies s on s.id = g.study_id
     where a.status = 'pending' and a.type_key in (${sql.join(typeKeys.map((k) => sql`${k}`), sql`, `)})
     order by a.requested_at
  `);
  return {
    rows: rows.map((r) => ({
      approvalId: String(r.id), typeKey: String(r.type_key), approverRole: String(r.approver_role),
      urgencyClass: String(r.urgency_class), requesterName: r.requester === null ? null : String(r.requester),
      requestedAt: asDate(r.requested_at).toISOString(), ageMin: minsBetween(asDate(r.requested_at), now),
      note: r.request_note === null ? null : String(r.request_note),
      subject: r.gate_kind !== null
        ? `${String(r.gate_kind)} · ${String(r.accession_no)} · ${String(r.study_type_code)}`
        : `${String(r.subject_type)}`,
      studyId: r.study_id === null ? null : String(r.study_id),
      gateKind: r.gate_kind === null ? null : String(r.gate_kind),
      accessionNo: r.accession_no === null ? null : String(r.accession_no),
      studyTypeCode: r.study_type_code === null ? null : String(r.study_type_code),
    })),
    billDecisions: await openBillDecisionRows(db, now),
  };
}

export type BillDecisionRow = {
  billDecisionId: string; kind: string; studyId: string; accessionNo: string; studyTypeCode: string;
  raisedAt: string; ageMin: number; listPricePaise: number | null;
};

async function openBillDecisionRows(db: Db, now: Date): Promise<BillDecisionRow[]> {
  const prices = new Map((await listPriceList(db, now)).map((p) => [p.serviceId, p.pricePaise] as const));
  return (await rowsOf(db, sql`
    select b.id, b.kind, b.raised_at, s.id as study_id, s.accession_no, s.study_type_code, s.service_id
      from imaging_bill_decisions b join imaging_studies s on s.id = b.study_id
     where b.resolved_at is null order by b.raised_at
  `)).map((r) => ({
    billDecisionId: String(r.id), kind: String(r.kind), studyId: String(r.study_id), accessionNo: String(r.accession_no),
    studyTypeCode: String(r.study_type_code), raisedAt: asDate(r.raised_at).toISOString(),
    ageMin: minsBetween(asDate(r.raised_at), now), listPricePaise: prices.get(String(r.service_id)) ?? null,
  }));
}

/* ═══════════════════════════════ quality (NABH imaging indicators) ═══════════════════════════════ */

export type QualityStatus = "ok" | "out" | "not_measured";
export type QualityIndicator = {
  key: "tat_compliance" | "critical_communication" | "repeat_rate" | "amendment_rate" | "contrast_reaction_rate"
    | "peer_review_discrepancy" | "waiting_time";
  unit: "%" | "min";
  /** `≥` — higher is better (compliance); `≤` — lower is better (rates, waits). */
  comparator: "≥" | "≤";
  target: number;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  status: QualityStatus;
  /** Why a value is missing, or what it is computed from. */
  note: string;
  days: { day: string; value: number | null; status: QualityStatus }[];
};

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const judge = (value: number | null, comparator: "≥" | "≤", target: number): QualityStatus =>
  value === null ? "not_measured" : (comparator === "≥" ? value >= target : value <= target) ? "ok" : "out";

type Measure = { value: number | null; numerator: number | null; denominator: number | null };

/**
 * NABH's diagnostic-imaging indicators, each from rows that already exist. A number with no data
 * behind it is `not_measured`, never a zero — a department with no criticals this week has not
 * achieved 100 % read-back, it has had nothing to read back.
 */
export async function supervisorQuality(db: Db, input: { from: string; to: string; now?: Date }): Promise<{
  from: string; to: string; indicators: QualityIndicator[];
}> {
  const { days } = dayRange(input.from, input.to, 92);
  const book = await activeDefinitionRow(db, "critical_categories");
  const windows = book
    ? new Map((parseDefinitionBody("critical_categories", book.body) as CriticalCategoriesBody).categories
      .map((c) => [c.category as string, c.communicate_within_min] as const))
    : null;

  const measure = async (lo: Date, hi: Date): Promise<Record<QualityIndicator["key"], Measure>> => {
    // TAT: images in → first signature, against the class target (RS8a).
    const signed = await rowsOf(db, sql`
      select s.priority, s.bedside_location, s.acquired_at, min(r.signed_at) as first_signed
        from imaging_studies s join imaging_reports r on r.study_id = s.id
       where r.signed_at is not null and s.acquired_at is not null
       group by s.id, s.priority, s.bedside_location, s.acquired_at
      having min(r.signed_at) >= ${lo} and min(r.signed_at) < ${hi}
    `);
    const inTat = signed.filter((r) => minsBetween(asDate(r.acquired_at), asDate(r.first_signed))
      <= TAT_MINUTES[tatClassOf(String(r.priority), r.bedside_location === null ? null : String(r.bedside_location))]).length;

    let critical: Measure = { value: null, numerator: null, denominator: null };
    if (windows !== null) {
      const flagged = await rowsOf(db, sql`
        select f.category, f.created_at, f.acknowledged_at from imaging_critical_findings f
         where f.created_at >= ${lo} and f.created_at < ${hi}
      `);
      const judged = flagged.filter((f) => windows.has(String(f.category)));
      const met = judged.filter((f) => f.acknowledged_at !== null
        && minsBetween(asDate(f.created_at), asDate(f.acknowledged_at)) <= windows.get(String(f.category))!).length;
      critical = { value: pct(met, judged.length), numerator: met, denominator: judged.length };
    }

    const from = istDayString(lo);
    const to = istDayString(new Date(hi.getTime() - 3_600_000));
    const rejects = await roomRejects(db, { from, to });
    const acquired = rejects.rows.reduce((t, r) => t + r.acquired, 0);
    const repeats = rejects.rows.reduce((t, r) => t + r.repeats, 0);

    const amend = (await rowsOf(db, sql`
      select count(*) filter (where r.amendment_reason is not null)::int as amended,
             count(distinct r.study_id)::int as studies
        from imaging_reports r where r.signed_at >= ${lo} and r.signed_at < ${hi}
    `))[0] ?? {};

    const contrast = (await rowsOf(db, sql`
      select (select count(*)::int from imaging_contrast_administrations a where a.given_at >= ${lo} and a.given_at < ${hi}) as given,
             (select count(*)::int from imaging_contrast_reactions x where x.observed_at >= ${lo} and x.observed_at < ${hi}) as reactions
    `))[0] ?? {};

    const waits = (await rowsOf(db, sql`
      select s.checked_in_at, s.acquisition_started_at from imaging_studies s
       where s.acquisition_started_at >= ${lo} and s.acquisition_started_at < ${hi} and s.checked_in_at is not null
    `)).map((r) => minsBetween(asDate(r.checked_in_at), asDate(r.acquisition_started_at)));
    const wait = percentiles(waits);

    return {
      tat_compliance: { value: pct(inTat, signed.length), numerator: inTat, denominator: signed.length },
      critical_communication: critical,
      repeat_rate: { value: pct(repeats, acquired), numerator: repeats, denominator: acquired },
      amendment_rate: { value: pct(Number(amend.amended ?? 0), Number(amend.studies ?? 0)), numerator: Number(amend.amended ?? 0), denominator: Number(amend.studies ?? 0) },
      contrast_reaction_rate: { value: pct(Number(contrast.reactions ?? 0), Number(contrast.given ?? 0)), numerator: Number(contrast.reactions ?? 0), denominator: Number(contrast.given ?? 0) },
      peer_review_discrepancy: { value: null, numerator: null, denominator: null },
      waiting_time: { value: wait.medianMin, numerator: null, denominator: wait.n },
    };
  };

  const SPEC: { key: QualityIndicator["key"]; unit: "%" | "min"; comparator: "≥" | "≤"; target: number; note: string }[] = [
    { key: "tat_compliance", unit: "%", comparator: "≥", target: 90, note: "images in → first signature within the class target (STAT 30 min, ER 60, IPD 6 h, OPD 24 h)" },
    { key: "critical_communication", unit: "%", comparator: "≥", target: 100, note: windows === null ? "no critical_categories book is active — the windows are the book's to set" : "critical findings read back within their tier's window" },
    { key: "repeat_rate", unit: "%", comparator: "≤", target: 3, note: "in-room repeats ÷ studies acquired (the Rejects log)" },
    { key: "amendment_rate", unit: "%", comparator: "≤", target: 2, note: "amended versions ÷ studies signed" },
    { key: "contrast_reaction_rate", unit: "%", comparator: "≤", target: 1, note: "reactions recorded ÷ contrast injections recorded" },
    { key: "peer_review_discrepancy", unit: "%", comparator: "≤", target: 2, note: "not measured yet — peer review arrives with RS8c" },
    { key: "waiting_time", unit: "min", comparator: "≤", target: 30, note: "median minutes from check-in to the scan starting" },
  ];

  const total = await measure(istStart(days[0]!), new Date(istStart(days[days.length - 1]!).getTime() + 86_400_000));
  const perDay: Record<string, Record<QualityIndicator["key"], Measure>> = {};
  for (const d of days) perDay[d] = await measure(istStart(d), new Date(istStart(d).getTime() + 86_400_000));

  return {
    from: input.from, to: input.to,
    indicators: SPEC.map((s) => ({
      ...s,
      ...total[s.key],
      status: judge(total[s.key].value, s.comparator, s.target),
      days: days.map((d) => ({ day: d, value: perDay[d]![s.key].value, status: judge(perDay[d]![s.key].value, s.comparator, s.target) })),
    })),
  };
}

/* ═══════════════════════════════ equipment ═══════════════════════════════ */

export const UPTIME_WINDOW_DAYS = 30;
const OUT_OF_SERVICE = new Set(["down", "maintenance", "qa_blocked"]);

export async function supervisorEquipment(db: Db, now: Date = new Date()): Promise<{
  machines: (FloorRoom & { uptimePct: number | null; booked: number; lastChange: { to: string; at: string; reason: string | null } | null })[];
  qa: { deviceCode: string; qaType: string; dueOn: string; state: string; daysOverdue: number }[];
  radiationSafety: { red: number; amber: number };
  tickets: { store: false; note: string };
}> {
  const floor = await supervisorFloor(db, now);
  const lo = new Date(now.getTime() - UPTIME_WINDOW_DAYS * 86_400_000);
  const history = await rowsOf(db, sql`
    select h.resource_id, h.to_status, h.at, h.reason from resource_status_history h
     where h.resource_id in (${floor.rooms.length === 0 ? sql`null` : sql.join(floor.rooms.map((r) => sql`${r.deviceId}`), sql`, `)})
     order by h.resource_id, h.seq
  `);
  const machines = floor.rooms.map((room) => {
    const mine = history.filter((h) => String(h.resource_id) === room.deviceId);
    // Walk the status history across the window: out-of-service minutes ÷ window minutes.
    let status: string | null = null;
    let cursor = lo;
    let outMin = 0;
    let seen = false;
    for (const h of mine) {
      const at = asDate(h.at);
      if (at > lo) {
        if (status !== null && OUT_OF_SERVICE.has(status)) outMin += minsBetween(cursor < lo ? lo : cursor, at);
        cursor = at;
        seen = true;
      }
      status = String(h.to_status);
      if (at <= lo) cursor = lo;
    }
    if (status !== null && OUT_OF_SERVICE.has(status)) outMin += minsBetween(cursor, now);
    const windowMin = minsBetween(lo, now);
    const last = mine[mine.length - 1];
    return {
      ...room,
      uptimePct: status === null && !seen ? null : Math.round((1 - outMin / windowMin) * 1000) / 10,
      booked: floor.licenceGaps.find((g) => g.deviceId === room.deviceId)?.booked ?? room.queue,
      lastChange: last ? { to: String(last.to_status), at: asDate(last.at).toISOString(), reason: last.reason === null ? null : String(last.reason) } : null,
    };
  });
  const qa = (await qaDueList(db, { onDate: floor.day }))
    .filter((q) => q.state !== "ok")
    .map((q) => ({ deviceCode: q.deviceCode, qaType: q.qaType, dueOn: q.dueOn, state: q.state, daysOverdue: q.daysOverdue }));
  let red = 0; let amber = 0;
  try {
    // The RSO's one list; the pregnancy rows stay the RSO's (RS11 DECIDED), so they are not counted here.
    for (const a of await attentionList(db, { type: "system", id: "radiology-hod" }, { now })) {
      if (a.view === "pregnancy") continue;
      if (a.severity === "red") red += 1; else amber += 1;
    }
  } catch { /* the RSO's registers are empty on a fresh database */ }
  return {
    machines, qa, radiationSafety: { red, amber },
    tickets: {
      store: false,
      note: "There is no service-ticket store: breakdowns are recorded as the machine's status with a reason "
        + "(Downtime). Tickets, contracts, preventive maintenance and helium belong to the biomedical plan.",
    },
  };
}

/* ═══════════════════════════════ roster ═══════════════════════════════ */

export const RADIOLOGY_ROSTER_ROLES = [
  "radiologist", "radiology_resident", "radiographer", "radiology_nurse", "radiology_receptionist", "radiation_safety_officer",
] as const;

export async function supervisorRoster(db: Db, now: Date = new Date()): Promise<{
  resolverEnabled: boolean;
  department: { code: string; name: string } | null;
  source: string;
  positions: { positionKey: string; people: { userId: string; name: string }[] }[];
  roles: { roleKey: string; people: { userId: string; name: string }[] }[];
  note: string;
}> {
  const dept = await orgDepartmentByCode(db, "RAD");
  const names = async (ids: string[]): Promise<{ userId: string; name: string }[]> => {
    if (ids.length === 0) return [];
    const rows = await rowsOf(db, sql`select id, full_name from users where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) order by full_name`);
    return rows.map((r) => ({ userId: String(r.id), name: String(r.full_name) }));
  };
  let source = "static";
  const positions: { positionKey: string; people: { userId: string; name: string }[] }[] = [];
  if (dept) {
    const on = await onDutyNow(db, dept.id, now);
    source = on.source;
    for (const p of on.positions) positions.push({ positionKey: p.positionKey, people: await names(p.userIds) });
  }
  const roles: { roleKey: string; people: { userId: string; name: string }[] }[] = [];
  for (const roleKey of RADIOLOGY_ROSTER_ROLES) {
    const ids = await withTx(db, (tx) => usersHoldingRole(tx, roleKey));
    roles.push({ roleKey, people: await names(ids) });
  }
  return {
    resolverEnabled: resolverEnabled(), department: dept ? { code: dept.code, name: dept.name } : null, source, positions, roles,
    note: "The roster has one imaging position (radiologist on call) and no technologist, nurse or desk position, "
      + "and no room on an assignment — so who is in which room is not something it can say yet. "
      + "The role lists are everyone who holds the role, not who is on.",
  };
}

/* ═══════════════════════════════ money ═══════════════════════════════ */

export async function supervisorMoney(db: Db, input: { day?: string; now?: Date } = {}): Promise<{
  day: string;
  billed: { modality: string; source: NorthStarSource; studies: number; netPaise: number }[];
  billedTotal: { studies: number; netPaise: number };
  monthToDate: { modality: string; studies: number; netPaise: number }[];
  billDecisions: BillDecisionRow[];
  leakagePaise: number;
}> {
  const now = input.now ?? new Date();
  const day = input.day ?? istDayString(now);
  if (!DAY_RE.test(day)) throw new RadiologyError("invalid_date", "day is a calendar day, YYYY-MM-DD");
  const monthStart = `${day.slice(0, 8)}01`;
  let modalityOf: (code: string) => string = () => "other";
  try {
    const types = await activeStudyTypes(db);
    const by = new Map(types.map((t) => [t.code, t.modality as string]));
    modalityOf = (code) => by.get(code) ?? "other";
  } catch { /* no active book */ }
  const lines = await rowsOf(db, sql`
    select s.study_type_code, s.encounter_no, s.bedside_location, s.priority, o.authority, i.service_day, l.net_paise
      from imaging_studies s
      join invoice_lines l on l.id = s.invoice_line_id
      join invoices i on i.id = l.invoice_id
      join orders o on o.id = s.order_id
     where i.service_day >= ${monthStart} and i.service_day <= ${day}
  `);
  const billed = new Map<string, { modality: string; source: NorthStarSource; studies: number; netPaise: number }>();
  const mtd = new Map<string, { modality: string; studies: number; netPaise: number }>();
  for (const l of lines) {
    const modality = modalityOf(String(l.study_type_code));
    const net = Number(l.net_paise);
    const m = mtd.get(modality) ?? { modality, studies: 0, netPaise: 0 };
    m.studies += 1; m.netPaise += net; mtd.set(modality, m);
    if (String(l.service_day) !== day) continue;
    const source = sourceOf({
      authority: String(l.authority), encounterNo: String(l.encounter_no),
      bedsideLocation: l.bedside_location === null ? null : String(l.bedside_location), priority: String(l.priority),
    });
    const key = `${modality}|${source}`;
    const b = billed.get(key) ?? { modality, source, studies: 0, netPaise: 0 };
    b.studies += 1; b.netPaise += net; billed.set(key, b);
  }
  const billDecisions = await openBillDecisionRows(db, now);
  const rows = [...billed.values()].sort((a, b) => a.modality.localeCompare(b.modality) || a.source.localeCompare(b.source));
  return {
    day, billed: rows,
    billedTotal: { studies: rows.reduce((t, r) => t + r.studies, 0), netPaise: rows.reduce((t, r) => t + r.netPaise, 0) },
    monthToDate: [...mtd.values()].sort((a, b) => b.netPaise - a.netPaise),
    billDecisions,
    leakagePaise: billDecisions.filter((b) => b.kind === "acquired_unbilled").reduce((t, b) => t + (b.listPricePaise ?? 0), 0),
  };
}

/* ═══════════════════════════════ access log ═══════════════════════════════ */

export const ACCESS_LOG_SURFACES = [
  "imaging.worklist", "imaging.study", "imaging.report", "imaging.patient_reports", "pcpndt.form_f",
  "aerb.dose_register", "aerb.incident_register",
] as const;
export const ACCESS_LOG_LIMIT = 300;
/** The reason this read writes on its own PHI rows — and the marker that keeps the HOD's review out of the list it reviews. */
export const ACCESS_LOG_REVIEW_REASON = "HOD access-log review";

export type AccessLogRow = {
  at: string;
  who: string;
  whoName: string;
  roles: string[];
  kind: "images" | "record";
  /** `images` via the viewer, or the PHI surface read. */
  what: string;
  patientUhid: string;
  patientName: string;
  accessionNo: string | null;
  context: string | null;
  reason: string | null;
  sealed: boolean;
  breakGlass: boolean;
};

export async function supervisorAccessLog(db: Db, actor: Actor, input: { from: string; to: string; now?: Date }): Promise<{
  from: string; to: string; rows: AccessLogRow[]; truncated: boolean;
  counts: { openings: number; images: number; breakGlass: number; noCareContext: number };
}> {
  const { lo, hi } = dayRange(input.from, input.to, 31);
  const images = await rowsOf(db, sql`
    select v.viewed_at as at, v.viewer_id as who, v.via, s.accession_no, s.patient_id
      from imaging_image_views v join imaging_studies s on s.id = v.study_id
     where v.viewed_at >= ${lo} and v.viewed_at < ${hi}
     order by v.viewed_at desc limit ${ACCESS_LOG_LIMIT + 1}
  `);
  const records = await rowsOf(db, sql`
    select p.at, p.actor_id as who, p.surface, p.patient_id, p.context, p.reason, p.sealed
      from phi_access_log p
     where p.at >= ${lo} and p.at < ${hi}
       and p.surface in (${sql.join(ACCESS_LOG_SURFACES.map((s) => sql`${s}`), sql`, `)})
       and not (p.actor_id = ${actor.id} and p.reason = ${ACCESS_LOG_REVIEW_REASON})
     order by p.at desc limit ${ACCESS_LOG_LIMIT + 1}
  `);
  type Merged = { at: Date; who: string; kind: "images" | "record"; what: string; patientId: string; accessionNo: string | null; context: string | null; reason: string | null; sealed: boolean };
  const merged: Merged[] = [
    ...images.map((r): Merged => ({
      at: asDate(r.at), who: String(r.who), kind: "images", what: `images (${String(r.via)})`, patientId: String(r.patient_id),
      accessionNo: String(r.accession_no), context: null, reason: null, sealed: false,
    })),
    ...records.map((r): Merged => ({
      at: asDate(r.at), who: String(r.who), kind: "record", what: String(r.surface), patientId: String(r.patient_id),
      accessionNo: null, context: r.context === null ? null : String(r.context), reason: r.reason === null ? null : String(r.reason),
      sealed: r.sealed === true,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const truncated = merged.length > ACCESS_LOG_LIMIT;
  const kept = merged.slice(0, ACCESS_LOG_LIMIT);

  const who = [...new Set(kept.map((k) => k.who))];
  const pts = [...new Set(kept.map((k) => k.patientId))];
  const people = who.length === 0 ? [] : await rowsOf(db, sql`
    select u.id, u.full_name,
           array(select distinct ra.role_key from role_assignments ra where ra.user_id = u.id order by 1) as roles
      from users u where u.id in (${sql.join(who.map((w) => sql`${w}`), sql`, `)})
  `);
  const personOf = new Map(people.map((p) => [String(p.id), { name: String(p.full_name), roles: (p.roles as string[]) ?? [] }] as const));
  const patientRows = pts.length === 0 ? [] : await rowsOf(db, sql`
    select id, uhid, name, alias, is_confidential from patients where id in (${sql.join(pts.map((p) => sql`${p}`), sql`, `)})
  `);
  const clearance = await clearanceOf(db, actor);
  const patientOf = new Map(patientRows.map((p) => [String(p.id), {
    uhid: String(p.uhid),
    name: displayName({ name: String(p.name), alias: p.alias === null ? null : String(p.alias), isConfidential: p.is_confidential === true }, clearance.canSeeConfidential),
  }] as const));
  const grants = who.length === 0 ? [] : await rowsOf(db, sql`
    select user_id, patient_id, created_at, expires_at from break_glass_grants
     where user_id in (${sql.join(who.map((w) => sql`${w}`), sql`, `)}) and created_at < ${hi} and expires_at > ${lo}
  `);
  const underGrant = (m: Merged): boolean => grants.some((g) => String(g.user_id) === m.who
    && (g.patient_id === null || String(g.patient_id) === m.patientId)
    && asDate(g.created_at) <= m.at && m.at <= asDate(g.expires_at));

  const rows: AccessLogRow[] = kept.map((m) => ({
    at: m.at.toISOString(), who: m.who, whoName: personOf.get(m.who)?.name ?? m.who, roles: personOf.get(m.who)?.roles ?? [],
    kind: m.kind, what: m.what, patientUhid: patientOf.get(m.patientId)?.uhid ?? "—",
    patientName: patientOf.get(m.patientId)?.name ?? "—", accessionNo: m.accessionNo, context: m.context,
    reason: m.reason, sealed: m.sealed, breakGlass: underGrant(m),
  }));

  for (const patientId of pts) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason: ACCESS_LOG_REVIEW_REASON });
  }
  return {
    from: input.from, to: input.to, rows, truncated,
    counts: {
      openings: rows.length, images: rows.filter((r) => r.kind === "images").length,
      breakGlass: rows.filter((r) => r.breakGlass).length, noCareContext: rows.filter((r) => r.context === "none").length,
    },
  };
}
