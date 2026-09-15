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
  DEVICE_PORTABLE_ATTRIBUTE, IMAGING_MODALITIES,
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
  IMAGING_DEFINITION_KINDS, VIEWER_URL_PLACEHOLDERS, activateSeededDefinition, activeDefinition, activeDefinitionRow, draftDefinition,
  parseDefinitionBody, publishDefinition, requestDefinitionPublish,
} from "./definitions";
export type {
  CriticalCategoriesBody, ImagingDefinitionRow, PacsSettingsBody, PregnancyPolicyBody, StudyType, StudyTypesBody,
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
export { checkIn, deriveGateSet } from "./checkin";
export type { CheckInResult, DerivedGateSet } from "./checkin";
export {
  CONTRAST_ALLERGEN_TERMS, DEFAULT_PREGNANCY_POLICY, IMAGING_TERMINAL_GATE_STATES,
  LMP_REASSURING_DAYS, NEVER_OVERRIDABLE_KINDS, NEVER_WAIVABLE_KINDS,
  RENAL_CREATININE_CEILING_UMOL_L, RENAL_VALIDITY_DAYS_ADMITTED, RENAL_VALIDITY_DAYS_CKD,
  RENAL_VALIDITY_DAYS_OPD, WAIVABLE_KINDS, evaluateReadiness, gateState, isContrastAllergen,
  openStudyGate, overrideGate, pregnancyPolicy, readiness, requireStudyGate, satisfyGate,
  studyGates, studyState, waiveGate,
} from "./gates";
export type { GateRow, StudyGate, StudyRow } from "./gates";
export {
  LATE_ENTRY_MINUTES, abortAcquisition, recordAcquired, resolveStudyInstanceUid, startAcquisition,
} from "./acquisition";
export type { RecordAcquiredInput, StartAcquisitionResult } from "./acquisition";
export {
  CONTRAST_RECORDABLE_STATUSES, assertContrastPermissible, contrastAdministrationsFor,
  recordContrastAdministration, summariseContrast,
} from "./contrast";
export type { ContrastAdministrationRow, RecordContrastInput } from "./contrast";
export {
  CONTRAST_ALLERGY_SUFFIX, contrastAllergySubstance, contrastReactionHistory, contrastReactionsFor,
  recordContrastReaction,
} from "./reactions";
export type { ContrastReactionRow, RecordContrastReactionInput } from "./reactions";
export { outsideStudyFor, registerOutsideStudy } from "./outside";
export type { OutsideStudyRow, RegisterOutsideStudyInput } from "./outside";
/** 18a-iii T5 — the worker's two chasers. `jobs.ts` imports them through this barrel, as it does the lab's. */
export {
  CHASER_ACTOR, UNREAD_REPORT_HOURS, sweepCriticalChaser, sweepUnreadWatchman,
} from "./chasers";
export type { CriticalChaseResult, UnreadChaseResult } from "./chasers";
export {
  authorisationOf, encounterPayer, hasBillDecision, linkInvoiceLine, openBillDecisions,
  raiseBillDecision, resolveBillDecision,
} from "./money";
export type { AuthorisationEncounterFacts, AuthorisationStudyFacts } from "./money";
export {
  SECOND_FACTOR_WINDOW_MINUTES, acknowledgeCritical, amendReport, draftReport, flagCritical,
  latestSigned, proposeDraft, publishReport, savePrelim, signReport,
} from "./reports";
export { activeDrafter, offlineTemplateDrafter, proposalLockoutHits } from "./drafter";
export type { DraftProposal, DrafterFacts, ReportDrafter } from "./drafter";
export type { ReportContent, ReportRow } from "./reports";
export { REPORT_TEMPLATES, templateFor, templateKeyFor } from "./templates";
export type { ReportTemplate } from "./templates";
export { WORKLIST_VIEWS, reportView, studyView, worklist } from "./read";
export { DICOM_UID_MAX_LENGTH, STUDY_UID_ROOT, isValidDicomUid, mintStudyInstanceUid } from "./uid";
export {
  DEVICE_AE_TITLE_ATTRIBUTE, DICOM_MODALITY, MWL_READ, MWL_STATUSES, istDayWindow, mwlExport,
  renderMwlDump, toPersonName,
} from "./mwl";
export type { MwlExport, MwlRow } from "./mwl";
export { IMAGES_READ, openImages, renderViewerUrl, studyImageViews } from "./views";
export type { ImageViewRow } from "./views";
export type { ReportView, StudyView, WorklistRow, WorklistView } from "./read";
export type {
  PcpndtApplicability, PcpndtPatientFacts, PcpndtStudyTypeFacts,
} from "./applicability";
export * from "./events";
