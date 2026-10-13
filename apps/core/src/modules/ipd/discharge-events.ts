import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E3.2 (#730) — the discharge acts' events. Names are the contract's (`IPD_INTENTS[...].events`; the goal queries read
 * `ipd.discharge.fit_declared` and `ipd.gate_pass.scanned` for G4, and the passes lane's consumer reads
 * `ipd.admission.discharged|lama|absconded|deceased` — `admissionId` only — and re-reads IPD live). Every payload carries
 * `admissionId` and `provenance` (G11b). Ids and codes only: no names, no money (the realtime gateway fans them out and a
 * doctor may be listening — decision 0058). The fit declaration's id is `declarationId` (a key never reads as money);
 * review #762 item 9: no settlement kind and no "dues" flag in any payload — those are money facts.
 */
const MODULE = "ipd";
const id = z.string().min(1);

export const fitDeclared = defineEvent("ipd.discharge.fit_declared", MODULE, z.object({
  admissionId: id, declarationId: id, disposition: z.enum(["home", "transfer_out"]), fitWhen: z.enum(["today", "tomorrow"]),
  targetAt: z.string(), provenance: IpdProvenanceSchema,
}));

export const fitCancelled = defineEvent("ipd.discharge.fit_cancelled", MODULE, z.object({
  admissionId: id, declarationId: id, gatePassVoided: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const chargesConfirmed = defineEvent("ipd.discharge.charges_confirmed", MODULE, z.object({
  admissionId: id, declarationId: id, department: z.string(), allConfirmed: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const summarySigned = defineEvent("ipd.summary.signed", MODULE, z.object({
  admissionId: id, summaryId: id, status: z.enum(["signed", "awaiting_cosign"]), documentId: id, version: z.number().int(),
  provenance: IpdProvenanceSchema,
}));

export const billSettled = defineEvent("ipd.bill.settled", MODULE, z.object({
  admissionId: id, finalBillId: id, invoiceId: id.nullable(), provenance: IpdProvenanceSchema,
}));

/** #763 — a settled bill voided (its credit note, the approval). Ids only: no money, no reason text (0058). */
export const billVoided = defineEvent("ipd.bill.voided", MODULE, z.object({
  admissionId: id, billId: id, creditNoteId: id.nullable(), approvalId: id, provenance: IpdProvenanceSchema,
}));

export const gatePassIssued = defineEvent("ipd.gate_pass.issued", MODULE, z.object({
  admissionId: id, gatePassId: id, kind: z.enum(["discharge", "transfer_out"]), provenance: IpdProvenanceSchema,
}));

export const gatePassScanned = defineEvent("ipd.gate_pass.scanned", MODULE, z.object({
  admissionId: id, gatePassId: id, gateId: id, provenance: IpdProvenanceSchema,
}));

/** The stay ended at the gate: `discharged`, or `transferred_out` for a refer-out (the passes lane's decision). */
export const admissionDischarged = defineEvent("ipd.admission.discharged", MODULE, z.object({
  admissionId: id, patientId: id, state: z.enum(["discharged", "transferred_out"]), bedId: id.nullable(), provenance: IpdProvenanceSchema,
}));

export const admissionLama = defineEvent("ipd.admission.lama", MODULE, z.object({
  admissionId: id, patientId: id, kind: z.enum(["lama", "dama"]), bedId: id.nullable(), provenance: IpdProvenanceSchema,
}));

export const admissionAbsconded = defineEvent("ipd.admission.absconded", MODULE, z.object({
  admissionId: id, patientId: id, bedId: id.nullable(), policeIntimated: z.boolean(), provenance: IpdProvenanceSchema,
}));

export const admissionDeceased = defineEvent("ipd.admission.deceased", MODULE, z.object({
  admissionId: id, patientId: id, bedId: id.nullable(), mortuaryEntryId: id, provenance: IpdProvenanceSchema,
}));

export const mortuaryReceived = defineEvent("ipd.mortuary.received", MODULE, z.object({
  admissionId: id, entryId: id, provenance: IpdProvenanceSchema,
}));

export const mortuaryReleased = defineEvent("ipd.mortuary.released", MODULE, z.object({
  admissionId: id, entryId: id, provenance: IpdProvenanceSchema,
}));

/** The discharge events that change the Beds board (a bed empties; an expected discharge appears or goes). */
export const IPD_DISCHARGE_EVENT_NAMES = [
  fitDeclared.name, fitCancelled.name, gatePassIssued.name, admissionDischarged.name, admissionLama.name, admissionAbsconded.name,
  admissionDeceased.name,
] as const;
