import { z } from "zod";
import { IpdProvenanceSchema, defineEvent } from "@hmis/contracts";

/**
 * E2.3 (#727) — the deposit ladder's and the daily totals' events. Ids, levels, basis points, dates and reason codes —
 * NO MONEY (decision 0058: the event log is readable beyond the bill desk). None is on the realtime list.
 */
const MODULE = "ipd";
const id = z.string().min(1);
const level = z.enum(["top_up", "escalate"]);

/** A ladder level crossed while armed (75 % `top_up`, 90 % `escalate`): the notices follow the commit. */
export const depositAlertFired = defineEvent("ipd.deposit.alert_fired", MODULE, z.object({
  admissionId: id, alertId: id, level, thresholdBp: z.number().int(), usedBp: z.number().int(), provenance: IpdProvenanceSchema,
}));

/** Usage back under a fired level (a top-up, a reversal): the level is armed again. */
export const depositAlertRearmed = defineEvent("ipd.deposit.alert_rearmed", MODULE, z.object({
  admissionId: id, alertId: id, level, usedBp: z.number().int().nullable(), provenance: IpdProvenanceSchema,
}));

/** The daily totals message was not queued for an admission on a day, and why (no attendant phone, sealed admission). */
export const dailyTotalsSkipped = defineEvent("ipd.daily_totals.skipped", MODULE, z.object({
  admissionId: id, billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.enum(["no_attendant_phone", "sealed"]),
  provenance: IpdProvenanceSchema,
}));

/**
 * #761 — the attendant's word on the daily totals: consent recorded at the desk (who, relation, how) and the stop. Ids and
 * codes only: no phone, no name of the attendant.
 */
export const attendantMessagesConsented = defineEvent("ipd.attendant_messages.consented", MODULE, z.object({
  admissionId: id, attendantKind: z.enum(["guardian", "deposit_payer"]), relation: z.string(), method: z.enum(["verbal", "paper"]),
  provenance: IpdProvenanceSchema,
}));

export const attendantMessagesStopped = defineEvent("ipd.attendant_messages.stopped", MODULE, z.object({
  admissionId: id, attendantKind: z.enum(["guardian", "deposit_payer"]), provenance: IpdProvenanceSchema,
}));
