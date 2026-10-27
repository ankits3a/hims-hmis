/**
 * ICU IC-1 (#984, decision 0090) — other modules import this one only through here (lint-enforced). Importing it also
 * installs the family page's "today's update" reader into ipd (`family.ts` `installFamilyToday`).
 */
import { installFamilyToday } from "./family";

installFamilyToday();

export { icuManifest, ICU_CARE, ICU_DECIDE, ICU_MANAGE, ICU_REQUEST, ICU_VIEW } from "./manifest";
export { IcuError, icuHttpStatus } from "./errors";
export { ICU_DECIDER_ROLES, decideIcuRequest, listIcuRequests, requestIcu } from "./requests";
export { deviceDays, linkDevice, reconcileLinks, unlinkDevice } from "./devices";
export type { LinkResult } from "./devices";
export { hallFeed, ingestBatch, mapCode, mapSlot, registerGateway } from "./feed";
export { correctValue, enterManualHour, isIstHourMark, istHourOf, prefillHour, readChart, signHour } from "./chart";
export { acknowledgeAlarm, activeLimits, confirmLimitOnMonitor, escalateAlarms, setAlarmLimit, syncFeedGaps } from "./alarms";
export { completeBundle, ensureBundles, insertLine, removeLine, startSepsisBundle } from "./bundles";
export { familyToday, installFamilyToday, logFamilyUpdate, logVisit } from "./family";
export { dropExpiredNumericsPartitions, ensureNumericsPartitions, partitionNameOf } from "./partitions";
export { sweepIcuAlarms } from "./sweep";
export type { IcuSweepResult } from "./sweep";
export { listHalls, readBed, readIncharge, readMyBeds, readNight, readStation, readTrends } from "./reads";
export { IcuModule } from "./icu.module";
