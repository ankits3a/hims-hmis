import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { recordPhiAccessMany } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import { events } from "../../kernel/db/schema/events";
import { patients } from "../../kernel/db/schema/patients";
import { rolePermissions, roleAssignments, users } from "../../kernel/db/schema/auth";
import {
  IMAGING_AUTOMATION_KINDS, imagingAutomationRuns, imagingAutomationSettings, imagingFollowups, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { displayName } from "../patients";
import { AUTOMATION_ACTOR } from "./automation-actor";
import { RadiologyError } from "./errors";
import { imagingAutomationSwitched, imagingStudyScheduled } from "./events";
import { NO_SHOW_REBOOK_DAYS } from "./money";
import { clearanceOf } from "./read";
import { APPOINTMENT_MESSAGE_REF, markNoShow } from "./schedule";
import type { ImagingAutomationKind } from "../../kernel/db/schema/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #1085 (IM6c) — THE IMAGING MORNING SWEEP: NO-SHOWS, PATIENT REMINDERS, AND THE SWITCHES ═══
 *
 * It rides the existing 08:00 IST radiology job (`kernel/worker/jobs.ts`, the Watchman's) — DECIDED, no
 * new worker job: each new job is a census sweep, and all of these are once-a-morning facts.
 *
 * Every automated act is written by `AUTOMATION_ACTOR`, appends the act's own normal event (a no-show is
 * `imaging.booking_changed` through the desk's own `markNoShow`; nothing here writes a study's status by
 * hand) and leaves ONE `imaging_automation_runs` row per automation per IST day. A second run on the same
 * day inserts nothing and does nothing: the row is taken FIRST, in the run's own transaction, so a
 * concurrent second worker blocks on the unique index and then finds it taken. A run whose work throws
 * rolls its row back with it, so the next run tries again.
 *
 * **The switches** (`imaging_automation_settings`): a holder of `radiology.definitions.manage` turns one
 * off or on with a reason (`imaging.automation_switched`). No row = the default: on, except
 * `patient_reminders`, which stays OFF until the WhatsApp and SMS templates are approved (ruling 0098 §2).
 * An automation that is off writes no run row — it did nothing that day.
 */

export const AUTOMATION_DEFAULTS: Readonly<Record<ImagingAutomationKind, boolean>> = {
  no_show_sweep: true,
  patient_reminders: false,
  hod_digest: true,
  register_completeness: true,
};

/** The reason the sweep and the desk's one-tap no-show both write for a patient who never came. */
export const NO_SHOW_REASON = "not arrived";
/** DECIDED: a slot booked at least this many IST days before its day gets a reminder the day before. */
export const REMINDER_MIN_DAYS_AHEAD = 2;
/** How many rows one run will touch. A sweep that cannot finish is a sweep that never runs. */
const SWEEP_LIMIT = 500;

/* ═══════════════════════════════ IST days ═══════════════════════════════ */

export const istStart = (day: string): Date => new Date(`${day}T00:00:00.000+05:30`);
export function addIstDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/* ═══════════════════════════════ the switches ═══════════════════════════════ */

export function isAutomationKind(kind: string): kind is ImagingAutomationKind {
  return (IMAGING_AUTOMATION_KINDS as readonly string[]).includes(kind);
}

export async function automationEnabled(exec: Db | Tx, kind: ImagingAutomationKind): Promise<boolean> {
  const row = (await (exec as Db).select({ enabled: imagingAutomationSettings.enabled }).from(imagingAutomationSettings)
    .where(eq(imagingAutomationSettings.kind, kind)))[0];
  return row?.enabled ?? AUTOMATION_DEFAULTS[kind];
}

export type AutomationSetting = {
  kind: ImagingAutomationKind;
  enabled: boolean;
  /** True when no one has switched it: the default holds. */
  isDefault: boolean;
  reason: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string | null;
  lastRun: { day: string; ranAt: string; counts: Record<string, unknown> } | null;
};

/** All four, in a fixed order, with who last switched each and its newest run. */
export async function automationSettings(db: Db): Promise<AutomationSetting[]> {
  const rows = await db.select({ s: imagingAutomationSettings, name: users.fullName }).from(imagingAutomationSettings)
    .leftJoin(users, eq(users.id, imagingAutomationSettings.changedBy));
  const out: AutomationSetting[] = [];
  for (const kind of IMAGING_AUTOMATION_KINDS) {
    const r = rows.find((x) => x.s.kind === kind);
    const run = (await db.select().from(imagingAutomationRuns).where(eq(imagingAutomationRuns.kind, kind))
      .orderBy(desc(imagingAutomationRuns.day)).limit(1))[0];
    out.push({
      kind, enabled: r?.s.enabled ?? AUTOMATION_DEFAULTS[kind], isDefault: r === undefined,
      reason: r?.s.reason ?? null, changedBy: r?.s.changedBy ?? null, changedByName: r?.name ?? null,
      changedAt: r?.s.changedAt.toISOString() ?? null,
      lastRun: run === undefined ? null : { day: run.day, ranAt: run.ranAt.toISOString(), counts: run.counts as Record<string, unknown> },
    });
  }
  return out;
}

/**
 * The HOD switches one automation off or on, with a reason. The route holds `radiology.definitions.manage`;
 * this holds the rest: a person (never the sweep itself), a known automation, a reason. A switch that
 * changes nothing writes nothing.
 */
export async function switchAutomation(
  tx: Tx, actor: Actor, input: { kind: string; enabled: boolean; reason: string; now?: Date },
): Promise<{ kind: ImagingAutomationKind; enabled: boolean; changed: boolean }> {
  if (actor.type !== "user") throw new RadiologyError("user_actor_required", "an automation is switched by a person");
  if (!isAutomationKind(input.kind)) {
    throw new RadiologyError("evidence_invalid", `there is no imaging automation called "${input.kind}"`, { kind: input.kind });
  }
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new RadiologyError("reason_required", "switching an automation needs a reason — say why", { kind: input.kind });
  }
  const now = input.now ?? new Date();
  const kind = input.kind;
  if ((await automationEnabled(tx, kind)) === input.enabled) return { kind, enabled: input.enabled, changed: false };
  await tx.insert(imagingAutomationSettings)
    .values({ kind, enabled: input.enabled, reason, changedBy: actor.id, changedAt: now })
    .onConflictDoUpdate({
      target: imagingAutomationSettings.kind,
      set: { enabled: input.enabled, reason, changedBy: actor.id, changedAt: now },
    });
  await appendEvent(tx, imagingAutomationSwitched.make({
    actor, occurredAt: now, payload: { kind, enabled: input.enabled, reason },
  }));
  return { kind, enabled: input.enabled, changed: true };
}

/* ═══════════════════════════════ one run a day ═══════════════════════════════ */

export type RunOutcome<T> = { ran: false; runId: null; counts: null } | { ran: true; runId: string; counts: T };

/**
 * Takes the `(kind, day)` row, does the work in the same transaction, stores the counts. The work gets
 * the transaction and the run's id; each item it touches should be its own savepoint so one bad row is
 * counted, not fatal.
 */
export async function runOnce<T extends Record<string, unknown>>(
  db: Db, kind: ImagingAutomationKind, day: string, now: Date, work: (tx: Tx, runId: string) => Promise<T>,
): Promise<RunOutcome<T>> {
  return withTx(db, async (tx) => {
    const runId = newId();
    const won = await tx.insert(imagingAutomationRuns)
      .values({ id: runId, kind, day, counts: {}, ranAt: now })
      .onConflictDoNothing({ target: [imagingAutomationRuns.kind, imagingAutomationRuns.day] })
      .returning({ id: imagingAutomationRuns.id });
    if (won.length === 0) return { ran: false, runId: null, counts: null };
    const counts = await work(tx, runId);
    await tx.update(imagingAutomationRuns).set({ counts }).where(eq(imagingAutomationRuns.id, runId));
    return { ran: true, runId, counts };
  });
}

/** One item, its own savepoint: its value when it committed, `undefined` when it threw (counted, not fatal). */
async function item<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<{ value: T } | undefined> {
  try {
    return { value: await withTx(tx as unknown as Db, fn) };
  } catch {
    return undefined;
  }
}

/* ═══════════════════════════════ no-shows ═══════════════════════════════ */

export type NoShowSweep = { ran: boolean; enabled: boolean; marked: string[]; failed: number };

/**
 * Yesterday's (IST) bookings never checked in become no-shows, "not arrived", through the desk's own
 * `markNoShow` — the workflow edge, the status, `imaging.booking_changed` and the expired booking message
 * all come from there. Only `scheduled` rows: a checked-in patient arrived, and whatever kept them from the
 * machine is the floor's to record. Only YESTERDAY: older stale bookings are the desk's to look at, not a
 * first-morning mass no-show after a deploy or an outage. Same-day release of a slot is out of scope.
 */
export async function sweepNoShows(db: Db, now: Date): Promise<NoShowSweep> {
  if (!(await automationEnabled(db, "no_show_sweep"))) return { ran: false, enabled: false, marked: [], failed: 0 };
  const day = istDayString(now);
  const yesterday = addIstDays(day, -1);
  const marked: string[] = [];
  let failed = 0;
  const run = await runOnce(db, "no_show_sweep", day, now, async (tx) => {
    const due = await (tx as unknown as Db).select({ id: imagingStudies.id }).from(imagingStudies)
      .where(and(
        eq(imagingStudies.status, "scheduled"),
        gte(imagingStudies.scheduledAt, istStart(yesterday)), lt(imagingStudies.scheduledAt, istStart(day)),
      ))
      .orderBy(asc(imagingStudies.scheduledAt)).limit(SWEEP_LIMIT);
    for (const s of due) {
      if (await item(tx, (sp) => markNoShow(sp, AUTOMATION_ACTOR, s.id, NO_SHOW_REASON)) === undefined) failed += 1;
      else marked.push(s.id);
    }
    return { reportDay: yesterday, marked: marked.length, failed };
  });
  return run.ran ? { ran: true, enabled: true, marked, failed } : { ran: false, enabled: true, marked: [], failed: 0 };
}

/* ═══════════════════════════════ reminders ═══════════════════════════════ */

export type ReminderSweep = { ran: boolean; enabled: boolean; appointments: number; followups: number };

/** When the study's CURRENT booking was made: its newest `imaging.study_scheduled`. */
async function bookedAt(exec: Db | Tx, study: { id: string; patientId: string }): Promise<Date | null> {
  const row = (await (exec as Db).select({ at: events.occurredAt }).from(events)
    .where(and(
      eq(events.name, imagingStudyScheduled.name), eq(events.patientId, study.patientId),
      sql`${events.payload}->>'studyId' = ${study.id}`,
    ))
    .orderBy(desc(events.occurredAt)).limit(1))[0];
  return row?.at ?? null;
}

/**
 * Behind the `patient_reminders` switch (OFF by default). One message the day before a slot booked two or
 * more days ahead (`imaging_appointment_reminder`), and one when a follow-up comes due
 * (`imaging_followup_due`). Each is ENQUEUED, never claimed sent, under a dedupe key of its own, so even a
 * second run that got past the run row would queue nothing twice. The words are the templates': the
 * accession and the time, never the study or the finding.
 */
export async function sendPatientReminders(db: Db, now: Date): Promise<ReminderSweep> {
  if (!(await automationEnabled(db, "patient_reminders"))) return { ran: false, enabled: false, appointments: 0, followups: 0 };
  const day = istDayString(now);
  const tomorrow = addIstDays(day, 1);
  const run = await runOnce(db, "patient_reminders", day, now, async (tx) => {
    const slots = await (tx as unknown as Db).select({
      id: imagingStudies.id, patientId: imagingStudies.patientId, accessionNo: imagingStudies.accessionNo,
      scheduledAt: imagingStudies.scheduledAt,
    }).from(imagingStudies)
      .where(and(
        eq(imagingStudies.status, "scheduled"),
        gte(imagingStudies.scheduledAt, istStart(tomorrow)), lt(imagingStudies.scheduledAt, istStart(addIstDays(tomorrow, 1))),
      ))
      .orderBy(asc(imagingStudies.scheduledAt)).limit(SWEEP_LIMIT);
    let appointments = 0;
    let failed = 0;
    for (const s of slots) {
      const booked = await bookedAt(tx, s);
      if (booked === null || s.scheduledAt === null || daysBetween(istDayString(booked), tomorrow) < REMINDER_MIN_DAYS_AHEAD) continue;
      const slotStart = s.scheduledAt.toISOString();
      const queued = await item(tx, (sp) => enqueueNotification(sp, {
        templateKey: "imaging_appointment_reminder",
        params: { accessionNo: s.accessionNo, slotStart },
        dedupeKey: `imaging_appointment_reminder:${s.id}:${slotStart}`,
        occurredAt: now, patientId: s.patientId, refType: APPOINTMENT_MESSAGE_REF, refId: s.id,
      }));
      if (queued === undefined) failed += 1;
      else if (queued.value !== null) appointments += 1;
    }
    const due = await (tx as unknown as Db).select({ id: imagingFollowups.id, patientId: imagingFollowups.patientId, dueOn: imagingFollowups.dueOn })
      .from(imagingFollowups)
      .where(and(eq(imagingFollowups.state, "open"), eq(imagingFollowups.dueOn, day)))
      .orderBy(asc(imagingFollowups.id)).limit(SWEEP_LIMIT);
    let followups = 0;
    for (const f of due) {
      const queued = await item(tx, (sp) => enqueueNotification(sp, {
        templateKey: "imaging_followup_due",
        params: { dueOn: f.dueOn },
        dedupeKey: `imaging_followup_due:${f.id}`,
        occurredAt: now, patientId: f.patientId, refType: "imaging_followup", refId: f.id,
      }));
      if (queued === undefined) failed += 1;
      else if (queued.value !== null) followups += 1;
    }
    return { appointments, followups, failed };
  });
  return run.ran
    ? { ran: true, enabled: true, appointments: run.counts.appointments, followups: run.counts.followups }
    : { ran: false, enabled: true, appointments: 0, followups: 0 };
}

/* ═══════════════════════════════ the desk's rebooking list ═══════════════════════════════ */

export type NoShowToRebook = {
  studyId: string; accessionNo: string; studyTypeCode: string; patientId: string; patientName: string;
  encounterNo: string; missedAt: string;
  /** Ruling 0098 §3 — paid: its invoice is good for a rebooking of the same study until `goodUntil`. */
  paid: boolean; goodUntil: string;
};

/**
 * No-shows of the last 30 days that nobody has booked again — a later study of the same patient and service
 * that is not itself a no-show takes a row off the list. A list read: the worklist's name rule and its PHI
 * row, once per reader, patient and surface per 30 minutes (ruling 0098 §1).
 */
export async function noShowsToRebook(db: Db, actor: Actor, now: Date = new Date()): Promise<NoShowToRebook[]> {
  const clearance = await clearanceOf(db, actor);
  const since = new Date(now.getTime() - NO_SHOW_REBOOK_DAYS * 86_400_000);
  const rows = await db.select({
    s: imagingStudies, name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
  })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .where(and(
      eq(imagingStudies.status, "no_show"), gte(imagingStudies.scheduledAt, since), lt(imagingStudies.scheduledAt, now),
      sql`not exists (select 1 from imaging_studies later
        where later.patient_id = ${imagingStudies.patientId} and later.service_id = ${imagingStudies.serviceId}
          and later.status <> 'no_show' and later.created_at > ${imagingStudies.scheduledAt})`,
    ))
    .orderBy(desc(imagingStudies.scheduledAt)).limit(100);
  await recordPhiAccessMany(db, {
    actor, patientIds: rows.map((r) => r.s.patientId), surface: "imaging.worklist",
    reason: `imaging no-shows to rebook, ${String(rows.length)} rows`, now,
  });
  return rows.map((r) => ({
    studyId: r.s.id, accessionNo: r.s.accessionNo, studyTypeCode: r.s.studyTypeCode, patientId: r.s.patientId,
    patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
    encounterNo: r.s.encounterNo, missedAt: r.s.scheduledAt!.toISOString(), paid: r.s.invoiceLineId !== null,
    goodUntil: new Date(r.s.scheduledAt!.getTime() + NO_SHOW_REBOOK_DAYS * 86_400_000).toISOString(),
  }));
}

/* ═══════════════════════════════ who hears ═══════════════════════════════ */

/** Everyone a role grants `permission` to, at any scope — a bell's list, not an authorisation. */
export async function permissionHolders(exec: Db | Tx, permission: string): Promise<string[]> {
  const rows = await (exec as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .innerJoin(users, and(eq(users.id, roleAssignments.userId), eq(users.active, true)))
    .where(eq(rolePermissions.permission, permission));
  return rows.map((r) => r.userId).sort();
}

/** Active users among `ids`, sorted and distinct. */
export async function activeUsers(exec: Db | Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await (exec as Db).select({ id: users.id }).from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.active, true)));
  return rows.map((r) => r.id).sort();
}
