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
// E2.1 (#725) — the running bill: the day rule, the nightly posting job, the rounds visit seam, reversals, the interim bill.
export { IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS } from "./manifest";
export { DISCHARGE_FREE_UNTIL_MS, TRANSIT_UNDER_MS, classRank, ipdChargeableDays, rentClassOf } from "./charge-days";
export type { ChargeStay, ChargeableDay } from "./charge-days";
export {
  IPD_DAILY_COMPONENTS, IPD_ENDED_STATES, IPD_NIGHTLY_ACTOR, postAdmissionCharges, postConsultantVisit, postNightlyIpdCharges,
  priceComponent, reverseChargeLine,
} from "./charges";
export type { AdmissionPostResult, ConsultantVisitInput, ConsultantVisitResult, NightlyResult } from "./charges";
export { readInterimBill } from "./interim-bill";
// E2.2 (#726) — the payer split: the pure engine, its inputs, the cap warning, printed snapshots, the non-payables list.
export {
  CAP_EXEMPT_CLASSES, PROPORTIONAL_COMPONENTS, capWarningOf, splitBill, splitModeOf, splitTermsOf,
} from "./payer-split";
export type { AuthRowInput, NonPayables, SplitLineInput, SplitTerms } from "./payer-split";
export {
  addPayerNonPayable, computePayerSplit, listPayerNonPayables, retirePayerNonPayable, roomRentCapWarning,
} from "./payer-bill";
export { printInterimBillSnapshot } from "./interim-bill";
// E3.1 (#729) — transfers: start, accept, cancel, swap, class change in place, the handover list and the panel.
export { IPD_TRANSFER_ACCEPT, IPD_TRANSFER_START } from "./manifest";
export {
  acceptHandover, cancelTransfer, changeClass, listHandovers, startTransfer, swapBeds, transferOptions,
} from "./transfers";
export { applyClassChanges, classChangesOf, nextNoonIst } from "./class-change";
export type { StayClassChange } from "./class-change";
export { IPD_TRANSFER_EVENT_NAMES } from "./transfer-events";
// E3.2 (#730) — discharge: fit, the departments' confirmations, the summary, the final bill, the gate pass, LAMA /
// abscond / death and the mortuary register.
export {
  IPD_DISCHARGE_BILL, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_EXIT, IPD_DISCHARGE_VIEW, IPD_GATE_PASS, IPD_GATE_SCAN,
  IPD_MORTUARY_MANAGE,
} from "./manifest";
export {
  IPD_DEPARTMENT_ROLES, IPD_DISCHARGE_TARGET_MINUTES, cancelFit, confirmCharges, declareFit, readSummary, saveSummaryDraft, signSummary,
} from "./discharge";
export {
  askDuesApproval, assertPayerAccounted, composeFinalBill, listBillDesk, prepareFinalBill, priceFinalBill, readFinalBill, recordDuesApproval,
  settleFinalBill,
} from "./discharge-bill";
export {
  issueGatePass, listMortuary, receiveBody, recordAbscond, recordDeath, recordLama, recordPoliceClearance, releaseBody, scanGatePass,
} from "./discharge-exit";
export { readDischargeBoard, readDischargeTracker } from "./discharge-read";
export { IPD_DISCHARGE_EVENT_NAMES } from "./discharge-events";
// E2.3 (#727) — the deposit ladder, the daily totals to the attendant, the bill desk and its Now card.
export { IPD_BILLDESK_VIEW } from "./manifest";
export {
  IPD_CLINICAL_ROLES, IPD_DEPOSIT_LADDER, IPD_DEPOSIT_RECIPIENT_ROLES, depositNoticeRecipients, depositOwed, depositPosition,
  evaluateAllDepositLadders, evaluateDepositLadder, evaluateDepositLadderSafely, icuBurnOf, registerIpdAdvanceRefundListener, usedBpOf,
} from "./deposit-ladder";
export type { DepositLevel, DepositPosition, LadderOutcome } from "./deposit-ladder";
export { dayOfStay, messageNameOf, queueAllDailyTotals, queueDailyTotals } from "./daily-totals";
export type { DailyTotalsResult } from "./daily-totals";
export { SEALED_LABEL, depositLowCard, readBillDesk, retryFromBillDesk, runIpdBillDeskNightly } from "./bill-desk";
// E3.3 (#731) — the family link: issue / revoke, the condition word, callbacks, the public OTP page, the stop consumer.
export { IPD_CONDITION_SET, IPD_FAMILY_ISSUE } from "./manifest";
export {
  closeFamilyCallback, familyBlockOf, familyCallbacksCard, familyStopConsumer, handleFamilyStop, issueFamilyLink, listFamilyCallbacks,
  readFamilyPanel, revokeFamilyLink, setCondition,
} from "./family";
export {
  familyGate, readFamilyBillDetails, readFamilyView, requestFamilyCallback, sendFamilyOtp, verifyFamilyOtp,
} from "./family-public";
export { FamilyOtpUnavailable, LoggingFamilyOtpSender, SmsFamilyOtpSender, familyOtpSender } from "./family-otp";
export type { FamilyOtpSender } from "./family-otp";
export { IPD_FAMILY_STOP_CONSUMER } from "./family-events";
export { attendantOf, attendantPhoneOf } from "./daily-totals";
// E5.1 (#738) Now cards and E5.2 (#739) Bed Flow T0.
export { BED_FLOW_HOT_WAIT_MINUTES, readBedFlow } from "./bed-flow";
export type { BedFlowEntry } from "./bed-flow";
export { settleBedProposalIn, withdrawBedProposalIn } from "./bed-flow-log";
export type { BedFlowWithdrawReason } from "./bed-flow-log";
export {
  IPD_DISCHARGE_STEP_STUCK_MINUTES, bedProposalCard, cleaningOverdueCard, dischargeBlockedCard, rankNowRows, stuckStepOf,
} from "./now-cards";
export type { NowRow, StuckStep } from "./now-cards";
