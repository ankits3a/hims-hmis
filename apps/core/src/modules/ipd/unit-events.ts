import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * #962 — a change of the admission's clinical unit (spec 962: "a change of unit is a transfer row and an event, never an
 * edit"). Ids and the instant only: no names, no diagnosis, no money.
 */
const id = z.string().min(1);

export const admissionUnitTransferred = defineEvent("ipd.admission.unit_transferred", "ipd", z.object({
  transferId: id, admissionId: id, fromTeamId: id.nullable(), toTeamId: id, at: z.string(), provenance: IpdProvenanceSchema,
}));

export const IPD_UNIT_EVENT_NAMES = [admissionUnitTransferred.name] as const;
