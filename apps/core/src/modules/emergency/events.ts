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

/** Every event the tracking board refetches on. */
export const ER_BOARD_EVENT_NAMES: readonly string[] = [
  erPreAlerted.name, erPreAlertCancelled.name, erArrived.name, erBroughtDead.name, erBandPrinted.name, erBandVoided.name,
  erIdentityLinked.name,
];
