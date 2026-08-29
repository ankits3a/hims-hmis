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
  analytesFor, activeReflexRules, getOrderable, rangesFor, upsertAnalyte, upsertOrderable,
} from "./catalogue";
export type { AnalyteInput, OrderableInput } from "./catalogue";
export { ageInDaysIst, flagFor, resolveRange } from "./ranges";
export type { AnalyteRow, RangeRow, RangeSubject, ResolvedRange } from "./ranges";
export { assertFormulaParses, evaluateFormula } from "./formula";
export type { FormulaOutcome, Siblings } from "./formula";
export { matchReflex } from "./reflex";
export type { ReflexMatch, ReflexRule } from "./reflex";
export { duplicateWarnings, overlappingAnalytes } from "./duplicates";
export type { DuplicateWarning } from "./duplicates";
