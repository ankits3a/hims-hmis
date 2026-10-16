import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * DD-1 — the Doctor Desk's own events. A MOVE is audited by this event, appended in the same
 * transaction as the `doctor_desk_moves` row (spec DECIDED 3). An act and a rating are their own
 * append-only rows with actor and time; the move is the one that changes who is expected to act, so
 * it is also on the hospital's event log. No patient, no test, no value in any payload (GC6).
 */
const MODULE = "doctor-desk";
const id = z.string().min(1);

export const doctorDeskRowMoved = defineEvent("doctor_desk.row_moved", MODULE, z.object({
  moveId: id, rowKey: z.string().min(3).max(120), teamId: id, fromUserId: id, toUserId: id,
}));

/**
 * DD-1.3 — somebody recorded what was done on a critical (D3). In the act's own transaction. The
 * payload names the row, the people by id, the choice and the minutes — no patient, no test, no value.
 */
export const doctorDeskCriticalActed = defineEvent("doctor_desk.critical_acted", MODULE, z.object({
  actId: id, rowKey: z.string().min(3).max(120), teamId: id.nullable(), holderId: id,
  choice: z.enum(["seen_at_bedside", "ecg_ordered", "repeat_sample_sent", "treatment_started", "other"]), minutes: z.number().int().nonnegative(),
}));

export const DOCTOR_DESK_EVENTS = [doctorDeskRowMoved, doctorDeskCriticalActed] as const;
