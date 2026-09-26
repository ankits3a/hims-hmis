import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * ABDM S2 — ONE event, and it is about DISCLOSURE: the hospital sent a patient's health information
 * to another institution over the national network. `abdm_messages` holds the exchange and
 * `phi_access_log` the per-visit access; this is the semantic fact on the spine, so "what did we
 * release, to whom, on which consent" is answerable from the event stream as well as from the log.
 * Nothing consumes it yet.
 */
const MODULE = "abdm";
const id = z.string().min(1);

export const healthInformationReleased = defineEvent("abdm.health_information_released", MODULE, z.object({
  transactionId: id,
  consentId: id,
  hiuId: z.string().nullable(),
  purposeCode: z.string().nullable(),
  careContexts: z.array(z.object({ careContextReference: id, hiTypes: z.array(id), entries: z.number().int().nonnegative() })),
  entryCount: z.number().int().nonnegative(),
}));

/**
 * ABDM S3 — the two facts of the hospital as HIU. RECEIVED: another facility's records arrived under
 * the patient's consent and were stored as EXTERNAL records (never merged into ours). ERASED: the
 * consent ended — revoked by the patient, expired by ABDM, or past its `dataEraseAt` on our own clock —
 * and every record held under it was DELETED; the count is the record of the erasure. Nothing consumes
 * either yet.
 */
export const externalRecordsReceived = defineEvent("abdm.external_records_received", MODULE, z.object({
  consentId: id,
  transactionId: id,
  hipId: z.string().nullable(),
  pageNumber: z.number().int(),
  stored: z.number().int().nonnegative(),
  hiTypes: z.array(id),
}));

export const externalRecordsErased = defineEvent("abdm.external_records_erased", MODULE, z.object({
  consentId: id,
  hipId: z.string().nullable(),
  reason: z.enum(["REVOKED", "EXPIRED"]),
  /** Who ended it: ABDM's notify, or our own clock passing `dataEraseAt`. */
  by: z.enum(["abdm_notify", "data_erase_at"]),
  erased: z.number().int().nonnegative(),
}));
