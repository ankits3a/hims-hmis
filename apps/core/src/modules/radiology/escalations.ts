import { and, eq, inArray, like, sql } from "drizzle-orm";
import { alerts, workflowInstances } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { defineWorkflow } from "../../kernel/workflow/definition";
import { activateDefinition, createDraft, getActiveDefinition } from "../../kernel/workflow/definitions";
import { startInstance, transition } from "../../kernel/workflow/instances";
import { istDayString } from "../../kernel/approvals/cumulative";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { imagingDevices } from "./devices";
import type { CriticalCategoriesBody } from "./definitions";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PLAN 18-S RS10 T2 — THE HOD'S ESCALATIONS, ON THE KERNEL OBLIGATION SPINE (not a second system)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Each cause below is a station's own clock that ran out: a STAT study nobody has read, a patient
 * held at a gate, a red critical nobody read back, a machine out of service, a machine with no
 * licence and a patient booked on it, a bill decision nobody took, an abnormal report the doctor has
 * not opened. RS10 does not invent a queue for them. Each becomes a **kernel workflow instance** of
 * a class-C definition `imaging_esc_<cause>` whose `open` state carries an SLA — a percent ladder
 * and a respond clock — so the kernel does everything a queue needs:
 *
 *   · `runDueTimers` fires the ladder: rung 0 at 1 % (straight away) tells the first role, the last
 *     rung at 100 % tells the medical superintendent; nobody on a rung → the duty managers → the
 *     owners (`resolveRung`, `fallbackExhausted`).
 *   · `kernel/alerts` turns each `escalation.triggered` into a row in front of each person, with the
 *     three acts (`seen`, `owned` with a deadline, `handed_over` to a named person).
 *   · the obligations consumer stops the RESPOND clock on seen/owned — and never the ladder: saying
 *     "mine" is not the work. The HOD's screen reads the same rows.
 *
 * **It resolves when its cause clears.** `sweepImagingEscalations` recomputes the causes every
 * minute, starts an instance for a cause that has none, and moves an instance whose cause is gone to
 * `resolved` (system), which cancels its timers. Close the cause at its seat and the row goes — the
 * board's rule ("Nothing is a second data set").
 *
 * **No patient on any of it** (GC6): the subject is the study / finding / machine / decision id, the
 * alert title is the kernel's structural one, and the HOD's list names the accession and the study
 * type, not the patient; the seat the "do it" link opens shows the patient and logs the read there.
 */

export const IMAGING_ESCALATION_PREFIX = "imaging_esc_";

export const IMAGING_ESCALATION_CAUSES = [
  "stat_unread", "held_study", "red_critical", "machine_down", "licence_gap",
  "bill_decision_stale", "abnormal_unopened", "unmatched_pacs",
] as const;
export type ImagingEscalationCause = (typeof IMAGING_ESCALATION_CAUSES)[number];

/** The thresholds, each the board's number (st-hod `escList`) or the plan's (RS10 core list). */
export const STAT_UNREAD_MINUTES = 15;
export const HELD_STUDY_MINUTES = 30;
export const BILL_DECISION_STALE_HOURS = 24;
export const ABNORMAL_UNOPENED_HOURS = 24;
/** RS12 moved it here: an archive study nobody has attached or rejected for a day. */
export const UNMATCHED_PACS_HOURS = 24;

type CauseSpec = {
  title: string;
  /** The obligation's budget; the last rung fires at 100 %. */
  minutes: number;
  respondMinutes: number;
  ladder: { atPercent: number; toRole: string }[];
  /** The seat that fixes it — the HOD's "do it" link. */
  seat: string;
};

/**
 * DECIDED (standard Indian-corporate-hospital escalation, open to owner objection): the department's
 * radiologists first — the HOD is one of them, and a roster target on `workflow.timer_rung` narrows
 * it to whoever is on — then the medical superintendent when the budget runs out (the NABH escalation
 * policy ends at the administrative head). Money goes to the billing manager first; a licence gap to
 * the RSO first.
 */
export const ESCALATION_SPECS: Record<ImagingEscalationCause, CauseSpec> = {
  stat_unread: {
    title: "STAT study unread past 15 minutes", minutes: 15, respondMinutes: 10,
    ladder: [{ atPercent: 1, toRole: "radiologist" }, { atPercent: 100, toRole: "medical_superintendent" }],
    seat: "/radiology/read",
  },
  held_study: {
    title: "Patient held at a safety gate past 30 minutes", minutes: 30, respondMinutes: 15,
    ladder: [{ atPercent: 1, toRole: "radiologist" }, { atPercent: 100, toRole: "medical_superintendent" }],
    seat: "/radiology/prep",
  },
  red_critical: {
    title: "Red critical not read back in its window", minutes: 15, respondMinutes: 10,
    ladder: [{ atPercent: 1, toRole: "radiologist" }, { atPercent: 100, toRole: "medical_superintendent" }],
    seat: "/radiology/read?view=criticals",
  },
  machine_down: {
    title: "Imaging machine out of service", minutes: 60, respondMinutes: 15,
    ladder: [{ atPercent: 1, toRole: "radiologist" }, { atPercent: 100, toRole: "medical_superintendent" }],
    seat: "/radiology/room?view=downtime",
  },
  licence_gap: {
    title: "Machine without an AERB licence has a patient booked", minutes: 60, respondMinutes: 15,
    ladder: [
      { atPercent: 1, toRole: "radiation_safety_officer" }, { atPercent: 50, toRole: "radiologist" },
      { atPercent: 100, toRole: "medical_superintendent" },
    ],
    seat: "/radiology/radiation-safety",
  },
  bill_decision_stale: {
    title: "Imaging bill decision open more than a day", minutes: 240, respondMinutes: 60,
    ladder: [{ atPercent: 1, toRole: "billing_manager" }, { atPercent: 100, toRole: "radiologist" }],
    seat: "/radiology/room?view=rejects",
  },
  abnormal_unopened: {
    title: "Abnormal report not opened by the doctor in 24 hours", minutes: 60, respondMinutes: 30,
    ladder: [{ atPercent: 1, toRole: "radiologist" }, { atPercent: 100, toRole: "medical_superintendent" }],
    seat: "/radiology/reports",
  },
  // RS12's inbox: the technologist knows who was on the table, so the rooms first, then the HOD.
  unmatched_pacs: {
    title: "Archive study unmatched for more than a day", minutes: 240, respondMinutes: 60,
    ladder: [{ atPercent: 1, toRole: "radiographer" }, { atPercent: 100, toRole: "radiologist" }],
    seat: "/radiology/room?view=unmatched",
  },
};

export function escalationDefKey(cause: ImagingEscalationCause): string {
  return `${IMAGING_ESCALATION_PREFIX}${cause}`;
}

/** One class-C definition per cause — the `approvalFlowDefinition` shape, validated on build. */
export function escalationDefinition(cause: ImagingEscalationCause): WorkflowDefinition {
  const spec = ESCALATION_SPECS[cause];
  return defineWorkflow({
    key: escalationDefKey(cause),
    title: `Imaging escalation — ${spec.title}`,
    changeClass: "C",
    initialState: "open",
    states: [
      {
        name: "open",
        sla: { minutes: spec.minutes, alerting: "active", respondMinutes: spec.respondMinutes, ladder: spec.ladder },
      },
      { name: "resolved", terminal: true },
    ],
    // Only the sweep closes one: the cause clearing IS the resolution (a person acts at the seat).
    transitions: [{ from: "open", to: "resolved", roles: ["system"] }],
  });
}

export const RADIOLOGY_ESCALATION_DEFINITIONS: readonly WorkflowDefinition[] =
  IMAGING_ESCALATION_CAUSES.map(escalationDefinition);

const ESC_DRAFTER: Actor = { type: "system", id: "radiology-escalation-drafter" };

/**
 * Drafts and activates each `imaging_esc_*` definition that has no active version — class C, so
 * zero governance approvals (Plan 03's policy; the approval-flow precedent). Idempotent. `activator`
 * must be a user (`activateDefinition` refuses anything else).
 */
export async function ensureEscalationDefinitions(db: Db, activator: Actor): Promise<string[]> {
  const activated: string[] = [];
  for (const def of RADIOLOGY_ESCALATION_DEFINITIONS) {
    const active = await withTx(db, (tx) => getActiveDefinition(tx, def.key));
    if (active) continue;
    const draft = await createDraft(db, ESC_DRAFTER, def);
    await activateDefinition(db, activator, draft.definitionId);
    activated.push(def.key);
  }
  return activated;
}

/* ─────────────────────────────── the causes ─────────────────────────────── */

export type EscalationCauseRow = {
  cause: ImagingEscalationCause;
  subjectType: "imaging_study" | "imaging_critical_finding" | "resource" | "imaging_bill_decision" | "imaging_report"
    | "imaging_unmatched_study";
  subjectId: string;
  patientId: string | null;
  /** When the clock this cause is about started (images in, check-in, flagged, raised, released). */
  since: Date;
  studyId: string | null;
  accessionNo: string | null;
  studyTypeCode: string | null;
  deviceCode: string | null;
  /** A plain-words line for the HOD: which gate, which machine, which decision. No patient. */
  detail: string;
  /** Held studies: the gate kinds still open (the screen names them in the reader's words). */
  gateKinds: string[] | null;
  /** The seat that closes it, with the thing in hand where the seat takes one. */
  seat: string;
};

type Row = Record<string, unknown>;
const rowsOf = async (exec: Db | Tx, q: ReturnType<typeof sql>): Promise<Row[]> => (await exec.execute(q)).rows as Row[];
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const minutesAgo = (now: Date, m: number): Date => new Date(now.getTime() - m * 60_000);

/** Every cause live at `now`, oldest first. Pure read. */
export async function escalationCauses(db: Db, now: Date = new Date()): Promise<EscalationCauseRow[]> {
  const out: EscalationCauseRow[] = [];

  // ── STAT unread: images in more than 15 minutes ago, no prelim and no signature yet.
  for (const r of await rowsOf(db, sql`
    select s.id, s.patient_id, s.accession_no, s.study_type_code, s.acquired_at
      from imaging_studies s
     where s.priority = 'stat' and s.status = 'acquired' and s.acquired_at is not null
       and s.acquired_at < ${minutesAgo(now, STAT_UNREAD_MINUTES)}
       and not exists (select 1 from imaging_reports r where r.study_id = s.id and r.status in ('prelim', 'signed'))
  `)) {
    out.push({
      cause: "stat_unread", subjectType: "imaging_study", subjectId: String(r.id), patientId: String(r.patient_id),
      since: asDate(r.acquired_at), studyId: String(r.id), accessionNo: String(r.accession_no),
      studyTypeCode: String(r.study_type_code), deviceCode: null,
      gateKinds: null, detail: "images in, no preliminary or signed report", seat: `/radiology/read?study=${String(r.id)}`,
    });
  }

  // ── Held: checked in more than 30 minutes ago with a safety gate still open.
  for (const r of await rowsOf(db, sql`
    select s.id, s.patient_id, s.accession_no, s.study_type_code, s.checked_in_at,
           string_agg(g.kind, ', ' order by g.kind) as kinds
      from imaging_studies s
      join imaging_safety_screenings g on g.study_id = s.id
      join workflow_instances w on w.id = g.workflow_instance_id
     where s.status = 'checked_in' and s.checked_in_at is not null
       and s.checked_in_at < ${minutesAgo(now, HELD_STUDY_MINUTES)}
       and w.current_state = 'open'
     group by s.id, s.patient_id, s.accession_no, s.study_type_code, s.checked_in_at
  `)) {
    out.push({
      cause: "held_study", subjectType: "imaging_study", subjectId: String(r.id), patientId: String(r.patient_id),
      since: asDate(r.checked_in_at), studyId: String(r.id), accessionNo: String(r.accession_no),
      studyTypeCode: String(r.study_type_code), deviceCode: null,
      gateKinds: String(r.kinds).split(", "), detail: `open: ${String(r.kinds)}`, seat: `/radiology/prep?study=${String(r.id)}`,
    });
  }

  // ── Red critical past its window (the governed book's red window; with no book, once the chaser
  //    has marked it overdue — this module never invents a clinical communication standard).
  const book = await activeDefinitionRow(db, "critical_categories");
  const redWindow = book
    ? parseDefinitionBody("critical_categories", book.body) as CriticalCategoriesBody
    : null;
  const redMin = redWindow?.categories.find((c) => c.category === "red")?.communicate_within_min;
  for (const r of await rowsOf(db, sql`
    select f.id, f.created_at, s.id as study_id, s.patient_id, s.accession_no, s.study_type_code
      from imaging_critical_findings f
      join imaging_reports r on r.id = f.report_id
      join imaging_studies s on s.id = r.study_id
     where f.category = 'red' and f.acknowledged_at is null
       and (${redMin === undefined
         ? sql`f.chased_at is not null`
         : sql`f.created_at < ${minutesAgo(now, redMin)}`})
  `)) {
    out.push({
      cause: "red_critical", subjectType: "imaging_critical_finding", subjectId: String(r.id),
      patientId: String(r.patient_id), since: asDate(r.created_at), studyId: String(r.study_id),
      accessionNo: String(r.accession_no), studyTypeCode: String(r.study_type_code), deviceCode: null,
      gateKinds: null,
      detail: redMin === undefined ? "red call not read back" : `red call not read back within ${String(redMin)} min`,
      seat: ESCALATION_SPECS.red_critical.seat,
    });
  }

  // ── Machines: out of service (down / blocked by QA), and unlicensed with a patient booked.
  const today = istDayString(now);
  const devices = await imagingDevices(db, today);
  const statusSince = await rowsOf(db, sql`
    select h.resource_id, max(h.at) as at from resource_status_history h
     where h.to_status in ('down', 'qa_blocked') group by h.resource_id
  `);
  const sinceOf = new Map(statusSince.map((r) => [String(r.resource_id), asDate(r.at)] as const));
  const booked = await rowsOf(db, sql`
    select s.device_resource_id, count(*)::int as n, min(s.created_at) as first_at
      from imaging_studies s
     where s.device_resource_id is not null
       and (s.status in ('checked_in', 'ready')
            or (s.status = 'scheduled' and s.scheduled_at >= ${new Date(`${today}T00:00:00+05:30`)}))
     group by s.device_resource_id
  `);
  const bookedOn = new Map(booked.map((r) => [String(r.device_resource_id), { n: Number(r.n), at: asDate(r.first_at) }] as const));
  for (const d of devices) {
    if (d.status === "down" || d.status === "qa_blocked") {
      const b = bookedOn.get(d.id);
      out.push({
        cause: "machine_down", subjectType: "resource", subjectId: d.id, patientId: null,
        since: sinceOf.get(d.id) ?? now, studyId: null, accessionNo: null, studyTypeCode: null, deviceCode: d.code, gateKinds: null,
        detail: `${d.code} · ${d.name} is ${d.status === "down" ? "down" : "blocked by a failed or overdue QA"}`
          + (b ? `; ${String(b.n)} booked to move` : "; nobody booked on it"),
        seat: ESCALATION_SPECS.machine_down.seat,
      });
    }
    const b = bookedOn.get(d.id);
    if (d.licensedNow === false && b) {
      out.push({
        cause: "licence_gap", subjectType: "resource", subjectId: d.id, patientId: null,
        since: b.at, studyId: null, accessionNo: null, studyTypeCode: null, deviceCode: d.code, gateKinds: null,
        detail: `${d.code} · ${d.name} has no AERB licence covering today and ${String(b.n)} booked`,
        seat: ESCALATION_SPECS.licence_gap.seat,
      });
    }
  }

  // ── Bill decisions nobody took for a day.
  for (const r of await rowsOf(db, sql`
    select b.id, b.kind, b.raised_at, s.id as study_id, s.patient_id, s.accession_no, s.study_type_code
      from imaging_bill_decisions b join imaging_studies s on s.id = b.study_id
     where b.resolved_at is null and b.raised_at < ${minutesAgo(now, BILL_DECISION_STALE_HOURS * 60)}
  `)) {
    out.push({
      cause: "bill_decision_stale", subjectType: "imaging_bill_decision", subjectId: String(r.id),
      patientId: String(r.patient_id), since: asDate(r.raised_at), studyId: String(r.study_id),
      accessionNo: String(r.accession_no), studyTypeCode: String(r.study_type_code), deviceCode: null,
      gateKinds: null, detail: String(r.kind).replaceAll("_", " "), seat: ESCALATION_SPECS.bill_decision_stale.seat,
    });
  }

  // ── An abnormal (critical-category) report released 24 h ago that nobody who treats has opened.
  for (const r of await rowsOf(db, sql`
    select r.id, r.published_at, r.critical_category, s.id as study_id, s.patient_id, s.accession_no, s.study_type_code
      from imaging_reports r join imaging_studies s on s.id = r.study_id
     where r.status = 'signed' and r.critical_category is not null and r.published_at is not null
       and r.published_at < ${minutesAgo(now, ABNORMAL_UNOPENED_HOURS * 60)}
       and not exists (select 1 from imaging_report_delivery d where d.report_id = r.id and d.first_read_at is not null)
  `)) {
    out.push({
      cause: "abnormal_unopened", subjectType: "imaging_report", subjectId: String(r.id),
      patientId: String(r.patient_id), since: asDate(r.published_at), studyId: String(r.study_id),
      accessionNo: String(r.accession_no), studyTypeCode: String(r.study_type_code), deviceCode: null,
      gateKinds: null,
      detail: `${String(r.critical_category)} report released, not opened by the treating doctor`,
      seat: ESCALATION_SPECS.abnormal_unopened.seat,
    });
  }

  // ── An archive study (RS12) nobody has attached or rejected for a day. No patient: the DICOM
  //    identity is exactly what did not match.
  for (const r of await rowsOf(db, sql`
    select u.id, u.received_at, u.accession_number, u.modality, u.reason
      from imaging_unmatched_studies u
     where u.status = 'open' and u.received_at < ${minutesAgo(now, UNMATCHED_PACS_HOURS * 60)}
  `)) {
    out.push({
      cause: "unmatched_pacs", subjectType: "imaging_unmatched_study", subjectId: String(r.id), patientId: null,
      since: asDate(r.received_at), studyId: null, accessionNo: r.accession_number === null ? null : String(r.accession_number),
      studyTypeCode: null, deviceCode: null, gateKinds: null,
      detail: `${r.modality === null ? "archive study" : String(r.modality)} · ${String(r.reason).replaceAll("_", " ")}`,
      seat: ESCALATION_SPECS.unmatched_pacs.seat,
    });
  }

  return out.sort((a, b) => a.since.getTime() - b.since.getTime());
}

/* ─────────────────────────────── the sweep ─────────────────────────────── */

export const ESCALATION_SWEEP_ACTOR: Actor = { type: "system", id: "radiology-escalation-sweep" };

export type OpenEscalation = { instanceId: string; defKey: string; cause: ImagingEscalationCause; subjectId: string; startedAt: Date };

/** Every active `imaging_esc_*` instance. */
export async function openEscalations(exec: Db | Tx): Promise<OpenEscalation[]> {
  const rows = await (exec as Db).select({
    id: workflowInstances.id, defKey: workflowInstances.defKey, subjectId: workflowInstances.subjectId,
    startedAt: workflowInstances.startedAt,
  }).from(workflowInstances).where(and(
    like(workflowInstances.defKey, `${IMAGING_ESCALATION_PREFIX}%`), eq(workflowInstances.status, "active"),
  ));
  return rows.map((r) => ({
    instanceId: r.id, defKey: r.defKey, subjectId: r.subjectId, startedAt: r.startedAt,
    cause: r.defKey.slice(IMAGING_ESCALATION_PREFIX.length) as ImagingEscalationCause,
  }));
}

export type EscalationSweepResult = {
  raised: { cause: ImagingEscalationCause; subjectId: string; instanceId: string }[];
  resolved: { cause: ImagingEscalationCause; subjectId: string; instanceId: string }[];
  /** Causes live now whose definition is not active — the go-live step (runbook) is owed. */
  notActive: ImagingEscalationCause[];
};

const keyOf = (cause: string, subjectId: string): string => `${cause}:${subjectId}`;

/**
 * Raise what is new, resolve what cleared. Serialised by a transaction advisory lock so two worker
 * cycles cannot both raise one cause; each raise / resolve is its own transaction under it.
 */
export async function sweepImagingEscalations(db: Db, now: Date = new Date()): Promise<EscalationSweepResult> {
  const causes = await escalationCauses(db, now);
  const result: EscalationSweepResult = { raised: [], resolved: [], notActive: [] };
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('radiology.escalation_sweep'))`);
    const open = await openEscalations(tx);
    const live = new Set(causes.map((c) => keyOf(c.cause, c.subjectId)));
    const opened = new Set(open.map((o) => keyOf(o.cause, o.subjectId)));

    const inactive = new Set<ImagingEscalationCause>();
    for (const c of causes) {
      if (opened.has(keyOf(c.cause, c.subjectId))) continue;
      if (inactive.has(c.cause)) continue;
      if (!(await getActiveDefinition(tx, escalationDefKey(c.cause)))) { inactive.add(c.cause); continue; }
      const { instanceId } = await startInstance(tx, escalationDefKey(c.cause), {
        type: c.subjectType, id: c.subjectId, ...(c.patientId !== null ? { patientId: c.patientId } : {}),
      });
      opened.add(keyOf(c.cause, c.subjectId));
      result.raised.push({ cause: c.cause, subjectId: c.subjectId, instanceId });
    }
    for (const o of open) {
      if (live.has(keyOf(o.cause, o.subjectId))) continue;
      await transition(tx, o.instanceId, "resolved", ESCALATION_SWEEP_ACTOR, { note: "the cause cleared at its seat" });
      result.resolved.push({ cause: o.cause, subjectId: o.subjectId, instanceId: o.instanceId });
    }
    result.notActive = [...inactive];
  });
  return result;
}

/* ─────────────────────────────── the HOD's list ─────────────────────────────── */

export type EscalationListRow = EscalationCauseRow & {
  title: string;
  ageMin: number;
  /** Null while the sweep has not yet raised it (at most a minute) or its definition is not active. */
  instanceId: string | null;
  raisedAt: Date | null;
  /** The viewer's own alert on this obligation, if the ladder has reached them — the three acts go through it. */
  myAlert: { alertId: string; ackKind: string | null; ownedUntil: Date | null; handedToUserId: string | null } | null;
};

/** Open escalations for the HOD, red causes first then oldest; each with the viewer's alert. */
export async function escalationList(db: Db, actor: Actor, now: Date = new Date()): Promise<{
  rows: EscalationListRow[]; notActive: ImagingEscalationCause[];
}> {
  const causes = await escalationCauses(db, now);
  const open = await openEscalations(db);
  const instanceOf = new Map(open.map((o) => [keyOf(o.cause, o.subjectId), o] as const));
  const ids = open.map((o) => o.instanceId);
  const mine = ids.length === 0 ? [] : await db.select({
    id: alerts.id, refId: alerts.refId, ackKind: alerts.ackKind, ownedUntil: alerts.ownedUntil,
    handedToUserId: alerts.handedToUserId, createdAt: alerts.createdAt,
  }).from(alerts).where(and(
    eq(alerts.userId, actor.id), eq(alerts.refType, "workflow_instance"), inArray(alerts.refId, ids),
  ));
  // The newest alert per obligation is the one that carries the latest act.
  const alertOf = new Map<string, (typeof mine)[number]>();
  for (const a of mine) {
    const prev = alertOf.get(a.refId ?? "");
    if (!prev || a.createdAt > prev.createdAt) alertOf.set(a.refId ?? "", a);
  }
  const notActive: ImagingEscalationCause[] = [];
  for (const cause of IMAGING_ESCALATION_CAUSES) {
    if (causes.some((c) => c.cause === cause) && !(await withTx(db, (tx) => getActiveDefinition(tx, escalationDefKey(cause))))) {
      notActive.push(cause);
    }
  }
  const RED = new Set<ImagingEscalationCause>(["red_critical", "stat_unread", "licence_gap", "machine_down"]);
  const rows = causes.map((c): EscalationListRow => {
    const inst = instanceOf.get(keyOf(c.cause, c.subjectId)) ?? null;
    const a = inst ? alertOf.get(inst.instanceId) : undefined;
    return {
      ...c,
      title: ESCALATION_SPECS[c.cause].title,
      ageMin: Math.max(0, Math.floor((now.getTime() - c.since.getTime()) / 60_000)),
      instanceId: inst?.instanceId ?? null,
      raisedAt: inst?.startedAt ?? null,
      myAlert: a ? { alertId: a.id, ackKind: a.ackKind, ownedUntil: a.ownedUntil, handedToUserId: a.handedToUserId } : null,
    };
  });
  rows.sort((x, y) => (RED.has(x.cause) === RED.has(y.cause) ? x.since.getTime() - y.since.getTime() : RED.has(x.cause) ? -1 : 1));
  return { rows, notActive };
}
