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
