/**
 * PLAN 15 — the mini-OT module's public surface.
 *
 * OTHER MODULES IMPORT FROM HERE AND FROM NOWHERE ELSE (spec §4, and the `materials/index.ts`
 * precedent). Billing reaches the day-care encounter through the resolver T7 registers, never
 * through `daycare_encounters`; nothing else in the tree touches these tables at all.
 *
 * It goes the other way too, and that is the half worth stating: this module reads materials through
 * `modules/materials`' own index (`consumptionsFor`, `createStore`, `consignmentDeployed`) and
 * patients through `modules/patients`', never through `kernel/db/schema`. The one exception is this
 * module's OWN tables, which it owns.
 *
 * T3–T8 each append their own exports here. The list grows downward, task by task, so a reader can
 * see what each task added.
 */
export { otManifest } from "./manifest";
export { OtError, otHttpStatus, OT_ERROR_CODES } from "./errors";
export type { OtErrorCode } from "./errors";
export { OT_EVENTS } from "./events";
export {
  DAYCARE_RECOVERY_BAY_CLASS, OT_CONSIGNMENT_STORE_CODE, OT_RECOVERY_BAY_CODES, OT_RESOURCE_KINDS,
  OT_THEATRE_CODE,
} from "./kinds";
export {
  DEFINITION_PUBLISH_APPROVAL_TYPE, DEPOSIT_EXCEPTION_APPROVAL_TYPE, OT_APPROVAL_TYPES,
  registerOtApprovalTypes,
} from "./approval-types";
export {
  OT_IMPLANT_CONFIRMED_CONSUMER, OT_PATIENT_MERGED_CONSUMER, handleMaterialConsumed,
  handlePatientMerged, implantConfirmedConsumer, patientMergedConsumer,
} from "./consumers";
export type { ImplantConfirmation, MergeRewrite } from "./consumers";
export { OtModule } from "./ot.module";

// ── T3 — governed definition data, the deposit, booking, and the two workflow definitions ──
export {
  CRITERIA_SEED_BODY, DEPOSIT_POLICY_SEED_BODY, OT_DEFINITION_SEEDS, PACU_THRESHOLDS_SEED_BODY,
  PROCEDURE_CLASS_VALUES, activeDefinition, activeDefinitionRow, criteriaBodySchema, criteriaFor,
  depositPolicyBodySchema, draftDefinition, pacuThresholdsBodySchema, parseDefinitionBody,
  privilegesBodySchema, publishDefinition, requestDefinitionPublish,
} from "./definitions";
export type {
  CriteriaBody, CriteriaEntry, DepositPolicyBody, OtDefinitionKind, OtDefinitionRow,
  PacuThresholdsBody, PrivilegesBody, ProcedureClass,
} from "./definitions";
export {
  grantedShortfallPaise, heldPaise, holdDeposit, openHolds, releaseHolds, requestDepositException,
  requiredDeposit,
} from "./deposit";
export type { DepositHoldRow, PayerClass, RequiredDepositInput } from "./deposit";
export { bookCase, cancelCase, caseState, changePayerClass, currentState, postponeCase } from "./booking";
export type { BookCaseInput, BookCaseResult } from "./booking";
export {
  DAYCARE_CASE_DEF_KEY, OT_GATE_DEF_KEY, OT_WORKFLOW_DEFINITIONS, POSTPONE_REASONS,
  daycareCaseDefinition, otGateDefinition,
} from "./workflow-def";

// ── T4 — readiness: the gates, the consents, the list ──
export {
  ADULT_AGE_YEARS, CLINICALLY_OVERRIDABLE_KINDS, NPO_CLEAR_FLUIDS_HOURS, NPO_SOLIDS_HOURS,
  TERMINAL_GATE_STATES, caseGates, evaluateReadiness, gateState, overrideGate, satisfyGate, waiveGate,
} from "./gates";
export type { GateRow } from "./gates";
export { CONSENT_KINDS, consentEvidence, consentSchema, validateConsent } from "./consents";
export type { ConsentEvidence, ConsentKind } from "./consents";
export {
  SURGEON_LATE_RUNGS_MINUTES, flagLateSurgeons, listForDay, printPack, publishList, resequence,
} from "./lists";
export type { ListItem, OtListRow } from "./lists";

// ── T5 — the cockpit: holding verify, the WHO states, counts, implants, specimens ──
export {
  BACKFILL_PHASES, backfillCase, completeChecklist, markClosure, markIncision, recordDeathOnTable,
  recordDoseLog, recordProcedureConverted, signIn, signOut, timeOut, toHolding, verifyHolding,
  wheelOut,
} from "./cockpit";
export type { BackfillPhase, ChecklistPhase } from "./cockpit";
export { countsFor, finalCountVerdict, openCountMismatch, recordCount } from "./counts";
export type { CountRound, CountRow, RecordCountInput } from "./counts";
export {
  IMPLANTABLE_STATES, deployImplant, deployingImplants, explantImplant, implantsFor,
} from "./implants";
export type { DeployImplantInput, ImplantRow } from "./implants";
export { SPECIMEN_STATES, createSpecimen, dispatchSpecimen, specimensFor } from "./specimens";
export type { SpecimenRow } from "./specimens";

// ── T6 — recovery: bays, scoring, escort, discharge, conversion, absconded ──
export {
  admitToBay, convertToAdmission, dischargeDaycare, evaluateDischargeReady, istTimePassed,
  markAbsconded, readinessOf, recordScore, recoveryBoard, scoresFor, verifyEscort,
} from "./recovery";
export type { EscortVerification, PacuScoreRow, ReadinessVerdict } from "./recovery";
