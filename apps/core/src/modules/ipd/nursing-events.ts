import { z } from "zod";
import { IPD_INTENTS, IpdProvenanceSchema, defineEvent } from "@hmis/contracts";
import { IPD_GOAL_EVENTS } from "./goals/goal-events";

/**
 * E4.1 (#733) — the nursing acts' events. Ids, codes, bands and numbers only: no names, no note text, no SBAR words —
 * the realtime gateway fans these to the nurse station's viewers. The two §0B intents' names are the contract's
 * (`IPD_INTENTS[...].events`); the early-warning breach and acknowledgement are G7's INSTRUMENT events, named by
 * `goals/goal-events.ts` (`IPD_GOAL_EVENTS`) — `alertId` is the breach (a re-raise on a worse band repeats it).
 */
const MODULE = "ipd";
const id = z.string().min(1);
const band = z.enum(["low", "low_medium", "medium", "high"]);
const kind = z.enum(["news2", "meows", "pews"]);

export const nursingAssessed = defineEvent(IPD_INTENTS.record_nursing_assessment.events[0]!, MODULE, z.object({
  assessmentId: id, admissionId: id, happenedAt: z.string(), lateEntry: z.boolean(), morse: z.number().int(), braden: z.number().int(),
  scoreKind: kind, provenance: IpdProvenanceSchema,
}));

export const vitalsRecorded = defineEvent(IPD_INTENTS.record_vitals.events[0]!, MODULE, z.object({
  vitalsId: id, admissionId: id, observedAt: z.string(), lateEntry: z.boolean(), lateReason: z.enum(["offline", "typed_late"]).nullable(),
  refused: z.boolean(),
  score: z.object({ kind, value: z.number().int(), band }).nullable(), provenance: IpdProvenanceSchema,
}));

/** G7's breach: `{ alertId, admissionId, wardId? }` (+ the band and score for the station). Re-raised on a worse band. */
export const ewsBreached = defineEvent(IPD_GOAL_EVENTS.ewsBreached, MODULE, z.object({
  alertId: id, admissionId: id, wardId: id.nullable(), vitalsId: id.nullable(), scoreKind: kind, band, value: z.number().int(),
  escalation: z.boolean(), notified: z.number().int().nonnegative(), doctorReached: z.boolean(), provenance: IpdProvenanceSchema,
}));

/**
 * G7's acknowledgement: `{ alertId, byKind }`, `byKind` an `IpdActorKind` (a doctor's counts for G7 and alone stops the
 * escalation, `stopsEscalation`). It carries the acknowledger's NOTE, so it is NOT on the realtime fan-out list below.
 */
export const ewsAcknowledged = defineEvent(IPD_GOAL_EVENTS.ewsAcknowledged, MODULE, z.object({
  alertId: id, admissionId: id, byKind: z.enum(["desk", "nurse", "doctor", "resident", "pharmacist", "billing", "supervisor", "duty_manager", "device", "agent"]),
  stopsEscalation: z.boolean(), note: z.string().nullable(), provenance: IpdProvenanceSchema,
}));

/** A set below the notify band closed the breach; the next breach is a new alert. */
export const ewsCleared = defineEvent("ipd.ews.cleared", MODULE, z.object({
  alertId: id, admissionId: id, vitalsId: id, provenance: IpdProvenanceSchema,
}));

/** No nursing admission assessment one hour after admission (§4.5): raised once per admission by the minute sweep. */
export const assessmentOverdue = defineEvent("ipd.nursing.assessment_overdue", MODULE, z.object({
  alertId: id, admissionId: id, admittedAt: z.string(), notified: z.number().int().nonnegative(), provenance: IpdProvenanceSchema,
}));

export const intakeOutputRecorded = defineEvent("ipd.nursing.io_recorded", MODULE, z.object({
  entryId: id, admissionId: id, direction: z.enum(["in", "out"]), kind: z.string(), volumeMl: z.number().int(), provenance: IpdProvenanceSchema,
}));

export const nursingNoteAdded = defineEvent("ipd.nursing.note_added", MODULE, z.object({
  noteId: id, admissionId: id, category: z.string(), lateEntry: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const shiftHandoverGiven = defineEvent("ipd.shift_handover.given", MODULE, z.object({
  handoverId: id, admissionId: id, wardId: id.nullable(), shift: z.string(), supersedes: id.nullable(), provenance: IpdProvenanceSchema,
}));

export const shiftHandoverAccepted = defineEvent("ipd.shift_handover.accepted", MODULE, z.object({
  handoverId: id, admissionId: id, provenance: IpdProvenanceSchema,
}));

/** Every nursing event: the nurse station and my-shift refetch on any of them. */
export const IPD_NURSING_EVENT_NAMES: readonly string[] = [
  // Not `ewsAcknowledged` (it carries note text); the station's 15-second poll picks an acknowledgement up.
  nursingAssessed.name, vitalsRecorded.name, ewsBreached.name, ewsCleared.name, assessmentOverdue.name,
  intakeOutputRecorded.name, nursingNoteAdded.name, shiftHandoverGiven.name, shiftHandoverAccepted.name,
];
