import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * E4.4 DIET (#736) — the audit trail of the diet acts. Ids and codes only: no name, no UHID, no bed (the gateway and
 * the logs read every payload). Every person's act carries its provenance source.
 */
const MODULE = "diet";
const id = z.string().min(1);
const source = z.enum(["doctor", "dietician", "nurse", "ot_booking", "system"]);

export const dietOrdered = defineEvent("diet.ordered", MODULE, z.object({
  orderId: id, admissionId: id, code: z.string().min(1), source, replaces: id.nullable(),
}));
export const dietNpoStarted = defineEvent("diet.npo_started", MODULE, z.object({
  npoId: id, patientId: id, admissionId: id.nullable(), startsAt: z.string(), endsAt: z.string().nullable(), source, sourceRef: z.string().nullable(),
}));
export const dietNpoLifted = defineEvent("diet.npo_lifted", MODULE, z.object({ npoId: id, patientId: id, source }));
export const dietListBuilt = defineEvent("diet.list_built", MODULE, z.object({
  listId: id, wardId: id, meal: z.string(), date: z.string(), trays: z.number().int(), npo: z.number().int(),
}));
export const dietListDispatched = defineEvent("diet.list_dispatched", MODULE, z.object({ listId: id, wardId: id, taskId: id }));
export const dietTrayServed = defineEvent("diet.tray_served", MODULE, z.object({
  lineId: id, listId: id, admissionId: id, outcome: z.enum(["delivered", "refused"]),
}));
export const dietConsultRequested = defineEvent("diet.consult_requested", MODULE, z.object({ consultId: id, admissionId: id, source }));
export const dietConsultCompleted = defineEvent("diet.consult_completed", MODULE, z.object({ consultId: id, admissionId: id }));

export const DIET_EVENTS = [
  dietOrdered, dietNpoStarted, dietNpoLifted, dietListBuilt, dietListDispatched, dietTrayServed, dietConsultRequested,
  dietConsultCompleted,
] as const;
