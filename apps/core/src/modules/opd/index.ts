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
export { parkConsultation, registerConsultStartGuard, resumeConsultation } from "./consultation";
export type { ConsultStartGuard } from "./consultation";
/*
  FD-28 — `counterState` is exported for BILLING. It is the PHI-free projection of a visit (status,
  service date, fee status, token) and the billing counter needs the token so a cashier entered by
  `?encounterId=` can say which slip they are billing against. Additive: `getVisit` ships vitals,
  prescriptions and the diagnosis and is the wrong read for a money seat, which is exactly why this
  narrower one exists.
*/
export { counterState, getEncounter, getVisit, listVisits, patientTimeline } from "./encounters";
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
/* `isCurrent` under its telling name: the pharmacy asks the same question about a prior course
   ("is the patient still on this?") that the duplicate check asks (`patient-rail.ts`). */
export { isCurrent as isCurrentDose } from "./rx-checks";
export { discardDraft, getPendingDraft, issueDraft, saveDraft } from "./prescription-drafts";
export { registerVitalsStartGuard, vitalsGateVerdict } from "./consultation";
export type { VitalsStartGuard } from "./consultation";
export type { DraftRow, SaveDraftInput } from "./prescription-drafts";
export type {
  AllergyMatch, AllergyOverride, RxCheckOutcome, RxNotice, RxOverride, RxVerifyReason, RxVerifyResult,
} from "./prescriptions";
export { findVisitByToken } from "./encounters";
// PLAN 16c T4 — the prescriber on the Schedule H1 register (Rule 65(3): name and registration number).
export { getDoctor } from "./masters";
// PHARMACY P6 — the controlled-drug licence sheet names which doctors are trained under NDPS Rules r.2(ib).
export { listDoctors } from "./masters";
export type { DoctorRow } from "./masters";
export type { PrescriptionRow } from "./encounters";
export type { Eye, RxLine, TaperStep } from "./fhir";
// The ophthal line's words: the pharmacy label names the eye exactly as the e-Rx does.
export { EYE_TEXT } from "./fhir";
export { classifyVisit } from "./visit-type";
export type { VisitType } from "./visit-type";
/**
 * PHASE R (R1) — `DEFAULT_DEPARTMENTS` joins the declared interface, ADDITIVELY and read-only.
 * The roster's own department master must cover every clinic the OPD opens, and the census that
 * proves it (`modules/roster/masters.test.ts`) may only see another module through this file
 * (spec §4). A transcription of the twelve into the roster would be a copy that goes stale the
 * first time somebody adds a thirteenth — which is the exact defect the census exists to catch.
 */
export { DEFAULT_DEPARTMENTS, loadOpdConfig } from "./config";
export type { OpdConfig } from "./config";
export { orderQueue, nextInQueue, classOf } from "./queue-engine";
export { SKIP_REASONS } from "./skip-reasons";
export type { SkipReason } from "./skip-reasons";
export type { QueueEntryState, QueuePolicy, QueueClass } from "./queue-engine";
export * from "./events";
export { walkIn } from "./walk-in";
export type { WalkInInput, WalkInResult, WalkInDeferredResult, DuplicateCandidate } from "./walk-in";
// VD-1 T3 — the danger protocol. Exported so the controllers (T5) and the bay's read surfaces
// reach it through the module boundary rather than the file, like every other service here.
export { CANCEL_WINDOW_MS, cancelEscalation, cancelMsRemaining, demandRecheck, escalate, escalationFor } from "./escalation";
export type { EscalationState, EscalationView } from "./escalation";
// ── ABDM S2 — what a completed OPD visit releases to the national network (modules/abdm reads only this) ──
export { completedVisitIdsOf, completedVisitsForRelease } from "./abdm-release";
export type { OpdReleaseDiagnosis, OpdReleaseVisit } from "./abdm-release";
// ── ABDM S3 — a request for a patient's records from OTHER facilities rides the consult's own guard:
//    the encounter's treating doctor, resolved from opd_doctors.user_id (D5), never from a role ──
export { requireTreatingDoctor } from "./consultation";
