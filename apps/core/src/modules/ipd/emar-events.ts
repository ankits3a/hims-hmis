import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E4.3 (#735) — the eMAR's events. Ids, codes, counts and instants only: no patient name, no drug name, no note or reason
 * text, no money (decision 0058) — the realtime gateway fans them to every viewer of the nursing topic.
 * `ipd.dose.given` carries `wardId`, `patientCheck.kind` and `labelCode`: goal G6a (scanned doses) reads exactly those.
 */
const MODULE = "ipd";
const id = z.string().min(1);

export const orderVerified = defineEvent("ipd.order.verified", MODULE, z.object({
  orderId: id, admissionId: id, decision: z.enum(["verified", "rejected", "query"]), findings: z.number().int(), dosesScheduled: z.number().int(),
  provenance: IpdProvenanceSchema,
}));

export const medIssued = defineEvent("ipd.med.issued", MODULE, z.object({
  issueId: id, orderId: id, admissionId: id, units: z.number().int(), labels: z.number().int(), ownMedicine: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const medReturned = defineEvent("ipd.med.returned", MODULE, z.object({
  returnId: id, issueId: id, orderId: id, admissionId: id, units: z.number().int(), creditedUnits: z.number().int(), provenance: IpdProvenanceSchema,
}));

export const doseGiven = defineEvent("ipd.dose.given", MODULE, z.object({
  administrationId: id, doseId: id, orderId: id, admissionId: id, wardId: id.nullable(),
  patientCheck: z.object({ kind: z.enum(["scan", "override"]), overrideReason: z.string().optional() }),
  labelCode: z.string(), givenAt: z.string(), late: z.boolean(), highAlert: z.boolean(), secondNurse: z.boolean(), prn: z.boolean(),
  provenance: IpdProvenanceSchema,
}));

export const doseHeld = defineEvent("ipd.dose.held", MODULE, z.object({
  holdId: id, doseId: id, orderId: id, admissionId: id, reason: z.string(), reofferOnReturn: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const doseRefused = defineEvent("ipd.dose.refused", MODULE, z.object({
  refusalId: id, doseId: id, orderId: id, admissionId: id, reason: z.string(), provenance: IpdProvenanceSchema,
}));

export const doseMissed = defineEvent("ipd.dose.missed", MODULE, z.object({
  missId: id, doseId: id, orderId: id, admissionId: id, by: z.enum(["nurse", "sweep"]), notified: z.number().int(), provenance: IpdProvenanceSchema,
}));

export const dosesReoffered = defineEvent("ipd.dose.reoffered", MODULE, z.object({
  admissionId: id, count: z.number().int(), reason: z.string(), provenance: IpdProvenanceSchema,
}));

export const dosesCancelled = defineEvent("ipd.dose.cancelled", MODULE, z.object({
  orderId: id, admissionId: id, count: z.number().int(), provenance: IpdProvenanceSchema,
}));

export const doseCorrected = defineEvent("ipd.dose.corrected", MODULE, z.object({
  correctionId: id, actId: id, orderId: id, admissionId: id, kind: z.enum(["entered_in_error", "medication_incident"]), incidentId: id.nullable(),
  provenance: IpdProvenanceSchema,
}));

export const infusionRecorded = defineEvent("ipd.infusion.recorded", MODULE, z.object({
  infusionEventId: id, orderId: id, admissionId: id, event: z.string(), state: z.enum(["running", "paused", "stopped"]), provenance: IpdProvenanceSchema,
}));

export const secondCheckPassed = defineEvent("ipd.second_check.passed", MODULE, z.object({
  checkId: id, purpose: z.string(), provenance: IpdProvenanceSchema,
}));

export const verbalOrderRecorded = defineEvent("ipd.verbal_order.recorded", MODULE, z.object({
  orderId: id, admissionId: id, signBy: z.string(), provenance: IpdProvenanceSchema,
}));

export const verbalOrderSigned = defineEvent("ipd.verbal_order.signed", MODULE, z.object({
  orderId: id, admissionId: id, provenance: IpdProvenanceSchema,
}));

export const narcoticWasted = defineEvent("ipd.narcotic.wasted", MODULE, z.object({
  entryId: id, orderId: id, admissionId: id, provenance: IpdProvenanceSchema,
}));

export const allergyFlagRaised = defineEvent("ipd.allergy_flag.raised", MODULE, z.object({
  flagId: id, orderId: id, admissionId: id, notified: z.number().int(), provenance: IpdProvenanceSchema,
}));

export const allergyFlagResolved = defineEvent("ipd.allergy_flag.resolved", MODULE, z.object({
  flagId: id, orderId: id, admissionId: id, provenance: IpdProvenanceSchema,
}));

/** The names the nursing topic refetches on (the phone and the ward MAR). */
export const IPD_EMAR_EVENT_NAMES: readonly string[] = [
  orderVerified.name, medIssued.name, medReturned.name, doseGiven.name, doseHeld.name, doseRefused.name, doseMissed.name,
  dosesReoffered.name, dosesCancelled.name, doseCorrected.name, infusionRecorded.name, verbalOrderRecorded.name, allergyFlagRaised.name,
  allergyFlagResolved.name, "ipd.allergy_flag.decided",
];

/** The consumer that re-checks active orders when an allergy is recorded (§4.6 edge "allergy added later"). */
export const IPD_EMAR_ALLERGY_CONSUMER = "ipd.emar_allergy_recheck";

/** E4.3 review — the doctor's decision on an allergy flag (stop / continue). Ids and the decision only. */
export const allergyFlagDecided = defineEvent("ipd.allergy_flag.decided", MODULE, z.object({
  flagId: id, orderId: id, admissionId: id, decision: z.enum(["stop", "continue"]), provenance: IpdProvenanceSchema,
}));
