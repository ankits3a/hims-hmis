/**
 * E2.4 LINEN (issue #728, decision 0072) — other modules import this one only through here (lint-enforced). Importing
 * it also defines the `linen_change` task kind (`kinds.ts`). IPD admission and discharge call `raiseLinenChange`.
 */
export { linenManifest, LINEN_HANDLE, LINEN_MANAGE, LINEN_VIEW } from "./manifest";
export { LinenModule } from "./linen.module";
export { LINEN_CHANGE_TASK, LINEN_SYSTEM, raiseLinenChange } from "./kinds";
export type { RaiseLinenChangeInput } from "./kinds";
export { LinenError, linenHttpStatus } from "./errors";
export {
  approveCondemn, borrowBetweenWards, formatBatchNo, receiveFromLaundry, recordInfected, recordSoiled, recordWardCount,
  rejectCondemn, requestCondemn, requireWard, sendToLaundry, setParLevel, topUpWard,
} from "./intents";
export type { BatchRow, CondemnRow, MovementRow } from "./intents";
export {
  bookBalances, condemnPending, inTransit, linenBoard, linenHandlerView, linenItemList, rollingWeek, seedLinenItems, soiledPool,
  wardShapes, wardStates, weeklyVariance,
} from "./reads";
export type { WardShape } from "./reads";
