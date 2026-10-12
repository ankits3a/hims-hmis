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
  BED_LAYOUT_COLUMNS, formatBedLayoutReport, loadBedLayout, parseBedLayoutCsv, validateBedLayout,
} from "./bed-layout";
export type {
  BedLayoutChange, BedLayoutColumn, BedLayoutPlan, BedLayoutProblem, BedLayoutReport, BedLayoutRow,
} from "./bed-layout";
// E0.2 — the admission workflow definition (states and the intent that drives each transition).
export {
  ADMISSION_WORKFLOW_DEF_KEY, ADMISSION_TRANSITIONS, IPD_ACTOR_ROLE_KEYS, admissionIntentFor, admissionWorkflowDefinition,
} from "./admission-workflow";
export type { AdmissionTransition } from "./admission-workflow";
