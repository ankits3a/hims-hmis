import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  ER_DOOR_TO_TRIAGE_MINUTES, ER_ESI_INFO, ER_INTENTS, ER_RETRIAGE_CLIMB_MIN, erIsInFuture, esiAlgorithm, isDownTriage, newId,
} from "@hmis/contracts";
import { ewsBandRank, scoreEws } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { erEpisodes, erTriageEntries, resources, roleAssignments, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { IpdRefusal, lockBedsInOrder, placeErEpisodeIn, releaseErBayIn } from "../ipd";
import { escalationRecipients, orgDepartmentByCode, unitOnTake } from "../roster";
import { cancelTask, getTask, raiseTask } from "../tasks";
import { getPatientSummaries } from "../patients";
import { lockEpisode, moveEpisode, onceEr, provenanceOf, requireErPermission, yearsOld } from "./core";
import { ErRefusal } from "./errors";
import { erDoctorAssigned, erMoved, erPlaced, erRetriaged, erTriaged, erVitalsRecorded } from "./events";
import { ER_TRIAGE } from "./names";
import { ER_RETRIAGE_TASK, ER_TRIAGE_DUE_TASK } from "./task-kinds";
import type { Actor, ErEsiDecision, ErEsiLevel, ErEws, ErIntentName, ErVitals } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 2 (#809) — TRIAGE, BAYS AND THE DOCTOR (spec SPEC-emergency §3.1–§3.3, §4.2; contracts
 * `packages/contracts/src/emergency/triage.ts`). The lane-1 shape: parse → permission → once → lock → rules → write.
 *
 * Rules this file owns:
 * - ESI v4; the level is the person's choice. A level LESS urgent than the algorithm's proposal or the last level needs
 *   a reason; an up-triage never does.
 * - The re-triage clock runs from each triage by level (ESI 2: 15 min … ESI 5: 120; ESI 1 none) until a doctor has
 *   seen the patient. A vital set with a WORSE early-warning band than the last pulls it to now.
 * - Overdue: one task (`er_retriage`, per due instant), then ONE climb 15 minutes later through the roster ladder.
 * - The take (seam E2): the specialty given at triage is stamped with the unit on take at the GATE instant.
 * - Bays: emergency-class beds through the IPD bed seam (same lock); one bay per patient; "already in R-3" for a second.
 * - Care is never gated: nothing here reads money, identity status or MLC.
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

const MIN = 60_000;
export const ER_CLOCK_ACTOR: Actor = { type: "system", id: "er-triage-clock" };
/** DECIDED (lane 2): an overdue re-triage climbs to the nursing supervisor's holders until a roster row names a position. */
export const ER_RETRIAGE_FALLBACK_ROLE = "nursing_supervisor";

const at$ = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function retriageDue(level: ErEsiLevel, from: Date): Date | null {
  const m = ER_ESI_INFO[level].retriageMin;
  return m === null ? null : new Date(from.getTime() + m * MIN);
}

function doctorDue(level: ErEsiLevel, arrivedAt: Date): Date {
  return new Date(arrivedAt.getTime() + ER_ESI_INFO[level].doctorWithinMin * MIN);
}

/** The early-warning score of a vital set, by the IPD export (PEWS under 16, MEOWS when obstetric, NEWS2 otherwise). */
async function scoreFor(db: Db, actor: Actor, e: EpisodeRow, vitals: ErVitals | undefined, obstetric: boolean | undefined, at: Date): Promise<ErEws | null> {
  if (vitals === undefined || Object.keys(vitals).length === 0) return null;
  const [p] = await getPatientSummaries(db, actor, [e.patientId]);
  const age = yearsOld(p?.dob ?? null, at) ?? (e.ageBand === "infant" ? 0 : e.ageBand === "child" ? 6 : e.ageBand === "teen" ? 15 : null);
  const kind = age !== null && age < 16 ? "pews" : obstetric === true ? "meows" : "news2";
  const s = scoreEws(kind, vitals, age);
  return { kind: s.kind, value: s.value, band: s.band };
}

/** Closes the open re-triage task, if any (the act it asked for happened). In the caller's transaction. */
async function closeRetriageTask(tx: Tx, e: EpisodeRow, why: string, at: Date): Promise<void> {
  if (e.retriageTaskId === null) return;
  const t = await getTask(tx, e.retriageTaskId);
  if (t === null || !["created", "assigned", "accepted", "in_progress"].includes(t.state)) return;
  await cancelTask(tx, ER_CLOCK_ACTOR, { taskId: t.id, version: t.version, reason: why }, at);
}

function downTriageCheck(level: ErEsiLevel, algorithm: ErEsiLevel | null, last: ErEsiLevel | null, reason: string | undefined): boolean {
  const down = isDownTriage(level, algorithm) || isDownTriage(level, last);
  if (down && reason === undefined) {
    throw new ErRefusal("down_triage_needs_reason", { level, algorithmLevel: algorithm, lastLevel: last });
  }
  return down;
}

async function takeFor(tx: Tx, departmentCode: string | undefined, gate: Date): Promise<{ departmentCode: string; departmentId: string; teamId: string | null; source: "published" | "none" } | null> {
  if (departmentCode === undefined) return null;
  const dept = await orgDepartmentByCode(tx, departmentCode.toUpperCase());
  if (dept === undefined) throw new ErRefusal("department_not_found", { departmentCode });
  const take = await unitOnTake(tx, dept.id, gate);
  return { departmentCode: dept.code, departmentId: dept.id, teamId: take.teamId, source: take.source };
}

type Common = { level: ErEsiLevel; decision?: ErEsiDecision; reason?: string; vitals?: ErVitals; obstetric?: boolean };

/** The shared triage / re-triage write: the entry row, the episode mirror, the clock and the task. */
async function writeTriage(
  db: Db, tx: Tx, actor: Actor, e: EpisodeRow, kind: "triage" | "re_triage", input: Common, at: Date, ews: ErEws | null,
): Promise<{ algorithm: ErEsiLevel | null; down: boolean; retriageAt: Date | null }> {
  const algorithm = input.decision === undefined ? null : esiAlgorithm(input.decision).level;
  const down = downTriageCheck(input.level, algorithm, (e.esi ?? null) as ErEsiLevel | null, input.reason);
  // Until a doctor has seen the patient the clock runs; after, the doctor watches them (lane 3's clocks).
  const retriageAt = e.seenAt === null && e.state !== "in_treatment" ? retriageDue(input.level, at) : null;
  await tx.insert(erTriageEntries).values({
    id: newId(), episodeId: e.id, kind, level: input.level, algorithmLevel: algorithm,
    decision: input.decision ?? null, reason: input.reason ?? null, vitals: input.vitals ?? null,
    ewsKind: ews?.kind ?? null, ewsValue: ews?.value ?? null, ewsBand: ews?.band ?? null,
    recordedBy: actor.id, recordedAt: at, takenAt: at, provenance: provenanceOf(actor),
  });
  await closeRetriageTask(tx, e, kind === "triage" ? "triaged" : "re-triaged", at);
  return { algorithm, down, retriageAt };
}

// ═══════════════════════════════════════════ triage ═══════════════════════════════════════════

export async function triage(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"triage">> {
  const input: Input<"triage"> = ER_INTENTS.triage.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "triage", input.idempotencyKey, input, async () => {
    const pre = await lockFree(db, input.episodeId);
    const ews = await scoreFor(db, actor, pre, input.vitals, input.obstetric, at);
    return withTx(db, async (tx) => {
      const e = await lockEpisode(tx, input.episodeId);
      if (e.state !== "arrived") throw new ErRefusal("episode_wrong_state", { state: e.state });
      const take = await takeFor(tx, input.departmentCode, e.arrivedAt);
      const w = await writeTriage(db, tx, actor, e, "triage", input, at, ews);
      await moveEpisode(tx, actor, e, "triaged", at, {
        esi: input.level, triagedAt: at, lastTriageAt: at, retriageDueAt: w.retriageAt,
        ...(ews === null ? {} : { ewsKind: ews.kind, ewsValue: ews.value, ewsBand: ews.band }),
        ...(take === null ? {} : { takeDepartmentId: take.departmentId, takeTeamId: take.teamId, takeSource: take.source }),
      });
      await appendEvent(tx, erTriaged.make({
        payload: {
          episodeId: e.id, level: input.level, algorithmLevel: w.algorithm, downTriage: w.down, triagedAt: at.toISOString(),
          takeTeamId: take?.teamId ?? null, provenance: provenanceOf(actor),
        },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return {
        episodeId: e.id, level: input.level, algorithmLevel: w.algorithm, downTriage: w.down, retriageDueAt: at$(w.retriageAt),
        doctorDueAt: doctorDue(input.level, e.arrivedAt).toISOString(), ews,
        take: take === null ? null : { departmentCode: take.departmentCode, teamId: take.teamId, source: take.source },
      };
    });
  }, at);
}

/** Reads the episode outside the transaction (the score needs the patient's age before the locks are taken). */
async function lockFree(db: Db, episodeId: string): Promise<EpisodeRow> {
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  return e;
}

export async function reTriage(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"re_triage">> {
  const input: Input<"re_triage"> = ER_INTENTS.re_triage.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "re_triage", input.idempotencyKey, input, async () => {
    const pre = await lockFree(db, input.episodeId);
    const ews = await scoreFor(db, actor, pre, input.vitals, input.obstetric, at);
    return withTx(db, async (tx) => {
      const e = await lockEpisode(tx, input.episodeId);
      if (e.state !== "triaged" && e.state !== "in_treatment") throw new ErRefusal("episode_wrong_state", { state: e.state });
      const w = await writeTriage(db, tx, actor, e, "re_triage", input, at, ews);
      await tx.update(erEpisodes).set({
        esi: input.level, lastTriageAt: at, retriageDueAt: w.retriageAt, updatedAt: at,
        ...(ews === null ? {} : { ewsKind: ews.kind, ewsValue: ews.value, ewsBand: ews.band }),
      }).where(eq(erEpisodes.id, e.id));
      await appendEvent(tx, erRetriaged.make({
        payload: {
          episodeId: e.id, level: input.level, fromLevel: e.esi, algorithmLevel: w.algorithm, downTriage: w.down,
          provenance: provenanceOf(actor),
        },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return {
        episodeId: e.id, level: input.level, algorithmLevel: w.algorithm, downTriage: w.down, retriageDueAt: at$(w.retriageAt),
        doctorDueAt: doctorDue(input.level, e.arrivedAt).toISOString(), ews, take: null,
      };
    });
  }, at);
}

// ═══════════════════════════════════════════ vitals ═══════════════════════════════════════════

export async function recordErVitals(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_er_vitals">> {
  const input: Input<"record_er_vitals"> = ER_INTENTS.record_er_vitals.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  if (input.takenAt !== undefined && erIsInFuture(input.takenAt, at)) throw new ErRefusal("time_in_future");
  const takenAt = input.takenAt === undefined ? at : new Date(Math.min(new Date(input.takenAt).getTime(), at.getTime()));
  return onceEr(db, actor, "record_er_vitals", input.idempotencyKey, input, async () => {
    const pre = await lockFree(db, input.episodeId);
    const ews = (await scoreFor(db, actor, pre, input.vitals, input.obstetric, at))!;
    return withTx(db, async (tx) => {
      const e = await lockEpisode(tx, input.episodeId);
      if (!["arrived", "triaged", "in_treatment", "disposition_decided"].includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
      const worse = e.ewsBand !== null && ewsBandRank(ews.band) > ewsBandRank(e.ewsBand as ErEws["band"]);
      // A worse set re-triages AT ONCE while the clock runs (triaged, not yet seen): the due instant is now.
      const retriageAt = worse && e.state === "triaged" && e.retriageDueAt !== null && e.retriageDueAt.getTime() > at.getTime() ? at : e.retriageDueAt;
      await tx.insert(erTriageEntries).values({
        id: newId(), episodeId: e.id, kind: "vitals", level: null, algorithmLevel: null, decision: null, reason: null,
        vitals: input.vitals, ewsKind: ews.kind, ewsValue: ews.value, ewsBand: ews.band,
        recordedBy: actor.id, recordedAt: at, takenAt, provenance: provenanceOf(actor),
      });
      await tx.update(erEpisodes).set({ ewsKind: ews.kind, ewsValue: ews.value, ewsBand: ews.band, retriageDueAt: retriageAt, updatedAt: at })
        .where(eq(erEpisodes.id, e.id));
      await appendEvent(tx, erVitalsRecorded.make({
        payload: { episodeId: e.id, ewsKind: ews.kind, ewsValue: ews.value, ewsBand: ews.band, worse, provenance: provenanceOf(actor) },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return { episodeId: e.id, ews, worse, retriageDueAt: at$(retriageAt) };
    });
  }, at);
}

// ═══════════════════════════════════════════ bays ═══════════════════════════════════════════

const OPEN_STATES = ["arrived", "triaged", "in_treatment", "disposition_decided"];

/** IPD bed-seam refusals in ER words. */
function bayRefusal(e: unknown): unknown {
  if (!(e instanceof IpdRefusal)) return e;
  if (e.code === "bed_not_found") return new ErRefusal("bay_not_found");
  if (e.code === "bed_class_mismatch") return new ErRefusal("bay_not_emergency");
  if (e.code === "bed_retired" || e.code === "bed_not_available" || e.code === "repair_ticket_open") {
    return new ErRefusal("bay_not_available", { why: e.bedRule ?? e.code });
  }
  return e;
}

async function bayCode(tx: Tx, bedId: string | null): Promise<string | null> {
  if (bedId === null) return null;
  return (await tx.select({ code: resources.code }).from(resources).where(eq(resources.id, bedId)))[0]?.code ?? null;
}

/**
 * LOCK ORDER: the episode (advisory, then its row), then the bed's room and the bed (the IPD seam). Two nurses placing
 * one patient in two bays: the second waits on the episode, then sees `already_in_bay` with the first bay's code.
 */
export async function placeInBay(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"place_in_bay">> {
  const input: Input<"place_in_bay"> = ER_INTENTS.place_in_bay.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "place_in_bay", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!OPEN_STATES.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (e.bayId !== null) throw new ErRefusal("already_in_bay", { bedId: e.bayId, bayCode: await bayCode(tx, e.bayId) });
    let placed: { bedId: string; bedCode: string };
    try { placed = await placeErEpisodeIn(tx, actor, { bedId: input.bedId, episodeId: e.id }, at); } catch (err) { throw bayRefusal(err); }
    await tx.update(erEpisodes).set({ bayId: placed.bedId, updatedAt: at }).where(eq(erEpisodes.id, e.id));
    await appendEvent(tx, erPlaced.make({
      payload: { episodeId: e.id, bedId: placed.bedId, bayCode: placed.bedCode, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { episodeId: e.id, bedId: placed.bedId, bayCode: placed.bedCode };
  }), at);
}

/** A move within the ER: the new bay is taken first, then the old one goes to cleaning — never a moment in no bay. */
export async function moveBay(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"move_bay">> {
  const input: Input<"move_bay"> = ER_INTENTS.move_bay.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "move_bay", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!OPEN_STATES.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (e.bayId === null) throw new ErRefusal("not_in_bay");
    if (e.bayId === input.bedId) throw new ErRefusal("same_bay");
    const from = e.bayId;
    let placed: { bedId: string; bedCode: string };
    try {
      // Both beds (and their zones) in one global order first, as the IPD transfer does: two opposite moves between
      // two zones would otherwise each hold one zone and wait for the other (a deadlock).
      await lockBedsInOrder(tx, [from, input.bedId]);
      placed = await placeErEpisodeIn(tx, actor, { bedId: input.bedId, episodeId: e.id }, at);
      await releaseErBayIn(tx, actor, { bedId: from, episodeId: e.id }, at);
    } catch (err) { throw bayRefusal(err); }
    await tx.update(erEpisodes).set({ bayId: placed.bedId, updatedAt: at }).where(eq(erEpisodes.id, e.id));
    await appendEvent(tx, erMoved.make({
      payload: { episodeId: e.id, fromBedId: from, bedId: placed.bedId, bayCode: placed.bedCode, reason: input.reason ?? null, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { episodeId: e.id, bedId: placed.bedId, bayCode: placed.bedCode, fromBedId: from };
  }), at);
}

// ═══════════════════════════════════════════ the doctor ═══════════════════════════════════════════

async function isActiveDoctor(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.select({ id: users.id }).from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(and(eq(users.id, userId), eq(users.active, true), eq(roleAssignments.roleKey, "doctor"))).limit(1);
  return rows.length > 0;
}

export async function assignErDoctor(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"assign_er_doctor">> {
  const input: Input<"assign_er_doctor"> = ER_INTENTS.assign_er_doctor.input.parse(raw);
  await requireErPermission(db, actor, ER_TRIAGE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "assign_er_doctor", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await lockEpisode(tx, input.episodeId);
    if (!OPEN_STATES.includes(e.state) || e.state === "disposition_decided") throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (!(await isActiveDoctor(tx, input.doctorId))) throw new ErRefusal("not_a_doctor", { doctorId: input.doctorId });
    const seenAt = e.seenAt ?? at;
    if (e.state === "in_treatment") {
      await tx.update(erEpisodes).set({ doctorId: input.doctorId, updatedAt: at }).where(eq(erEpisodes.id, e.id));
    } else {
      // Seen by a doctor: the door-to-doctor clock stops, and the re-triage clock with it.
      await closeRetriageTask(tx, e, "seen by a doctor", at);
      await moveEpisode(tx, actor, e, "in_treatment", at, { doctorId: input.doctorId, seenAt, retriageDueAt: null });
    }
    await appendEvent(tx, erDoctorAssigned.make({
      payload: {
        episodeId: e.id, doctorId: input.doctorId, firstSeen: e.seenAt === null, seenAt: seenAt.toISOString(),
        doorToDoctorMin: Math.max(0, Math.round((seenAt.getTime() - e.arrivedAt.getTime()) / MIN)), provenance: provenanceOf(actor),
      },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { episodeId: e.id, doctorId: input.doctorId, seenAt: seenAt.toISOString(), state: "in_treatment" as const };
  }), at);
}

// ═══════════════════════════════════════════ the re-triage clock ═══════════════════════════════════════════

/**
 * Every minute (inside the bed-reservation lapse job, beside the pre-alert lapse). Two clocks, ONE ladder (spec §0: a
 * breached clock is a task with an owner):
 * - door-to-triage: an `arrived` patient not triaged 5 minutes after the GATE → task `er_triage_due` (stat);
 * - re-triage: a `triaged` patient past the re-triage instant → task `er_retriage` (urgent).
 * Each raises ONE task per due instant (`sourceRef`; stamped on the episode) and, 15 minutes after the due instant, ONE
 * climb through the roster ladder (`er_retriage`; the nursing supervisor's holders when no roster row names a position).
 * The act the task asks for (triage, re-triage, the doctor) cancels it. Notices carry the ER number, never a name.
 * The two clocks share the episode's stamps: an episode is in one state, so only one of them can be running.
 */
export async function sweepErTriageClocks(db: Db, now: Date): Promise<{ tasks: number; climbs: number }> {
  const triageCutoff = new Date(now.getTime() - ER_DOOR_TO_TRIAGE_MINUTES * MIN);
  const due = await db.select({ id: erEpisodes.id }).from(erEpisodes).where(or(
    // ER review (2026-10-15): an episode already climbed for its CURRENT due instant has nothing left to raise — it is
    // left out here, so a stale episode costs no transaction and no row lock every minute.
    and(eq(erEpisodes.state, "triaged"), isNotNull(erEpisodes.retriageDueAt), lte(erEpisodes.retriageDueAt, now),
      sql`${erEpisodes.retriageClimbedDueAt} is distinct from ${erEpisodes.retriageDueAt}`),
    and(eq(erEpisodes.state, "arrived"), lte(erEpisodes.arrivedAt, triageCutoff),
      sql`${erEpisodes.retriageClimbedDueAt} is distinct from ${erEpisodes.arrivedAt} + make_interval(mins => ${ER_DOOR_TO_TRIAGE_MINUTES})`),
  ));
  let tasks = 0;
  let climbs = 0;
  for (const { id } of due) {
    const r = await withTx(db, async (tx) => {
      const e = await lockEpisode(tx, id);
      const clock = clockOf(e);
      if (clock === null || clock.dueAt.getTime() > now.getTime()) return { t: 0, c: 0 };
      const { dueAt } = clock;
      let t = 0;
      let c = 0;
      if (e.retriageTaskDueAt?.getTime() !== dueAt.getTime()) {
        const raised = await raiseTask(tx, ER_CLOCK_ACTOR, {
          kind: clock.kind, patientId: e.patientId, placeResourceId: e.bayId, priority: clock.priority,
          dueAt: dueAt.toISOString(), sourceRef: `${clock.ref}:${e.id}:${dueAt.toISOString()}`,
          note: clock.note, raisedAt: dueAt.toISOString(),
        }, now);
        await tx.update(erEpisodes).set({ retriageTaskId: raised.task.id, retriageTaskDueAt: dueAt }).where(eq(erEpisodes.id, e.id));
        t = 1;
      }
      const climbAt = dueAt.getTime() + ER_RETRIAGE_CLIMB_MIN * MIN;
      if (now.getTime() >= climbAt && e.retriageClimbedDueAt?.getTime() !== dueAt.getTime()) {
        const to = await escalationRecipients(tx, "er_retriage", { fallbackRoleKey: ER_RETRIAGE_FALLBACK_ROLE }, now);
        const late = String(Math.round((now.getTime() - dueAt.getTime()) / MIN));
        for (const userId of to.userIds) {
          await raiseNoticeIn(tx, {
            userId, kind: clock.noticeKind, title: `${clock.title} · ${e.episodeNo}`, body: `${clock.body} · due ${late} min ago`,
            refType: "er_episode", refId: e.id, sourceKey: `${clock.ref}:${e.id}:${dueAt.toISOString()}:climb`, at: now,
          });
        }
        await tx.update(erEpisodes).set({ retriageClimbedDueAt: dueAt }).where(eq(erEpisodes.id, e.id));
        c = 1;
      }
      return { t, c };
    });
    tasks += r.t;
    climbs += r.c;
  }
  return { tasks, climbs };
}

type Clock = {
  kind: string; ref: string; dueAt: Date; priority: "stat" | "urgent"; note: string;
  noticeKind: string; title: string; body: string;
};

/** The clock an episode runs now: door-to-triage while `arrived`, re-triage while `triaged`; none otherwise. */
function clockOf(e: EpisodeRow): Clock | null {
  if (e.state === "arrived") {
    return {
      kind: ER_TRIAGE_DUE_TASK, ref: "er_triage", dueAt: new Date(e.arrivedAt.getTime() + ER_DOOR_TO_TRIAGE_MINUTES * MIN),
      priority: "stat", note: `Triage ${e.episodeNo}`, noticeKind: "er.triage_overdue", title: "Triage overdue", body: "Not triaged",
    };
  }
  if (e.state === "triaged" && e.retriageDueAt !== null) {
    return {
      kind: ER_RETRIAGE_TASK, ref: "er_retriage", dueAt: e.retriageDueAt, priority: "urgent",
      note: `Re-triage ${e.episodeNo} (ESI ${String(e.esi)})`, noticeKind: "er.retriage_overdue", title: "Re-triage overdue", body: `ESI ${String(e.esi)}`,
    };
  }
  return null;
}
