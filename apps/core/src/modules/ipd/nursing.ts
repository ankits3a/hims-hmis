import { Logger } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  IPD_ASSESSMENT_DUE_MINUTES, IPD_EWS_UNACKED_MINUTES, IPD_INTENTS, IPD_LATE_ENTRY_MINUTES, IPD_OFFLINE_QUEUE_MINUTES, IPD_VITALS_LIMITS,
  IpdAcceptShiftHandoverInputSchema, IpdAcknowledgeEwsInputSchema, IpdGiveShiftHandoverInputSchema, IpdIntakeOutputInputSchema,
  IpdNursingNoteInputSchema, ewsBandRank, ewsKindFor, ewsNotifies, ipdIsInFuture, newId, scoreEws,
} from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissions, ipdBedStays, ipdIntakeOutput, ipdNursingAlerts, ipdNursingAssessments, ipdNursingNotes, ipdShiftHandovers,
  ipdVitals, patients, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole, usersHoldingRole } from "../../kernel/workflow/roles";
import { withIdempotency } from "../billing";
import { istMinutesOfInstant, orgDepartmentByCode, whoIsOn } from "../roster";
import { lockAdmission, provenanceOf, requireIpdPermission } from "./admission-core";
import { IPD_ACTOR_ROLE_KEYS } from "./admission-workflow";
import { ageInYears } from "./bed-rules";
import { bedWithWard } from "./beds";
import { IpdError, IpdRefusal } from "./errors";
import { EWS_ACK_KINDS } from "./goals/goal-events";
import {
  assessmentOverdue, ewsAcknowledged, ewsBreached, ewsCleared, intakeOutputRecorded, nursingAssessed, nursingNoteAdded,
  shiftHandoverAccepted, shiftHandoverGiven, vitalsRecorded,
} from "./nursing-events";
import { IPD_ASSESSMENT_RECORD, IPD_EWS_RESPOND, IPD_SHIFT_HANDOVER, IPD_VITALS_RECORD } from "./permissions";
import type {
  Actor, IpdActorKind, IpdEwsBand, IpdEwsKind, IpdEwsScore, IpdEwsValues, IpdIntentName,
} from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E4.1 (#733) — IPD NURSING: the acts (spec SPEC-ipd-core §4.5; plan M4 E4.1; boards C and D1).
 *
 * - `recordNursingAssessment` (§0B `record_nursing_assessment`): once per admission, due within an hour of admission.
 *   Morse, Braden, nutrition, allergies confirmed, home medicines, pain, pressure injuries present on admission, lines
 *   and devices, and the obstetric answer that picks MEOWS.
 * - `recordVitals` (§0B `record_vitals`): append-only; scored at once by the patient's chart (NEWS2 / MEOWS / PEWS,
 *   `ews.ts` in contracts); a value outside physiological limits is refused `value_needs_confirm` until confirmed; a
 *   refused set is recorded as refused (not missing); a set typed 15+ minutes after it was taken is a late entry.
 *   IDEMPOTENT BY THE CLIENT'S KEY twice over: the idempotency ledger answers a retry by the same person, and the
 *   `ipd_vitals.client_key` unique index answers an offline replay that reaches us by any path — one row per set.
 * - EARLY WARNING (§4.5, §4.10 edge 12): ONE ALERT PER BREACH. The first set at or above the notify band (NEWS2 5+ or a
 *   single 3; MEOWS one red or two yellows; PEWS a total of 3+) opens `ipd_nursing_alerts` and tells the duty doctor.
 *   While the breach stands every in-breach set writes its band (it may go DOWN); a set whose band is ABOVE the band
 *   last seen re-raises the same alert and tells the doctor again (so a relapse high → medium → high is told twice); a
 *   set below the band clears it. Only the LATEST set by time taken moves the alert (§4.10 edge 25). `notified_at` is
 *   stamped only when a notice went out; with no doctor to tell, the nursing fallback chain (supervisor → superintendent
 *   → duty manager) is told at once. Only a DOCTOR's acknowledgement stops the 10-minute step to that chain.
 * - `sweepIpdNursing(db, now)` (the minute job): an admission without its assessment one hour after admission raises
 *   ONE alert to the fallback chain (`assessment_overdue`); an alert nobody was reached for is retried; the 10-minute
 *   step above. Each row in its own transaction; a failing row is logged and the loop goes on.
 * - Sets are bounded in time: a future stamp beyond the 2-minute skew is refused; older than 24 h refused
 *   `observation_too_old`; past the 30-minute offline window accepted, marked late with reason `offline`.
 * - The four nursing record tables are APPEND-ONLY in the database (migration triggers).
 * - Intake/output, nursing notes, the shift handover (give → another nurse accepts) and the acknowledgement are module
 *   acts with contracts in `packages/contracts/src/ipd/nursing.ts`.
 *
 * DECIDED (standard Indian corporate-hospital practice; owner rulings are for money, procurement and law):
 * - THE DUTY DOCTOR = the admitting consultant, plus the ward junior resident(s) a PUBLISHED roster has on for the
 *   admission's department now (`roster` `whoIsOn`, position `ward_jr`). A roster answer that is not published (the
 *   static fallback) is NOT used: it is every doctor in the building. Inactive users are never told. The emergency band
 *   (`high`) also tells the nursing fallback chain.
 * - Device readings are refused `device_not_registered`: there is no bedside-monitor registry yet (ICU device feeds
 *   are spec §5 Phase 2).
 * - The I/O day starts 08:00 IST; shifts are 08–14, 14–20, 20–08 IST; night mode is 22:00–06:00 IST.
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

/** The admission states in which the patient is on a ward bed and nursing acts apply. */
export const IPD_NURSING_STATES = ["admitted", "transferring", "fit_declared", "discharging"] as const;
const inNursingState = (s: string): boolean => (IPD_NURSING_STATES as readonly string[]).includes(s);

// The hospital's clock is the kernel's and the roster's (test/ist-clock-parity.test.ts): never a local copy of the offset.
const minutesOfIstDay = (at: Date): number => istMinutesOfInstant(at);
const istMidnightBefore = (at: Date): number => istDayWindow(at).start.getTime();

export type IpdShiftKey = "morning" | "evening" | "night";
/** The nursing shift an instant falls in: 08–14 morning, 14–20 evening, 20–08 night (IST). */
export function shiftOf(at: Date): { key: IpdShiftKey; startsAt: Date; endsAt: Date } {
  const m = minutesOfIstDay(at);
  const day = istMidnightBefore(at);
  const h = (n: number) => new Date(day + n * 3_600_000);
  if (m >= 8 * 60 && m < 14 * 60) return { key: "morning", startsAt: h(8), endsAt: h(14) };
  if (m >= 14 * 60 && m < 20 * 60) return { key: "evening", startsAt: h(14), endsAt: h(20) };
  if (m >= 20 * 60) return { key: "night", startsAt: h(20), endsAt: h(32) };
  return { key: "night", startsAt: h(-4), endsAt: h(8) };
}
/** Ward surfaces switch to night mode 22:00–06:00 IST (spec §0A principle 10). */
export function isNightIst(at: Date): boolean {
  const m = minutesOfIstDay(at);
  return m >= 22 * 60 || m < 6 * 60;
}
/** The start of the 24-hour intake/output day (08:00 IST) that contains `at`. */
export function ioDayStart(at: Date): Date {
  const day = istMidnightBefore(at) + 8 * 3_600_000;
  return new Date(at.getTime() >= day ? day : day - 86_400_000);
}

/** The IST calendar day number of an instant (days since the epoch, IST): day of stay is a difference of two. */
export const istDayIndex = (at: Date): number => Math.round(Date.parse(`${istDayString(at)}T00:00:00Z`) / 86_400_000);
/** "14:05", the hospital's clock. */
export function istClock(at: Date): string {
  const m = minutesOfIstDay(at);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const isLate = (happened: Date, recorded: Date): boolean => recorded.getTime() - happened.getTime() >= IPD_LATE_ENTRY_MINUTES * 60_000;

/** The key for an act that is not a §0B intent: the same ledger, its own route. */
function onceNursing<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

function requireNursingState(a: AdmissionRow): void {
  if (!inNursingState(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
}

// ═══════════════════════════════════════════ which score ═══════════════════════════════════════════

export type ScoreContext = { kind: IpdEwsKind; ageYears: number | null };

/** The chart a patient is scored on now: age (PEWS under 16), the obstetric answer, the department or a labour bed. */
export async function scoreContextOf(db: Db | Tx, a: Pick<AdmissionRow, "id" | "patientId" | "department">, at: Date): Promise<ScoreContext> {
  return (await scoreContextsOf(db, [a], at)).get(a.id)!;
}

/** The same for many admissions in three queries (the station's poll; review: no per-patient lookups). */
export async function scoreContextsOf(
  db: Db | Tx, admissions: readonly Pick<AdmissionRow, "id" | "patientId" | "department">[], at: Date,
): Promise<Map<string, ScoreContext>> {
  const out = new Map<string, ScoreContext>();
  if (admissions.length === 0) return out;
  const ids = admissions.map((a) => a.id);
  const [people, obstetric, stays] = await Promise.all([
    db.select({ id: patients.id, dob: patients.dob, gender: patients.administrativeGender }).from(patients)
      .where(inArray(patients.id, [...new Set(admissions.map((a) => a.patientId))])),
    db.select({ id: ipdNursingAssessments.admissionId, o: ipdNursingAssessments.obstetric }).from(ipdNursingAssessments)
      .where(inArray(ipdNursingAssessments.admissionId, ids)),
    db.select({ id: ipdBedStays.admissionId, c: ipdBedStays.bedClass }).from(ipdBedStays)
      .where(and(inArray(ipdBedStays.admissionId, ids), isNull(ipdBedStays.endedAt))),
  ]);
  const p = new Map(people.map((r) => [r.id, r] as const));
  const ob = new Map(obstetric.map((r) => [r.id, r.o] as const));
  const st = new Map(stays.map((r) => [r.id, r.c] as const));
  for (const a of admissions) {
    const who = p.get(a.patientId);
    const ageYears = ageInYears(who?.dob ?? null, at);
    out.set(a.id, {
      ageYears,
      kind: ewsKindFor({
        ageYears, sex: who?.gender ?? null, obstetric: (ob.get(a.id) ?? null) as "none" | "pregnant" | "postpartum" | null,
        department: a.department, bedClass: st.get(a.id) ?? null,
      }),
    });
  }
  return out;
}

// ═══════════════════════════════════════════ record_nursing_assessment ═══════════════════════════════════════════

export async function recordNursingAssessment(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_nursing_assessment">> {
  const input: Input<"record_nursing_assessment"> = IPD_INTENTS.record_nursing_assessment.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.happenedAt, at)) throw new IpdRefusal("time_in_future");
  return onceNursing(db, actor, "record_nursing_assessment", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireNursingState(a);
    const prior = (await tx.select({ id: ipdNursingAssessments.id }).from(ipdNursingAssessments).where(eq(ipdNursingAssessments.admissionId, a.id)))[0];
    if (prior !== undefined) throw new IpdRefusal("assessment_already_recorded", undefined, { assessmentId: prior.id });
    const happenedAt = new Date(input.happenedAt);
    const lateEntry = isLate(happenedAt, at);
    const assessmentId = newId();
    await tx.insert(ipdNursingAssessments).values({
      id: assessmentId, admissionId: a.id, patientId: a.patientId, happenedAt, recordedAt: at, recordedBy: actor.id,
      source: input.source, lateEntry, morse: input.morse, braden: input.braden, nutrition: input.nutrition,
      allergies: input.allergies, homeMedicines: input.homeMedicines, painScore: input.painScore,
      pressureInjuries: input.pressureInjuriesOnAdmission,
      linesDevices: (input.linesDevices ?? []).map((l) => ({ kind: l.kind, ...(l.site === undefined ? {} : { site: l.site }), ...(l.insertedAt === undefined ? {} : { insertedAt: l.insertedAt }) })),
      obstetric: input.obstetric ?? null,
    });
    // The assessment answers the overdue alert, if the sweep raised one.
    await tx.update(ipdNursingAlerts).set({ clearedAt: at, clearedBy: assessmentId })
      .where(and(eq(ipdNursingAlerts.admissionId, a.id), eq(ipdNursingAlerts.kind, "assessment_overdue"), isNull(ipdNursingAlerts.clearedAt)));
    const ctx = await scoreContextOf(tx, a, at);
    await appendEvent(tx, nursingAssessed.make({
      payload: {
        assessmentId, admissionId: a.id, happenedAt: happenedAt.toISOString(), lateEntry, morse: input.morse, braden: input.braden,
        scoreKind: ctx.kind, provenance: input.source,
      },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    // SEAM (task engine): Morse ≥ 45 / Braden ≤ 12 reassessment tasks wait for a nursing task kind (owed, MAP.md).
    return { assessmentId, lateEntry, tasksRaised: 0 };
  }), at);
}

// ═══════════════════════════════════════════ record_vitals ═══════════════════════════════════════════

type VitalsValues = Input<"record_vitals">["values"];

/** The fields outside physiological limits (the typo guard), and a systolic not above its diastolic. */
export function outOfRange(v: VitalsValues): string[] {
  const out: string[] = [];
  for (const [k, [lo, hi]] of Object.entries(IPD_VITALS_LIMITS) as [keyof typeof IPD_VITALS_LIMITS, readonly [number, number]][]) {
    const x = v[k];
    if (x !== undefined && (x < lo || x > hi)) out.push(k);
  }
  if (v.systolic !== undefined && v.diastolic !== undefined && v.systolic <= v.diastolic) out.push("systolic_not_above_diastolic");
  return out;
}

function ewsValuesOf(v: VitalsValues): IpdEwsValues {
  return {
    temperatureC: v.temperatureC, pulse: v.pulse, respRate: v.respRate, systolic: v.systolic, diastolic: v.diastolic,
    spo2: v.spo2, onOxygen: v.onOxygen, consciousness: v.consciousness, capRefillSec: v.capRefillSec,
  };
}

type VitalsRow = typeof ipdVitals.$inferSelect;
type Raised = { alertRaised: boolean; doctorReached: boolean | null };
const NOTHING_RAISED: Raised = { alertRaised: false, doctorReached: null };
const outputOfRow = (r: VitalsRow, raised: Raised): Output<"record_vitals"> => ({
  vitalsId: r.id,
  score: r.scoreKind === null ? null : { kind: r.scoreKind as IpdEwsKind, value: r.scoreValue!, band: r.scoreBand as IpdEwsBand },
  alertRaised: raised.alertRaised, doctorReached: raised.doctorReached, lateEntry: r.lateEntry,
});

/** What a set raised, read back from the breach event it wrote (a replay answers the first act's truth). */
async function raisedBy(db: Db | Tx, vitalsId: string): Promise<Raised> {
  const rows = (await db.execute(sql`
    select payload from events where name = ${ewsBreached.name} and payload->>'vitalsId' = ${vitalsId}
    order by seq desc limit 1`)).rows as { payload: { notified?: number; doctorReached?: boolean } }[];
  const p = rows[0]?.payload;
  if (p === undefined) return NOTHING_RAISED;
  return { alertRaised: (p.notified ?? 0) > 0, doctorReached: p.doctorReached ?? false };
}

/** Sets older than this are not charted by `record_vitals` (E4.1 review, DECIDED). */
export const IPD_VITALS_MAX_AGE_MS = 24 * 3_600_000;
/** Why a set is late: past the phone's 30-minute queue → `offline`; typed 15+ minutes after → `typed_late`. */
export function lateReasonOf(observedAt: Date, recordedAt: Date): "offline" | "typed_late" | null {
  const ms = recordedAt.getTime() - observedAt.getTime();
  if (ms > IPD_OFFLINE_QUEUE_MINUTES * 60_000) return "offline";
  if (ms >= IPD_LATE_ENTRY_MINUTES * 60_000) return "typed_late";
  return null;
}

export async function recordVitals(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_vitals">> {
  const input: Input<"record_vitals"> = IPD_INTENTS.record_vitals.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_VITALS_RECORD);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.observedAt, at)) throw new IpdRefusal("time_in_future");
  if (at.getTime() - new Date(input.observedAt).getTime() > IPD_VITALS_MAX_AGE_MS) {
    throw new IpdRefusal("observation_too_old", undefined, { observedAt: input.observedAt });
  }
  if (input.source === "device") throw new IpdRefusal("device_not_registered", undefined, { deviceId: input.deviceId ?? null });
  if (input.refused !== true && input.confirmedOutOfRange !== true) {
    const fields = outOfRange(input.values);
    if (fields.length > 0) throw new IpdRefusal("value_needs_confirm", undefined, { fields });
  }
  const clientKey = input.idempotencyKey.toLowerCase();
  return onceIpdVitals(db, actor, input, at, async () => {
    try {
      return await withTx(db, async (tx) => {
        const a = await lockAdmission(tx, input.admissionId);
        const replay = (await tx.select().from(ipdVitals).where(eq(ipdVitals.clientKey, clientKey)))[0];
        if (replay !== undefined) {
          if (replay.admissionId !== a.id) throw new IpdRefusal("state_changed", "This key was used for another admission");
          return outputOfRow(replay, await raisedBy(tx, replay.id));
        }
        requireNursingState(a);
        const observedAt = new Date(input.observedAt);
        const lateReason = lateReasonOf(observedAt, at);
        const ctx = await scoreContextOf(tx, a, observedAt);
        const score = input.refused === true ? null : scoreEws(ctx.kind, ewsValuesOf(input.values), ctx.ageYears);
        const vitalsId = newId();
        const v = input.values;
        const row = (await tx.insert(ipdVitals).values({
          id: vitalsId, admissionId: a.id, patientId: a.patientId, observedAt, recordedAt: at, recordedBy: actor.id,
          source: input.source, deviceId: input.deviceId ?? null, clientKey, lateEntry: lateReason !== null, lateReason,
          refused: input.refused === true, confirmedOutOfRange: input.confirmedOutOfRange === true,
          temperatureC: v.temperatureC ?? null, pulse: v.pulse ?? null, respRate: v.respRate ?? null, systolic: v.systolic ?? null,
          diastolic: v.diastolic ?? null, spo2: v.spo2 ?? null, onOxygen: v.onOxygen ?? null, consciousness: v.consciousness ?? null,
          painScore: v.painScore ?? null, capRefillSec: v.capRefillSec ?? null,
          scoreKind: score?.kind ?? null, scoreValue: score?.value ?? null, scoreBand: score?.band ?? null, scoreComplete: score?.complete ?? null,
        }).returning())[0]!;
        await appendEvent(tx, vitalsRecorded.make({
          payload: {
            vitalsId, admissionId: a.id, observedAt: observedAt.toISOString(), lateEntry: row.lateEntry, lateReason, refused: row.refused,
            score: score === null ? null : { kind: score.kind, value: score.value, band: score.band }, provenance: input.source,
          },
          actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
        }));
        let raised = NOTHING_RAISED;
        if (score !== null && await isLatestSet(tx, a.id, vitalsId, observedAt)) {
          raised = await evaluateEws(tx, actor, a, vitalsId, score, at);
        }
        return outputOfRow(row, raised);
      });
    } catch (e) {
      // Two replays of one offline set racing past the read: the loser answers the winner's row.
      if (isUniqueViolation(e)) {
        const won = (await db.select().from(ipdVitals).where(eq(ipdVitals.clientKey, clientKey)))[0];
        if (won !== undefined) return outputOfRow(won, await raisedBy(db, won.id));
      }
      throw e;
    }
  });
}

function onceIpdVitals<T>(db: Db, actor: Actor, input: Input<"record_vitals">, at: Date, work: () => Promise<T>): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: "ipd:record_vitals", key: input.idempotencyKey.toLowerCase() }, input, work, at);
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.cause?.code ?? err.code) === "23505";
}

/** True when no other scored set of this admission was taken later (ties broken by id). */
async function isLatestSet(tx: Tx, admissionId: string, vitalsId: string, observedAt: Date): Promise<boolean> {
  const later = await tx.select({ id: ipdVitals.id }).from(ipdVitals).where(and(
    eq(ipdVitals.admissionId, admissionId), sql`${ipdVitals.scoreKind} is not null`,
    sql`(${ipdVitals.observedAt}, ${ipdVitals.id}) > (${observedAt.toISOString()}::timestamptz, ${vitalsId})`,
  )).limit(1);
  return later.length === 0;
}

const KIND_WORD: Record<IpdEwsKind, string> = { news2: "NEWS2", meows: "MEOWS", pews: "PEWS" };
const BAND_WORD: Record<IpdEwsBand, string> = { low: "low", low_medium: "single red", medium: "urgent review", high: "EMERGENCY" };

async function bedCodeOf(tx: Tx, admissionId: string): Promise<{ code: string | null; wardId: string | null }> {
  const stay = (await tx.select({ bedId: ipdBedStays.bedId }).from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0];
  if (stay === undefined) return { code: null, wardId: null };
  const b = await bedWithWard(tx, stay.bedId);
  return { code: b.code, wardId: b.wardId };
}

async function activeUserIds(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return (await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, [...ids]), eq(users.active, true)))).map((u) => u.id);
}

/** DECIDED: the consultant, plus the ward junior resident a PUBLISHED roster has on for the department now. Active users only. */
export async function dutyDoctorsFor(tx: Tx, a: Pick<AdmissionRow, "consultantId" | "department">, at: Date): Promise<string[]> {
  const out = new Set([a.consultantId]);
  if (a.department !== null) {
    const dept = await orgDepartmentByCode(tx, a.department);
    if (dept !== undefined) {
      const on = await whoIsOn(tx, { position: "ward_jr", departmentId: dept.id }, at);
      if (on.source === "published") for (const u of on.userIds) out.add(u);
    }
  }
  return (await activeUserIds(tx, [...out])).sort();
}

/** Active holders of a role. */
async function activeHolders(tx: Tx, role: string): Promise<string[]> {
  return (await activeUserIds(tx, [...new Set(await usersHoldingRole(tx, role))])).sort();
}

/**
 * THE NURSING FALLBACK CHAIN (E4.1 review, DECIDED): the first of nursing supervisor → nursing superintendent → duty
 * manager that has an ACTIVE holder. Used when nobody else can be told (no doctor; the 10-minute step; an overdue
 * assessment). Empty only when the hospital has none of the three — then the sweep retries next minute.
 */
export async function nursingFallback(tx: Tx): Promise<string[]> {
  for (const role of ["nursing_supervisor", "nursing_superintendent", "duty_manager"]) {
    const ids = await activeHolders(tx, role);
    if (ids.length > 0) return ids;
  }
  return [];
}

/**
 * The words a notice may carry about where the patient is: bed and IP number — or, for a SEALED patient
 * (`patients.sensitive_context`), "Sealed patient" and nothing else (no bed, no admission number; review #767).
 */
async function whereWords(tx: Tx, a: Pick<AdmissionRow, "id" | "patientId" | "admissionNo">): Promise<{ words: string[]; wardId: string | null }> {
  const bed = await bedCodeOf(tx, a.id);
  const sealed = (await tx.select({ s: patients.sensitiveContext }).from(patients).where(eq(patients.id, a.patientId)))[0]?.s === true;
  if (sealed) return { words: [SEALED_WORDS], wardId: bed.wardId };
  return { words: [bed.code === null ? null : `Bed ${bed.code}`, a.admissionNo].filter((x): x is string => x !== null), wardId: bed.wardId };
}
const SEALED_WORDS = "Sealed patient";

type EwsAlertRow = typeof ipdNursingAlerts.$inferSelect;

/**
 * Tells the duty doctor about a raise or re-raise of `alert` (band `band`, value `value`, by set `vitalsId`); with no
 * doctor to tell, the nursing fallback chain is told NOW; the emergency band also tells the fallback chain. Stamps
 * `notified_at` / `notified_band` ONLY when a notice went out (otherwise the sweep retries). Appends the breach event.
 */
async function notifyEws(
  tx: Tx, actor: Actor, a: AdmissionRow, alert: Pick<EwsAlertRow, "id" | "scoreKind">,
  b: { band: IpdEwsBand; value: number; vitalsId: string | null; escalation: boolean }, at: Date,
): Promise<Raised> {
  const where = await whereWords(tx, a);
  const doctors = await dutyDoctorsFor(tx, a, at);
  const recipients = new Set(doctors);
  if (doctors.length === 0 || b.band === "high") for (const u of await nursingFallback(tx)) recipients.add(u);
  const kind = (alert.scoreKind ?? "news2") as IpdEwsKind;
  const title = `${KIND_WORD[kind]} ${String(b.value)} — ${BAND_WORD[b.band]}`;
  const body = [...where.words, doctors.length === 0 ? "No doctor reached — call" : b.escalation ? "Score worse" : "Review now"].join(" · ");
  let notified = 0;
  let doctorReached = false;
  for (const userId of [...recipients].sort()) {
    const won = await raiseNoticeIn(tx, {
      userId, kind: "ipd.ews_breach", title, body, refType: "ipd_admission", refId: a.id,
      sourceKey: `ipd.ews:${alert.id}:${b.vitalsId ?? "retry"}:${b.band}`, at,
    });
    if (won) { notified += 1; if (doctors.includes(userId)) doctorReached = true; }
  }
  if (notified > 0) await tx.update(ipdNursingAlerts).set({ notifiedAt: at, notifiedBand: b.band, doctorReached }).where(eq(ipdNursingAlerts.id, alert.id));
  await appendEvent(tx, ewsBreached.make({
    payload: {
      alertId: alert.id, admissionId: a.id, wardId: where.wardId, vitalsId: b.vitalsId, scoreKind: kind, band: b.band, value: b.value,
      escalation: b.escalation, notified, doctorReached, provenance: provenanceOf(actor),
    },
    actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
  }));
  return { alertRaised: notified > 0, doctorReached };
}

/**
 * ONE ALERT PER BREACH (review fix: the in-breach band is the LATEST band, and it may go down). A set at the notify band
 * with no open alert opens one; with one open, it writes its band into the row and re-raises (notifies again) only when
 * its band is ABOVE the band last seen — so high → medium → high and medium → low–medium → medium each re-notify on the
 * way back up, and the same band twice says nothing. A set below the band clears the alert. Under the admission lock.
 */
async function evaluateEws(tx: Tx, actor: Actor, a: AdmissionRow, vitalsId: string, score: IpdEwsScore, at: Date): Promise<Raised> {
  const open = (await tx.select().from(ipdNursingAlerts).where(and(
    eq(ipdNursingAlerts.admissionId, a.id), eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt),
  )).for("update"))[0];
  if (!ewsNotifies(score.band)) {
    if (open !== undefined) {
      await tx.update(ipdNursingAlerts).set({ clearedAt: at, clearedBy: vitalsId }).where(eq(ipdNursingAlerts.id, open.id));
      await appendEvent(tx, ewsCleared.make({
        payload: { alertId: open.id, admissionId: a.id, vitalsId, provenance: provenanceOf(actor) },
        actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
      }));
    }
    return NOTHING_RAISED;
  }
  if (open === undefined) {
    const alertId = newId();
    await tx.insert(ipdNursingAlerts).values({
      id: alertId, admissionId: a.id, patientId: a.patientId, kind: "ews", scoreKind: score.kind, band: score.band,
      scoreValue: score.value, vitalsId, lastVitalsId: vitalsId, raisedAt: at,
    });
    return notifyEws(tx, actor, a, { id: alertId, scoreKind: score.kind }, { band: score.band, value: score.value, vitalsId, escalation: false }, at);
  }
  const rises = ewsBandRank(score.band) > ewsBandRank(open.band as IpdEwsBand);
  if (!rises) {
    // The same breach stands (or eases): record the band, say nothing.
    await tx.update(ipdNursingAlerts).set({ band: score.band, scoreValue: score.value, scoreKind: score.kind, lastVitalsId: vitalsId })
      .where(eq(ipdNursingAlerts.id, open.id));
    return NOTHING_RAISED;
  }
  // A rise above the band last seen is a new call: its own notice, its own acknowledgement, its own supervisor step.
  await tx.update(ipdNursingAlerts).set({
    band: score.band, scoreValue: score.value, scoreKind: score.kind, vitalsId, lastVitalsId: vitalsId, escalatedAt: at,
    notifiedAt: null, doctorReached: false, acknowledgedAt: null, acknowledgedBy: null, seenAt: null, seenBy: null, supervisorToldAt: null,
  }).where(eq(ipdNursingAlerts.id, open.id));
  return notifyEws(tx, actor, a, { id: open.id, scoreKind: score.kind }, { band: score.band, value: score.value, vitalsId, escalation: true }, at);
}

// ═══════════════════════════════════════════ acknowledge ═══════════════════════════════════════════

/** The actor kind G7 reads: doctor / resident by role, else the nursing kinds, else the duty manager. */
async function actorKindOf(tx: Tx, actor: Actor): Promise<IpdActorKind> {
  if (actor.type === "agent") return "agent";
  if (actor.type === "system") return "device";
  for (const k of ["doctor", "resident", "supervisor", "nurse", "duty_manager"] as const) {
    if (await actorHoldsAnyRole(tx, actor.id, [...IPD_ACTOR_ROLE_KEYS[k]])) return k;
  }
  return "nurse";
}

/**
 * Acknowledge an early-warning alert. DECIDED (E4.1 review, standard rapid-response practice): only a DOCTOR's
 * acknowledgement (an actor holding a doctor or resident role — `EWS_ACK_KINDS`) answers the call and stops the
 * 10-minute escalation; a nurse's or supervisor's is recorded as SEEN and the escalation runs on. The note is kept on
 * the row and in the event.
 */
export async function acknowledgeEwsAlert(
  db: Db, actor: Actor, raw: unknown, opts: Opts = {},
): Promise<{ alertId: string; acknowledgedAt: string | null; seenAt: string | null; byDoctor: boolean }> {
  const input = IpdAcknowledgeEwsInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_EWS_RESPOND);
  const at = opts.now ?? new Date();
  return onceNursing(db, actor, "acknowledge_ews", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const row0 = (await tx.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.id, input.alertId), eq(ipdNursingAlerts.kind, "ews"))))[0];
    if (row0 === undefined) throw new IpdError("ews_alert_not_found", "No early-warning alert has this id.");
    const a = await lockAdmission(tx, row0.admissionId);
    const row = (await tx.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.id, row0.id)))[0]!;
    if (row.clearedAt !== null) throw new IpdError("ews_alert_closed", "This alert has already cleared: a later set scored below the alert band.");
    const byKind = await actorKindOf(tx, actor);
    const byDoctor = EWS_ACK_KINDS.includes(byKind);
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    if (byDoctor && row.acknowledgedAt !== null) return { alertId: row.id, acknowledgedAt: iso(row.acknowledgedAt), seenAt: iso(row.seenAt), byDoctor };
    if (!byDoctor && row.seenAt !== null) return { alertId: row.id, acknowledgedAt: iso(row.acknowledgedAt), seenAt: iso(row.seenAt), byDoctor };
    const note = input.note ?? null;
    await tx.update(ipdNursingAlerts).set(byDoctor
      ? { acknowledgedAt: at, acknowledgedBy: actor.id, ...(note === null ? {} : { ackNote: note }) }
      : { seenAt: at, seenBy: actor.id, ...(note === null ? {} : { ackNote: note }) }).where(eq(ipdNursingAlerts.id, row.id));
    await appendEvent(tx, ewsAcknowledged.make({
      payload: { alertId: row.id, admissionId: a.id, byKind, stopsEscalation: byDoctor, note, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return {
      alertId: row.id, acknowledgedAt: byDoctor ? at.toISOString() : iso(row.acknowledgedAt), seenAt: byDoctor ? iso(row.seenAt) : at.toISOString(), byDoctor,
    };
  }), at);
}

// ═══════════════════════════════════════════ intake / output, notes ═══════════════════════════════════════════

export async function recordIntakeOutput(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ entryId: string; lateEntry: boolean }> {
  const input = IpdIntakeOutputInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_VITALS_RECORD);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.observedAt, at)) throw new IpdRefusal("time_in_future");
  return onceNursing(db, actor, "record_intake_output", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireNursingState(a);
    const observedAt = new Date(input.observedAt);
    const entryId = newId();
    await tx.insert(ipdIntakeOutput).values({
      id: entryId, admissionId: a.id, patientId: a.patientId, observedAt, recordedAt: at, recordedBy: actor.id, source: input.source,
      direction: input.direction, kind: input.kind, volumeMl: input.volumeMl, note: input.note ?? null,
    });
    await appendEvent(tx, intakeOutputRecorded.make({
      payload: { entryId, admissionId: a.id, direction: input.direction, kind: input.kind, volumeMl: input.volumeMl, provenance: input.source },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { entryId, lateEntry: isLate(observedAt, at) };
  }), at);
}

export async function addNursingNote(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ noteId: string; lateEntry: boolean }> {
  const input = IpdNursingNoteInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_VITALS_RECORD);
  const at = opts.now ?? new Date();
  if (ipdIsInFuture(input.observedAt, at)) throw new IpdRefusal("time_in_future");
  return onceNursing(db, actor, "add_nursing_note", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireNursingState(a);
    const observedAt = new Date(input.observedAt);
    const lateEntry = isLate(observedAt, at);
    const noteId = newId();
    // A copilot draft becomes a note only here, signed by the person saving it: recordedBy is that person.
    await tx.insert(ipdNursingNotes).values({
      id: noteId, admissionId: a.id, patientId: a.patientId, observedAt, recordedAt: at, recordedBy: actor.id, source: input.source,
      lateEntry, category: input.category, text: input.text,
    });
    await appendEvent(tx, nursingNoteAdded.make({
      payload: { noteId, admissionId: a.id, category: input.category, lateEntry, provenance: input.source },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { noteId, lateEntry };
  }), at);
}

// ═══════════════════════════════════════════ shift handover ═══════════════════════════════════════════

export async function giveShiftHandover(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ handoverId: string; supersedes: string | null }> {
  const input = IpdGiveShiftHandoverInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_SHIFT_HANDOVER);
  const at = opts.now ?? new Date();
  return onceNursing(db, actor, "give_shift_handover", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    requireNursingState(a);
    const open = (await tx.select({ id: ipdShiftHandovers.id }).from(ipdShiftHandovers)
      .where(and(eq(ipdShiftHandovers.admissionId, a.id), eq(ipdShiftHandovers.status, "given"))))[0];
    if (open !== undefined) await tx.update(ipdShiftHandovers).set({ status: "superseded" }).where(eq(ipdShiftHandovers.id, open.id));
    const bed = await bedCodeOf(tx, a.id);
    const handoverId = newId();
    const shift = shiftOf(at).key;
    await tx.insert(ipdShiftHandovers).values({
      id: handoverId, admissionId: a.id, patientId: a.patientId, wardId: bed.wardId, shift, situation: input.sbar.situation,
      background: input.sbar.background, assessment: input.sbar.assessment, recommendation: input.sbar.recommendation,
      status: "given", givenBy: actor.id, givenAt: at,
    });
    await appendEvent(tx, shiftHandoverGiven.make({
      payload: { handoverId, admissionId: a.id, wardId: bed.wardId, shift, supersedes: open?.id ?? null, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { handoverId, supersedes: open?.id ?? null };
  }), at);
}

export async function acceptShiftHandover(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ handoverId: string; acceptedAt: string }> {
  const input = IpdAcceptShiftHandoverInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_SHIFT_HANDOVER);
  const at = opts.now ?? new Date();
  return onceNursing(db, actor, "accept_shift_handover", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const h0 = (await tx.select().from(ipdShiftHandovers).where(eq(ipdShiftHandovers.id, input.handoverId)))[0];
    if (h0 === undefined) throw new IpdError("shift_handover_not_found", "No shift handover has this id.");
    const a = await lockAdmission(tx, h0.admissionId);
    const h = (await tx.select().from(ipdShiftHandovers).where(eq(ipdShiftHandovers.id, h0.id)).for("update"))[0]!;
    if (h.status !== "given") throw new IpdError("shift_handover_not_open", "This handover was already accepted or replaced by a newer one.", { status: h.status });
    if (h.givenBy === actor.id) throw new IpdError("shift_handover_own", "The nurse who gave a handover cannot accept it: the next nurse accepts.");
    await tx.update(ipdShiftHandovers).set({ status: "accepted", acceptedBy: actor.id, acceptedAt: at }).where(eq(ipdShiftHandovers.id, h.id));
    await appendEvent(tx, shiftHandoverAccepted.make({
      payload: { handoverId: h.id, admissionId: a.id, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return { handoverId: h.id, acceptedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ the minute sweep ═══════════════════════════════════════════

const SWEEP_ACTOR: Actor = { type: "system", id: "ipd-nursing-sweep" };
const sweepLog = new Logger("ipd.sweepIpdNursing");
/** Admissions older than this without an assessment are left to the Now card (a cutover backlog never floods the bell). */
const ASSESSMENT_SWEEP_LOOKBACK_MS = 3 * 86_400_000;

export type NursingSweepResult = { assessmentOverdue: number; ewsUnacked: number; ewsRetried: number; failed: number };

/** One row's work in its own transaction; a failure is logged and counted and the loop goes on (E4.1 review). */
async function eachRow<T extends { id: string }>(rows: readonly T[], out: NursingSweepResult, what: string, work: (r: T) => Promise<void>): Promise<void> {
  for (const r of rows) {
    try { await work(r); } catch (e) {
      out.failed += 1;
      sweepLog.error(`${what} ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The minute job. Every step stamps only when a notice actually went out, so a tick that reaches nobody is retried next
 * minute. (1) An admission on a bed one hour past admission with no assessment: ONE alert (raised once, ever) and the
 * nursing fallback chain told; `ipd.nursing.assessment_overdue` once, when first told. (2) An early-warning alert nobody
 * was reached for: told again (doctors, else the chain). (3) An alert without a DOCTOR's acknowledgement 10 minutes after
 * its raise or re-raise: the nursing fallback chain, once per raise. Each row in its own transaction, failures isolated.
 */
export async function sweepIpdNursing(db: Db, now: Date, hooks: { beforeRow?: (admissionId: string) => void } = {}): Promise<NursingSweepResult> {
  const out: NursingSweepResult = { assessmentOverdue: 0, ewsUnacked: 0, ewsRetried: 0, failed: 0 };
  const dueBefore = new Date(now.getTime() - IPD_ASSESSMENT_DUE_MINUTES * 60_000);
  const candidates = await db.select({ id: ipdAdmissions.id }).from(ipdAdmissions).where(and(
    inArray(ipdAdmissions.state, [...IPD_NURSING_STATES]),
    lte(ipdAdmissions.admittedAt, dueBefore),
    gte(ipdAdmissions.admittedAt, new Date(now.getTime() - ASSESSMENT_SWEEP_LOOKBACK_MS)),
    sql`not exists (select 1 from ${ipdNursingAssessments} s where s.admission_id = ${ipdAdmissions.id})`,
    sql`not exists (select 1 from ${ipdNursingAlerts} x where x.admission_id = ${ipdAdmissions.id} and x.kind = 'assessment_overdue' and x.notified_at is not null)`,
  ));
  await eachRow(candidates, out, "assessment_overdue", async (c) => {
    hooks.beforeRow?.(c.id);
    await withTx(db, async (tx) => {
      const a = await lockAdmission(tx, c.id);
      if (!inNursingState(a.state) || a.admittedAt === null) return;
      const done = await tx.select({ id: ipdNursingAssessments.id }).from(ipdNursingAssessments).where(eq(ipdNursingAssessments.admissionId, a.id));
      if (done.length > 0) return;
      await tx.insert(ipdNursingAlerts).values({ id: newId(), admissionId: a.id, patientId: a.patientId, kind: "assessment_overdue", raisedAt: now })
        .onConflictDoNothing();
      const alert = (await tx.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.admissionId, a.id), eq(ipdNursingAlerts.kind, "assessment_overdue"))).for("update"))[0]!;
      if (alert.notifiedAt !== null || alert.clearedAt !== null) return;
      const where = await whereWords(tx, a);
      let notified = 0;
      for (const userId of await nursingFallback(tx)) {
        if (await raiseNoticeIn(tx, {
          userId, kind: "ipd.assessment_overdue", title: "Nursing assessment overdue",
          body: [...where.words, "1 hour since admission"].join(" · "),
          refType: "ipd_admission", refId: a.id, sourceKey: `ipd.assessment_overdue:${alert.id}`, at: now,
        })) notified += 1;
      }
      if (notified === 0) return; // nobody to tell: no stamp, no event — the next tick tries again
      await tx.update(ipdNursingAlerts).set({ notifiedAt: now }).where(eq(ipdNursingAlerts.id, alert.id));
      await appendEvent(tx, assessmentOverdue.make({
        payload: { alertId: alert.id, admissionId: a.id, admittedAt: a.admittedAt.toISOString(), notified, provenance: "system" },
        actor: SWEEP_ACTOR, correlationId: a.id, patientId: a.patientId, occurredAt: now,
      }));
      out.assessmentOverdue += 1;
    });
  });

  // (2) Early-warning alerts nobody was reached for.
  const unreached = await db.select({ id: ipdNursingAlerts.id, admissionId: ipdNursingAlerts.admissionId }).from(ipdNursingAlerts).where(and(
    eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt), isNull(ipdNursingAlerts.notifiedAt),
  ));
  await eachRow(unreached, out, "ews_retry", async (s) => {
    hooks.beforeRow?.(s.admissionId);
    await withTx(db, async (tx) => {
      const a = await lockAdmission(tx, s.admissionId);
      const r = (await tx.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.id, s.id)).for("update"))[0]!;
      if (r.clearedAt !== null || r.notifiedAt !== null) return;
      const raised = await notifyEws(tx, SWEEP_ACTOR, a, r, { band: r.band as IpdEwsBand, value: r.scoreValue ?? 0, vitalsId: null, escalation: false }, now);
      if (raised.alertRaised) out.ewsRetried += 1;
    });
  });

  // (3) No DOCTOR's acknowledgement 10 minutes after the raise → the nursing fallback chain.
  const unackedBefore = new Date(now.getTime() - IPD_EWS_UNACKED_MINUTES * 60_000);
  const stale = await db.select({ id: ipdNursingAlerts.id, admissionId: ipdNursingAlerts.admissionId }).from(ipdNursingAlerts).where(and(
    eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt), isNull(ipdNursingAlerts.acknowledgedAt),
    isNull(ipdNursingAlerts.supervisorToldAt), sql`coalesce(${ipdNursingAlerts.escalatedAt}, ${ipdNursingAlerts.raisedAt}) <= ${unackedBefore.toISOString()}::timestamptz`,
  ));
  await eachRow(stale, out, "ews_unacked", async (s) => {
    hooks.beforeRow?.(s.admissionId);
    await withTx(db, async (tx) => {
      const a = await lockAdmission(tx, s.admissionId);
      const r = (await tx.select().from(ipdNursingAlerts).where(eq(ipdNursingAlerts.id, s.id)).for("update"))[0]!;
      if (r.clearedAt !== null || r.acknowledgedAt !== null || r.supervisorToldAt !== null) return;
      const where = await whereWords(tx, a);
      let notified = 0;
      for (const userId of await nursingFallback(tx)) {
        if (await raiseNoticeIn(tx, {
          userId, kind: "ipd.ews_unacknowledged", title: `${KIND_WORD[r.scoreKind as IpdEwsKind]} ${String(r.scoreValue)} — no doctor yet`,
          body: [...where.words, "10 min, no doctor"].join(" · "),
          refType: "ipd_admission", refId: a.id, sourceKey: `ipd.ews_unacked:${r.id}:${(r.escalatedAt ?? r.raisedAt).toISOString()}`, at: now,
        })) notified += 1;
      }
      if (notified === 0) return; // nobody reached: retried next tick
      await tx.update(ipdNursingAlerts).set({ supervisorToldAt: now }).where(eq(ipdNursingAlerts.id, r.id));
      out.ewsUnacked += 1;
    });
  });
  return out;
}

// ═══════════════════════════════════════════ shared reads ═══════════════════════════════════════════

export type ScoredSet = {
  id: string; admissionId: string; observedAt: Date; scoreKind: IpdEwsKind; scoreValue: number; scoreBand: IpdEwsBand; scoreComplete: boolean;
};
/** The latest two SCORED sets per admission (newest first) — the score and its trend. One query. */
export async function latestScores(db: Db | Tx, admissionIds: readonly string[]): Promise<Map<string, ScoredSet[]>> {
  const out = new Map<string, ScoredSet[]>();
  if (admissionIds.length === 0) return out;
  const rows = (await db.execute(sql`
    select id, admission_id, observed_at, score_kind, score_value, score_band, score_complete from (
      select v.*, row_number() over (partition by v.admission_id order by v.observed_at desc, v.id desc) as rn
      from ipd_vitals v
      where v.score_kind is not null and v.admission_id in (${sql.join(admissionIds.map((i) => sql`${i}`), sql`, `)})
    ) x where x.rn <= 2 order by x.admission_id, x.rn`)).rows as Record<string, unknown>[];
  for (const r of rows) {
    const set: ScoredSet = {
      id: r.id as string, admissionId: r.admission_id as string, observedAt: new Date(r.observed_at as string | Date),
      scoreKind: r.score_kind as IpdEwsKind, scoreValue: Number(r.score_value), scoreBand: r.score_band as IpdEwsBand,
      scoreComplete: r.score_complete === true,
    };
    const list = out.get(set.admissionId) ?? [];
    list.push(set);
    out.set(set.admissionId, list);
  }
  return out;
}

/** The newest set of an admission (scored or refused): the clock for the next one. */
export async function lastSetAt(db: Db | Tx, admissionIds: readonly string[]): Promise<Map<string, Date>> {
  if (admissionIds.length === 0) return new Map();
  const rows = await db.select({ admissionId: ipdVitals.admissionId, at: sql<string>`max(${ipdVitals.observedAt})` }).from(ipdVitals)
    .where(inArray(ipdVitals.admissionId, [...admissionIds])).groupBy(ipdVitals.admissionId);
  return new Map(rows.map((r) => [r.admissionId, new Date(r.at)] as const));
}

