import { and, eq, isNull, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labAnalytes, labCriticalCalls, labResults, orderItems, orders, patients,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { displayName, resolvePatientId } from "../patients";
import { LabError } from "./errors";
import { labCriticalAcknowledged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17b T6 / DD12 — **THE CALL LADDER**, and the one thing that closes it is a READ-BACK.
 *
 * ═══ 02 §3.6 — AN ATTEMPT IS NOT AN ACKNOWLEDGEMENT ═══
 *
 * A critical potassium is telephoned to the person looking after the patient, and the call is over
 * only when that person REPEATS THE VALUE BACK. Three unanswered rings, a message left with a ward
 * clerk and a bleep that nobody returned are all attempts, and a register that closed on any of
 * them would report a hospital where every critical value reached a clinician — which is precisely
 * the claim the read-back exists to make true rather than to assume.
 *
 * So `attempts` is an APPEND-ONLY jsonb array of `{at, by, contact, outcome}` and the row closes
 * only when `readback_text` is non-empty. `lab_critical_calls_closed_ck` enforces the triple
 * (`closed_at`, `readback_text`, `closed_by` — all three or none) at the table, independently.
 *
 * ═══ THE CALL NEVER CONSULTS THE DELIVERY INTERLOCK (E24) ═══
 *
 * An unpaid self-pay patient in the emergency department with a potassium of 6.8 is telephoned
 * exactly like everybody else. DD6's interlock holds a DOCUMENT; it has never held a fact, and the
 * one place that distinction could kill somebody is here.
 */

export const LAB_CRITICALS_CLOSE = "lab.criticals.close";

/** One rung of the ladder. Free-text `contact` because a ward extension is not an entity. */
export type CriticalAttempt = {
  at: string;
  by: string;
  contact: string;
  outcome: "no_answer" | "engaged" | "message_left" | "spoke";
};

export type AcknowledgeCriticalInput = {
  callId: string;
  /** A rung: recorded, and the call stays OPEN. */
  attempt?: { contact: string; outcome: CriticalAttempt["outcome"] };
  /** The words the clinician said back. Non-empty, and the ONLY thing that closes the call. */
  readback?: string;
};

export type AcknowledgeCriticalOutcome = {
  callId: string;
  resultId: string;
  attempts: number;
  closed: boolean;
};

export async function acknowledgeCritical(
  tx: Tx,
  actor: Actor,
  input: AcknowledgeCriticalInput,
  now: Date = new Date(),
): Promise<AcknowledgeCriticalOutcome> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not work a critical call`);
  }
  if (!(await hasPermission(tx as Db, actor.id, LAB_CRITICALS_CLOSE, "hospital"))) {
    throw new LabError("permission_denied", `working a critical call requires ${LAB_CRITICALS_CLOSE}`);
  }

  const [call] = await tx.select().from(labCriticalCalls)
    .where(eq(labCriticalCalls.id, input.callId));
  if (!call) throw new LabError("unknown_result", `no critical call ${input.callId}`);
  if (call.closedAt !== null) {
    throw new LabError(
      "critical_already_closed",
      `critical call ${input.callId} was closed at ${call.closedAt.toISOString()} with a read-back ` +
        "— a second read-back is a second call, and this one is over",
    );
  }

  const priorAttempts = call.attempts as CriticalAttempt[];
  const attempts = [...priorAttempts];
  if (input.attempt) {
    attempts.push({ at: now.toISOString(), by: actor.id, ...input.attempt });
  }

  const readback = input.readback?.trim() ?? "";
  if (readback === "") {
    /**
     * AN ATTEMPT ALONE LEAVES THE CALL OPEN, and the partial index on `closed_at IS NULL` is what a
     * shift handover reads. Recording the rung is not a formality: three failed attempts on a
     * potassium of 6.8 is the fact that has to be visible at 07:00 to whoever takes over.
     */
    if (!input.attempt) {
      throw new LabError(
        "catalogue_invalid",
        "acknowledging a critical call takes either an ATTEMPT or a READ-BACK — this call carries " +
          "neither, and a row that records nothing is not a rung",
      );
    }
    /**
     * ═══ THE APPEND IS A CAS TOO (CLOSE REVIEW m1) ═══
     *
     * `attempts` was read at the top of this function and written back here with no guard, so two
     * nurses recording rungs in the same minute lost one — and a rung racing the CLOSE could write
     * an attempt list over a call that had already been answered. The ladder is a medico-legal
     * record of who was telephoned and when; losing an entry from it is losing the evidence that
     * the hospital tried.
     *
     * `closed_at IS NULL` AND the exact `attempts` this call read: zero rows means somebody else
     * moved it, and the honest answer is to say so rather than to overwrite.
     */
    const appended = await tx
      .update(labCriticalCalls)
      .set({ attempts })
      .where(and(
        eq(labCriticalCalls.id, input.callId),
        isNull(labCriticalCalls.closedAt),
        eq(sql`jsonb_array_length(${labCriticalCalls.attempts})`, priorAttempts.length),
      ))
      .returning({ id: labCriticalCalls.id });
    if (appended.length === 0) {
      throw new LabError(
        "critical_already_closed",
        `critical call ${input.callId} was worked concurrently — re-read the ladder before adding ` +
          "another rung, because one of them would otherwise be lost",
      );
    }
    return { callId: input.callId, resultId: call.resultId, attempts: attempts.length, closed: false };
  }

  /**
   * ═══ THE CLOSE IS A COMPARE-AND-SET ON `closed_at IS NULL` ═══
   *
   * Two nurses reading back the same potassium in the same minute is an ordinary race on a busy
   * ward, and the loser is a conflict rather than a failure — `critical_already_closed` tells them
   * the call was already answered instead of writing a second closer over the first.
   */
  const won = await tx
    .update(labCriticalCalls)
    .set({ attempts, readbackText: readback, closedBy: actor.id, closedAt: now })
    .where(and(eq(labCriticalCalls.id, input.callId), isNull(labCriticalCalls.closedAt)))
    .returning({ id: labCriticalCalls.id });
  if (won.length === 0) {
    throw new LabError(
      "critical_already_closed",
      `critical call ${input.callId} was closed concurrently by another caller`,
    );
  }

  /**
   * THE SUBJECT IS READ WITH A PLAIN JOIN AND **NOT** WITH `resultContext`. That helper asserts the
   * item is still RESULTABLE, which is right for entry and wrong here: a read-back arrives at 09:00
   * for a potassium keyed at 02:00, by which time the item is very often `completed` — and a call
   * that could not be closed once the work finished is a register that stays open for ever.
   */
  const [subject] = await tx
    .select({ patientId: orders.patientId, encounterNo: orders.encounterNo, orderId: orders.id })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(labResults.id, call.resultId));
  const patientId = subject ? (await resolvePatientId(tx, subject.patientId)) ?? subject.patientId : undefined;

  await appendEvent(tx, labCriticalAcknowledged.make({
    actor,
    patientId,
    encounterId: subject?.encounterNo,
    correlationId: subject?.orderId ?? call.resultId,
    payload: {
      callId: input.callId, resultId: call.resultId, closedBy: actor.id,
      attempts: attempts.length, at: now.toISOString(),
    },
  }));

  return { callId: input.callId, resultId: call.resultId, attempts: attempts.length, closed: true };
}

export type OpenCriticalCall = {
  id: string;
  resultId: string;
  openedAt: string;
  openedBy: string;
  attempts: CriticalAttempt[];
  /** WHOSE potassium it is, and WHAT it was. A ladder without a patient is a ladder nobody can work. */
  patientDisplay: string;
  patientId: string;
  orderNo: string;
  encounterNo: string;
  analyteCode: string;
  value: string;
  unit: string | null;
  flag: string | null;
};

/**
 * ═══ THE OPEN LADDER — WHAT A SHIFT HANDOVER READS, AND IT NAMES THE PATIENT ═══
 *
 * It used to return the bare `lab_critical_calls` rows: an id, an instant and an attempts array,
 * with no patient, no test and no value. **A nurse cannot telephone anybody from that** — and the
 * screen built on it shared one contact/read-back field across every open call, so a read-back
 * typed for one patient could close a different patient's call by CAS (close review, web C5). The
 * reader is widened here rather than on the screen, because the screen must not be the thing that
 * knows which patient a critical value belongs to.
 *
 * `displayName` with the CALLER's own clearance: a sealed patient's ladder shows the alias, and a
 * technologist telephoning about "Patient A" is what DD14 requires of every other reader here.
 */
export async function openCriticalCalls(db: Db, actor: Actor): Promise<OpenCriticalCall[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read the critical ladder`);
  }
  if (!(await hasPermission(db, actor.id, LAB_CRITICALS_CLOSE, "hospital"))) {
    throw new LabError("permission_denied", `reading the critical ladder requires ${LAB_CRITICALS_CLOSE}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const rows = await db
    .select({
      call: labCriticalCalls,
      result: labResults,
      analyteCode: labAnalytes.code,
      orderNo: orders.orderNo,
      encounterNo: orders.encounterNo,
      patientId: orders.patientId,
      patientName: patients.name,
      patientAlias: patients.alias,
      patientConfidential: patients.isConfidential,
    })
    .from(labCriticalCalls)
    .innerJoin(labResults, eq(labResults.id, labCriticalCalls.resultId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(isNull(labCriticalCalls.closedAt))
    .orderBy(labCriticalCalls.openedAt);

  return rows.map((r) => ({
    id: r.call.id,
    resultId: r.call.resultId,
    openedAt: r.call.openedAt.toISOString(),
    openedBy: r.call.openedBy,
    attempts: r.call.attempts as CriticalAttempt[],
    patientDisplay: displayName(
      { name: r.patientName, alias: r.patientAlias, isConfidential: r.patientConfidential },
      canSeeConfidential,
    ),
    patientId: r.patientId,
    orderNo: r.orderNo,
    encounterNo: r.encounterNo,
    analyteCode: r.analyteCode,
    value: r.result.valueNumeric ?? r.result.valueText ?? r.result.valueCoded ?? "",
    unit: r.result.unit,
    flag: r.result.flag,
  }));
}
