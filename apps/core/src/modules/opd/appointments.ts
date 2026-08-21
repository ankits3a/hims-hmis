import { and, asc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDoctorLeaves, opdDoctors } from "../../kernel/db/schema";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { openVisitInTx } from "./encounters";
import { OpdError } from "./errors";
import { appointmentBooked, appointmentCancelled, appointmentNoShow, appointmentRescheduled } from "./events";
import { availableSlots } from "./schedules";
import { istDate } from "./time";
import type { OpenVisitResult } from "./encounters";
import type { Db, Tx } from "../../kernel/db/client";

export type AppointmentRow = typeof opdAppointments.$inferSelect;
export const LIVE_APPOINTMENT_STATUSES = ["booked", "checked_in", "needs_rebooking"] as const;

/** Throws doctor_on_leave when a scheduled leave covers this doctor-day (booking/reschedule; check-in maps needs_rebooking directly). */
async function assertNotOnLeave(tx: Tx, doctorId: string, serviceDate: string): Promise<void> {
  const leaves = await tx
    .select({ id: opdDoctorLeaves.id })
    .from(opdDoctorLeaves)
    .where(and(
      eq(opdDoctorLeaves.doctorId, doctorId), eq(opdDoctorLeaves.status, "scheduled"),
      lte(opdDoctorLeaves.fromDate, serviceDate), gte(opdDoctorLeaves.toDate, serviceDate),
    ));
  if (leaves.length > 0) throw new OpdError("doctor_on_leave", `doctor ${doctorId} is on leave on ${serviceDate}`);
}

/**
 * Books a slot. The partial unique index (doctor_id, slot_start) WHERE status IN ('booked','checked_in',
 * 'needs_rebooking') is the SOLE arbiter — the booking-race loser code is slot_taken on every interleaving because
 * availableSlots(...).booked is never read here for correctness (that flag is display data only). The membership
 * check below validates the GRID (template, weekday, validity), never other bookings.
 */
export async function bookAppointment(
  db: Db,
  actor: Actor,
  input: { patientId: string; doctorId: string; slotStart: Date; source?: "desk" | "phone"; note?: string },
  now: Date = new Date(),
): Promise<{ appointment: AppointmentRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const canonical = await resolvePatientId(db, input.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  return withTx(db, async (tx) => {
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
    if (!doctor) throw new OpdError("unknown_doctor");
    if (!doctor.active) throw new OpdError("doctor_inactive");
    if (input.slotStart.getTime() < now.getTime()) throw new OpdError("slot_in_past", "the slot is in the past");
    const serviceDate = istDate(input.slotStart);
    await assertNotOnLeave(tx, doctor.id, serviceDate);

    const slots = await availableSlots(tx, doctor.id, serviceDate, now);
    const slot = slots.find((s) => s.start.getTime() === input.slotStart.getTime());
    if (!slot) throw new OpdError("invalid_slot", `${input.slotStart.toISOString()} is not a slot for doctor ${doctor.id}`);

    const appointmentId = newId();
    const inserted = await tx.insert(opdAppointments).values({
      id: appointmentId, patientId: canonical, doctorId: doctor.id, departmentId: doctor.departmentId,
      serviceDate, slotStart: input.slotStart, slotEnd: slot.end, status: "booked",
      source: input.source ?? "desk", note: input.note ?? null,
      bookedBy: actor.id, updatedBy: actor.id,
    }).onConflictDoNothing().returning();
    if (inserted.length === 0) throw new OpdError("slot_taken", `slot ${input.slotStart.toISOString()} for doctor ${doctor.id} is taken`);
    const appointment = inserted[0]!;

    await appendEvent(tx, appointmentBooked.make({
      actor, patientId: canonical,
      payload: {
        appointmentId, patientId: canonical, doctorId: doctor.id, departmentId: doctor.departmentId,
        serviceDate, slotStart: input.slotStart.toISOString(), source: appointment.source,
      },
    }));
    return { appointment };
  });
}

/** Cancel-as-rescheduled + a new booked row, atomically: the flip's rescheduled_to_id is pre-generated so a losing
 *  insert (slot_taken) rolls the WHOLE transaction back, leaving the original row exactly as it was. */
export async function rescheduleAppointment(
  db: Db,
  actor: Actor,
  appointmentId: string,
  input: { slotStart: Date; doctorId?: string },
  now: Date = new Date(),
): Promise<{ from: AppointmentRow; to: AppointmentRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const loaded = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!loaded) throw new OpdError("unknown_appointment", `unknown appointment ${appointmentId}`);
  if (loaded.status !== "booked" && loaded.status !== "needs_rebooking") {
    throw new OpdError("appointment_state_conflict", `cannot reschedule from ${loaded.status}`);
  }
  const targetDoctorId = input.doctorId ?? loaded.doctorId;
  return withTx(db, async (tx) => {
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, targetDoctorId)))[0];
    if (!doctor) throw new OpdError("unknown_doctor");
    if (!doctor.active) throw new OpdError("doctor_inactive");
    if (input.slotStart.getTime() < now.getTime()) throw new OpdError("slot_in_past", "the slot is in the past");
    const serviceDate = istDate(input.slotStart);
    await assertNotOnLeave(tx, doctor.id, serviceDate);

    const slots = await availableSlots(tx, doctor.id, serviceDate, now);
    const slot = slots.find((s) => s.start.getTime() === input.slotStart.getTime());
    if (!slot) throw new OpdError("invalid_slot", `${input.slotStart.toISOString()} is not a slot for doctor ${doctor.id}`);

    const toId = newId();
    const flipped = await tx
      .update(opdAppointments)
      .set({ status: "rescheduled", rescheduledToId: toId, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, appointmentId), eq(opdAppointments.status, loaded.status)))
      .returning();
    if (flipped.length === 0) throw new OpdError("appointment_state_conflict", "moved concurrently");
    const from = flipped[0]!;

    const inserted = await tx.insert(opdAppointments).values({
      id: toId, patientId: loaded.patientId, doctorId: doctor.id, departmentId: doctor.departmentId,
      serviceDate, slotStart: input.slotStart, slotEnd: slot.end, status: "booked",
      source: loaded.source, note: loaded.note, rescheduledFromId: appointmentId,
      bookedBy: actor.id, updatedBy: actor.id,
    }).onConflictDoNothing().returning();
    if (inserted.length === 0) throw new OpdError("slot_taken", `slot ${input.slotStart.toISOString()} for doctor ${doctor.id} is taken`);
    const to = inserted[0]!;

    await appendEvent(tx, appointmentRescheduled.make({
      actor, patientId: loaded.patientId,
      payload: {
        fromAppointmentId: appointmentId, toAppointmentId: toId, patientId: loaded.patientId,
        doctorId: doctor.id, departmentId: doctor.departmentId, serviceDate, slotStart: input.slotStart.toISOString(),
        previousDoctorId: loaded.doctorId, previousSlotStart: loaded.slotStart.toISOString(),
      },
    }));
    return { from, to };
  });
}

export async function cancelAppointment(
  db: Db, actor: Actor, appointmentId: string, reason: string, now: Date = new Date(),
): Promise<{ appointment: AppointmentRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  if (reason.trim() === "") throw new OpdError("reason_required", "cancelling an appointment records why");
  const loaded = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!loaded) throw new OpdError("unknown_appointment", `unknown appointment ${appointmentId}`);
  if (loaded.status !== "booked" && loaded.status !== "needs_rebooking") {
    throw new OpdError("appointment_state_conflict", `cannot cancel from ${loaded.status}`);
  }
  return withTx(db, async (tx) => {
    const updated = await tx
      .update(opdAppointments)
      .set({ status: "cancelled", cancelReason: reason, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, appointmentId), eq(opdAppointments.status, loaded.status)))
      .returning();
    if (updated.length === 0) throw new OpdError("appointment_state_conflict", "moved concurrently");
    const appointment = updated[0]!;
    await appendEvent(tx, appointmentCancelled.make({
      actor, patientId: appointment.patientId,
      payload: {
        appointmentId, patientId: appointment.patientId, doctorId: appointment.doctorId,
        serviceDate: appointment.serviceDate, slotStart: appointment.slotStart.toISOString(), reason,
      },
    }));
    return { appointment };
  });
}

/**
 * Check-in claims the appointment BEFORE opening the visit (a concurrent check-in fails fast having written
 * nothing) and sets encounter_id AFTER (a failed open rolls the claim back — same transaction). The merge chain is
 * resolved through the patients module BEFORE the transaction (Db-first: patients-module readers are typed Db, and
 * Tx is not assignable to Db — T3 preamble, flag ③).
 */
export async function checkInAppointment(db: Db, actor: Actor, appointmentId: string, now: Date = new Date()): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const appt = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointmentId)))[0];
  if (!appt) throw new OpdError("unknown_appointment", `unknown appointment ${appointmentId}`);
  if (appt.status === "needs_rebooking") throw new OpdError("doctor_on_leave", `appointment ${appointmentId} needs rebooking`);
  if (appt.status !== "booked") throw new OpdError("appointment_state_conflict", `cannot check in from ${appt.status}`);
  if (appt.serviceDate !== istDate(now)) throw new OpdError("appointment_not_today", `appointment is for ${appt.serviceDate}, not ${istDate(now)}`);
  const canonical = await resolvePatientId(db, appt.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${appt.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, async (tx) => {
    const claimed = await tx
      .update(opdAppointments)
      .set({ status: "checked_in", updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdAppointments.id, appointmentId), eq(opdAppointments.status, "booked")))
      .returning();
    if (claimed.length === 0) throw new OpdError("appointment_state_conflict", "moved concurrently");
    const result = await openVisitInTx(tx, actor, {
      patientId: canonical, departmentId: appt.departmentId, doctorId: appt.doctorId,
      appointment: { id: appointmentId, slotStart: appt.slotStart }, chainIds,
    }, now);
    await tx.update(opdAppointments).set({ encounterId: result.encounter.id }).where(eq(opdAppointments.id, appointmentId));
    return result;
  });
}

export async function listAppointments(
  db: Db,
  filter: { doctorId?: string; serviceDate?: string; patientId?: string; status?: string[]; needsRebooking?: boolean },
  limit = 500,
): Promise<AppointmentRow[]> {
  const clauses = [
    filter.doctorId === undefined ? undefined : eq(opdAppointments.doctorId, filter.doctorId),
    filter.serviceDate === undefined ? undefined : eq(opdAppointments.serviceDate, filter.serviceDate),
    filter.patientId === undefined ? undefined : eq(opdAppointments.patientId, filter.patientId),
    filter.status === undefined ? undefined : inArray(opdAppointments.status, filter.status),
    filter.needsRebooking !== true ? undefined : eq(opdAppointments.status, "needs_rebooking"),
  ].filter((c) => c !== undefined);
  return db.select().from(opdAppointments).where(clauses.length === 0 ? undefined : and(...clauses)).orderBy(asc(opdAppointments.slotStart)).limit(limit);
}

/**
 * Scheduled daily at 23:55 IST as of Plan 08.5 (the worker process's scheduler,
 * kernel/worker/jobs.ts — the fifth of six sweeps, joining runDispatchCycle,
 * sweepExpiredTempRoles, runDueTimers, sweepGuardianMajority and runDailyClose; Plan 11
 * productionises the worker, it does not schedule this). Claims each row with a conditional
 * UPDATE and appends its event in the SAME per-row transaction as the claim — never one bulk
 * UPDATE with events appended outside the claim's tx.
 */
export async function sweepAppointmentNoShows(db: Db, now: Date = new Date()): Promise<number> {
  const today = istDate(now);
  const candidates = await db
    .select({ id: opdAppointments.id })
    .from(opdAppointments)
    .where(and(eq(opdAppointments.status, "booked"), lt(opdAppointments.serviceDate, today)));
  let fired = 0;
  for (const candidate of candidates) {
    const didFire = await withTx(db, async (tx) => {
      const updated = await tx
        .update(opdAppointments)
        .set({ status: "no_show", updatedBy: "no-show-sweep", updatedAt: now })
        .where(and(eq(opdAppointments.id, candidate.id), eq(opdAppointments.status, "booked")))
        .returning();
      const row = updated[0];
      if (!row) return false;
      await appendEvent(tx, appointmentNoShow.make({
        actor: { type: "system", id: "no-show-sweep" }, patientId: row.patientId,
        payload: {
          appointmentId: row.id, patientId: row.patientId, doctorId: row.doctorId,
          serviceDate: row.serviceDate, slotStart: row.slotStart.toISOString(),
        },
      }));
      return true;
    });
    if (didFire) fired++;
  }
  return fired;
}
