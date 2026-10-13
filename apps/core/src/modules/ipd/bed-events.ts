import { z } from "zod";
import { IpdBedClassSchema, IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E1.1 (#718) — the bed acts' events. Names are the contract's (`IPD_INTENTS[...].events`); every payload carries
 * `provenance` (G11b audits it) and, where an admission is involved, `admissionId` (G2 correlates on it). Payloads
 * carry ids only — no names: the realtime gateway fans them to every board viewer.
 */
const MODULE = "ipd";
const id = z.string().min(1);
const at = z.string().min(1);

export const bedReserved = defineEvent("ipd.bed.reserved", MODULE, z.object({
  reservationId: id, bedId: id, bedCode: z.string(), admissionId: id, patientId: id, expiresAt: at,
  provenance: IpdProvenanceSchema,
}));

export const bedReservationReleased = defineEvent("ipd.bed.reservation_released", MODULE, z.object({
  reservationId: id, bedId: id, bedCode: z.string(), admissionId: id,
  reason: z.enum(["plan_changed", "lapsed", "bed_unsuitable", "other"]),
  provenance: IpdProvenanceSchema,
}));

export const bedAssigned = defineEvent("ipd.bed.assigned", MODULE, z.object({
  stayId: id, bedId: id, bedCode: z.string(), admissionId: id, patientId: id,
  bedClass: IpdBedClassSchema, billedClass: IpdBedClassSchema, classChange: z.enum(["upgrade", "downgrade"]).nullable(),
  reservationId: id.nullable(), provenance: IpdProvenanceSchema,
}));

export const bedOccupied = defineEvent("ipd.bed.occupied", MODULE, z.object({
  bedId: id, bedCode: z.string(), admissionId: id, patientId: id, provenance: IpdProvenanceSchema,
}));

export const bedBlocked = defineEvent("ipd.bed.blocked", MODULE, z.object({
  blockId: id, bedId: id, bedCode: z.string(), status: z.enum(["blocked", "block_on_release"]),
  reason: z.string(), expectedReturnAt: at, provenance: IpdProvenanceSchema,
}));

export const bedUnblocked = defineEvent("ipd.bed.unblocked", MODULE, z.object({
  blockId: id, bedId: id, bedCode: z.string(), bedStatus: z.string(), provenance: IpdProvenanceSchema,
}));

export const bedCleaned = defineEvent("ipd.bed.cleaned", MODULE, z.object({
  bedId: id, bedCode: z.string(), cleanedAt: at, provenance: IpdProvenanceSchema,
}));

export const bedIncumbentReleased = defineEvent("ipd.bed.incumbent_released", MODULE, z.object({
  bedId: id, bedCode: z.string(), bedStatus: z.string(), provenance: IpdProvenanceSchema,
}));

export const IPD_BED_EVENT_NAMES = [
  bedReserved.name, bedReservationReleased.name, bedAssigned.name, bedOccupied.name, bedBlocked.name,
  bedUnblocked.name, bedCleaned.name, bedIncumbentReleased.name,
] as const;
