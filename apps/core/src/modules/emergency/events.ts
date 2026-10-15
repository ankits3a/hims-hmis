import { z } from "zod";
import { ErProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * ER lane 1 (#808) — the arrival acts' events (names are the contracts' `ER_INTENTS[...].events`). Ids and codes only:
 * no names and no money — the realtime gateway fans them to the board's viewers. Every payload carries `provenance`.
 */
const MODULE = "emergency";
const id = z.string().min(1);

export const erPreAlerted = defineEvent("er.pre_alerted", MODULE, z.object({
  preAlertId: id, mode: z.string(), count: z.number().int(), provenance: ErProvenanceSchema,
}));
export const erPreAlertCancelled = defineEvent("er.pre_alert_cancelled", MODULE, z.object({
  preAlertId: id, reason: z.string(), provenance: ErProvenanceSchema,
}));
/** Seam E6/E7: `arrived_at` is the gate instant; `unidentified` lets the MLC lane open its default MLC later. */
export const erArrived = defineEvent("er.arrived", MODULE, z.object({
  episodeId: id, episodeNo: z.string(), patientId: id, arrivalMode: z.string(), arrivedAt: z.string(),
  unidentified: z.boolean(), returnedWithin24h: z.boolean(), preAlertId: id.nullable(), provenance: ErProvenanceSchema,
}));
export const erBroughtDead = defineEvent("er.brought_dead", MODULE, z.object({
  episodeId: id, episodeNo: z.string(), patientId: id, arrivedAt: z.string(), examinedAt: z.string(), provenance: ErProvenanceSchema,
}));
export const erBandPrinted = defineEvent("er.band_printed", MODULE, z.object({
  episodeId: id, bandId: id, serial: z.string(), provenance: ErProvenanceSchema,
}));
export const erBandVoided = defineEvent("er.band_voided", MODULE, z.object({
  episodeId: id, bandId: id, serial: z.string(), reason: z.string(), provenance: ErProvenanceSchema,
}));
export const erIdentityLinked = defineEvent("er.identity_linked", MODULE, z.object({
  episodeId: id, mergeRequestId: id, provenance: ErProvenanceSchema,
}));

/* ═══ lane 2 (#809) — triage, vitals, bays and the doctor (seams E6/E7: the Doctor Desk and the copilot read these) ═══ */
export const erTriaged = defineEvent("er.triaged", MODULE, z.object({
  episodeId: id, level: z.number().int(), algorithmLevel: z.number().int().nullable(), downTriage: z.boolean(),
  triagedAt: z.string(), takeTeamId: id.nullable(), provenance: ErProvenanceSchema,
}));
export const erRetriaged = defineEvent("er.retriaged", MODULE, z.object({
  episodeId: id, level: z.number().int(), fromLevel: z.number().int().nullable(), algorithmLevel: z.number().int().nullable(),
  downTriage: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erVitalsRecorded = defineEvent("er.vitals_recorded", MODULE, z.object({
  episodeId: id, ewsKind: z.string(), ewsValue: z.number().int(), ewsBand: z.string(), worse: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erPlaced = defineEvent("er.placed", MODULE, z.object({
  episodeId: id, bedId: id, bayCode: z.string(), provenance: ErProvenanceSchema,
}));
export const erMoved = defineEvent("er.moved", MODULE, z.object({
  episodeId: id, fromBedId: id, bedId: id, bayCode: z.string(), reason: z.string().nullable(), provenance: ErProvenanceSchema,
}));
export const erDoctorAssigned = defineEvent("er.doctor_assigned", MODULE, z.object({
  episodeId: id, doctorId: id, firstSeen: z.boolean(), seenAt: z.string(), doorToDoctorMin: z.number().int(), provenance: ErProvenanceSchema,
}));

/** Every event the tracking board refetches on. */
export const ER_BOARD_EVENT_NAMES: readonly string[] = [
  erPreAlerted.name, erPreAlertCancelled.name, erArrived.name, erBroughtDead.name, erBandPrinted.name, erBandVoided.name,
  erIdentityLinked.name,
  erTriaged.name, erRetriaged.name, erVitalsRecorded.name, erPlaced.name, erMoved.name, erDoctorAssigned.name,
];
