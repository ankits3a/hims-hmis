/**
 * THE cross-module interface of the ipd module (spec §4: modules import each other only through
 * here). E0.3 starts the module with the bed registry: what a bed and a ward are (validated
 * attributes on kernel resource rows) and the spreadsheet loader that puts the hospital into the
 * registry. Later IPD lanes (bed board, admission, transfer, nursing, discharge) add to this file.
 */
export { IpdError } from "./errors";
export type { IpdErrorCode } from "./errors";
export {
  IPD_BED_EQUIPMENT, IPD_BED_RULE_CODES, IPD_GENDER_RULES, IPD_ISOLATION_TYPES, IPD_UNIT_TYPES, IPD_WARD_TYPES,
  IpdBedAttributesSchema, IpdWardAttributesSchema, canonicalEquipment,
} from "./bed-attributes";
export type {
  IpdBedAttributes, IpdBedEquipment, IpdGenderRule, IpdIsolationType, IpdUnitType, IpdWardAttributes, IpdWardType,
} from "./bed-attributes";
export {
  BED_LAYOUT_COLUMNS, BED_LAYOUT_PERMISSION, formatBedLayoutReport, loadBedLayout, parseBedLayoutCsv, validateBedLayout,
} from "./bed-layout";
export type {
  BedLayoutChange, BedLayoutColumn, BedLayoutPlan, BedLayoutProblem, BedLayoutReport, BedLayoutRow,
} from "./bed-layout";
// E0.2 — the admission workflow definition (states and the intent that drives each transition).
export {
  ADMISSION_WORKFLOW_DEF_KEY, ADMISSION_TRANSITIONS, IPD_ACTOR_ROLE_KEYS, admissionIntentFor, admissionWorkflowDefinition,
  requestedBudgetMinutes,
} from "./admission-workflow";
export type { AdmissionTransition } from "./admission-workflow";
// E0.5 — one named query per IPD goal (plan §1, §6).
export * from "./goals";
// E1.1 (#718) — the bed intents, the release and housekeeping seams, the capacity board and the module surface.
export { ipdManifest, IPD_BEDS_CLEAN, IPD_BEDS_MANAGE, IPD_BEDS_OVERFLOW, IPD_BEDS_VIEW } from "./manifest";
export { IpdModule } from "./ipd.module";
export { IpdRefusal, ipdRefusalStatus } from "./errors";
export {
  IPD_SYSTEM_ACTOR, assignBed, blockBed, lapseBedReservations, markBedClean, markBedCleanIn, markIncumbentBeds,
  nextRuleValidBeds, releaseBedOccupant, releaseIncumbentBed, releaseReservation, reserveBed, retireBed, unblockBed,
} from "./beds";
export type { IncumbentBedLine, IncumbentBedReport } from "./beds";
export { PAEDIATRIC_AGE_LIMIT_YEARS, checkBedRules, placementGender } from "./bed-rules";
export type { BedRuleBreach, BedRuleContext, BedRulePatient } from "./bed-rules";
export { initialsOf, readBedBoard } from "./beds-board";
export { IPD_BED_EVENT_NAMES } from "./bed-events";
export { IPD_REALTIME_NAMES, IPD_TOPIC_SPACES, ipdTopicRouter, ipdTopicsFor } from "./realtime";
// E1.2 (#719) — admission: the intents, the deposit, the band, the payer record, the desk's reads, the approvals.
export {
  IPD_ADMIT, IPD_ADMIT_REQUEST, IPD_BAND_PRINT, IPD_PAYER_MANAGE,
} from "./manifest";
export {
  admit, backfillDowntime, cancelAdmission, emergencyAdmit, incompleteOf, recordConsent, recordStabilised, requestAdmission,
} from "./admissions";
export {
  IPD_DEPOSIT_COMPONENTS, IPD_DEPOSIT_POLICY, ipdNonPayableDepositCode, ipdSchemeReceiptGuard, planAdmission, quoteDeposit,
  registerIpdReceiptGuard, takeDeposit,
} from "./deposit";
export type { DepositQuote, DepositQuoteArgs } from "./deposit";
export { allergyWords, printBand, reprintBand } from "./bands";
export { recordPayerAuth } from "./payer";
export {
  askApproval, askEmergencyIcuApproval, bedProposalsFor, pendingDepositChecks, consultantChoices, listDeskAdmissions, quotesFor, recentAdvice, viewAdmission,
} from "./admission-read";
export { IPD_APPROVAL_TYPES, IPD_APPROVAL_TYPE_KEYS, ipdApprovalDefinition, registerIpdApprovalTypes } from "./approval-types";
export { IPD_ADMISSION_BOARD_EVENT_NAMES } from "./admission-events";
export { assignBedIn, endAdmissionHolds, placementContext, proposeBeds, readBedFacts } from "./beds";
export type { BedPlacementInput, PlacementContext } from "./beds";
