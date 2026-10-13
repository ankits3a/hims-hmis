import { z } from "zod";
import { IpdBedClassSchema, IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E1.2 (#719) — the admission acts' events. Names are the contract's (`IPD_INTENTS[...].events`). Every payload
 * carries `admissionId` (the goal queries correlate on it: G2 request → first bed act, G4 cashless split) and
 * `provenance` (G11b). Ids and codes only: no names and no money — the realtime gateway fans these to the Beds
 * board's viewers, and a doctor may be one of them (decision 0058).
 */
const MODULE = "ipd";
const id = z.string().min(1);
const source = z.enum(["opd_advice", "ot_daycare_conversion", "er", "direct", "transfer_in", "downtime"]);

export const admissionRequested = defineEvent("ipd.admission.requested", MODULE, z.object({
  admissionId: id, patientId: id, source, requestedClass: IpdBedClassSchema, icu: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const admissionReserved = defineEvent("ipd.admission.reserved", MODULE, z.object({
  admissionId: id, bedId: id, reservationId: id, provenance: IpdProvenanceSchema,
}));

export const admissionPlanned = defineEvent("ipd.admission.planned", MODULE, z.object({
  admissionId: id, payerKind: z.string(), requestedClass: IpdBedClassSchema, depositBasis: z.string(), provenance: IpdProvenanceSchema,
}));

export const admissionAdmitted = defineEvent("ipd.admission.admitted", MODULE, z.object({
  admissionId: id, patientId: id, bedId: id, admissionNo: z.string(), source, provenance: IpdProvenanceSchema,
}));

export const admissionCancelled = defineEvent("ipd.admission.cancelled", MODULE, z.object({
  admissionId: id, reason: z.string(), releasedBedId: id.nullable(), provenance: IpdProvenanceSchema,
}));

export const admissionBackfilled = defineEvent("ipd.admission.backfilled", MODULE, z.object({
  admissionId: id, paperSerial: z.string(), provenance: IpdProvenanceSchema,
}));

export const admissionConsented = defineEvent("ipd.admission.consented", MODULE, z.object({
  admissionId: id, signedBy: z.string(), method: z.string().nullable(), provenance: IpdProvenanceSchema,
}));

export const admissionStabilised = defineEvent("ipd.admission.stabilised", MODULE, z.object({
  admissionId: id, stabilisedAt: z.string(), provenance: IpdProvenanceSchema,
}));

export const payerAuthRecorded = defineEvent("ipd.payer_auth.recorded", MODULE, z.object({
  admissionId: id, authId: id, entry: z.string(), status: z.string(), provenance: IpdProvenanceSchema,
}));

export const depositTaken = defineEvent("ipd.deposit.taken", MODULE, z.object({
  admissionId: id, receiptId: id, provenance: IpdProvenanceSchema,
}));

export const bandPrinted = defineEvent("ipd.band.printed", MODULE, z.object({
  admissionId: id, bandId: id, serial: z.string(), provenance: IpdProvenanceSchema,
}));

export const bandReprinted = defineEvent("ipd.band.reprinted", MODULE, z.object({
  admissionId: id, bandId: id, serial: z.string(), reason: z.string(), provenance: IpdProvenanceSchema,
}));

export const bandVoided = defineEvent("ipd.band.voided", MODULE, z.object({
  admissionId: id, bandId: id, serial: z.string(), reason: z.string(), provenance: IpdProvenanceSchema,
}));

/** The admission events that change the Beds board's waiting column. */
export const IPD_ADMISSION_BOARD_EVENT_NAMES = [
  admissionRequested.name, admissionReserved.name, admissionAdmitted.name, admissionCancelled.name, admissionPlanned.name,
] as const;
