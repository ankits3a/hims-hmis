import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * WM-2 (#983, decisions 0089 / 0091) — ward safety, stock and quality events. Ids, kinds, numbers and statuses only: no
 * names, no reasons, no note text (the realtime gateway fans these to the ward's screens).
 */
const MODULE = "ipd";
const id = z.string().min(1);
const p = IpdProvenanceSchema;

export const riskScored = defineEvent("ipd.safety.risk_scored", MODULE, z.object({
  scoreId: id, admissionId: id, morse: z.number().int(), braden: z.number().int(), plansStarted: z.number().int(), plansEnded: z.number().int(), provenance: p,
}));
export const carePlanStarted = defineEvent("ipd.safety.care_plan_started", MODULE, z.object({
  planId: id, admissionId: id, kind: z.enum(["fall", "pressure"]), score: z.number().int(), provenance: p,
}));
export const carePlanEnded = defineEvent("ipd.safety.care_plan_ended", MODULE, z.object({ planId: id, admissionId: id, kind: z.enum(["fall", "pressure"]), provenance: p }));
export const careChecked = defineEvent("ipd.safety.care_checked", MODULE, z.object({ checkId: id, planId: id, admissionId: id, late: z.boolean(), provenance: p }));

export const restraintOrdered = defineEvent("ipd.restraint.ordered", MODULE, z.object({
  restraintId: id, admissionId: id, kind: z.string(), psychiatric: z.boolean(), reviewDueAt: z.string(), provenance: p,
}));
export const restraintApplied = defineEvent("ipd.restraint.applied", MODULE, z.object({ restraintId: id, admissionId: id, provenance: p }));
export const restraintChecked = defineEvent("ipd.restraint.checked", MODULE, z.object({ checkId: id, restraintId: id, late: z.boolean(), provenance: p }));
export const restraintReviewed = defineEvent("ipd.restraint.reviewed", MODULE, z.object({
  restraintId: id, decision: z.enum(["continue", "remove"]), reviewDueAt: z.string(), provenance: p,
}));
export const restraintFamilyTold = defineEvent("ipd.restraint.family_told", MODULE, z.object({ restraintId: id, nominatedRepresentative: z.boolean(), provenance: p }));
export const restraintEnded = defineEvent("ipd.restraint.ended", MODULE, z.object({ restraintId: id, admissionId: id, provenance: p }));
export const restraintCheckMissed = defineEvent("ipd.restraint.check_missed", MODULE, z.object({ restraintId: id, dueAt: z.string(), notified: z.number().int(), provenance: p }));
export const restraintLapsed = defineEvent("ipd.restraint.lapsed", MODULE, z.object({ restraintId: id, admissionId: id, notified: z.number().int(), provenance: p }));

export const lineInserted = defineEvent("ipd.line.inserted", MODULE, z.object({
  lineId: id, admissionId: id, kind: z.string(), dueRemovalAt: z.string(), provenance: p,
}));
export const lineReviewed = defineEvent("ipd.line.reviewed", MODULE, z.object({ lineId: id, decision: z.enum(["keep", "remove"]), provenance: p }));
export const lineRemoved = defineEvent("ipd.line.removed", MODULE, z.object({ lineId: id, admissionId: id, days: z.number().int(), provenance: p }));

export const crashCartChecked = defineEvent("ipd.crash_cart.checked", MODULE, z.object({
  cartId: id, checkId: id, sealChanged: z.boolean(), recounted: z.boolean(), status: z.enum(["ready", "needs_restock"]), provenance: p,
}));
export const crashCartUsed = defineEvent("ipd.crash_cart.used", MODULE, z.object({ cartId: id, checkId: id, provenance: p }));
export const wardIncidentRaised = defineEvent("ipd.ward.incident_raised", MODULE, z.object({
  incidentId: id, wardId: id, kind: z.string(), refType: z.string(), refId: id, notified: z.number().int(), provenance: p,
}));
export const narcoticKeysTaken = defineEvent("ipd.narcotic.keys_taken", MODULE, z.object({ holdId: id, wardId: id, fromUserId: id.nullable(), provenance: p }));

export const wardParSet = defineEvent("ipd.ward_stock.par_set", MODULE, z.object({ wardId: id, storeId: id, supplyStoreId: id, items: z.number().int(), provenance: p }));
export const wardIndentRaised = defineEvent("ipd.ward_stock.indent_raised", MODULE, z.object({ wardId: id, indentId: id, lines: z.number().int(), provenance: p }));
export const wardStockUsed = defineEvent("ipd.ward_stock.used", MODULE, z.object({
  useId: id, admissionId: id, wardId: id, itemId: id, batchId: id, qty: z.number().int(), outcome: z.string(), charged: z.boolean(),
  notChargedWhy: z.string().nullable(), waived: z.boolean(), provenance: p,
}));

export const safetyEventRecorded = defineEvent("ipd.safety.event_recorded", MODULE, z.object({
  eventId: id, admissionId: id, wardId: id.nullable(), kind: z.string(), presentOnAdmission: z.boolean(), provenance: p,
}));

/** The ward-safety events the ward screens refetch on. */
export const IPD_WARD_SAFETY_EVENT_NAMES: readonly string[] = [
  riskScored.name, carePlanStarted.name, carePlanEnded.name, careChecked.name, restraintOrdered.name, restraintApplied.name,
  restraintChecked.name, restraintReviewed.name, restraintFamilyTold.name, restraintEnded.name, restraintCheckMissed.name,
  restraintLapsed.name, lineInserted.name, lineReviewed.name, lineRemoved.name, crashCartChecked.name, crashCartUsed.name,
  wardIncidentRaised.name, narcoticKeysTaken.name, wardParSet.name, wardIndentRaised.name, wardStockUsed.name, safetyEventRecorded.name,
];
