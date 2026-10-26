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
  blockBedIn, lockBedIn, unblockBedIn,
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
// ER lane 2 (#809) — ER bays are emergency-class beds placed and emptied under the same bed lock.
export { OCCUPANT_ER_EPISODE, placeErEpisodeIn, releaseErBayIn } from "./beds";
// ER review — `move_bay` locks both bays in one global order before it places and releases (no crossed-zone deadlock).
export { lockBedsInOrder } from "./beds";
export type { BedPlacementInput, PlacementContext } from "./beds";
// E1.3 (#720) — where an admission is, and the stay-ending and transfer event names, for the companion modules (passes).
export {
  IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_ENDED_STATES, IPD_PLACED_STATES, IPD_TRANSFER_ACCEPTED_EVENT_NAME, admissionPlace,
  // ER lane 1 (#808) — an admitted patient arriving at the emergency department is refused with their ward and bed.
  placedAdmissionOf,
} from "./admission-place";
export type { AdmissionPlace } from "./admission-place";
export { ageInYears } from "./bed-rules";
// E2.1 (#725) — the running bill: the day rule, the nightly posting job, the rounds visit seam, reversals, the interim bill.
export { IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_PAYER_TERMS } from "./manifest";
export { DISCHARGE_FREE_UNTIL_MS, TRANSIT_UNDER_MS, classRank, ipdChargeableDays, rentClassOf } from "./charge-days";
export type { ChargeStay, ChargeableDay } from "./charge-days";
export {
  // INTEGRATION (ipd-stage): IPD_ENDED_STATES is exported once, from ./admission-place (passes); charges.ts holds the same list.
  IPD_DAILY_COMPONENTS, IPD_NIGHTLY_ACTOR, postAdmissionCharges, postConsultantVisit, postNightlyIpdCharges,
  priceComponent, reverseChargeLine,
} from "./charges";
export type { AdmissionPostResult, ConsultantVisitInput, ConsultantVisitResult, NightlyResult } from "./charges";
export { readInterimBill } from "./interim-bill";
// E1.6 TRANSPORT (#723) — an admission's movable facts (current bed, critical-care class) and the wristband scan.
export { CRITICAL_CARE_BED_CLASSES, admissionForTransport, movableAdmissions, resolveBandScan } from "./transport-seam";
export type { BandScan, TransportAdmissionFacts } from "./transport-seam";
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
  IPD_SETTLED_BILL_RECENT_DAYS, askDuesApproval, assertPayerAccounted, composeFinalBill, listBillDesk, prepareFinalBill, prepareSupplementaryBill,
  priceFinalBill, readFinalBill, recordDuesApproval, settleFinalBill, settleSupplementaryBill,
} from "./discharge-bill";
// #763 — voiding a settled bill.
export { askBillVoid, voidBill } from "./bill-void";
export type { VoidBillResult } from "./bill-void";
export {
  issueGatePass, listMortuary, receiveBody, recordAbscond, recordDeath, recordLama, recordPoliceClearance, releaseBody, scanGatePass,
} from "./discharge-exit";
/** ER lane 4 (#811) — a body brought dead to the ER opens its mortuary entry (an MLC: released only on police clearance). */
export { openErMortuaryEntry } from "./discharge-exit";
/** ER lane 5 (#812) — the hand-off: the ER gate time and "stabilised" onto the admission; the ER order lines onto the IP bill. */
export { cancelErAdmissionIn, carryErAdvanceIn, carryErLineIn, carryErOrderLinesIn, erAdmissionState, erOpenAdmissionFor, stampErHandOffIn } from "./er-handoff";
export { readDischargeBoard, readDischargeTracker } from "./discharge-read";
export { IPD_DISCHARGE_EVENT_NAMES } from "./discharge-events";
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
// #761 — the attendant-recipient seam for the daily totals, the approved-template switch from config, consent and stop.
export { IPD_DAILY_TOTALS_SEND_HOUR_IST, dailyTotalsSendAt } from "./daily-totals";
export {
  dailyTotalsSendingOf, dailyTotalsWords, ipdAttendantRecipient, ipdTemplateRegistrations, readAttendantMessages, readDailyTotalsStrip,
  recordAttendantConsent, stopAttendantMessages,
} from "./attendant-messages";
// E5.1 (#738) Now cards and E5.2 (#739) Bed Flow T0.
export { BED_FLOW_HOT_WAIT_MINUTES, readBedFlow } from "./bed-flow";
export type { BedFlowEntry } from "./bed-flow";
export { settleBedProposalIn, withdrawBedProposalIn } from "./bed-flow-log";
export type { BedFlowWithdrawReason } from "./bed-flow-log";
export {
  IPD_DISCHARGE_STEP_STUCK_MINUTES, bedProposalCard, cleaningOverdueCard, dischargeBlockedCard, rankNowRows, stuckStepOf,
} from "./now-cards";
export type { NowRow, StuckStep } from "./now-cards";
// E4.4 DIET (#736) — who lies on a bed now and in which ward (the meal lists), and the shared Now-card identity rule
// (name, alias for a sealed or confidential patient) for the kitchen's labels and the ward diet sheet.
export { placedCensus } from "./diet-seam";
export type { PlacedPatient } from "./diet-seam";
export { nowIdentities } from "./now-cards";
export type { Identity as NowIdentity } from "./now-cards";
// E4.1 (#733) — nursing: the assessment, vitals scored by NEWS2 / MEOWS / PEWS, one alert per breach, I/O, notes, the
// shift handover, the nurse station and my shift, the four nursing Now cards, the minute sweep.
export {
  IPD_ASSESSMENT_RECORD, IPD_EWS_RESPOND, IPD_NURSING_VIEW, IPD_SHIFT_HANDOVER, IPD_VITALS_RECORD,
} from "./manifest";
export {
  IPD_NURSING_STATES, acceptShiftHandover, acknowledgeEwsAlert, addNursingNote, dutyDoctorsFor, giveShiftHandover, ioDayStart,
  isNightIst, recordIntakeOutput, recordNursingAssessment, recordVitals, scoreContextOf, shiftOf, sweepIpdNursing,
} from "./nursing";
export type { NursingSweepResult } from "./nursing";
export { listShiftHandovers, nextDueOf, readMyShift, readNurseStation, readNursingChart } from "./nursing-read";
export { assessmentDueCard, ewsRisingCard, handoverPendingCard, overdueVitalsCard } from "./nursing-cards";
export { IPD_NURSING_EVENT_NAMES } from "./nursing-events";
// E4.2 (#734) — rounds: sign (S/O/A/P, bedside or remote; resident drafts co-signed), fit from the round, inpatient
// orders (drugs; lab and imaging through the ordering door), cross-consults, the 08:00 cover and 14:00 nudge clock,
// and the eMAR's seams on the order contract (`ipd.order.placed|stopped|cancelled`, `readIpdOrder`,
// `activeIpdOrdersOf`, `markIpdOrderIssuedIn`).
export { IPD_ORDER_PLACE, IPD_ROUND_SIGN } from "./permissions";
export { IPD_CONSULT_NOTICE_KIND, closeConsult, cosignRound, requestConsult, signRound } from "./rounds";
export {
  activeIpdOrdersOf, cancelIpOrder, drugFactsOf, markIpdOrderIssuedIn, placeIpOrder, readIpdOrder, stopIpOrder,
} from "./orders";
export type { IpdOrderDoor, IpdOrderIssueStamp, IpdOrderOpts, IpdOrderRow } from "./orders";
export { readRoundPatient, readRoundsList, roundsConsultantChoices } from "./rounds-read";
export {
  IPD_COVER_KIND, IPD_ROUND_NUDGE_HEAD_KIND, IPD_ROUND_NUDGE_KIND, IPD_ROUNDS_REF_TYPE, applyCovers, nudgeUnrounded, sweepIpdRoundsClock,
} from "./rounds-clock";
export { CONSULTANT_GRADES, NON_CONSULTANT_ROLE_KEYS, consultantIdsAmong, coveringConsultantFor, isConsultant, unitHeadFor } from "./rounds-team";
export { raiseBackdatedVisitIn, resolveBackdatedVisit, visitChargeableAt } from "./charges";
export { declareFitIn } from "./discharge";
export { orderCancelled, orderPlaced, orderStopped, roundSigned } from "./rounds-events";
export { IPD_ADMISSION_NO_RE, IPD_ADMISSION_PREFIX, intendedPayerOfAdmission, registerIpdEncounterResolver } from "./encounter";
export { ipdCoversOrderItem, ipdOrderStanding, lockIpdOrderStanding, postIpdOrderCharges, registerIpdOrderChargeSink, reverseIpdOrderCharge } from "./order-charges";
export { keepOrderCharge } from "./charges";
// E4.3 (#735) — the eMAR: pharmacist verify (allergy, interaction, dose, duplicate), issue with patient labels and returns,
// the dose schedule, the bedside acts (give with both scans or a counted override, hold / refuse / miss / re-offer,
// corrections never deleting), the second nurse's PIN, infusions, the narcotic register, verbal orders, the allergy
// re-check consumer, the minute sweep (missed doses, verbal-order nudges), the two nurse Now cards and the reads.
export { IPD_EMAR_GIVE, IPD_EMAR_ISSUE, IPD_EMAR_VERIFY, IPD_EMAR_VIEW } from "./permissions";
export {
  EMAR_SYSTEM_ACTOR, IPD_EMAR_NURSE_ROLES, NPO_ROUTES, administerDose, backfillEmarAllergyFlags, decideAllergyFlag, npoAt, emarAllergyConsumer, holdDose, issueMed, markDoseInError, missDose,
  recheckOrdersForAllergy, recordInfusionEvent, recordNarcoticWastage, refuseDose, reofferHeldDoses, resolveAllergyFlag, returnMed,
  secondCheck, confirmSecondNursePin, signVerbalOrder, sweepIpdEmar, verifyFindingsOf, verifyOrder,
} from "./emar";
export type { EmarSweepResult } from "./emar";
export { cancelFutureDosesIn, scheduleDosesIn } from "./emar-doses";
export { ISMP_HIGH_ALERT_NAMES, dueTimesFor, giveTiming, isHighAlert, isTimeCritical, prnState, unitsPerDose } from "./emar-rules";
export { readAdmissionAllergyFlags, readEmarDue, readEmarPatient, readLabelSheet, readOverrideCounts, readPharmacyQueue, readWardChart, scanAtBedside } from "./emar-read";
export { IPD_NEW_ORDER_HOURS, dueDoseCard, newOrderCard } from "./emar-cards";
export { IPD_EMAR_ALLERGY_CONSUMER, IPD_EMAR_EVENT_NAMES } from "./emar-events";
// #787 — medicines issued to the ward on the running bill: the eMAR's issue and return post / credit `ipd.pharmacy` lines
// at the pharmacy counter's own batch price; the bill desk decides a return after the bill and a charged lost / damaged
// replacement with the order-cancel acts (`reverseChargeLine`, `keepOrderCharge`).
export { postDrugIssueChargesIn, postDrugReturnCreditsIn, retryDrugExceptionsIn, versionPricedServices } from "./drug-charges";
export type { DrugIssueCharge, DrugReturnOutcome } from "./drug-charges";
// #787 (IP counter) — the OPD pharmacy counter charges a sale to the admission (and takes its returns) on the running bill.
export { counterCharge, counterReturn, lookupCounterAdmission, readCounterSales, searchCounterShelfForIp } from "./counter-charge";
// 2026-10-14 — the ward narcotic register (NDPS / NABH): per-ward running balance, the shift-change count by two nurses,
// exceptions to the nursing supervisor and the pharmacy, resolved with a note; the patient's units follow a ward move.
export { IPD_NARCOTIC_RESOLVER_ROLES, readNarcoticWard, recordNarcoticCount, resolveNarcoticException } from "./narcotic";
export { followNarcoticsIn, wardNarcoticBalances } from "./narcotic-ledger";
export type { NarcoticBalance, NarcoticMove } from "./narcotic-ledger";

// E5.3 (#740), E5.4 (#741) — "Since yesterday", the nurse's SBAR draft and the discharge drafter: a deterministic fact
// builder and line templates (every line names its records), a verifier that refuses a model's wrong or invented
// number, and the staff copilot's own model behind one door (mask, halt, cap, ledger). Drafts only: a person signs.
export {
  DISCHARGE_LIMITS, DISCHARGE_PROMPT_VERSION, DRAFT_BUDGET_MS, HANDOVER_GRACE_MS, SBAR_PROMPT_VERSION, SINCE_BUDGET_MS, SINCE_PROMPT_VERSION,
  buildDischargeDraft, buildSbarDraft, medicinesNamedWithoutOrder, polishSinceYesterday, readHandoverDraft, readSinceYesterday,
} from "./copilot";
export type { CopilotOpts } from "./copilot";
export { MODEL_COOLDOWN_MS, checkSbarDraftForGive, dischargeRecordsHash, sbarTextHash } from "./copilot-drafts";
export { buildFactSet, buildFacts, factsHash } from "./copilot-facts";
export {
  CONNECTIVES, SINCE_MAX_LINES, applyRewordings, chooseLines, isAbnormal, lineTokens, quantitiesIn, renderLine, unverifiedWords, verifyFreeText,
  verifyReworded,
} from "./copilot-lines";
export type { Fact, FactRecord, Line, Quantities, Verdict } from "./copilot-lines";
export { askIpdModel, ipdModelFrom, maskForModel, modelBarred } from "./copilot-model";
export type { FallbackReason, IpdModel } from "./copilot-model";
export { medicineFlagsOf, medicineRowReason, sameMedicineName } from "./discharge-medicines";
// #604 (decision 0075) — the TPA desk: payer queries, documents, scheme packages and their importer, the claim after the
// bill (submit, settle, reject), the board, the per-admission panel and the `ipd.tpa_due` card.
export {
  answerTpaQuery, attachTpaDocument, packageAmountOf, recordClaimRejection, recordClaimSettlement, recordTpaQuery, removeSchemePackage,
  selectSchemePackage, submitClaim,
} from "./tpa";
export { importSchemePackages, packageShares, parseSchemePackagesCsv, searchSchemePackages } from "./tpa-packages";
export { authStateOf, readTpaBoard, readTpaPanel, tpaDueCard } from "./tpa-read";
// LD-1 (#978) — what the laundry needs from IPD, by bed: planned discharges (rush demand) and MLC beds (hold suggestion).
export { mlcOccupiedBeds, plannedDischargeBeds } from "./linen-seam";
