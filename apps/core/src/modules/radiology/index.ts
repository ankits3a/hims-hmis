/**
 * PLAN 18a T2 — the radiology module's public surface.
 *
 * Every later task in this phase widens this file and no earlier one does, which is the shape
 * `modules/ot/index.ts` uses: T3 adds the placement function and the consumer constant, T4 the
 * scheduler and the definitions, T5 the gates, T7 acquisition, T8 the readers and the reports.
 *
 * **The kernel never imports this.** `collectOrderKinds` and `collectResourceKinds` read the
 * MANIFEST off `ALL_MANIFESTS`; the seam is a declaration, not an import, which is the property
 * phase 0 §6.1 sells and the reason claiming an order kind edits no kernel file.
 */
export { radiologyManifest } from "./manifest";
export { RadiologyError, RADIOLOGY_ERROR_CODES, radiologyHttpStatus } from "./errors";
export type { RadiologyErrorCode } from "./errors";
export {
  RADIOLOGY_RESOURCE_KINDS, SCHEDULABLE_DEVICE_STATUSES, DEVICE_MODALITY_ATTRIBUTE,
  IMAGING_MODALITIES,
} from "./kinds";
export type { ImagingModality } from "./kinds";
export {
  IMAGING_STUDY_DEF_KEY, IMAGING_GATE_DEF_KEY, RADIOLOGY_WORKFLOW_DEFINITIONS,
  imagingStudyDefinition, imagingGateDefinition,
} from "./workflow-def";
export {
  IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE, RADIOLOGY_APPROVAL_TYPES, registerRadiologyApprovalTypes,
} from "./approval-types";
export {
  RADIOLOGY_ORDER_PLACED_CONSUMER, handleOrderPlaced, orderPlacedConsumer,
} from "./consumers";
export type { CreatedStudy, OrderPlacedPayload } from "./consumers";
export {
  COMPLETED_VISIT_GRACE_DAYS, DUPLICATE_WINDOW_HOURS, addImagingViews, placeImagingOrder,
} from "./place";
export type {
  PlaceImagingItemInput, PlaceImagingOrderInput, PlaceImagingOrderResult,
} from "./place";
export {
  IMAGING_DEFINITION_KINDS, activeDefinition, activeDefinitionRow, draftDefinition,
  parseDefinitionBody, publishDefinition, requestDefinitionPublish,
} from "./definitions";
export type {
  CriticalCategoriesBody, ImagingDefinitionRow, PregnancyPolicyBody, StudyType, StudyTypesBody,
} from "./definitions";
export {
  STUDY_TYPE_SEEDS, activeStudyTypes, requireStudyType, studyTypeByService, studyTypeFor,
} from "./study-types";
export type { StudyTypeSeed } from "./study-types";
export {
  autoSlotWalkIn, cancelStudy, deviceDiary, markNoShow, rescheduleStudy, scheduleStudy,
} from "./schedule";
export type { ScheduleInput, ScheduleResult } from "./schedule";
export {
  PCPNDT_AGE_MAX_YEARS, PCPNDT_AGE_MIN_YEARS, ageInYearsOn, pcpndtApplicability,
} from "./applicability";
export type {
  PcpndtApplicability, PcpndtPatientFacts, PcpndtStudyTypeFacts,
} from "./applicability";
export * from "./events";
