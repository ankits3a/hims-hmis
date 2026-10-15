import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { ER_INTENTS, erIsInFuture, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { erChargeLines, erDepartureRecords, erEpisodes, erMlcObligations, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import {
  IpdError, IpdRefusal, carryErOrderLinesIn, emergencyAdmit, erAdmissionState, openErMortuaryEntry, releaseErBayIn, requestAdmission,
  stampErHandOffIn,
} from "../ipd";
import { recordErDeath as markPatientDeceased } from "../patients";
import { escalationRecipients } from "../roster";
import { cancelTask, getTask } from "../tasks";
import { lockEpisode, moveEpisode, onceEr, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { erDeparted, erDispositionDecided, erHandedToUnit } from "./events";
import { rollErLinesIn } from "./bill";
import { mlcOfEpisode } from "./mlc";
import { ER_DISPOSITION } from "./names";
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
    if (e.disposition !== disposition) throw new ErRefusal("disposition_mismatch", { decided: e.disposition, asked: disposition });
    return e;
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
  if (e.retriageTaskId !== null) {
    const t = await getTask(tx, e.retriageTaskId);
    if (t !== null && OPEN_TASK.includes(t.state)) await cancelTask(tx, ER_DISPO_ACTOR, { taskId: t.id, version: t.version, reason: `departed: ${outcome}` }, at);
  }
  if (e.bayId !== null) await releaseErBayIn(tx, actor, { bedId: e.bayId, episodeId: e.id }, at);
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
    const e = await lockEpisode(tx, input.episodeId);
    if (e.state === "disposition_decided") throw new ErRefusal("disposition_already_decided", { disposition: e.disposition });
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
  await rollErLinesIn(tx, actor, e, admissionId, at); // lane 6 (#813): every other ER line rolls into the IP bill too
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
  return departIn(tx, actor, { ...e, admissionId }, "admitted", at, at);
}

export async function handToUnit(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"hand_to_unit">> {
  const input: Input<"hand_to_unit"> = ER_INTENTS.hand_to_unit.input.parse(raw);
  await requireErPermission(db, actor, ER_DISPOSITION);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "hand_to_unit", input.idempotencyKey, input, async () => {
    // The checks that can refuse BEFORE the admission is raised (re-made under the lock below).
    const pre = await readEpisode(db, input.episodeId);
    await withTx(db, (tx) => requireDoctor(tx, actor));
    if (pre.boardingSince !== null) throw new ErRefusal("already_boarding", { admissionId: pre.admissionId });
    if (pre.state === "disposition_decided" && pre.disposition !== "admit") throw new ErRefusal("disposition_mismatch", { decided: pre.disposition, asked: "admit" });
    if (pre.state !== "disposition_decided" && pre.state !== "in_treatment") throw new ErRefusal("episode_wrong_state", { state: pre.state });
    if (pre.state === "in_treatment" && input.reason === undefined) throw new ErRefusal("disposition_reason_needed");
    const mlc = (await mlcOfEpisode(db, pre.id)) !== undefined;
    // The admission, through IPD's own intent (its own transaction and idempotency: a retry finds the same admission).
    let admissionId: string;
    let admissionNo: string | null = null;
    try {
      if (input.bedId !== undefined) {
        const r = await emergencyAdmit(db, actor, {
          idempotencyKey: input.idempotencyKey, patientId: pre.patientId, bedId: input.bedId, consultantId: input.consultantId,
          isolation: input.isolation, provisionalDiagnosis: input.provisionalDiagnosis, mlc,
        }, { now: at });
        admissionId = r.admissionId;
        admissionNo = r.admissionNo;
      } else {
        const r = await requestAdmission(db, actor, {
          idempotencyKey: input.idempotencyKey, patientId: pre.patientId, source: "er", sourceRef: pre.id, consultantId: input.consultantId,
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
      if (e.boardingSince !== null) throw new ErRefusal("already_boarding", { admissionId: e.admissionId });
      await stampErHandOffIn(tx, { admissionId, erArrivedAt: e.arrivedAt, stabilisedAt: e.stabilisedAt });
      const boarding = input.bedId === undefined;
      await tx.update(erEpisodes).set({ admissionId, boardingSince: boarding ? at : null, updatedAt: at }).where(eq(erEpisodes.id, e.id));
      await writeRecord(tx, actor, e, "admission", {
        admissionId, consultantId: input.consultantId, department: input.department ?? null, requestedClass: input.requestedClass,
        provisionalDiagnosis: input.provisionalDiagnosis, bedId: input.bedId ?? null,
      }, at);
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
export async function sweepErBoarding(db: Db, now: Date): Promise<{ departed: number; lapsed: number }> {
  const res = { departed: 0, lapsed: 0 };
  const boarding = await db.select({ id: erEpisodes.id, admissionId: erEpisodes.admissionId }).from(erEpisodes)
    .where(and(eq(erEpisodes.state, "disposition_decided"), isNotNull(erEpisodes.boardingSince)));
  for (const b of boarding) {
    if (b.admissionId === null) continue;
    const state = await erAdmissionState(db, b.admissionId);
    if (state === "requested" || state === "reserved" || state === null) continue;
    await withTx(db, async (tx) => {
      const e = await lockEpisode(tx, b.id);
      if (e.state !== "disposition_decided" || e.boardingSince === null || e.admissionId !== b.admissionId) return;
      if (state === "cancelled") {
        await tx.update(erEpisodes).set({ boardingSince: null, updatedAt: now }).where(eq(erEpisodes.id, e.id));
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
        userId, kind: "er.absconded", title: `Patient absconded · ${e.episodeNo}`, body: `Last seen ${seen.toISOString().slice(11, 16)} UTC`,
        refType: "er_episode", refId: e.id, sourceKey: `er_abscond:${e.id}`, at,
      });
    }
    if (mlc) {
      const dms = (await escalationRecipients(tx, "er_abscond", { fallbackRoleKey: "duty_manager" }, at)).userIds;
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
    await markPatientDeceased(tx, actor, e.patientId, diedAt, input.mccdNo === undefined ? { medicoLegal: true } : { mccdNo: input.mccdNo });
    const { entryId } = await openErMortuaryEntry(tx, actor, { erEpisodeId: e.id, patientId: e.patientId, diedAt, mlc: m !== undefined }, at);
    await writeRecord(tx, actor, e, "death", { diedAt: diedAt.toISOString(), mccdNo: input.mccdNo ?? null, note: input.note ?? null, mortuaryEntryId: entryId }, at);
    const bay = await departIn(tx, actor, e, "died", diedAt, at);
    return { ...out(e, "died", diedAt, bay), mortuaryEntryId: entryId, mlc: m !== undefined };
  }), at);
}
