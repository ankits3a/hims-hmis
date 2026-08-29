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
