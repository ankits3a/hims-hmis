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

/* ═══ lane 3 (#810) — care ═══ */
export const erNoteRecorded = defineEvent("er.note_recorded", MODULE, z.object({ episodeId: id, noteId: id, kind: z.string(), draft: z.boolean(), provenance: ErProvenanceSchema }));
export const erNoteCosigned = defineEvent("er.note_cosigned", MODULE, z.object({ episodeId: id, noteId: id, provenance: ErProvenanceSchema }));
export const erOrderPlaced = defineEvent("er.order_placed", MODULE, z.object({
  episodeId: id, labOrderId: id.nullable(), imagingOrderId: id.nullable(), priority: z.string(), items: z.number().int(), skipped: z.number().int(),
  provenance: ErProvenanceSchema,
}));
export const erMedIssued = defineEvent("er.med_issued", MODULE, z.object({
  episodeId: id, issueId: id, units: z.number().int(), highAlert: z.boolean(), own: z.boolean(), verbal: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erDoseRecorded = defineEvent("er.dose_recorded", MODULE, z.object({
  episodeId: id, issueId: id, doseId: id, outcome: z.string(), highAlert: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erVerbalSigned = defineEvent("er.verbal_signed", MODULE, z.object({ episodeId: id, issueId: id, lateMin: z.number().int(), provenance: ErProvenanceSchema }));
export const erProcedureRecorded = defineEvent("er.procedure_recorded", MODULE, z.object({ episodeId: id, procedureId: id, performedBy: id, provenance: ErProvenanceSchema }));
export const erConsentRecorded = defineEvent("er.consent_recorded", MODULE, z.object({ episodeId: id, consentId: id, kind: z.string(), signedBy: z.string(), provenance: ErProvenanceSchema }));
export const erCallRaised = defineEvent("er.call_raised", MODULE, z.object({
  episodeId: id, callId: id, departmentCode: z.string(), urgency: z.string(), takeTeamId: id.nullable(), provenance: ErProvenanceSchema,
}));
export const erCallAnswered = defineEvent("er.call_answered", MODULE, z.object({ episodeId: id, callId: id, step: z.string(), minutes: z.number().int(), provenance: ErProvenanceSchema }));
export const erStabilised = defineEvent("er.stabilised", MODULE, z.object({ episodeId: id, stabilisedAt: z.string(), provenance: ErProvenanceSchema }));

/* ═══ lane 4 (#811) — the medico-legal case (ids and codes only: no informant words, no injuries, no officer names) ═══ */
export const erMlcOpened = defineEvent("er.mlc_opened", MODULE, z.object({
  episodeId: id, mlcId: id, mlcNo: z.string(), category: z.string(), byRule: z.boolean(), late: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erMlcAddendum = defineEvent("er.mlc_addendum", MODULE, z.object({ episodeId: id, mlcId: id, addendumId: id, provenance: ErProvenanceSchema }));
export const erPoliceIntimated = defineEvent("er.police_intimated", MODULE, z.object({
  episodeId: id, mlcId: id, mode: z.string(), withinTarget: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erMlcCountersigned = defineEvent("er.mlc_countersigned", MODULE, z.object({
  episodeId: id, mlcId: id, withinTarget: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erBelongingsRecorded = defineEvent("er.belongings_recorded", MODULE, z.object({
  episodeId: id, mlcId: id, custodyId: id, items: z.number().int(), provenance: ErProvenanceSchema,
}));
export const erEvidenceCustody = defineEvent("er.evidence_custody", MODULE, z.object({
  episodeId: id, mlcId: id, custodyId: id, link: z.number().int(), action: z.string(), provenance: ErProvenanceSchema,
}));

/* ═══ lane 5 (#812) — disposition and departure (ids and codes only) ═══ */
export const erDispositionDecided = defineEvent("er.disposition_decided", MODULE, z.object({
  episodeId: id, disposition: z.string(), /** Review #3: a re-decision after IPD cancelled the hand-off names the one it replaces. */
  previous: z.string().nullable().optional(), provenance: ErProvenanceSchema,
}));
export const erHandedToUnit = defineEvent("er.handed_to_unit", MODULE, z.object({
  episodeId: id, admissionId: id, boarding: z.boolean(), provenance: ErProvenanceSchema,
}));
export const erDeparted = defineEvent("er.departed", MODULE, z.object({
  episodeId: id, outcome: z.string(), bayId: id.nullable(), admissionId: id.nullable(), provenance: ErProvenanceSchema,
}));
export const erAdmissionDisputed = defineEvent("er.admission_disputed", MODULE, z.object({
  episodeId: id, disputeId: id, departmentCode: z.string(), provenance: ErProvenanceSchema,
}));
export const erAdmissionArbitrated = defineEvent("er.admission_arbitrated", MODULE, z.object({
  episodeId: id, disputeId: id, ruling: z.string(), provenance: ErProvenanceSchema,
}));

/* ═══ lane 6 (#813) — the ER bill (the bill desk's events; amounts only where the desk needs them) ═══ */
export const erPayerSet = defineEvent("er.payer_set", MODULE, z.object({ episodeId: id, payer: z.string(), provenance: ErProvenanceSchema }));
export const erAdvanceTaken = defineEvent("er.advance_taken", MODULE, z.object({ episodeId: id, receiptId: id, amountPaise: z.number().int(), provenance: ErProvenanceSchema }));
export const erLinesPriced = defineEvent("er.lines_priced", MODULE, z.object({ episodeId: id, priced: z.number().int(), stillMissing: z.number().int(), provenance: ErProvenanceSchema }));
export const erBillSettled = defineEvent("er.bill_settled", MODULE, z.object({ episodeId: id, settlement: z.string(), duesPaise: z.number().int(), provenance: ErProvenanceSchema }));
export const erEventAccountOpened = defineEvent("er.event_account_opened", MODULE, z.object({ eventAccountId: id, provenance: ErProvenanceSchema }));

/** Every event the tracking board refetches on. */
export const ER_BOARD_EVENT_NAMES: readonly string[] = [
  erPreAlerted.name, erPreAlertCancelled.name, erArrived.name, erBroughtDead.name, erBandPrinted.name, erBandVoided.name,
  erIdentityLinked.name,
  erTriaged.name, erRetriaged.name, erVitalsRecorded.name, erPlaced.name, erMoved.name, erDoctorAssigned.name,
  erNoteRecorded.name, erNoteCosigned.name, erOrderPlaced.name, erMedIssued.name, erDoseRecorded.name, erVerbalSigned.name,
  erProcedureRecorded.name, erConsentRecorded.name, erCallRaised.name, erCallAnswered.name, erStabilised.name,
  erMlcOpened.name, erDispositionDecided.name, erHandedToUnit.name, erDeparted.name,
];
