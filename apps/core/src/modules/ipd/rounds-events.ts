import { z } from "zod";
import {
  IPD_ORDER_EVENT_NAMES, IpdOrderCancelledPayloadSchema, IpdOrderPlacedPayloadSchema, IpdOrderStoppedPayloadSchema, IpdProvenanceSchema,
  defineEvent,
} from "@hmis/contracts";

/**
 * E4.2 (#734) — the rounds lane's events. The ORDER events are the contract the eMAR lane (E4.3) builds on: their payload
 * schemas live in `@hmis/contracts` (`IpdOrderPlacedPayloadSchema` …) so a consumer parses exactly what is written here.
 * Ids, codes and schedules only — no patient name, no note text, no money (decision 0058).
 */
const MODULE = "ipd";
const id = z.string().min(1);

export const roundSigned = defineEvent("ipd.round.signed", MODULE, z.object({
  roundId: id, admissionId: id, status: z.enum(["signed", "awaiting_cosign"]), mode: z.enum(["bedside", "remote_review"]),
  authorKind: z.enum(["consultant", "resident"]), fitDeclared: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const roundCosigned = defineEvent("ipd.round.cosigned", MODULE, z.object({
  roundId: id, admissionId: id, provenance: IpdProvenanceSchema,
}));

export const orderPlaced = defineEvent(IPD_ORDER_EVENT_NAMES.placed, MODULE, IpdOrderPlacedPayloadSchema);
export const orderStopped = defineEvent(IPD_ORDER_EVENT_NAMES.stopped, MODULE, IpdOrderStoppedPayloadSchema);
export const orderCancelled = defineEvent(IPD_ORDER_EVENT_NAMES.cancelled, MODULE, IpdOrderCancelledPayloadSchema);

export const consultRequested = defineEvent("ipd.consult.requested", MODULE, z.object({
  consultId: id, admissionId: id, consultantId: id, urgency: z.enum(["routine", "urgent"]), provenance: IpdProvenanceSchema,
}));

export const consultClosed = defineEvent("ipd.consult.closed", MODULE, z.object({
  consultId: id, admissionId: id, consultantId: id, provenance: IpdProvenanceSchema,
}));

/** The 08:00 cover hand-over (clock): who covers whose inpatients today. Ids only. */
export const roundsCoverSet = defineEvent("ipd.rounds.cover_set", MODULE, z.object({
  admissionId: id, consultantId: id, coveringId: id.nullable(), istDate: z.string(), provenance: IpdProvenanceSchema,
}));
