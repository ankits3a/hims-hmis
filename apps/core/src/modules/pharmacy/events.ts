import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 16c — the counter's events. Declared at T1 (the catalog is a module fact), EMITTED by T3
 * (queue/claim/verify) and T4 (pick/bill/hand over). Doc 16 §3.1 named them; the names here are
 * the ones that shipped. Stock and money events are NOT here: `material.consumed` is the ledger's
 * (materials) and the invoice is billing's — a dispense POINTS at both by id.
 */
const MODULE = "pharmacy";
const id = z.string().min(1);

/** D11 — a row entered the counter's queue: from the `prescription.issued` consumer, or from a first scan. */
export const dispenseQueued = defineEvent("dispense.queued", MODULE, z.object({
  dispenseId: id, prescriptionId: id, prescriptionVersion: z.number().int().positive(),
  patientId: id, encounterId: id, source: z.enum(["prescription_issued", "scan"]),
}));

/** The counter took the Rx: through which door, and how many lines it carries. The order comes at verify. */
export const dispenseClaimed = defineEvent("dispense.claimed", MODULE, z.object({
  dispenseId: id, patientId: id, encounterId: id, prescriptionId: id,
  lineCount: z.number().int().positive(), door: z.enum(["rx_qr", "patient_qr", "token", "uhid"]),
}));

/**
 * D1 as executed + D9 — every line is settled, the re-check ran on the RESOLVED medicines, and
 * the `medication` order is placed: `dispenseNo` is its `P` number. Counts are KPI numerators.
 */
export const dispenseVerified = defineEvent("dispense.verified", MODULE, z.object({
  dispenseId: id, dispenseNo: id, orderId: id, patientId: id, encounterId: id,
  lineCount: z.number().int().positive(), declinedCount: z.number().int().nonnegative(), scheduled: z.boolean(),
  allergyHits: z.number().int().nonnegative(), interactionHits: z.number().int().nonnegative(),
  substitutions: z.number().int().nonnegative(),
  /** P2 — the verifying pharmacist's state council registration number. Null on payloads written before P2. */
  pharmacistRegNo: z.string().min(1).nullable().default(null),
  /**
   * PHARMACY P3 — the lines whose checks could see only part of the medicine (a component nobody
   * had reviewed), as they stood at the verify. Without it, `allergyHits: 0` read as "checked and
   * clean". Defaults to empty so earlier payloads still parse.
   */
  partlyCheckedLineIdxs: z.array(z.number().int().nonnegative()).default([]),
}));

export const dispenseLineDeclined = defineEvent("dispense.line_declined", MODULE, z.object({
  dispenseId: id, lineIdx: z.number().int().nonnegative(), patientId: id, reason: z.string().min(1),
}));

/** D6 — a generic substitution with the patient's consent; the doctor is NOTIFIED, not asked. */
export const substitutionRecorded = defineEvent("substitution.recorded", MODULE, z.object({
  dispenseId: id, lineIdx: z.number().int().nonnegative(), patientId: id, doctorId: id,
  orderedMedicineId: id, dispensedMedicineId: id, consentBy: id,
}));

/** D2 — every line holds a reservation on the ledger; a FEFO override is named, never silent. */
export const dispensePicked = defineEvent("dispense.picked", MODULE, z.object({
  dispenseId: id, patientId: id,
  lines: z.array(z.object({ lineIdx: z.number().int().nonnegative(), batchId: id, qtyBase: z.number().int().positive(), fefoOverride: z.boolean() })).min(1),
}));

export const dispenseBilled = defineEvent("dispense.billed", MODULE, z.object({
  dispenseId: id, patientId: id, encounterId: id, invoiceId: id, netPaise: z.number().int().nonnegative(),
}));

/** The drug left the counter: the ledger rows exist, the H1 register rows exist, the order items are `completed`. */
export const dispenseHandedOver = defineEvent("dispense.handed_over", MODULE, z.object({
  dispenseId: id, dispenseNo: id, patientId: id, encounterId: id, handedOverBy: id,
  ledgerEntryIds: z.array(id).min(1), h1RegisterRows: z.number().int().nonnegative(), identityConfirmedVia: z.enum(["token", "phone_last4"]).nullable(),
  /**
   * P2 — the handing-over pharmacist's registration number, when they have one. A dispense with no
   * scheduled line may be handed over by the aide, who has none, so it is nullable by design.
   */
  pharmacistRegNo: z.string().min(1).nullable().default(null),
}));

export const dispenseCancelled = defineEvent("dispense.cancelled", MODULE, z.object({
  dispenseId: id, patientId: id, fromStatus: z.string().min(1), reason: z.string().min(1), reservationsReleased: z.number().int().nonnegative(),
  /**
   * P5 — a BILLED dispense is cancelled with the refund credit note it raised and the refund approval
   * it filed. Null for a dispense cancelled before the bill, and on payloads written before P5.
   */
  creditNoteId: id.nullable().default(null),
  refundApprovalId: id.nullable().default(null),
}));

/** P2 — a state council registration was filed for a pharmacist (a renewal names the row it ended). */
export const pharmacistRegistered = defineEvent("pharmacist.registered", MODULE, z.object({
  registrationId: id, userId: id, council: z.string().min(1), registrationNo: z.string().min(1),
  validUntil: z.string().nullable(), supersededId: id.nullable(),
}));

/** P2 — a registration stopped being current, with the reason. */
export const pharmacistRegistrationEnded = defineEvent("pharmacist.registration_ended", MODULE, z.object({
  registrationId: id, userId: id, reason: z.string().min(1),
}));

/**
 * P6 — a sealed pack came back after the hand-over: restocked, credited, its refund requested. The
 * attestation that it was sealed and intact is the pharmacist's, and it is recorded here.
 */
export const dispenseLineReturned = defineEvent("dispense.line_returned", MODULE, z.object({
  dispenseId: id, patientId: id,
  lines: z.array(z.object({ lineIdx: z.number().int().nonnegative(), qtyBase: z.number().int().positive(), batchId: id, ledgerEntryId: id })).min(1),
  sealedIntact: z.literal(true), reason: z.string().min(1), reasonClass: z.enum(["mistake", "genuine"]),
  creditNoteId: id, refundApprovalId: id,
}));

/** The catalog, in source order (`LAB_EVENTS`' discipline). A later task that adds a `defineEvent` above adds it here. */
export const PHARMACY_EVENTS = [
  dispenseQueued, dispenseClaimed, dispenseVerified, dispenseLineDeclined, substitutionRecorded,
  dispensePicked, dispenseBilled, dispenseHandedOver, dispenseCancelled,
  pharmacistRegistered, pharmacistRegistrationEnded, dispenseLineReturned,
] as const;
