import { Logger } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import {
  IPD_CARE_CHECK_MINUTES, IPD_RESTRAINT_CHECK_MINUTES, IPD_RESTRAINT_REPRESENTATIVE_HOURS, IPD_RESTRAINT_REVIEW_HOURS,
  IpdEndRestraintInputSchema, IpdOrderRestraintInputSchema, IpdRecordCareCheckInputSchema, IpdRecordRiskScoreInputSchema,
  IpdRecordSafetyEventInputSchema, IpdRestraintCheckInputSchema, IpdRestraintFamilyInputSchema, IpdRestraintRefInputSchema,
  IpdReviewRestraintInputSchema, carePlansFor, newId, safetyThresholdsOf,
} from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  ipdCareChecks, ipdCarePlans, ipdLines, ipdRestraintAlerts, ipdRestraintChecks, ipdRestraints, ipdRiskScores, ipdSafetyEvents,
  opdDepartments, opdDoctors, resources, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { withIdempotency } from "../billing";
import { lockAdmission, provenanceOf, requireIpdPermission } from "./admission-core";
import { admissionPlace } from "./admission-place";
import { IpdError } from "./errors";
import { assignedNurseOf } from "./nurse-ward";
import { IPD_NURSING_STATES, nursingFallback } from "./nursing";
import { IPD_ASSESSMENT_RECORD, IPD_RESTRAINT_ORDER, IPD_WARD_QUALITY } from "./permissions";
import {
  carePlanEnded, carePlanStarted, careChecked, restraintApplied, restraintCheckMissed, restraintChecked, restraintEnded,
  restraintFamilyTold, restraintLapsed, restraintOrdered, restraintReviewed, riskScored, safetyEventRecorded,
} from "./ward-safety-events";
import type { Actor, IpdCarePlanKind, IpdCarePlanView, IpdRestraintRegister, IpdRestraintView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * WM-2 (#983, decisions 0089 / 0091) — WARD SAFETY: the safety round, care plans, restraints and safety events.
 *
 * - THE SAFETY ROUND: the admission assessment (E4.1) is the first Morse / Braden score; `recordRiskScore` is the daily
 *   one. A score at or over the ward's Morse threshold (45) starts a FALL plan, at or under its Braden threshold (12) a
 *   PRESSURE plan (`safetyThresholdsOf` reads the ward's `safetyThresholds` attribute); a later score on the safe side
 *   ends the plan. One live plan per kind (partial unique index).
 * - TIMED CHECKS (DECIDED): the fall bundle every 4 hours, pressure turns every 2. The next check is due one interval
 *   after the later of the plan's start and its last check; past that instant it is OVERDUE and lists on My shift and
 *   the cockpit's "Needs you" until a check is recorded. Nothing is materialised; the read computes it.
 * - RESTRAINT (0089 rule 3, 0091 rule 3): only a doctor orders (`ipd.restraint.order`); a nurse starts an ordered
 *   restraint (`applyRestraint`) — there is no other way to start one. Checks (circulation, skin, hydration, toileting)
 *   are due every 2 hours from the start or the last check; the minute sweep raises ONE alert per missed check (the
 *   bed's assigned nurse and the nursing fallback chain). The order lapses 24 hours after the doctor's last sign (the
 *   order or a "continue" review); a lapsed order takes nothing more — a new order is needed. On a psychiatric ward
 *   (ward department `PSY`) only a psychiatrist (an active doctor-master row in department PSY) orders (MHCA s.97), and
 *   the nominated representative not told within 24 hours shows on the register.
 * - SAFETY EVENTS: falls, pressure injuries, medication errors and line infections, each with present-on-admission;
 *   the quality read counts the rest.
 */

const SWEEP_ACTOR: Actor = { type: "system", id: "ipd-ward-safety-sweep" };
const sweepLog = new Logger("ipd.sweepWardSafety");
type Opts = { now?: Date };
const MIN = 60_000;
const HOUR = 60 * MIN;

function once<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

function requireOnWard(a: AdmissionRow): void {
  if (!(IPD_NURSING_STATES as readonly string[]).includes(a.state)) {
    throw new IpdError("patient_not_on_ward", "the patient is not on a ward bed", { state: a.state });
  }
}

async function wardRowOf(exec: Db | Tx, admissionId: string): Promise<typeof resources.$inferSelect | null> {
  const place = await admissionPlace(exec, admissionId);
  if (place?.wardId == null) return null;
  return (await exec.select().from(resources).where(eq(resources.id, place.wardId)))[0] ?? null;
}

/** Active holders of a role (users still active). */
export async function activeRoleHolders(exec: Db | Tx, role: string): Promise<string[]> {
  const ids = await usersHoldingRole(exec as Tx, role);
  if (ids.length === 0) return [];
  return (await exec.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)))).map((u) => u.id);
}

// ═══════════════════════════════════════════ care plans ═══════════════════════════════════════════

type PlanChange = { kind: IpdCarePlanKind; planId: string; change: "started" | "ended" };

/**
 * Starts the plans a score calls for and ends the ones it no longer does, in the caller's transaction (the admission
 * assessment's and the daily score's). Answers what changed.
 */
export async function syncCarePlansIn(tx: Tx, actor: Actor, a: AdmissionRow, morse: number, braden: number, at: Date): Promise<PlanChange[]> {
  const ward = await wardRowOf(tx, a.id);
  const wanted = new Set(carePlansFor(morse, braden, safetyThresholdsOf(ward?.attributes as { safetyThresholds?: unknown } | undefined)));
  const live = await tx.select().from(ipdCarePlans).where(and(eq(ipdCarePlans.admissionId, a.id), isNull(ipdCarePlans.endedAt)));
  const out: PlanChange[] = [];
  for (const p of live) {
    if (wanted.has(p.kind as IpdCarePlanKind)) continue;
    await tx.update(ipdCarePlans).set({ endedAt: at, endedReason: "score_below_threshold" }).where(eq(ipdCarePlans.id, p.id));
    await appendEvent(tx, carePlanEnded.make({
      payload: { planId: p.id, admissionId: a.id, kind: p.kind as IpdCarePlanKind, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    out.push({ kind: p.kind as IpdCarePlanKind, planId: p.id, change: "ended" });
  }
  for (const kind of wanted) {
    if (live.some((p) => p.kind === kind)) continue;
    const planId = newId();
    const score = kind === "fall" ? morse : braden;
    await tx.insert(ipdCarePlans).values({
      id: planId, admissionId: a.id, patientId: a.patientId, kind, score, intervalMinutes: IPD_CARE_CHECK_MINUTES[kind], startedAt: at, startedBy: actor.id,
    });
    await appendEvent(tx, carePlanStarted.make({
      payload: { planId, admissionId: a.id, kind, score, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    out.push({ kind, planId, change: "started" });
  }
  return out;
}

/** The daily safety round: a Morse and Braden score (append-only); the care plans follow it. */
export async function recordRiskScore(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ scoreId: string; plans: PlanChange[] }> {
  const input = IpdRecordRiskScoreInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "record_risk_score", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireOnWard(a);
    const scoreId = newId();
    await tx.insert(ipdRiskScores).values({ id: scoreId, admissionId: a.id, patientId: a.patientId, morse: input.morse, braden: input.braden, scoredAt: at, scoredBy: actor.id });
    const plans = await syncCarePlansIn(tx, actor, a, input.morse, input.braden, at);
    await appendEvent(tx, riskScored.make({
      payload: {
        scoreId, admissionId: a.id, morse: input.morse, braden: input.braden, plansStarted: plans.filter((p) => p.change === "started").length,
        plansEnded: plans.filter((p) => p.change === "ended").length, provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { scoreId, plans };
  }), at);
}

/** The live care plans of these admissions, each with its next check and whether it is overdue at `now`. */
export async function carePlansOf(exec: Db | Tx, admissionIds: readonly string[], now: Date): Promise<IpdCarePlanView[]> {
  if (admissionIds.length === 0) return [];
  const plans = await exec.select().from(ipdCarePlans)
    .where(and(inArray(ipdCarePlans.admissionId, [...admissionIds]), isNull(ipdCarePlans.endedAt))).orderBy(asc(ipdCarePlans.startedAt));
  if (plans.length === 0) return [];
  const checks = await exec.select({ planId: ipdCareChecks.planId, doneAt: ipdCareChecks.doneAt }).from(ipdCareChecks)
    .where(inArray(ipdCareChecks.planId, plans.map((p) => p.id))).orderBy(desc(ipdCareChecks.doneAt));
  const last = new Map<string, Date>();
  for (const c of checks) if (!last.has(c.planId)) last.set(c.planId, c.doneAt);
  return plans.map((p) => {
    const lastCheck = last.get(p.id) ?? null;
    const from = lastCheck !== null && lastCheck > p.startedAt ? lastCheck : p.startedAt;
    const nextDueAt = new Date(from.getTime() + p.intervalMinutes * MIN);
    return {
      planId: p.id, admissionId: p.admissionId, kind: p.kind as IpdCarePlanKind, score: p.score, startedAt: p.startedAt.toISOString(),
      nextDueAt: nextDueAt.toISOString(), overdue: now.getTime() > nextDueAt.getTime(), lastCheckAt: lastCheck?.toISOString() ?? null,
    };
  });
}

export async function recordCareCheck(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ checkId: string; nextDueAt: string; late: boolean }> {
  const input = IpdRecordCareCheckInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "record_care_check", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const plan = (await tx.select().from(ipdCarePlans).where(eq(ipdCarePlans.id, input.planId)))[0];
    if (plan === undefined) throw new IpdError("care_plan_not_found", "no care plan has this id", { planId: input.planId });
    const a = await lockAdmission(tx, plan.admissionId);
    if (plan.endedAt !== null) throw new IpdError("care_plan_ended", "this care plan has ended", { planId: plan.id });
    const view = (await carePlansOf(tx, [a.id], at)).find((p) => p.planId === plan.id)!;
    const checkId = newId();
    await tx.insert(ipdCareChecks).values({ id: checkId, planId: plan.id, admissionId: a.id, doneAt: at, doneBy: actor.id, dueAt: new Date(view.nextDueAt), note: input.note ?? null });
    await appendEvent(tx, careChecked.make({
      payload: { checkId, planId: plan.id, admissionId: a.id, late: view.overdue, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { checkId, nextDueAt: new Date(at.getTime() + plan.intervalMinutes * MIN).toISOString(), late: view.overdue };
  }), at);
}

// ═══════════════════════════════════════════ restraint ═══════════════════════════════════════════

type RestraintRow = typeof ipdRestraints.$inferSelect;

async function lockRestraint(tx: Tx, restraintId: string): Promise<{ r: RestraintRow; a: AdmissionRow }> {
  const r0 = (await tx.select().from(ipdRestraints).where(eq(ipdRestraints.id, restraintId)))[0];
  if (r0 === undefined) throw new IpdError("restraint_not_found", "no restraint has this id", { restraintId });
  const a = await lockAdmission(tx, r0.admissionId);
  const r = (await tx.select().from(ipdRestraints).where(eq(ipdRestraints.id, restraintId)).for("update"))[0]!;
  return { r, a };
}

/** Refuses an episode that is over, or whose 24 hours ran out without a doctor's review (lapsed, even before the sweep). */
function requireLive(r: RestraintRow, at: Date, want: "ordered" | "active" | "any"): void {
  if (r.status === "lapsed" || ((r.status === "ordered" || r.status === "active") && at.getTime() >= r.reviewDueAt.getTime())) {
    throw new IpdError("restraint_lapsed", "the restraint order lapsed without a doctor's review — a new order is needed", { restraintId: r.id });
  }
  if (r.status === "ended") throw new IpdError("restraint_not_active", "this restraint has ended", { restraintId: r.id });
  if (want !== "any" && r.status !== want) throw new IpdError("restraint_not_active", `the restraint is ${r.status}`, { restraintId: r.id, status: r.status });
}

async function isPsychiatrist(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.select({ id: opdDoctors.id }).from(opdDoctors).innerJoin(opdDepartments, eq(opdDepartments.id, opdDoctors.departmentId))
    .where(and(eq(opdDoctors.userId, userId), eq(opdDoctors.active, true), eq(opdDepartments.code, "PSY")));
  return rows.length > 0;
}

export async function orderRestraint(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ restraintId: string; reviewDueAt: string; psychiatric: boolean }> {
  const input = IpdOrderRestraintInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_RESTRAINT_ORDER);
  const at = opts.now ?? new Date();
  return once(db, actor, "order_restraint", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireOnWard(a);
    const ward = await wardRowOf(tx, a.id);
    const psychiatric = (ward?.attributes as { department?: unknown } | undefined)?.department === "PSY";
    if (psychiatric && !(await isPsychiatrist(tx, actor.id))) {
      throw new IpdError("restraint_psychiatrist_required", "on a psychiatric ward a psychiatrist orders the restraint (MHCA s.97)");
    }
    const restraintId = newId();
    const reviewDueAt = new Date(at.getTime() + IPD_RESTRAINT_REVIEW_HOURS * HOUR);
    await tx.insert(ipdRestraints).values({
      id: restraintId, admissionId: a.id, patientId: a.patientId, wardId: ward?.id ?? null, kind: input.kind, reason: input.reason, psychiatric,
      status: "ordered", orderedBy: actor.id, orderedAt: at, reviewDueAt,
    });
    await appendEvent(tx, restraintOrdered.make({
      payload: { restraintId, admissionId: a.id, kind: input.kind, psychiatric, reviewDueAt: reviewDueAt.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { restraintId, reviewDueAt: reviewDueAt.toISOString(), psychiatric };
  }), at);
}

/** A nurse starts a restraint a doctor ordered — the only way one starts. */
export async function applyRestraint(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ restraintId: string; nextCheckAt: string }> {
  const input = IpdRestraintRefInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "apply_restraint", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { r, a } = await lockRestraint(tx, input.restraintId);
    requireLive(r, at, "ordered");
    await tx.update(ipdRestraints).set({ status: "active", startedAt: at, startedBy: actor.id }).where(eq(ipdRestraints.id, r.id));
    await appendEvent(tx, restraintApplied.make({ payload: { restraintId: r.id, admissionId: a.id, provenance: provenanceOf(actor) }, actor, correlationId: a.id, patientId: a.patientId, occurredAt: at }));
    return { restraintId: r.id, nextCheckAt: new Date(at.getTime() + IPD_RESTRAINT_CHECK_MINUTES * MIN).toISOString() };
  }), at);
}

async function lastRestraintCheck(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, { at: Date; n: number }>> {
  const out = new Map<string, { at: Date; n: number }>();
  if (ids.length === 0) return out;
  const rows = await exec.select({ id: ipdRestraintChecks.restraintId, at: ipdRestraintChecks.doneAt }).from(ipdRestraintChecks)
    .where(inArray(ipdRestraintChecks.restraintId, [...ids])).orderBy(desc(ipdRestraintChecks.doneAt));
  for (const c of rows) {
    const had = out.get(c.id);
    out.set(c.id, had === undefined ? { at: c.at, n: 1 } : { at: had.at, n: had.n + 1 });
  }
  return out;
}

function nextCheckOf(r: RestraintRow, last: Date | null): Date | null {
  if (r.status !== "active" || r.startedAt === null) return null;
  const from = last !== null && last > r.startedAt ? last : r.startedAt;
  return new Date(from.getTime() + IPD_RESTRAINT_CHECK_MINUTES * MIN);
}

export async function recordRestraintCheck(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ checkId: string; nextCheckAt: string }> {
  const input = IpdRestraintCheckInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "record_restraint_check", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { r } = await lockRestraint(tx, input.restraintId);
    requireLive(r, at, "active");
    const due = nextCheckOf(r, (await lastRestraintCheck(tx, [r.id])).get(r.id)?.at ?? null)!;
    const checkId = newId();
    await tx.insert(ipdRestraintChecks).values({
      id: checkId, restraintId: r.id, doneAt: at, doneBy: actor.id, dueAt: due, circulation: input.circulation, skin: input.skin,
      hydration: input.hydration, toileting: input.toileting, note: input.note ?? null,
    });
    await appendEvent(tx, restraintChecked.make({ payload: { checkId, restraintId: r.id, late: at > due, provenance: provenanceOf(actor) }, actor, correlationId: r.admissionId, occurredAt: at }));
    return { checkId, nextCheckAt: new Date(at.getTime() + IPD_RESTRAINT_CHECK_MINUTES * MIN).toISOString() };
  }), at);
}

/** The doctor's review: `continue` signs again (24 more hours); `remove` ends it. A lapsed order cannot be renewed. */
export async function reviewRestraint(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ restraintId: string; status: string; reviewDueAt: string }> {
  const input = IpdReviewRestraintInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_RESTRAINT_ORDER);
  const at = opts.now ?? new Date();
  return once(db, actor, "review_restraint", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { r, a } = await lockRestraint(tx, input.restraintId);
    requireLive(r, at, "any");
    if (r.psychiatric && !(await isPsychiatrist(tx, actor.id))) {
      throw new IpdError("restraint_psychiatrist_required", "on a psychiatric ward a psychiatrist reviews the restraint (MHCA s.97)");
    }
    const reviewDueAt = input.decision === "continue" ? new Date(at.getTime() + IPD_RESTRAINT_REVIEW_HOURS * HOUR) : r.reviewDueAt;
    const status = input.decision === "continue" ? r.status : "ended";
    await tx.update(ipdRestraints).set({
      reviewDueAt, lastReviewedAt: at, lastReviewedBy: actor.id,
      ...(input.decision === "remove" ? { status: "ended", endedAt: at, endedBy: actor.id, endedReason: input.note ?? "Removed on review" } : {}),
    }).where(eq(ipdRestraints.id, r.id));
    await appendEvent(tx, restraintReviewed.make({
      payload: { restraintId: r.id, decision: input.decision, reviewDueAt: reviewDueAt.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { restraintId: r.id, status, reviewDueAt: reviewDueAt.toISOString() };
  }), at);
}

export async function recordRestraintFamilyTold(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ restraintId: string }> {
  const input = IpdRestraintFamilyInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "restraint_family_told", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { r } = await lockRestraint(tx, input.restraintId);
    await tx.update(ipdRestraints).set({
      familyToldName: input.toldName, familyToldRelation: input.relation, familyToldAt: new Date(input.toldAt), familyToldBy: actor.id,
      nominatedRepresentative: input.nominatedRepresentative === true,
    }).where(eq(ipdRestraints.id, r.id));
    await appendEvent(tx, restraintFamilyTold.make({
      payload: { restraintId: r.id, nominatedRepresentative: input.nominatedRepresentative === true, provenance: provenanceOf(actor) }, actor, correlationId: r.admissionId, occurredAt: at,
    }));
    return { restraintId: r.id };
  }), at);
}

export async function endRestraint(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ restraintId: string; endedAt: string }> {
  const input = IpdEndRestraintInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "end_restraint", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { r, a } = await lockRestraint(tx, input.restraintId);
    if (r.status === "ended") throw new IpdError("restraint_not_active", "this restraint has ended", { restraintId: r.id });
    // A lapsed or ordered-but-never-started restraint can still be taken off (ending is always safe).
    await tx.update(ipdRestraints).set({ status: "ended", endedAt: at, endedBy: actor.id, endedReason: input.reason }).where(eq(ipdRestraints.id, r.id));
    await appendEvent(tx, restraintEnded.make({ payload: { restraintId: r.id, admissionId: a.id, provenance: provenanceOf(actor) }, actor, correlationId: a.id, patientId: a.patientId, occurredAt: at }));
    return { restraintId: r.id, endedAt: at.toISOString() };
  }), at);
}

/** Restraint episodes as the register and the ward screen show them. */
export async function restraintViews(exec: Db | Tx, rows: readonly RestraintRow[], now: Date, names: Map<string, { bedCode: string | null; name: string }>): Promise<IpdRestraintView[]> {
  const ids = rows.map((r) => r.id);
  const last = await lastRestraintCheck(exec, ids);
  const missed = ids.length === 0 ? [] : await exec.select({ id: ipdRestraintAlerts.restraintId }).from(ipdRestraintAlerts)
    .where(and(inArray(ipdRestraintAlerts.restraintId, ids), eq(ipdRestraintAlerts.kind, "check_missed")));
  const doctors = new Map((rows.length === 0 ? [] : await exec.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, [...new Set(rows.map((r) => r.orderedBy))]))).map((u) => [u.id, u.name] as const));
  return rows.map((r) => {
    const l = last.get(r.id);
    const lapsedNow = (r.status === "ordered" || r.status === "active") && now >= r.reviewDueAt;
    const nextCheck = lapsedNow ? null : nextCheckOf(r, l?.at ?? null);
    const repDeadline = r.orderedAt.getTime() + IPD_RESTRAINT_REPRESENTATIVE_HOURS * HOUR;
    const representativeLate = r.psychiatric && now.getTime() > repDeadline
      && (r.familyToldAt === null || !r.nominatedRepresentative || r.familyToldAt.getTime() > repDeadline);
    const who = names.get(r.admissionId) ?? { bedCode: null, name: "" };
    return {
      restraintId: r.id, admissionId: r.admissionId, bedCode: who.bedCode, name: who.name, wardId: r.wardId, kind: r.kind as "physical", reason: r.reason,
      status: (lapsedNow ? "lapsed" : r.status) as "active", psychiatric: r.psychiatric, orderedBy: doctors.get(r.orderedBy) ?? r.orderedBy,
      orderedAt: r.orderedAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, endedAt: r.endedAt?.toISOString() ?? null,
      reviewDueAt: r.reviewDueAt.toISOString(), nextCheckAt: nextCheck?.toISOString() ?? null, checkOverdue: nextCheck !== null && now > nextCheck,
      checks: l?.n ?? 0, missedChecks: missed.filter((m) => m.id === r.id).length,
      familyTold: r.familyToldAt === null ? null : {
        name: r.familyToldName ?? "", relation: r.familyToldRelation ?? "", at: r.familyToldAt.toISOString(), nominatedRepresentative: r.nominatedRepresentative,
      },
      representativeLate,
    };
  });
}

export function monthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(m + 1).padStart(2, "0")}`;
  return { from: new Date(`${month}-01T00:00:00+05:30`), to: new Date(`${next}-01T00:00:00+05:30`) };
}

/** The restraint register for a month (by the order's instant), one ward or all; with the MHCA monthly summary. */
export async function readRestraintRegister(db: Db, actor: Actor, q: { month: string; wardId?: string; now?: Date }): Promise<IpdRestraintRegister> {
  await requireIpdPermission(db, actor, IPD_WARD_QUALITY);
  const now = q.now ?? new Date();
  const { from, to } = monthBounds(q.month);
  const rows = await db.select().from(ipdRestraints).where(and(
    gte(ipdRestraints.orderedAt, from), lt(ipdRestraints.orderedAt, to), ...(q.wardId === undefined ? [] : [eq(ipdRestraints.wardId, q.wardId)]),
  )).orderBy(asc(ipdRestraints.orderedAt), asc(ipdRestraints.id));
  const names = new Map<string, { bedCode: string | null; name: string }>();
  for (const r of rows) {
    if (names.has(r.admissionId)) continue;
    const place = await admissionPlace(db, r.admissionId);
    names.set(r.admissionId, { bedCode: place?.bedCode ?? null, name: "" });
  }
  const episodes = await restraintViews(db, rows, now, names);
  const psych = episodes.filter((e) => e.psychiatric);
  return {
    month: q.month, wardId: q.wardId ?? null, episodes,
    mhca: { episodes: psych.length, lapsed: psych.filter((e) => e.status === "lapsed").length, representativeLate: psych.filter((e) => e.representativeLate).length },
  };
}

// ═══════════════════════════════════════════ safety events ═══════════════════════════════════════════

export async function recordSafetyEvent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ eventId: string }> {
  const input = IpdRecordSafetyEventInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  if ((input.kind === "line_infection") !== (input.lineId !== undefined)) {
    throw new IpdError("safety_event_line_required", "a line infection names its line, and only a line infection does");
  }
  return once(db, actor, "record_safety_event", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (input.lineId !== undefined) {
      const line = (await tx.select({ admissionId: ipdLines.admissionId }).from(ipdLines).where(eq(ipdLines.id, input.lineId)))[0];
      if (line?.admissionId !== a.id) throw new IpdError("line_not_found", "no line of this patient has this id", { lineId: input.lineId });
    }
    const ward = await wardRowOf(tx, a.id);
    const eventId = newId();
    const poa = input.presentOnAdmission === true;
    await tx.insert(ipdSafetyEvents).values({
      id: eventId, admissionId: a.id, patientId: a.patientId, wardId: ward?.id ?? null, kind: input.kind, presentOnAdmission: poa,
      lineId: input.lineId ?? null, occurredAt: new Date(input.occurredAt), recordedBy: actor.id, recordedAt: at, note: input.note ?? null,
    });
    await appendEvent(tx, safetyEventRecorded.make({
      payload: { eventId, admissionId: a.id, wardId: ward?.id ?? null, kind: input.kind, presentOnAdmission: poa, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { eventId };
  }), at);
}

// ═══════════════════════════════════════════ the minute sweep ═══════════════════════════════════════════

export type WardSafetySweepResult = { restraintChecksMissed: number; restraintsLapsed: number; failed: number };

/**
 * The minute job's restraint step (rides the nursing job, like WM-1's), one transaction per episode, failures logged and
 * counted: an order past its 24 hours without a review LAPSES (one event, one notice to the ordering doctor, the bed's
 * nurse and the nursing chain); an active restraint past its check time raises ONE alert for that check.
 */
export async function sweepWardSafety(db: Db, now: Date): Promise<WardSafetySweepResult> {
  const out: WardSafetySweepResult = { restraintChecksMissed: 0, restraintsLapsed: 0, failed: 0 };
  const live = await db.select({ id: ipdRestraints.id }).from(ipdRestraints).where(inArray(ipdRestraints.status, ["ordered", "active"]));
  for (const { id } of live) {
    try {
      await withTx(db, async (tx) => {
        const r = (await tx.select().from(ipdRestraints).where(eq(ipdRestraints.id, id)).for("update"))[0];
        if (r === undefined || (r.status !== "ordered" && r.status !== "active")) return;
        const tell = async (kind: string, title: string, body: string, sourceKey: string, extra: string[] = []): Promise<number> => {
          const nurse = await assignedNurseOf(tx, r.admissionId, now);
          const to = [...new Set([...(nurse === null ? [] : [nurse]), ...extra, ...(await nursingFallback(tx))])];
          let n = 0;
          for (const userId of to) {
            if (await raiseNoticeIn(tx, { userId, kind, title, body, refType: "ipd_restraint", refId: r.id, sourceKey, at: now })) n += 1;
          }
          return n;
        };
        if (now.getTime() >= r.reviewDueAt.getTime()) {
          const inserted = await tx.insert(ipdRestraintAlerts).values({ id: newId(), restraintId: r.id, kind: "lapsed", dueAt: r.reviewDueAt, raisedAt: now })
            .onConflictDoNothing().returning({ id: ipdRestraintAlerts.id });
          await tx.update(ipdRestraints).set({ status: "lapsed", lapsedAt: now }).where(eq(ipdRestraints.id, r.id));
          const notified = inserted.length === 0 ? 0 : await tell("ipd.restraint_lapsed", "Restraint order lapsed", "No doctor's review in 24 h · new order needed", `ipd.restraint_lapsed:${r.id}`, [r.orderedBy]);
          await appendEvent(tx, restraintLapsed.make({ payload: { restraintId: r.id, admissionId: r.admissionId, notified, provenance: "system" }, actor: SWEEP_ACTOR, correlationId: r.admissionId, occurredAt: now }));
          out.restraintsLapsed += 1;
          return;
        }
        const due = nextCheckOf(r, (await lastRestraintCheck(tx, [r.id])).get(r.id)?.at ?? null);
        if (due === null || now.getTime() <= due.getTime()) return;
        const inserted = await tx.insert(ipdRestraintAlerts).values({ id: newId(), restraintId: r.id, kind: "check_missed", dueAt: due, raisedAt: now })
          .onConflictDoNothing().returning({ id: ipdRestraintAlerts.id });
        if (inserted.length === 0) return;
        const notified = await tell("ipd.restraint_check_missed", "Restraint check missed", "Check circulation, skin, fluids, toilet", `ipd.restraint_check_missed:${r.id}:${due.toISOString()}`);
        await tx.update(ipdRestraintAlerts).set({ notified }).where(eq(ipdRestraintAlerts.id, inserted[0]!.id));
        await appendEvent(tx, restraintCheckMissed.make({ payload: { restraintId: r.id, dueAt: due.toISOString(), notified, provenance: "system" }, actor: SWEEP_ACTOR, correlationId: r.admissionId, occurredAt: now }));
        out.restraintChecksMissed += 1;
      });
    } catch (e) {
      out.failed += 1;
      sweepLog.error(`restraint ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
