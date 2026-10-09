import { and, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { consultFeeAt, issueInvoice, standingInvoiceFor } from "../billing";
import { getPatientSummaries } from "../patients";
import { requireTreatingDoctor } from "./consultation";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visitAbandoned } from "./events";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * TELE-CALL — THE DOCTOR'S HALF: THE CALL, AND WHAT CAME OF IT (owner 2026-10-09)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The doctor rings from their own mobile; the system is told two things and nothing else.
 *
 *   call      the number to dial is handed over HERE and only here — not on the queue row, not on
 *             the visit read — and the hand-over is recorded as a contact disclosure, like every
 *             other read of a patient's telephone. The first call stamps `tele_call_started_at`.
 *   outcome   'spoke' — once. It is what unlocks Complete and the prescription (the guards are in
 *             `consultation.ts` and `prescriptions.ts`), and it is when the bill is raised.
 *             'no_answer' — the first sends the visit back to the doctor's line, at the end of the
 *             appointments already due, to be tried again; the second closes the visit as not
 *             consulted and puts the appointment on the desk's re-booking list WITH ITS PAYMENT
 *             (*"'No answer' by patient: carried to a re-booked slot."*).
 *
 * THE BILL IS RAISED AT 'spoke', NEVER BEFORE — so a call nobody answered has nothing to reverse.
 * It is the ordinary consultation invoice on this visit, settled from the advance the desk took
 * (`settleFromReceipts`); the receipt still names the cashier who took the money, the invoice names
 * the system. *"Bill at slot time: automatic; receipt already names the cashier."*
 *
 * NOTHING HERE ANSWERS A DOCTOR WITH A MONEY WORD. The routes return the visit and, for a call, the
 * number; whether a bill was raised is this file's own business.
 */
const TELE_BILL_ACTOR: Actor = { type: "system", id: "opd-tele-bill" };
const TELE_CLOSE_ACTOR: Actor = { type: "system", id: "opd-tele-no-answer" };
export const TELE_NO_ANSWER_REASON = "tele-call: the patient did not answer twice";
const FEE_LINE_ID = "fee";

async function teleVisitFor(db: Db, actor: Actor, encounterId: string): Promise<EncounterRow> {
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, enc);
  if (enc.consultMode !== "tele") throw new OpdError("not_a_tele_visit", "this visit is not a tele-call");
  if (enc.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `a tele-call is made in consultation, not ${enc.status}`);
  }
  return enc;
}

/**
 * The slot a tele visit was booked for — what the doctor's card prints beside the phone icon. Null
 * for every other visit. (The queue entry's `appointment_at` is not it: after a first "no answer"
 * that holds the moment the visit went back to the line.)
 */
export async function teleSlotOf(db: Db, enc: Pick<EncounterRow, "consultMode" | "appointmentId">): Promise<Date | null> {
  if (enc.consultMode !== "tele" || enc.appointmentId === null) return null;
  return (await db.select({ slotStart: opdAppointments.slotStart }).from(opdAppointments).where(eq(opdAppointments.id, enc.appointmentId)))[0]?.slotStart ?? null;
}

export type TeleCall = { encounterId: string; telePhone: string | null; callStartedAt: Date };

/** The doctor is about to dial: the number, and the first-call stamp. */
export async function startTeleCall(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<TeleCall> {
  const enc = await teleVisitFor(db, actor, encounterId);
  const appt = enc.appointmentId === null ? undefined
    : (await db.select({ telePhone: opdAppointments.telePhone }).from(opdAppointments).where(eq(opdAppointments.id, enc.appointmentId)))[0];
  // The disclosure is recorded by the patients module, with its reason — the same road the desk's re-booking rail takes.
  await getPatientSummaries(db, actor, [enc.patientId], { withContact: { reason: `tele-call: the treating doctor dials the patient (visit ${enc.visitNo})` } });
  const stamped = await db.update(opdEncounters)
    .set({ teleCallStartedAt: enc.teleCallStartedAt ?? now, updatedBy: actor.id, updatedAt: now })
    .where(eq(opdEncounters.id, encounterId)).returning({ at: opdEncounters.teleCallStartedAt });
  return { encounterId, telePhone: appt?.telePhone ?? null, callStartedAt: stamped[0]!.at ?? now };
}

/**
 * The consultation invoice for a tele visit, settled from the desk's advance. Answers what it did,
 * for this file and its tests — never for a doctor's screen.
 *
 *   `none`      nothing was taken (a ₹0 quote): an in-person free follow-up raises no bill either.
 *   `standing`  the visit already has its bill (a replayed 'spoke').
 *   `issued`    one invoice, settled in full from the advance. If the fee has FALLEN since the
 *               payment, the difference stays on the receipt as the patient's advance.
 *   `deferred`  the fee has RISEN since the payment, or billing refused: no invoice is raised here
 *               and the advance stays whole on the patient's account for the billing office. The
 *               doctor's outcome is recorded all the same — a price list is not theirs to resolve.
 */
export type TeleBill = "none" | "standing" | "issued" | "deferred";
export async function billSpokenTeleVisit(db: Db, enc: EncounterRow, now: Date = new Date()): Promise<TeleBill> {
  if (enc.appointmentId === null) return "none";
  const appt = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, enc.appointmentId)))[0];
  if (!appt || appt.advanceReceiptId === null || (appt.advanceQuotePaise ?? 0) <= 0) return "none";
  if ((await standingInvoiceFor(db, enc.id)) !== null) return "standing";
  try {
    const fee = await consultFeeAt(db, { patientId: enc.patientId, visitType: enc.visitType, at: now });
    if (fee.feeServiceId === null || fee.paise <= 0) return "none";
    if (fee.paise > (appt.advanceQuotePaise ?? 0)) return "deferred";
    await issueInvoice(db, TELE_BILL_ACTOR, {
      draftId: `tele-${enc.id}`, patientId: enc.patientId, encounterId: enc.id,
      lines: [{ lineId: FEE_LINE_ID, serviceId: fee.feeServiceId, qty: 1 }],
      settleFromReceipts: [{ receiptId: appt.advanceReceiptId, amountPaise: fee.paise }],
    }, now);
    return "issued";
  } catch {
    return "deferred";
  }
}

export type TeleOutcomeResult = { encounter: EncounterRow; outcome: "spoke" | "no_answer"; final: boolean };

export async function recordTeleOutcome(
  db: Db, actor: Actor, encounterId: string, outcome: "spoke" | "no_answer", now: Date = new Date(),
): Promise<TeleOutcomeResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const seen = await getEncounter(db, encounterId);
  // 'spoke' is recorded once: saying it again answers what stands and changes nothing.
  if (seen && seen.consultMode === "tele" && seen.teleOutcome === "spoke" && outcome === "spoke") {
    await requireTreatingDoctor(db, actor, seen);
    return { encounter: seen, outcome: "spoke", final: true };
  }
  const enc = await teleVisitFor(db, actor, encounterId);
  if (enc.teleOutcome === "spoke") throw new OpdError("encounter_state_conflict", "the call is already recorded as spoken");

  if (outcome === "spoke") {
    const stamped = await db.update(opdEncounters)
      .set({ teleOutcome: "spoke", teleOutcomeAt: now, teleOutcomeBy: actor.id, teleCallStartedAt: enc.teleCallStartedAt ?? now, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "in_consultation")))
      .returning();
    if (stamped.length === 0) throw new OpdError("encounter_state_conflict", "moved concurrently");
    await billSpokenTeleVisit(db, stamped[0]!, now);
    return { encounter: stamped[0]!, outcome: "spoke", final: true };
  }

  const second = enc.teleNoAnswerCount >= 1;
  return withTx(db, async (tx) => {
    const current = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0]!;
    if (current.status !== "in_consultation" || current.teleOutcome === "spoke") throw new OpdError("encounter_state_conflict", "moved concurrently");
    const entry = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(desc(opdQueueEntries.seq)).limit(1))[0]!;
    const stamp = { teleOutcome: "no_answer", teleOutcomeAt: now, teleOutcomeBy: actor.id, teleNoAnswerCount: current.teleNoAnswerCount + 1, updatedBy: actor.id, updatedAt: now };

    /*
      THE WORKFLOW HAS NO `in_consultation → waiting` AND NO `in_consultation → abandoned`, and its
      definition is Class A data activated in production — not this file's to widen. Both ends are
      reached through `awaiting_results`, which the definition does allow, by a named system actor
      (the arrangement `paper-consult.ts` and `patient-absent.ts` use). The doctor is not lost: the
      outcome columns carry them.
    */
    const parked = await moveEncounter(tx, TELE_CLOSE_ACTOR, current, "awaiting_results", {}, now);
    if (!second) {
      // Back to the line, to be tried again: a fresh entry at the END of the appointments already due.
      const waiting = await moveEncounter(tx, TELE_CLOSE_ACTOR, parked, "waiting", {}, now);
      await tx.update(opdQueueEntries).set({ status: "done", doneAt: now })
        .where(and(eq(opdQueueEntries.id, entry.id), inArray(opdQueueEntries.status, ["waiting", "called", "in_consult"])));
      await tx.insert(opdQueueEntries).values({
        id: newId(), sessionId: entry.sessionId, encounterId, tokenNo: entry.tokenNo, kind: "appointment",
        appointmentAt: now, status: "waiting", eligibleAt: now,
      });
      const encounter = (await tx.update(opdEncounters).set(stamp).where(eq(opdEncounters.id, waiting.id)).returning())[0]!;
      return { encounter, outcome: "no_answer" as const, final: false };
    }

    // The second time is final: not consulted, nothing billed, and the appointment goes to the desk with its payment.
    const closed = await moveEncounter(tx, TELE_CLOSE_ACTOR, parked, "abandoned", { abandonedAt: now, abandonReason: TELE_NO_ANSWER_REASON }, now);
    await tx.update(opdQueueEntries).set({ status: "cancelled" })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, ["waiting_vitals", "waiting", "called", "in_consult"])));
    const encounter = (await tx.update(opdEncounters).set(stamp).where(eq(opdEncounters.id, closed.id)).returning())[0]!;
    if (encounter.appointmentId !== null) {
      await tx.update(opdAppointments)
        .set({ status: "needs_rebooking", updatedBy: TELE_CLOSE_ACTOR.id, updatedAt: now })
        .where(and(eq(opdAppointments.id, encounter.appointmentId), eq(opdAppointments.status, "checked_in")));
    }
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0];
    await appendEvent(tx, visitAbandoned.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId!, serviceDate: encounter.serviceDate,
        sessionId: entry.sessionId, roomId: session?.roomId ?? null, tokenNo: entry.tokenNo,
        fromState: "awaiting_results", reason: TELE_NO_ANSWER_REASON,
      },
    }));
    return { encounter, outcome: "no_answer" as const, final: true };
  });
}
