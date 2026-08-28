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
  OT_PATIENT_MERGED_CONSUMER, handlePatientMerged, patientMergedConsumer,
} from "./consumers";
export type { MergeRewrite } from "./consumers";
export { OtModule } from "./ot.module";
