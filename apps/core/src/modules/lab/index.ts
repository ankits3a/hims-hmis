/**
 * THE cross-module interface of the lab module (spec §4). Later plans import from here or consume
 * events — never internals. 17-E, 17-M, 17-H, 24a, 26, 22c-F and 28a all read §6 of the phase
 * document and then this file.
 *
 * T2 ships the seam: manifest, kinds, events, errors, the approval type. T3–T8 widen it by ONE
 * export line each as the functions behind them land.
 */
export { labManifest } from "./manifest";
export { LabModule } from "./lab.module";
export { LAB_RESOURCE_KINDS } from "./kinds";
// ── PLAN 17-E T7b — the analyser's bridge: the kernel's two liveness edges, projected onto the machine ──
// `worker.module.ts` imports BOTH of these; the manifest declares the subscription and the worker
// supplies the handler, and `buildSubscriptionBus` makes shipping one without the other a boot error.
export { LAB_INTERFACE_ACTOR, LAB_INTERFACE_CONSUMER, labInterfaceConsumer } from "./interface-status";
export { LabError, labHttpStatus, LAB_ERROR_CODES } from "./errors";
export type { LabErrorCode } from "./errors";
export {
  LAB_APPROVAL_TYPES, RELEASE_UNPAID_APPROVAL_TYPE, registerLabApprovalTypes,
} from "./approval-types";
export * from "./events";
// ── PLAN 17a T3 — the catalogue and the three pure engines behind it ──
// 17b CALLS these and does not reimplement them (17a §6.3): `resolveRange`'s output is what a
// result row snapshots, `evaluateFormula` is what a formula analyte computes with, and
// `matchReflex` decides that a rule FIRES while 17b's caller decides that it may be acted on.
export {
  analytesFor, activeReflexRules, getOrderable, listOrderables, putReferenceRange, rangesFor,
  upsertAnalyte, upsertOrderable,
} from "./catalogue";
export type { AnalyteInput, OrderableInput, ReferenceRangeInput } from "./catalogue";
export { ageInDaysIst, flagFor, resolveRange } from "./ranges";
export type { AnalyteRow, RangeRow, RangeSubject, ResolvedRange } from "./ranges";
export { assertFormulaParses, evaluateFormula } from "./formula";
export type { FormulaOutcome, Siblings } from "./formula";
export { matchReflex } from "./reflex";
export type { ReflexMatch, ReflexRule } from "./reflex";
export { duplicateWarnings, overlappingAnalytes } from "./duplicates";
export type { DuplicateWarning } from "./duplicates";
// ── PLAN 17a T4 — the desk, the two definitions, and the add-on ──
// DD22: 17a mounts NO route, so these are transaction-shaped services. 17b's controllers wrap
// `deskOrder` in `withIdempotency` (imported from `../billing`) and add no second placement path.
export { addOnOrder, advisedTestItems, deskOrder, LAB_DESK_OPERATE } from "./desk";
export type {
  AddOnOrderInput, DeskItemInput, DeskOrderInput, DeskOrderResult, LabCollectionSite, LabPriority,
} from "./desk";
// ── PLAN 17c T1 — the reception seat: three doors, the Rx lines' first consumer, the walk-in door ──
export { deskFind, deskWalkinOrder, drawRank, DRAW_ORDER, labDoctors, tubePlan } from "./desk";
export type { DeskAdvisedLine, DeskFindHit, DeskWalkinInput, TubePlanRow } from "./desk";
export {
  LAB_ITEM_DEFINITION_JSON, LAB_ITEM_DEF_KEY, LAB_ITEM_STATES,
  LAB_SPECIMEN_DEFINITION_JSON, LAB_SPECIMEN_DEF_KEY, LAB_SPECIMEN_STATES,
  labItemDefinition, labSpecimenDefinition,
} from "./workflow-def";
export type { LabItemState, LabSpecimenState } from "./workflow-def";
export { activateLabDefinitions, LAB_DEFINITIONS, LAB_DEF_KEYS } from "./definitions";
export type { ActivateLabDefinitionsReport } from "./definitions";
// ── PLAN 17a T5 — collection, accession, and the two worker sweeps ──
// The phase STOPS at `receive`, which is DD4's first projection point: the item's `accessioned`
// becomes the envelope's `in_progress` and the TAT clock starts. 17b begins by reading that triple.
export { assertRightPatient, awaitingLabels, collect, collectionQueue, tokensByVisit } from "./collection";
export type { AwaitingLabelRow, CollectInput, CollectionQueueRow } from "./collection";
export { getSpecimenByNo, printLabels } from "./specimens";
export type { PrintedSpecimen, PrintLabelsInput, PrintLabelsResult, SpecimenView } from "./specimens";
export { orderableCodesFor, receive, reject } from "./accession";
export type { ReceiveInput, ReceiveResult, RejectInput, RejectResult } from "./accession";
export {
  LAB_NON_RETURN_ACTOR, LAB_SLA_ACTOR, NON_RETURN_DAYS, sweepLabNonReturn, sweepLabSla,
} from "./sweeps";
export type { NonReturnSweepReport, SlaSweepReport } from "./sweeps";
// ── PLAN 17b T6 — the number, the signature, the call ladder ──
// 17d T1 — `enterResult`, `verifyResult` and `printLabels` are now ALL `Db`-first, and the
// asymmetry 17a §6.8 recorded is gone. Each of the three must WRITE on its refusal path
// (`lab.tube_swap_suspected`, `lab.sod_violation_blocked`, `lab.tube_mismatch_flagged`), and an
// audit row appended on the transaction that is about to roll back is an audit row that never
// existed (F20, F27, and the third time the module has met it).
export {
  amendResult, chooseReportedResult, enterResult, requestRerun, resultContext, LAB_RESULTS_ENTER,
} from "./results";
export type {
  AmendResultInput, ChooseReportedResultInput, EnteredResult, EnterResultInput, EnterResultOutcome,
  LabEntryMode, RequestRerunInput,
} from "./results";
export {
  isSingleOperatorNight, verifyResult, LAB_REFLEX_ACTOR, LAB_RESULTS_VERIFY,
  NIGHT_MODE_FROM_HOUR_IST, NIGHT_MODE_TO_HOUR_IST,
} from "./verify";
export type { ReflexPlacement, ReflexRefusal, VerifyResultInput, VerifyResultOutcome } from "./verify";
export {
  acknowledgeCritical, openCriticalCalls, nextRung, RUNGS, CRITICAL_CALL_TARGET_MINUTES,
  LAB_CRITICALS_CLOSE,
} from "./criticals";
export type {
  AcknowledgeCriticalInput, AcknowledgeCriticalOutcome, CriticalAttempt, OpenCriticalCall,
} from "./criticals";
// ── PLAN 17b T7 — the money rule, the delivery interlock, and the document ──
// `money.ts` and `interlock.ts` are the close reviewer's first two files (§9.6): every threshold on
// this phase's money path is in one of them, and `deliveryAllowed` is the function 22c-F, 24a and
// 18a all call rather than re-deriving from invoices (CONTRACT §6.5 as amended by DD23).
export { billedLabLines, cancelLabItem, chargeReasonFor, deskOrderAtCounter, refundOnCancel } from "./money";
export type { CancelLabItemInput, LabChargeReason, RefundOutcome } from "./money";
export { deliveryAllowed, EXEMPT_ENCOUNTER_PREFIXES, EXEMPT_PAYERS } from "./interlock";
export type { DeliveryVerdict } from "./interlock";
export {
  amendReport, deliveryRegister, getReport, listResultsForEncounter, listProvisionalResultsForEncounter,
  printReport, publishReport, releaseUnpaid,
  reportsForPatient, reportVersions, LAB_REPORTS_AMEND, LAB_REPORTS_PRINT, LAB_REPORTS_PUBLISH, LAB_RESULTS_READ,
  PATIENT_LAB_REPORT_READY,
} from "./reports";
export type { DeliveryRegisterRow, PatientReportRow, PatientReports, ReportDeliveryRow, ReportNotice } from "./reports";
export type {
  AmendReportInput, EncounterResultRow, PrintedReport, PrintReportInput, ProvisionalResultRow, PublishedReport,
  PublishReportInput, ReleaseUnpaidInput, ReportAnalyteLine, ReportPanel, ReportSnapshot,
  ReportVersionRow, ReportView,
} from "./reports";
// ── PLAN 17b T8 — the HTTP surface, the worklists, and the live topics ──
export { LabCatalogueController } from "./lab-catalogue.controller";
export { LabDeskController } from "./lab-desk.controller";
export { LabCollectionController } from "./lab-collection.controller";
export { LabBenchController } from "./lab-bench.controller";
export { LabVerifyController } from "./lab-verify.controller";
export { LAB_IDEMPOTENT_ROUTES, LAB_REPORT_ROUTES, toHttp as labToHttp } from "./lab-http";
export { benchArrivals, benchWorklist, labWorklist, publishableOrders, verifyWorklist } from "./worklist";
export type { BenchArrivalRow, PublishableOrder, WorklistRow } from "./worklist";
export { LAB_BENCH_NAMES, LAB_BENCH_TOPIC, LAB_REALTIME_NAMES, LAB_TOPIC_SPACES, labTopicRouter, labTopicsFor } from "./realtime";
