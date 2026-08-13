import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The NINE catalog names this plan mints (§10.6 — P1 + pass-7 + pass-8 entries), module
 * "patients". No other event name may be emitted by this module in this plan; abha.linked
 * belongs to the real ABDM linking flow (later plan) — ABHA field edits ride patient.updated.
 */
const MODULE = "patients";

const authoritySchema = z.object({
  messages: z.boolean(),
  consents: z.boolean(),
  dsr: z.boolean(),
  bills: z.boolean(),
});

export const patientRegistered = defineEvent(
  "patient.registered",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    uhid: z.string().min(1),
    name: z.string().min(1),
    phone: z.string().nullable(),
    language: z.enum(["hi", "en"]),
  }),
);

export const patientUpdated = defineEvent(
  "patient.updated",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    // Field-level diff with stringified values — the audit trail §6 promises, and the raw
    // material for C-18's demographic-mismatch sampling (the report itself is Plan 12 scope).
    // Photo changes carry field "photo" with null values (bytes never enter an event).
    changes: z
      .array(z.object({ field: z.string().min(1), from: z.string().nullable(), to: z.string().nullable() }))
      .min(1),
  }),
);

export const patientMerged = defineEvent(
  "patient.merged",
  MODULE,
  z.object({
    winnerPatientId: z.string().min(1),
    loserPatientId: z.string().min(1),
    winnerUhid: z.string().min(1),
    loserUhid: z.string().min(1),
    mergeRequestId: z.string().min(1),
  }),
);

export const patientUnmerged = defineEvent(
  "patient.unmerged",
  MODULE,
  z.object({
    winnerPatientId: z.string().min(1),
    loserPatientId: z.string().min(1),
    mergeRequestId: z.string().min(1),
  }),
);

export const guardianLinked = defineEvent(
  "guardian.linked",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    guardianId: z.string().min(1),
    relationship: z.string().min(1),
    authority: authoritySchema,
  }),
);

export const guardianAuthorityChanged = defineEvent(
  "guardian.authority_changed",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    guardianId: z.string().min(1),
    reason: z.enum(["update", "ended", "majority"]),
    authority: authoritySchema, // the EFFECTIVE authority after the change (all-false for ended/majority)
  }),
);

export const allergyRecorded = defineEvent(
  "allergy.recorded",
  MODULE,
  z.object({
    patientId: z.string().min(1),
    allergyId: z.string().min(1),
    substance: z.string().min(1),
    severity: z.enum(["mild", "moderate", "severe"]).nullable(),
    source: z.enum(["registration", "vitals", "consult"]),
  }),
);

export const correctionEnteredInError = defineEvent(
  "correction.entered_in_error",
  MODULE,
  z.object({
    entity: z.literal("allergy"), // widens per-plan as the grammar reaches other records (E-8: universal)
    entityId: z.string().min(1),
    patientId: z.string().min(1),
    reason: z.string().min(1),
  }),
);

export const qrSignatureFailed = defineEvent(
  "qr.signature_failed",
  MODULE,
  z.object({
    reason: z.enum(["malformed", "invalid_signature", "stale_version", "unknown_patient"]),
    payloadPrefix: z.string(), // first 32 chars of the scanned payload — enough to investigate, never a full forgeable token
    patientId: z.string().optional(), // only when the signature verified (stale_version / unknown_patient) — a forged id is never evented as a patientId
  }),
);
