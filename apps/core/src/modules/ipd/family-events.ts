import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E3.3 (#731) — the family link's events. Ids, codes and reasons only: no phone number, no OTP, no name, no money, no
 * callback text (the event log is read beyond the ward desk). None is on the realtime list.
 */
const MODULE = "ipd";

/** The worker consumer that revokes the family link at death and absconding (`family.ts` `familyStopConsumer`). */
export const IPD_FAMILY_STOP_CONSUMER = "ipd.family_stop";
const id = z.string().min(1);

export const familyLinkIssued = defineEvent("ipd.family.link_issued", MODULE, z.object({
  admissionId: id, linkId: id, attendantKind: z.enum(["guardian", "deposit_payer"]), relation: z.string(), method: z.enum(["verbal", "paper"]),
  provenance: IpdProvenanceSchema,
}));

export const familyLinkRevoked = defineEvent("ipd.family.link_revoked", MODULE, z.object({
  admissionId: id, linkId: id, reason: z.enum(["deceased", "absconded", "reissued", "family_off", "sealed", "desk"]), provenance: IpdProvenanceSchema,
}));

export const familyOtpSent = defineEvent("ipd.family.otp_sent", MODULE, z.object({
  admissionId: id, linkId: id, challengeId: id, provenance: IpdProvenanceSchema,
}));

export const familyVerified = defineEvent("ipd.family.verified", MODULE, z.object({
  admissionId: id, linkId: id, sessionId: id, provenance: IpdProvenanceSchema,
}));

/** ⚖ The explicit "Show bill details" step inside a verified session (line items can reveal a diagnosis). */
export const familyBillDetailsViewed = defineEvent("ipd.family.bill_details_viewed", MODULE, z.object({
  admissionId: id, linkId: id, sessionId: id, lines: z.number().int().nonnegative(), provenance: IpdProvenanceSchema,
}));

export const familyCallbackRequested = defineEvent("ipd.family.callback_requested", MODULE, z.object({
  admissionId: id, linkId: id, callbackId: id, provenance: IpdProvenanceSchema,
}));

export const familyCallbackClosed = defineEvent("ipd.family.callback_closed", MODULE, z.object({
  admissionId: id, callbackId: id, provenance: IpdProvenanceSchema,
}));

/** The treating team set the condition word or turned the family link off / on. */
export const conditionSet = defineEvent("ipd.condition.set", MODULE, z.object({
  admissionId: id, word: z.enum(["stable", "improving", "serious", "critical"]).nullable(), familyOff: z.string().nullable(),
  provenance: IpdProvenanceSchema,
}));
