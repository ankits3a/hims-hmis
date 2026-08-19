/**
 * THE cross-module interface of the OPD module (spec §4). Later modules import from here or consume events —
 * never internals. The masters / appointments / queue / consultation / prescriptions / vitals services are
 * reachable over HTTP only (the Plan 05 pattern); Plan 08 reads encounters, visit type and the events from here.
 */
export { opdManifest } from "./manifest";
export { OpdModule } from "./opd.module";
export { OpdError } from "./errors";
export type { OpdErrorCode } from "./errors";
export { OPD_VISIT_DEF_KEY, OPD_VISIT_DEFINITION_JSON, OPD_VISIT_STATES, opdVisitDefinition } from "./workflow-def";
export type { OpdVisitState } from "./workflow-def";
export { registerConsultStartGuard } from "./consultation";
export type { ConsultStartGuard } from "./consultation";
export { getEncounter, getVisit, listVisits, patientTimeline } from "./encounters";
export type { EncounterRow, QueueEntryRow, TimelineItem } from "./encounters";
export { classifyVisit } from "./visit-type";
export type { VisitType } from "./visit-type";
export { loadOpdConfig } from "./config";
export type { OpdConfig } from "./config";
export { orderQueue, nextInQueue, classOf } from "./queue-engine";
export type { QueueEntryState, QueuePolicy, QueueClass } from "./queue-engine";
export * from "./events";
