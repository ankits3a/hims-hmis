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

export const DOCTOR_DESK_EVENTS = [doctorDeskRowMoved] as const;
