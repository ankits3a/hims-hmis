import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ER_INTENTS, erIsInFuture, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { erAdmissionDisputes, erChargeLines, erDepartureRecords, erEpisodes, erMlcObligations, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { createHash } from "node:crypto";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  IpdError, IpdRefusal, cancelErAdmissionIn, carryErOrderLinesIn, emergencyAdmit, erAdmissionState, erOpenAdmissionFor, openErMortuaryEntry,
  releaseErBayIn, requestAdmission, stampErHandOffIn,
} from "../ipd";
import { recordErDeath as markPatientDeceased } from "../patients";
import { escalationRecipients } from "../roster";
import { cancelTask, getTask, raiseTask } from "../tasks";
import { lockEpisode, moveEpisode, onceEr, personRecords, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { erAdmissionArbitrated, erAdmissionDisputed, erDeparted, erDispositionDecided, erHandedToUnit } from "./events";
import { mlcOfEpisode } from "./mlc";
import { ER_DISPOSITION } from "./names";
import { ER_ARBITRATION_TASK, ER_BOARDING_TASK } from "./task-kinds";
import { isActiveDoctor } from "./triage";
import type { Actor, ErDisposition, ErIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 5 (#812) — DISPOSITION AND DEPARTURE (spec SPEC-emergency §3.10, §4.5; contracts `emergency/dispo.ts`).
 *
 * - ONE disposition per episode (`discharge`, `admit`, `refer_out`), by a doctor with a reason. `decide_disposition`
 *   records it alone; the doctor's exit acts record it in the same act when the patient is still `in_treatment`, and
 *   refuse an act that does not match the disposition already decided.
 * - EVERY departure goes through `departIn`: the open re-triage task closed, the BAY released to cleaning (IPD's
 *   `releaseErBayIn`), the episode `departed` with its outcome, `er.departed`. The departure's paper (summary, referral
 *   note, LAMA form, LWBS / abscond note, death note) is one append-only `er_departure_records` row.
 * - HAND TO A UNIT raises the IPD admission through IPD's own intents (`emergencyAdmit` with a bed, else
 *   `requestAdmission` source `er`), copies the gate instant and "stabilised" onto it, and then either leaves the ER at
 *   once (a bed) or BOARDS (`boarding_since`) until `sweepErBoarding` sees IPD place the bed. Leaving for the bed carries
 *   the ER's lab and imaging lines onto the IP running bill (IPD's order seam: priced on the admission's tariff, dated
 *   the ER day, once) and marks them `moved`. DECIDED: the ER issue (drug) and procedure lines stay on the ER episode for
 *   lane 6's bill desk — IPD has no drug or procedure line source yet.
 * - Referral is never for money (`cannot_pay` refused). Death needs the MCCD number unless the case is an MLC whose
 *   police intimation is recorded; the body goes to the mortuary register through lane 4's seam.
 * Nothing here reads a bill or a balance (decision 0058; a patient leaving with dues is never held).
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type Outcome = "discharged" | "admitted" | "referred_out" | "lama" | "absconded" | "lwbs" | "died";

export const ER_DISPO_ACTOR: Actor = { type: "system", id: "er-boarding-clock" };
const OPEN_TASK = ["created", "assigned", "accepted", "in_progress"];
/** Review #12: notice times in IST words (formatting only — no offset arithmetic). */
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Decision-to-bed (spec §3.2): the bed manager's task at 2 h, the MS at 4 h. */
export const ER_BOARDING_TASK_MIN = 120;
export const ER_BOARDING_CLIMB_MIN = 240;

async function closeTask(tx: Tx, taskId: string | null, why: string, at: Date): Promise<void> {
  if (taskId === null) return;
  const t = await getTask(tx, taskId);
  if (t !== null && OPEN_TASK.includes(t.state)) await cancelTask(tx, ER_DISPO_ACTOR, { taskId: t.id, version: t.version, reason: why }, at);
}

async function requireDoctor(tx: Tx, actor: Actor): Promise<void> {
  if (actor.type === "system") return;
  if (!(await isActiveDoctor(tx, actor.id))) throw new ErRefusal("not_a_doctor", { userId: actor.id });
}

function timeNotFuture(at: string, now: Date): Date {
  if (erIsInFuture(at, now)) throw new ErRefusal("time_in_future");
  return new Date(Math.min(new Date(at).getTime(), now.getTime()));
}

/**
 * The disposition the act needs: decided now (from `in_treatment`, with a reason) or already decided and the same.
 * Returns the episode as it stands after (state `disposition_decided`).
 */
async function decidedIn(
  tx: Tx, actor: Actor, e: EpisodeRow, disposition: ErDisposition, reason: string | undefined, at: Date,
): Promise<EpisodeRow> {
  if (e.state === "disposition_decided") {
    if (e.disposition === disposition) return e;
    // Review #3: the IPD side cancelled the hand-off (the patient no longer boards): the doctor may decide again — audited.
    if (!handOffCancelled(e)) throw new ErRefusal("disposition_mismatch", { decided: e.disposition, asked: disposition });
    if (reason === undefined) throw new ErRefusal("disposition_reason_needed");
    await tx.update(erEpisodes).set({ disposition, dispositionReason: reason, dispositionBy: actor.id, dispositionAt: at, updatedAt: at })
      .where(eq(erEpisodes.id, e.id));
    await appendEvent(tx, erDispositionDecided.make({
      payload: { episodeId: e.id, disposition, previous: e.disposition, provenance: provenanceOf(actor) }, actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return readEpisode(tx, e.id);
  }
  if (e.state !== "in_treatment") throw new ErRefusal("episode_wrong_state", { state: e.state });
  if (reason === undefined) throw new ErRefusal("disposition_reason_needed");
  await moveEpisode(tx, actor, e, "disposition_decided", at, {
    disposition, dispositionReason: reason, dispositionBy: actor.id, dispositionAt: at,
  });
  await appendEvent(tx, erDispositionDecided.make({
    payload: { episodeId: e.id, disposition, provenance: provenanceOf(actor) }, actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
  }));
  return readEpisode(tx, e.id);
}

/** An `admit` decision whose hand-off IPD cancelled: decided, an admission named, no longer boarding. */
function handOffCancelled(e: EpisodeRow): boolean {
  return e.state === "disposition_decided" && e.disposition === "admit" && e.admissionId !== null && e.boardingSince === null;
}

/** Review #10: a referral decided "because the patient cannot pay" is refused at the decision too, not only at the exit. */
const MONEY_REASON = /(can(no|')?t|unable to|not able to)\s+(pay|afford)|no money|cannot afford|paise nahi|पैसे? नहीं/i;

async function writeRecord(tx: Tx, actor: Actor, e: EpisodeRow, kind: string, document: Record<string, unknown>, at: Date): Promise<void> {
  await tx.insert(erDepartureRecords).values({ id: newId(), episodeId: e.id, kind, document, signedBy: actor.id, signedAt: at });
}

/**
 * THE ONE WAY OUT: the re-triage task closed, the bay released to cleaning, the episode `departed` with its outcome.
 * In the caller's transaction, the episode locked. Returns the bay released (or null).
 */
export async function departIn(
  tx: Tx, actor: Actor, e: EpisodeRow, outcome: Outcome, departedAt: Date, at: Date,
): Promise<string | null> {
  await closeTask(tx, e.retriageTaskId, `departed: ${outcome}`, at);
  await closeTask(tx, e.boardingTaskId, `departed: ${outcome}`, at);
  if (e.bayId !== null) await releaseErBayIn(tx, actor, { bedId: e.bayId, episodeId: e.id }, at);
  // Review #2: a boarding patient leaving any other way takes the open admission request with them (IPD's own cancel).
  if (e.admissionId !== null && outcome !== "admitted") await cancelErAdmissionIn(tx, actor, e.admissionId, `ER departure: ${outcome}`, at);
  await moveEpisode(tx, actor, e, "departed", at, { outcome, departedAt, boardingSince: null });
  await appendEvent(tx, erDeparted.make({
    payload: { episodeId: e.id, outcome, bayId: e.bayId, admissionId: e.admissionId, provenance: provenanceOf(actor) },
    actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
  }));
  return e.bayId;
}

const out = (e: EpisodeRow, outcome: Outcome, departedAt: Date, bay: string | null) => ({
  episodeId: e.id, state: "departed" as const, outcome, departedAt: departedAt.toISOString(), bayReleased: bay,
});

// ═══════════════════════════════════════════ decide_disposition ═══════════════════════════════════════════

export async function decideDisposition(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"decide_disposition">> {
  const input: Input<"decide_disposition"> = ER_INTENTS.decide_disposition.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "decide_disposition", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    if (input.disposition === "refer_out" && MONEY_REASON.test(input.reason)) throw new ErRefusal("referral_not_for_money");
    const e = await lockEpisode(tx, input.episodeId);
    if (e.state === "disposition_decided" && !handOffCancelled(e)) throw new ErRefusal("disposition_already_decided", { disposition: e.disposition });
    await decidedIn(tx, actor, e, input.disposition, input.reason, at);
    return { episodeId: e.id, state: "disposition_decided" as const, disposition: input.disposition };
  }), at);
}

// ═══════════════════════════════════════════ discharge_from_er ═══════════════════════════════════════════

export async function dischargeFromEr(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"discharge_from_er">> {
  const input: Input<"discharge_from_er"> = ER_INTENTS.discharge_from_er.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "discharge_from_er", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    const e = await decidedIn(tx, actor, await lockEpisode(tx, input.episodeId), "discharge", input.reason, at);
    await writeRecord(tx, actor, e, "discharge_summary", input.summary, at);
    return out(e, "discharged", at, await departIn(tx, actor, e, "discharged", at, at));
  }), at);
}

// ═══════════════════════════════════════════ hand_to_unit ═══════════════════════════════════════════

function admissionRefusal(err: unknown): unknown {
  if (err instanceof IpdRefusal || err instanceof IpdError) return new ErRefusal("admission_refused", { code: err.code, message: err.message });
  return err;
}

/** Leaving the ER for the inpatient bed: the ER order lines onto the IP running bill (marked `moved`), then depart. */
async function leaveForBedIn(tx: Tx, actor: Actor, e: EpisodeRow, admissionId: string, at: Date): Promise<string | null> {
  const lines = await tx.select().from(erChargeLines).where(and(
    eq(erChargeLines.episodeId, e.id), eq(erChargeLines.source, "er.order"), inArray(erChargeLines.status, ["posted", "rate_missing"]),
    isNotNull(erChargeLines.orderItemId),
  )).for("update");
  const items = lines.filter((l) => l.orderId !== null && l.serviceId !== null && (l.department === "lab" || l.department === "imaging"))
    .map((l) => ({
      orderId: l.orderId!, orderItemId: l.orderItemId!, serviceId: l.serviceId!, component: l.department as "lab" | "imaging",
      serviceDate: istDayString(l.postedAt),
    }));
  const posted = await carryErOrderLinesIn(tx, actor, admissionId, items, at);
  for (const l of lines) {
    if (!posted.has(l.orderItemId!)) continue;
    await tx.update(erChargeLines).set({ status: "moved", movedToAdmissionId: admissionId, movedIpdLineId: posted.get(l.orderItemId!) ?? null })
      .where(eq(erChargeLines.id, l.id));
  }
  // Review #1: the admission paper is written when the patient actually leaves for the bed (one departure record ever).
  await writeRecord(tx, actor, e, "admission", { admissionId, boardedSince: e.boardingSince?.toISOString() ?? null }, at);
  return departIn(tx, actor, { ...e, admissionId }, "admitted", at, at);
}

/** Review #4: the IPD idempotency key is stable per episode and hand-off attempt — a retried hand-off finds the same admission. */
function handOffKey(episodeId: string, attempt: number): string {
  const h = createHash("sha256").update(`er-hand-off:${episodeId}:${String(attempt)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function handToUnit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"hand_to_unit">> {
  const input: Input<"hand_to_unit"> = ER_INTENTS.hand_to_unit.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "hand_to_unit", input.idempotencyKey, input, async () => {
    // The checks that can refuse BEFORE the admission is raised (re-made under the lock below).
    const pre = await readEpisode(db, input.episodeId);
    await withTx(db, (tx) => requireDoctor(tx, actor));
    // Review #5: a bed is the admission desk's to allot (`ipd.admit`); a doctor hands over without one and the patient boards.
    if (input.bedId !== undefined && actor.type === "user" && !(await hasPermission(db, actor.id, "ipd.admit", "hospital"))) {
      throw new ErRefusal("bed_needs_admission_desk");
    }
    if (pre.boardingSince !== null) throw new ErRefusal("already_boarding", { admissionId: pre.admissionId });
    if (pre.state === "disposition_decided" && pre.disposition !== "admit" && !handOffCancelled(pre)) {
      throw new ErRefusal("disposition_mismatch", { decided: pre.disposition, asked: "admit" });
    }
    if (pre.state !== "disposition_decided" && pre.state !== "in_treatment") throw new ErRefusal("episode_wrong_state", { state: pre.state });
    if ((pre.state === "in_treatment" || (handOffCancelled(pre) && pre.disposition !== "admit")) && input.reason === undefined) {
      throw new ErRefusal("disposition_reason_needed");
    }
    const mlc = (await mlcOfEpisode(db, pre.id)) !== undefined;
    // Review #4: the admission through IPD's own intent under a key STABLE per episode and attempt; a request already open
    // for this episode (an earlier attempt that committed IPD-side) is adopted, never duplicated.
    const ipdKey = handOffKey(pre.id, pre.handOffAttempts);
    let admissionId: string;
    let admissionNo: string | null = null;
    const open = input.bedId === undefined ? await erOpenAdmissionFor(db, pre.id) : undefined;
    try {
      if (open !== undefined) {
        admissionId = open.id;
      } else if (input.bedId !== undefined) {
        const r = await emergencyAdmit(db, actor, {
          idempotencyKey: ipdKey, patientId: pre.patientId, bedId: input.bedId, consultantId: input.consultantId,
          isolation: input.isolation, provisionalDiagnosis: input.provisionalDiagnosis, mlc,
        }, { now: at });
        admissionId = r.admissionId;
        admissionNo = r.admissionNo;
      } else {
        const r = await requestAdmission(db, actor, {
          idempotencyKey: ipdKey, patientId: pre.patientId, source: "er", sourceRef: pre.id, consultantId: input.consultantId,
          requestedClass: input.requestedClass, isolation: input.isolation, provisionalDiagnosis: input.provisionalDiagnosis, mlc,
          ...(input.department === undefined ? {} : { department: input.department }),
        }, { now: at });
        admissionId = r.admissionId;
      }
    } catch (err) {
      throw admissionRefusal(err);
    }
    return withTx(db, async (tx) => {
      const e = await decidedIn(tx, actor, await lockEpisode(tx, input.episodeId), "admit", input.reason, at);
      if (e.boardingSince !== null && e.admissionId !== admissionId) throw new ErRefusal("already_boarding", { admissionId: e.admissionId });
      await stampErHandOffIn(tx, { admissionId, erArrivedAt: e.arrivedAt, stabilisedAt: e.stabilisedAt });
      const boarding = input.bedId === undefined;
      await tx.update(erEpisodes).set({ admissionId, boardingSince: boarding ? (e.boardingSince ?? at) : null, updatedAt: at }).where(eq(erEpisodes.id, e.id));
      await appendEvent(tx, erHandedToUnit.make({
        payload: { episodeId: e.id, admissionId, boarding, provenance: provenanceOf(actor) }, actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      if (!boarding) await leaveForBedIn(tx, actor, await readEpisode(tx, e.id), admissionId, at);
      return { episodeId: e.id, admissionId, admissionNo, boarding, state: boarding ? "disposition_decided" as const : "departed" as const };
    });
  }, at);
}

/**
 * Every minute (the ER clocks ride the bed-reservation job): a BOARDING patient whose admission IPD has now placed in a
 * bed leaves the ER (`admitted`, the bay to cleaning, the ER order lines onto the IP bill); one whose admission was
 * cancelled stops boarding and the ER doctor of record is told (the disposition stands; the doctor hands again or
 * re-decides). Idempotent: each episode is re-read under its lock.
 */
export async function sweepErBoarding(db: Db, now: Date): Promise<{ departed: number; lapsed: number; tasks: number; climbs: number }> {
  const res = { departed: 0, lapsed: 0, tasks: 0, climbs: 0 };
  const boarding = await db.select({ id: erEpisodes.id, admissionId: erEpisodes.admissionId }).from(erEpisodes)
    .where(and(eq(erEpisodes.state, "disposition_decided"), isNotNull(erEpisodes.boardingSince)));
  for (const b of boarding) {
    if (b.admissionId === null) continue;
    const state = await erAdmissionState(db, b.admissionId);
    if (state === "requested" || state === "reserved" || state === null) {
      await boardingClockIn(db, b.id, now, res);
      continue;
    }
    await withTx(db, async (tx) => {
      const e = await lockEpisode(tx, b.id);
      if (e.state !== "disposition_decided" || e.boardingSince === null || e.admissionId !== b.admissionId) return;
      if (state === "cancelled") {
        await closeTask(tx, e.boardingTaskId, "admission cancelled", now);
        await tx.update(erEpisodes).set({
          boardingSince: null, boardingTaskId: null, boardingClimbedAt: null, handOffAttempts: e.handOffAttempts + 1, updatedAt: now,
        }).where(eq(erEpisodes.id, e.id));
        if (e.doctorId !== null) {
          await raiseNoticeIn(tx, {
            userId: e.doctorId, kind: "er.admission_cancelled", title: `Admission cancelled · ${e.episodeNo}`, body: "Hand to a unit again or re-decide",
            refType: "er_episode", refId: e.id, sourceKey: `er_admission_cancelled:${b.admissionId}`, at: now,
          });
        }
        res.lapsed += 1;
        return;
      }
      await leaveForBedIn(tx, ER_DISPO_ACTOR, e, b.admissionId!, now);
      res.departed += 1;
    });
  }
  return res;
}

/**
 * Decision-to-bed (spec §3.2, ≤ 2 h from the decision): 2 h → ONE task for the bed manager (`er_boarding`, the duty
 * manager's skill); 4 h → ONE notice climb on the `er_boarding` ladder (fallback the MS). Each stamped on the episode.
 */
async function boardingClockIn(db: Db, episodeId: string, now: Date, res: { tasks: number; climbs: number }): Promise<void> {
  await withTx(db, async (tx) => {
    const e = await lockEpisode(tx, episodeId);
    if (e.state !== "disposition_decided" || e.boardingSince === null) return;
    const from = (e.dispositionAt ?? e.boardingSince).getTime();
    const waited = Math.round((now.getTime() - from) / 60_000);
    if (e.boardingTaskId === null && waited >= ER_BOARDING_TASK_MIN) {
      const due = new Date(from + ER_BOARDING_TASK_MIN * 60_000);
      const raised = await raiseTask(tx, ER_DISPO_ACTOR, {
        kind: ER_BOARDING_TASK, patientId: e.patientId, placeResourceId: e.bayId, priority: "urgent", dueAt: due.toISOString(),
        sourceRef: `er_boarding:${e.id}`, note: `Bed for ${e.episodeNo}`, raisedAt: due.toISOString(),
      }, now);
      await tx.update(erEpisodes).set({ boardingTaskId: raised.task.id }).where(eq(erEpisodes.id, e.id));
      res.tasks += 1;
    }
    if (e.boardingClimbedAt === null && waited >= ER_BOARDING_CLIMB_MIN) {
      const to = (await escalationRecipients(tx, "er_boarding", { fallbackRoleKey: "medical_superintendent" }, now)).userIds;
      for (const userId of to) {
        await raiseNoticeIn(tx, {
          userId, kind: "er.boarding_long", title: `Waiting for a bed · ${e.episodeNo}`, body: `${String(Math.floor(waited / 60))} h since the decision`,
          refType: "er_episode", refId: e.id, sourceKey: `er_boarding:${e.id}:climb`, at: now,
        });
      }
      await tx.update(erEpisodes).set({ boardingClimbedAt: now }).where(eq(erEpisodes.id, e.id));
      res.climbs += 1;
    }
  });
}

// ═══════════════════════════════════════════ a specialty refuses: MS arbitration ═══════════════════════════════════════════

export async function recordSpecialtyRefusal(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_specialty_refusal">> {
  const input: Input<"record_specialty_refusal"> = ER_INTENTS.record_specialty_refusal.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_specialty_refusal", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    const e = await lockEpisode(tx, input.episodeId);
    if (e.state !== "in_treatment" && e.state !== "disposition_decided") throw new ErRefusal("episode_wrong_state", { state: e.state });
    const open = (await tx.select({ id: erAdmissionDisputes.id }).from(erAdmissionDisputes)
      .where(and(eq(erAdmissionDisputes.episodeId, e.id), isNull(erAdmissionDisputes.ruledAt))))[0];
    if (open !== undefined) throw new ErRefusal("dispute_open", { disputeId: open.id });
    const id = newId();
    const raised = await raiseTask(tx, ER_DISPO_ACTOR, {
      kind: ER_ARBITRATION_TASK, patientId: e.patientId, placeResourceId: e.bayId, priority: "urgent",
      dueAt: new Date(at.getTime() + 60 * 60_000).toISOString(), sourceRef: `er_arbitration:${id}`,
      note: `${input.departmentCode} declined ${e.episodeNo}`, raisedAt: at.toISOString(),
    }, at);
    await tx.insert(erAdmissionDisputes).values({
      id, episodeId: e.id, departmentCode: input.departmentCode.toUpperCase(), reason: input.reason, refusedBy: actor.id, refusedAt: at, taskId: raised.task.id,
    });
    await appendEvent(tx, erAdmissionDisputed.make({
      payload: { episodeId: e.id, disputeId: id, departmentCode: input.departmentCode.toUpperCase(), provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { disputeId: id, taskId: raised.task.id };
  }), at);
}

export async function arbitrateAdmission(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"arbitrate_admission">> {
  const input: Input<"arbitrate_admission"> = ER_INTENTS.arbitrate_admission.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "arbitrate_admission", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    if (actor.type !== "system" && !(await actorHoldsAnyRole(tx, actor.id, ["medical_superintendent"]))) throw new ErRefusal("not_the_ms");
    const d = (await tx.select().from(erAdmissionDisputes).where(eq(erAdmissionDisputes.id, input.disputeId)).for("update"))[0];
    if (d === undefined) throw new ErRefusal("dispute_not_found");
    if (d.ruledAt !== null) throw new ErRefusal("dispute_ruled", { ruling: d.ruling });
    await tx.update(erAdmissionDisputes).set({
      ruling: input.ruling, rulingDepartmentCode: input.departmentCode?.toUpperCase() ?? null, rulingNote: input.note, ruledBy: actor.id, ruledAt: at,
    }).where(eq(erAdmissionDisputes.id, d.id));
    await closeTask(tx, d.taskId, "arbitrated", at);
    const e = await readEpisode(tx, d.episodeId);
    await appendEvent(tx, erAdmissionArbitrated.make({
      payload: { episodeId: d.episodeId, disputeId: d.id, ruling: input.ruling, provenance: provenanceOf(actor) },
      actor, correlationId: d.episodeId, patientId: e.patientId, occurredAt: at,
    }));
    return { disputeId: d.id, ruling: input.ruling, ruledAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ refer_out ═══════════════════════════════════════════

export async function referOut(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"refer_out">> {
  const input: Input<"refer_out"> = ER_INTENTS.refer_out.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  // Spec §7: a referral "because the patient cannot pay" is refused — before anything else is read.
  if (input.reason === "cannot_pay") throw new ErRefusal("referral_not_for_money");
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "refer_out", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    const e = await decidedIn(tx, actor, await lockEpisode(tx, input.episodeId), "refer_out", `Referral: ${input.reason}`, at);
    await writeRecord(tx, actor, e, "referral", {
      reason: input.reason, facility: input.facility, note: input.note, escort: input.escort, transport: input.transport,
    }, at);
    return out(e, "referred_out", at, await departIn(tx, actor, e, "referred_out", at, at));
  }), at);
}

// ═══════════════════════════════════════════ record_lama ═══════════════════════════════════════════

export async function recordLama(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_lama">> {
  const input: Input<"record_lama"> = ER_INTENTS.record_lama.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_lama", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    if (actor.type === "user" && !(await isActiveDoctor(tx, actor.id)) && !(await actorHoldsAnyRole(tx, actor.id, ["duty_manager"]))) {
      throw new ErRefusal("not_a_doctor", { userId: actor.id });
    }
    if (input.signer.kind === "refused_to_sign") {
      const w = input.signer.witnessId;
      const known = (await tx.select({ id: users.id }).from(users).where(and(eq(users.id, w), eq(users.active, true))))[0];
      if (w === actor.id || known === undefined) throw new ErRefusal("lama_witness_needed");
    }
    const e = await lockEpisode(tx, input.episodeId);
    if (e.state !== "in_treatment" && e.state !== "disposition_decided") throw new ErRefusal("episode_wrong_state", { state: e.state });
    await writeRecord(tx, actor, e, "lama", { risksExplained: input.risksExplained, signer: input.signer, goingTo: input.goingTo ?? null }, at);
    return out(e, "lama", at, await departIn(tx, actor, e, "lama", at, at));
  }), at);
}

// ═══════════════════════════════════════════ record_lwbs, record_abscond ═══════════════════════════════════════════

function lastSeen(e: EpisodeRow, raw: string, at: Date): Date {
  const seen = timeNotFuture(raw, at);
  if (seen.getTime() < e.arrivedAt.getTime()) throw new ErRefusal("last_seen_before_arrival");
  return seen;
}

export async function recordLwbs(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_lwbs">> {
  const input: Input<"record_lwbs"> = ER_INTENTS.record_lwbs.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_lwbs", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (e.state !== "arrived" && e.state !== "triaged") throw new ErRefusal("episode_wrong_state", { state: e.state });
    const seen = lastSeen(e, input.lastSeenAt, at);
    await tx.update(erEpisodes).set({ lastSeenAt: seen }).where(eq(erEpisodes.id, e.id));
    await writeRecord(tx, actor, e, "lwbs", { lastSeenAt: seen.toISOString(), note: input.note ?? null }, at);
    return out(e, "lwbs", seen, await departIn(tx, actor, e, "lwbs", seen, at));
  }), at);
}

export async function recordAbscond(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_abscond">> {
  const input: Input<"record_abscond"> = ER_INTENTS.record_abscond.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_abscond", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!["triaged", "in_treatment", "disposition_decided"].includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    const seen = lastSeen(e, input.lastSeenAt, at);
    const mlc = (await mlcOfEpisode(tx, e.id)) !== undefined;
    await tx.update(erEpisodes).set({ lastSeenAt: seen }).where(eq(erEpisodes.id, e.id));
    await writeRecord(tx, actor, e, "abscond", { lastSeenAt: seen.toISOString(), searched: input.searched, note: input.note ?? null, mlc }, at);
    const bay = await departIn(tx, actor, e, "absconded", seen, at);
    // Security (the roster's `er_abscond` target, else the guards); an MLC patient: the duty manager informs the police.
    const guards = (await escalationRecipients(tx, "er_abscond", { fallbackRoleKey: "security_guard" }, at)).userIds;
    for (const userId of guards) {
      await raiseNoticeIn(tx, {
        userId, kind: "er.absconded", title: `Patient absconded · ${e.episodeNo}`, body: `Last seen ${IST_TIME.format(seen)} IST`,
        refType: "er_episode", refId: e.id, sourceKey: `er_abscond:${e.id}`, at,
      });
    }
    if (mlc) {
      // Review #7: the duty manager (for the police) on the MLC ladder of its own — never the security ladder.
      const dms = (await escalationRecipients(tx, "er_abscond_mlc", { fallbackRoleKey: "duty_manager" }, at)).userIds;
      for (const userId of dms) {
        await raiseNoticeIn(tx, {
          userId, kind: "er.absconded_mlc", title: `MLC patient absconded · ${e.episodeNo}`, body: "Inform the police",
          refType: "er_episode", refId: e.id, sourceKey: `er_abscond_mlc:${e.id}`, at,
        });
      }
    }
    return { ...out(e, "absconded", seen, bay), securityAlerted: guards.length, policeToBeInformed: mlc };
  }), at);
}

// ═══════════════════════════════════════════ record_er_death ═══════════════════════════════════════════

export async function recordErDeathIntent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_er_death">> {
  const input: Input<"record_er_death"> = ER_INTENTS.record_er_death.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  const diedAt = timeNotFuture(input.diedAt, at);
  return onceEr(db, actor, "record_er_death", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await requireDoctor(tx, actor);
    const e = await lockEpisode(tx, input.episodeId);
    if (!["arrived", "triaged", "in_treatment", "disposition_decided"].includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (diedAt.getTime() < e.arrivedAt.getTime()) throw new ErRefusal("died_before_arrival");
    const m = await mlcOfEpisode(tx, e.id);
    if (input.mccdNo === undefined) {
      // 0018: the MCCD number — unless a medico-legal case already intimated to the police (the post-mortem decides).
      const intimated = m === undefined ? false : (await tx.select({ metAt: erMlcObligations.metAt }).from(erMlcObligations)
        .where(and(eq(erMlcObligations.mlcId, m.id), eq(erMlcObligations.kind, "police_intimation"))))[0]?.metAt != null;
      if (!intimated) throw new ErRefusal("mccd_required", { mlc: m !== undefined });
    }
    // Review #8: an unknown merged into the true record dies as the TRUE record (the merge chain's canonical patient).
    const patientId = (await personRecords(tx, e.patientId))?.canonicalId ?? e.patientId;
    await markPatientDeceased(tx, actor, patientId, diedAt, input.mccdNo === undefined ? { medicoLegal: true } : { mccdNo: input.mccdNo });
    const { entryId } = await openErMortuaryEntry(tx, actor, { erEpisodeId: e.id, patientId, diedAt, mlc: m !== undefined }, at);
    await writeRecord(tx, actor, e, "death", { diedAt: diedAt.toISOString(), mccdNo: input.mccdNo ?? null, note: input.note ?? null, mortuaryEntryId: entryId }, at);
    const bay = await departIn(tx, actor, e, "died", diedAt, at);
    return { ...out(e, "died", diedAt, bay), mortuaryEntryId: entryId, mlc: m !== undefined };
  }), at);
}
