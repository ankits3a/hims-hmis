import { Logger } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { issuePrepaidConsultInvoice, standingInvoiceFor } from "../billing";
import { getPatientSummaries } from "../patients";
import { parkConsultation, requireTreatingDoctor } from "./consultation";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { teleBillFailed, visitAbandoned } from "./events";
import type { EncounterRow } from "./encounters";
import type { Db, Tx } from "../../kernel/db/client";

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
 *             'no_answer' — the first HOLDS THE VISIT ASIDE with the doctor, the park every
 *             consultation has (`parkConsultation`): it stays in consultation, parked, to be tried
 *             again; the second closes the visit as not consulted and puts the appointment on the
 *             desk's re-booking list WITH ITS PAYMENT (*"carried to a re-booked slot."*).
 *
 * THE BILL CANNOT BE LOST (fix round 2026-10-09). 'Spoke' and the consultation invoice — raised at
 * the amount the appointment was quoted and paid, settled from that advance — are written in ONE
 * transaction. If the invoice cannot be raised, 'spoke' is not recorded: the doctor is told
 * "Could not save — try again", and the cause goes to the server log and a `tele.bill_failed`
 * event for the desk and billing side. Nothing is swallowed.
 *
 * NOTHING HERE ANSWERS A DOCTOR WITH A MONEY WORD. The routes return the visit and, for a call, the
 * number; a refusal about the bill reaches them as that one neutral sentence.
 */
const TELE_BILL_ACTOR: Actor = { type: "system", id: "opd-tele-bill" };
const TELE_CLOSE_ACTOR: Actor = { type: "system", id: "opd-tele-no-answer" };
export const TELE_NO_ANSWER_REASON = "tele-call: the patient did not answer twice";
const log = new Logger("TeleCall");

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
 * The consultation invoice for a tele visit, ON THE CALLER'S TRANSACTION and with nothing caught:
 *
 *   `none`      nothing was taken (a ₹0 quote), or no consultation fee applies today — an
 *               in-person free follow-up raises no bill either.
 *   `standing`  the visit already has its bill.
 *   `issued`    one invoice, at the amount the appointment was quoted and PAID — whatever the price
 *               list says now, higher or lower — settled in full from that advance.
 */
export type TeleBill = "none" | "standing" | "issued";
async function billSpokenTeleVisit(tx: Tx, enc: EncounterRow, now: Date): Promise<TeleBill> {
  if (enc.appointmentId === null) return "none";
  const appt = (await tx.select().from(opdAppointments).where(eq(opdAppointments.id, enc.appointmentId)))[0];
  if (!appt || appt.advanceReceiptId === null || (appt.advanceQuotePaise ?? 0) <= 0) return "none";
  if ((await standingInvoiceFor(tx, enc.id)) !== null) return "standing";
  const issued = await issuePrepaidConsultInvoice(tx, TELE_BILL_ACTOR, {
    draftId: `tele-${enc.id}`, patientId: enc.patientId, encounterId: enc.id, visitType: enc.visitType,
    receiptId: appt.advanceReceiptId, quotePaise: appt.advanceQuotePaise ?? 0,
  }, now);
  return issued === null ? "none" : "issued";
}

export type TeleOutcomeResult = { encounter: EncounterRow; outcome: "spoke" | "no_answer"; final: boolean };

/** 'Spoke' and its bill, together or not at all. */
async function recordSpoke(db: Db, actor: Actor, encounterId: string, now: Date): Promise<TeleOutcomeResult> {
  try {
    return await withTx(db, async (tx) => {
      const current = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0]!;
      // Recorded once: saying it again answers what stands and changes nothing.
      if (current.teleOutcome === "spoke") return { encounter: current, outcome: "spoke" as const, final: true };
      if (current.status !== "in_consultation") throw new OpdError("encounter_state_conflict", "moved concurrently");
      const stamped = (await tx.update(opdEncounters)
        .set({ teleOutcome: "spoke", teleOutcomeAt: now, teleOutcomeBy: actor.id, teleCallStartedAt: current.teleCallStartedAt ?? now, updatedBy: actor.id, updatedAt: now })
        .where(eq(opdEncounters.id, encounterId)).returning())[0]!;
      // A doctor who had held the visit aside after a first "no answer" is with the patient again.
      await tx.update(opdQueueEntries).set({ parkedAt: null, parkedBy: null })
        .where(and(eq(opdQueueEntries.encounterId, encounterId), eq(opdQueueEntries.status, "in_consult")));
      await billSpokenTeleVisit(tx, stamped, now);
      return { encounter: stamped, outcome: "spoke" as const, final: true };
    });
  } catch (e) {
    if (e instanceof OpdError) throw e;
    // The transaction is gone, and 'spoke' with it. What follows is for the desk and billing side — never the doctor's screen.
    const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "error";
    log.error(`tele-call ${encounterId}: 'spoke' was not recorded — its bill could not be raised (${code}): ${e instanceof Error ? e.message : String(e)}`);
    const enc = await getEncounter(db, encounterId);
    if (enc) {
      await withTx(db, (tx) => appendEvent(tx, teleBillFailed.make({
        actor: TELE_BILL_ACTOR, patientId: enc.patientId, encounterId, correlationId: enc.workflowInstanceId,
        payload: { encounterId, appointmentId: enc.appointmentId, code },
      }))).catch(() => undefined);
    }
    throw new OpdError("tele_save_failed", "Could not save — try again", { encounterId });
  }
}

export async function recordTeleOutcome(
  db: Db, actor: Actor, encounterId: string, outcome: "spoke" | "no_answer", now: Date = new Date(),
): Promise<TeleOutcomeResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const seen = await getEncounter(db, encounterId);
  if (seen && seen.consultMode === "tele" && seen.teleOutcome === "spoke" && outcome === "spoke") {
    await requireTreatingDoctor(db, actor, seen);
    return { encounter: seen, outcome: "spoke", final: true };
  }
  const enc = await teleVisitFor(db, actor, encounterId);
  if (enc.teleOutcome === "spoke") throw new OpdError("encounter_state_conflict", "the call is already recorded as spoken");
  if (outcome === "spoke") return recordSpoke(db, actor, encounterId, now);

  if (enc.teleNoAnswerCount < 1) {
    /*
      THE FIRST "NO ANSWER" MOVES NOTHING IN THE WORKFLOW (fix round 2026-10-09). The visit is held
      aside with its doctor by the park every consultation has: it stays `in_consultation`, its queue
      entry stays `in_consult` with `parked_at` set, and the doctor resumes it to try again. No
      `awaiting_results`, no second `consultation.started`, no "done" entry, no waiting-state timer —
      so no report, count or nudge can mistake a call nobody answered for anything else.
    */
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
    if (entry?.parkedAt === null) await parkConsultation(db, actor, encounterId, now);
    const stamped = (await db.update(opdEncounters)
      .set({ teleOutcome: "no_answer", teleOutcomeAt: now, teleOutcomeBy: actor.id, teleNoAnswerCount: 1, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "in_consultation"), eq(opdEncounters.teleNoAnswerCount, 0)))
      .returning())[0];
    if (!stamped) throw new OpdError("encounter_state_conflict", "moved concurrently");
    return { encounter: stamped, outcome: "no_answer", final: false };
  }

  return withTx(db, async (tx) => {
    const current = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0]!;
    if (current.status !== "in_consultation" || current.teleOutcome === "spoke") throw new OpdError("encounter_state_conflict", "moved concurrently");
    const entry = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(desc(opdQueueEntries.seq)).limit(1))[0]!;
    /*
      THE SECOND IS FINAL: not consulted, nothing billed, the appointment to the desk with its payment.
      The workflow has no `in_consultation → abandoned` and its definition is Class A data activated
      in production — not this file's to widen. The close is two legal moves made by a named system
      actor INSIDE THIS ONE TRANSACTION (`in_consultation → awaiting_results → abandoned`): no reader
      ever sees the visit in `awaiting_results`, the timer that state schedules is cancelled by the
      very next move, and the visit rests `abandoned`. `tele-fix.test.ts` pins each of those.
    */
    const through = await moveEncounter(tx, TELE_CLOSE_ACTOR, current, "awaiting_results", {}, now);
    const closed = await moveEncounter(tx, TELE_CLOSE_ACTOR, through, "abandoned", { abandonedAt: now, abandonReason: TELE_NO_ANSWER_REASON }, now);
    await tx.update(opdQueueEntries).set({ status: "cancelled" })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, ["waiting_vitals", "waiting", "called", "in_consult"])));
    const encounter = (await tx.update(opdEncounters)
      .set({ teleOutcome: "no_answer", teleOutcomeAt: now, teleOutcomeBy: actor.id, teleNoAnswerCount: current.teleNoAnswerCount + 1, updatedBy: actor.id, updatedAt: now })
      .where(eq(opdEncounters.id, closed.id)).returning())[0]!;
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
