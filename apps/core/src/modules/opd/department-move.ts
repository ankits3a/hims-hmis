import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDepartments, opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { carryMoneyToMovedVisit, maySettleMoveDifference, moveMoneyPlan, newConsultFeePaise } from "../billing";
import { OpdError } from "./errors";
import { visitAbandoned, visitMovedDepartment } from "./events";
import { getEncounter, LIVE_ENTRY_STATUSES, moveEncounter, openVisitInTx, visitTypeIn } from "./encounters";
import type { Actor } from "@hmis/contracts";
import type { MoveMoneyPlan, MoveMoneyResult, TenderInput } from "../billing";
import type { Db, Tx } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";
import type { VisitType } from "./visit-type";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * OWNER 2026-10-05 — "WRONG DEPARTMENT — MOVE PATIENT"
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"If by mistake the front desk staff set an appointment of the patient to Orthopedics but it
 * should be General Medicine, how can they move that patient … making sure the OPD report also gets
 * auto corrected."*
 *
 * ONE transaction: the wrong visit is abandoned (its live token cancelled on the board, its own
 * `visit.abandoned` written) and the right one opened in the chosen department — a new visit number
 * and a token from THAT department's series, with the slips queued as for any visit. A visit is never
 * re-pointed in place: its number, token and slips all belong to the department it was opened in.
 *
 * THE REPORT CORRECTS ITSELF because it is read live: `report.ts` skips abandoned visits and groups
 * the rest by their department. The one stored fact it groups that this move must carry is the
 * BOOKING — a checked-in appointment counts as "booked" in its own department — so the appointment
 * that brought the patient moves with them (below).
 *
 * WHEN IT REFUSES:
 *  - the consult has begun (only `registered` and `waiting` move) — that is the doctor's referral;
 *  - the target is the department the visit is already in — that is "change the doctor".
 *
 * THE MONEY MOVES WITH THE VISIT (owner, 2026-10-05 — "yes go ahead" to four rules; billing's
 * `visit-move.ts` holds them): a ₹0 bill is corrected and re-raised; a paid fee that costs the same
 * in the new department moves to the new visit's bill with no refund and no new collection; a
 * different fee is the billing counter's to settle in the same act; a bill with anything but the
 * consultation on it, on credit or part paid goes to the billing office first. All of it commits in
 * this transaction or none of it does.
 *
 * ON `opd.visits.open`, the counter's own permission, as `abandon` and `reclassify` are: the seat
 * that opened the visit corrects it, and the event carries the whole control.
 */

/** Only these move. `awaiting_results` has been seen by a doctor, so a move there is a referral. */
const MOVABLE: readonly string[] = ["registered", "waiting"];

export type DepartmentMovePreview = {
  encounterId: string;
  from: { departmentId: string | null; doctorId: string | null; visitType: VisitType };
  to: { departmentId: string; visitType: VisitType };
  /** The bill standing against the visit, when there is one. Kept for older screens; `money` says what happens to it. */
  standingInvoiceNo: string | null;
  /** What the move does with the visit's money — one of billing's four rules, or the billing office. */
  money: MoveMoneyPlan;
  /** May THIS person settle a fee difference (rule 3)? Only asked when there is one. */
  maySettleDifference: boolean;
};

export type DepartmentMoveResult = {
  from: { encounter: EncounterRow; tokenNo: number | null };
  to: { encounter: EncounterRow; tokenNo: number | null; sessionId: string | null; roomId: string | null; visitType: VisitType };
  money: MoveMoneyResult;
};

async function chainOf(db: Db | Tx, patientId: string): Promise<string[]> {
  const canonical = (await resolvePatientId(db, patientId)) ?? patientId;
  return [canonical, ...(await listMergedLoserIds(db, canonical))];
}

async function movableOrRefuse(db: Db | Tx, encounterId: string, departmentId: string): Promise<EncounterRow> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!MOVABLE.includes(current.status)) {
    throw new OpdError("encounter_state_conflict", `a visit in ${current.status} is not moved — once the doctor has seen the patient, it is a referral`);
  }
  if (current.departmentId === departmentId) {
    throw new OpdError("move_same_department", "the visit is already in that department — change the doctor instead");
  }
  return current;
}

/** What the move would do, without doing it: the visit type (and so the fee) in the new department. */
export async function previewDepartmentMove(
  db: Db, encounterId: string, departmentId: string, now: Date = new Date(), actor?: Actor,
): Promise<DepartmentMovePreview> {
  const current = await movableOrRefuse(db, encounterId, departmentId);
  const dept = (await db.select().from(opdDepartments).where(eq(opdDepartments.id, departmentId)))[0];
  if (!dept) throw new OpdError("unknown_department");
  const visitType = await visitTypeIn(db, await chainOf(db, current.patientId), departmentId, now);
  const money = await moveMoneyPlan(db, encounterId, await newConsultFeePaise(db, current, visitType, now));
  return {
    encounterId,
    from: { departmentId: current.departmentId, doctorId: current.doctorId, visitType: current.visitType as VisitType },
    to: { departmentId, visitType },
    standingInvoiceNo: money.kind === "none" ? null : money.invoiceNo,
    money,
    maySettleDifference: money.kind === "difference" && actor !== undefined && (await maySettleMoveDifference(db, actor)),
  };
}

export async function moveVisitDepartment(
  db: Db,
  actor: Actor,
  encounterId: string,
  input: { departmentId: string; doctorId: string; reason: string; tenders?: TenderInput[] },
  now: Date = new Date(),
): Promise<DepartmentMoveResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const reason = input.reason.trim();
  if (reason === "") throw new OpdError("reason_required", "a department move records why");
  const current = await movableOrRefuse(db, encounterId, input.departmentId);
  const chainIds = await chainOf(db, current.patientId);

  return withTx(db, async (tx) => {
    // ── 1. the wrong visit ends: abandoned, its live token cancelled on the board ──
    const live = (await tx
      .select()
      .from(opdQueueEntries)
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
      .orderBy(desc(opdQueueEntries.seq))
      .limit(1))[0];
    const liveRoomId = live === undefined
      ? null
      : (await tx.select({ roomId: opdQueueSessions.roomId }).from(opdQueueSessions).where(eq(opdQueueSessions.id, live.sessionId)))[0]?.roomId ?? null;
    const abandoned = await moveEncounter(tx, actor, current, "abandoned", { abandonedAt: now, abandonReason: `wrong department — ${reason}` }, now);
    await tx
      .update(opdQueueEntries)
      .set({ status: "cancelled" })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])));
    await appendEvent(tx, visitAbandoned.make({
      actor, patientId: current.patientId, encounterId, correlationId: current.workflowInstanceId,
      payload: {
        encounterId, patientId: current.patientId, doctorId: current.doctorId, serviceDate: current.serviceDate,
        sessionId: live?.sessionId ?? null, roomId: liveRoomId, tokenNo: live?.tokenNo ?? null,
        fromState: current.status as "registered" | "waiting", reason: `wrong department — ${reason}`,
      },
    }));

    // ── 2. the booking that brought them moves with them, so the report's "booked" follows ──
    const appointment = current.appointmentId === null
      ? null
      : (await tx.select().from(opdAppointments).where(eq(opdAppointments.id, current.appointmentId)))[0] ?? null;

    // ── 3. the right visit opens: same patient, same payer and slip, the new department's token ──
    // A bill-first visit (no live entry yet) stays bill-first: its token waits for the money.
    const opened = await openVisitInTx(tx, actor, {
      patientId: current.patientId, chainIds,
      departmentId: input.departmentId, doctorId: input.doctorId,
      intendedPayer: current.intendedPayer as "self" | "tpa" | "pmjay" | "corporate",
      ...(current.referralSource === null ? {} : { referralSource: current.referralSource as "self" | "internal_doctor" | "external_rmp" | "camp" | "other" }),
      ...(current.referrerName === null ? {} : { referrerName: current.referrerName }),
      ...(current.attributionCode === null ? {} : { attributionCode: current.attributionCode }),
      ...(current.deskComplaint === null ? {} : { deskComplaint: current.deskComplaint }),
      ...(appointment !== null && live !== undefined ? { appointment: { id: appointment.id, slotStart: appointment.slotStart } } : {}),
      join: live === undefined ? "defer" : "queue",
    }, now);

    let appointmentId: string | null = null;
    if (appointment !== null) {
      appointmentId = appointment.id;
      // The new doctor may hold a live booking in this very slot (the slot index). Then the moved
      // booking cannot stand beside it and is closed as rescheduled — counted nowhere rather than
      // twice — instead of failing the patient's move on a booking-grid detail.
      const clash = (await tx.select({ id: opdAppointments.id }).from(opdAppointments).where(and(
        eq(opdAppointments.doctorId, input.doctorId), eq(opdAppointments.slotStart, appointment.slotStart),
        sql`${opdAppointments.status} in ('booked', 'checked_in', 'needs_rebooking')`,
      )))[0];
      await tx.update(opdAppointments)
        .set(clash !== undefined && clash.id !== appointment.id
          ? { status: "rescheduled", updatedBy: actor.id, updatedAt: now }
          : { departmentId: input.departmentId, doctorId: input.doctorId, encounterId: opened.encounter.id, updatedBy: actor.id, updatedAt: now })
        .where(eq(opdAppointments.id, appointment.id));
      if (opened.encounter.appointmentId === null) {
        await tx.update(opdEncounters).set({ appointmentId: appointment.id }).where(eq(opdEncounters.id, opened.encounter.id));
      }
    }

    // ── 4. the money moves with the visit (billing's four rules), in this same transaction ──
    // Read inside the transaction, so a bill issued a moment ago at another seat is seen.
    const money = await carryMoneyToMovedVisit(tx, actor, {
      from: current, to: opened.encounter, reason,
      ...(input.tenders === undefined ? {} : { tenders: input.tenders }),
    }, now);

    await appendEvent(tx, visitMovedDepartment.make({
      actor, patientId: current.patientId, encounterId: opened.encounter.id, correlationId: opened.encounter.workflowInstanceId,
      payload: {
        patientId: current.patientId, serviceDate: opened.encounter.serviceDate,
        fromEncounterId: encounterId, toEncounterId: opened.encounter.id,
        fromDepartmentId: current.departmentId, toDepartmentId: input.departmentId,
        fromDoctorId: current.doctorId, toDoctorId: input.doctorId,
        fromVisitType: current.visitType as VisitType, toVisitType: opened.visitType,
        fromTokenNo: live?.tokenNo ?? null, toTokenNo: opened.tokenNo,
        appointmentId, reason,
        money: {
          kind: money.kind === "billing_office" ? "none" : money.kind,
          fromInvoiceNo: money.invoiceNo, creditNoteNo: money.creditNoteNo, toInvoiceNo: money.newInvoiceNo,
          paidPaise: money.paidPaise, newFeePaise: money.newFeePaise,
          advancePaise: money.advancePaise, collectedPaise: money.collectedPaise,
        },
      },
    }));

    return {
      from: { encounter: abandoned, tokenNo: live?.tokenNo ?? null },
      to: { encounter: opened.encounter, tokenNo: opened.tokenNo, sessionId: opened.sessionId, roomId: opened.roomId, visitType: opened.visitType },
      money,
    };
  });
}
