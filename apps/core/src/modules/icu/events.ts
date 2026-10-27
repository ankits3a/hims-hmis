import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * ICU IC-1 (#984) — one event per request decision, link, gap, alarm and signed hour. NUMBERS ARE NEVER EVENTS (the
 * event log would flood at one sample per 5 s per parameter per bed): they live in `icu_numerics` only. Ids and codes
 * only, no names, no values.
 */
const MODULE = "icu";
const id = z.string().min(1);

export const icuRequestRaised = defineEvent("icu.request_raised", MODULE, z.object({
  requestId: id, patientId: id, source: z.string(), priorityClass: z.number().int(),
}));
export const icuRequestDecided = defineEvent("icu.request_decided", MODULE, z.object({
  requestId: id, decision: z.string(), approvalId: id.nullable(),
}));
export const icuDeviceLinked = defineEvent("icu.device_linked", MODULE, z.object({
  linkId: id, deviceId: id, deviceType: z.string(), bedId: id, admissionId: id,
}));
export const icuDeviceUnlinked = defineEvent("icu.device_unlinked", MODULE, z.object({
  linkId: id, deviceId: id, admissionId: id, reason: z.string(),
}));
export const icuClockDriftFlagged = defineEvent("icu.clock_drift_flagged", MODULE, z.object({
  gatewayId: id, batchRef: z.string(), skewMs: z.number().int(),
}));
export const icuFeedGapOpened = defineEvent("icu.feed_gap_opened", MODULE, z.object({ gapId: id, gatewayId: id, since: z.string() }));
export const icuFeedGapClosed = defineEvent("icu.feed_gap_closed", MODULE, z.object({ gapId: id, gatewayId: id, at: z.string() }));
export const icuAlarmRaised = defineEvent("icu.alarm_raised", MODULE, z.object({
  alarmId: id, admissionId: id, source: z.string(), severity: z.string(),
}));
export const icuAlarmEscalated = defineEvent("icu.alarm_escalated", MODULE, z.object({ alarmId: id, admissionId: id, rung: z.string() }));
export const icuAlarmAcknowledged = defineEvent("icu.alarm_acknowledged", MODULE, z.object({ alarmId: id, admissionId: id, rung: z.string() }));
export const icuHourSigned = defineEvent("icu.hour_signed", MODULE, z.object({ hourId: id, admissionId: id, mode: z.string() }));
