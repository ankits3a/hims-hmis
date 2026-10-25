import { z } from "zod";
import { IpdBedClassSchema, IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E3.1 (#729) — the transfer acts' events. Names are the contract's (`IPD_INTENTS[...].events`). Every payload carries
 * `admissionId` (G2; the passes lane's consumer reads only that from `ipd.transfer.accepted` and re-reads IPD live) and
 * `provenance` (G11b). Ids, codes and class words only: no names, no SBAR text, no money — the realtime gateway fans
 * these to the Beds board's viewers.
 */
const MODULE = "ipd";
const id = z.string().min(1);

export const transferStarted = defineEvent("ipd.transfer.started", MODULE, z.object({
  transferId: id, admissionId: id, patientId: id, fromBedId: id, toBedId: id, reservationId: id, reason: z.string(),
  escalatesAt: z.string().nullable(), provenance: IpdProvenanceSchema,
}));

/** The transfer is complete (§4.4): the receiving nurse accepted; the patient is on `toBedId`, `fromBedId` is cleaning. */
export const transferAccepted = defineEvent("ipd.transfer.accepted", MODULE, z.object({
  transferId: id, admissionId: id, patientId: id, fromBedId: id, toBedId: id, provenance: IpdProvenanceSchema,
}));

export const transferCancelled = defineEvent("ipd.transfer.cancelled", MODULE, z.object({
  transferId: id, admissionId: id, fromBedId: id, toBedId: id, reason: z.string(), provenance: IpdProvenanceSchema,
}));

export const bedSwapped = defineEvent("ipd.bed.swapped", MODULE, z.object({
  admissionIdA: id, admissionIdB: id, bedIdA: id, bedIdB: id, reason: z.string(), provenance: IpdProvenanceSchema,
}));

export const admissionClassChanged = defineEvent("ipd.admission.class_changed", MODULE, z.object({
  admissionId: id, classChangeId: id, stayId: id, fromClass: IpdBedClassSchema, toClass: IpdBedClassSchema,
  direction: z.enum(["upgrade", "downgrade"]), effectiveFrom: z.string(), provenance: IpdProvenanceSchema,
}));

/** The transfer events that change the Beds board (a hold appears or goes, a patient moves). */
export const IPD_TRANSFER_EVENT_NAMES = [
  transferStarted.name, transferAccepted.name, transferCancelled.name, bedSwapped.name, admissionClassChanged.name,
] as const;
