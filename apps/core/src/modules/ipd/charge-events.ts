import { z } from "zod";
import { IpdProvenanceSchema, IpdRateComponentSchema, defineEvent } from "@hmis/contracts";
import { IPD_GOAL_EVENTS } from "./goals/goal-events";

/**
 * E2.1 (#725) — the running bill's events. Ids, dates and codes only — NO MONEY: a payload is readable by whoever reads
 * the event log, and a doctor must never be shown an amount (decision 0058). None of these is on the realtime list.
 */
const MODULE = "ipd";
const id = z.string().min(1);
const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** G5b's producer: ONE per admission and IST night, emitted with the room line it posted (`goal-events.ts`). */
export const rentPosted = defineEvent(IPD_GOAL_EVENTS.rentPosted, MODULE, z.object({
  admissionId: id, rentDate: istDate, chargeLineId: id, provenance: IpdProvenanceSchema,
}));

/** Every consultant's "seen" tap on rounds, charged or not (a repeat the same day and a resident's visit post nothing). */
export const visitRecorded = defineEvent("ipd.charge.visit_recorded", MODULE, z.object({
  admissionId: id, consultantUserId: id, seenAt: z.string(), source: z.literal("rounds_tap"),
  outcome: z.enum(["charged", "repeat", "not_chargeable", "rate_missing"]), chargeLineId: id.nullable(),
  provenance: IpdProvenanceSchema,
}));

/** A charge that could not be posted (the rate is missing on the admission's locked tariff). Raised once per key. */
export const chargeException = defineEvent("ipd.charge.exception_raised", MODULE, z.object({
  admissionId: id, serviceDate: istDate, component: IpdRateComponentSchema, reason: z.enum(["rate_missing", "tariff_missing", "visit_backdated"]),
  serviceCode: z.string().nullable(), provenance: IpdProvenanceSchema,
}));

export const chargeReversed = defineEvent("ipd.charge.reversed", MODULE, z.object({
  admissionId: id, chargeLineId: id, reversalLineId: id, provenance: IpdProvenanceSchema,
}));
