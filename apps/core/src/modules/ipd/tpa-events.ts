import { z } from "zod";
import { IpdProvenanceSchema, IpdTpaStageSchema, defineEvent } from "@hmis/contracts";

/**
 * #604 (decision 0075) — the TPA desk's events. Names are the contract's (`IPD_INTENTS[...].events`). Ids and codes only:
 * no names and no money (the payload may reach a viewer without money permissions — decision 0058).
 */
const MODULE = "ipd";
const id = z.string().min(1);

export const tpaQueryRecorded = defineEvent("ipd.tpa.query_recorded", MODULE, z.object({
  admissionId: id, queryId: id, stage: IpdTpaStageSchema, provenance: IpdProvenanceSchema,
}));
export const tpaQueryAnswered = defineEvent("ipd.tpa.query_answered", MODULE, z.object({
  admissionId: id, queryId: id, provenance: IpdProvenanceSchema,
}));
export const tpaDocumentAttached = defineEvent("ipd.tpa.document_attached", MODULE, z.object({
  admissionId: id, attachmentId: id, stage: IpdTpaStageSchema, kind: z.string(), provenance: IpdProvenanceSchema,
}));
export const tpaPackageSelected = defineEvent("ipd.tpa.package_selected", MODULE, z.object({
  admissionId: id, selectionId: id, packageCode: z.string(), provenance: IpdProvenanceSchema,
}));
export const tpaPackageRemoved = defineEvent("ipd.tpa.package_removed", MODULE, z.object({
  admissionId: id, selectionId: id, provenance: IpdProvenanceSchema,
}));
export const tpaClaimSubmitted = defineEvent("ipd.tpa.claim_submitted", MODULE, z.object({
  admissionId: id, claimId: id, eventId: id, provenance: IpdProvenanceSchema,
}));
export const tpaClaimSettled = defineEvent("ipd.tpa.claim_settled", MODULE, z.object({
  admissionId: id, claimId: id, eventId: id, outcome: z.enum(["settled", "short_paid"]), provenance: IpdProvenanceSchema,
}));
export const tpaClaimRejected = defineEvent("ipd.tpa.claim_rejected", MODULE, z.object({
  admissionId: id, claimId: id, eventId: id, provenance: IpdProvenanceSchema,
}));
