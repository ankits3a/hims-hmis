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
// ── PLAN 17a T4 / DD15 — the lab walk-in, opened by the module that owns visits (spec §4) ──
export { LAB_DEPARTMENT_CODE, joinQueue, openLabWalkin, openLabWalkinInTx, reviewAnchorFor } from "./encounters";
export type { JoinQueueResult, OpenLabWalkinInput, OpenVisitResult, ReviewAnchor } from "./encounters";
export type { AdvisedTest } from "./consultation";
// ── PLAN 16c T0a — the prescription read surface the dispensing counter consumes (spec §4) ──
// `getPrescription` and `listPrescriptions` walk the 07a read gate and log the PHI read;
// `verifyPrescriptionQr` is the scanner's door; `runRxChecks` re-runs the issue-time checks on the
// RESOLVED medicines at dispense time (16c D9) — it is bound to a patient, not to a consult.
export { getPrescription, listPrescriptions, matchAllergies, runRxChecks, verifyPrescriptionQr } from "./prescriptions";
export type {
  AllergyMatch, AllergyOverride, RxCheckOutcome, RxNotice, RxOverride, RxVerifyReason, RxVerifyResult,
} from "./prescriptions";
export { findVisitByToken } from "./encounters";
export type { PrescriptionRow } from "./encounters";
export type { RxLine } from "./fhir";
export { classifyVisit } from "./visit-type";
export type { VisitType } from "./visit-type";
export { loadOpdConfig } from "./config";
export type { OpdConfig } from "./config";
export { orderQueue, nextInQueue, classOf } from "./queue-engine";
export type { QueueEntryState, QueuePolicy, QueueClass } from "./queue-engine";
export * from "./events";
export { walkIn } from "./walk-in";
export type { WalkInInput, WalkInResult, WalkInDeferredResult, DuplicateCandidate } from "./walk-in";
// VD-1 T3 — the danger protocol. Exported so the controllers (T5) and the bay's read surfaces
// reach it through the module boundary rather than the file, like every other service here.
export { CANCEL_WINDOW_MS, cancelEscalation, cancelMsRemaining, demandRecheck, escalate, escalationFor } from "./escalation";
export type { EscalationState, EscalationView } from "./escalation";
