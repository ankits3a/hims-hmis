/**
 * E1.4 HOUSEKEEPING (issue #721, decision 0072) — other modules import this one only through here (lint-enforced).
 * Importing it DEFINES housekeeping's task kinds and skills (`./kinds`), which both the API and the worker need.
 */
import "./kinds";
export { housekeepingManifest } from "./manifest";
export {
  HOUSEKEEPING_ACTOR, HOUSEKEEPING_BED_CONSUMER, HOUSEKEEPING_CONFIRM, HOUSEKEEPING_ROTA_MANAGE, HOUSEKEEPING_SETUP_MANAGE,
  HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW,
} from "./names";
export {
  AREA_REQUEST, AREA_REWORK, AREA_ROUND, AREA_ROUND_CHECKED, BED_CLEAN_ROUTINE, BED_CLEAN_TERMINAL, HOUSEKEEPING_ROUND_SKILL,
  HOUSEKEEPING_SKILL, ROOM_INSPECTION, SPILL,
} from "./kinds";
export { HousekeepingModule } from "./housekeeping.module";
export { HousekeepingRefusal, housekeepingHttpStatus } from "./errors";
export { backfillBedCleans, bedTurnoverConsumer, cancelBedCleans, handleBedEvent, raiseBedClean } from "./turnover";
export type { TurnoverResult } from "./turnover";
export { confirmClean, nudgeClean, verifyClean } from "./cleans";
// HK-1 (#973, decision 0086) — setup, rota, rounds, proof of work, door requests, the supervisor board.
export { addContractor, areaQrToken, defineArea, readQrToken, revokeAreaQr, saveChecklist, setHkStaff, setupView } from "./setup";
export { publishRota, rotaView, saveRota } from "./rota";
export { roundsOf, runRoundsClock } from "./rounds";
export type { RoundsResult } from "./rounds";
export { finishWork, proofOf, storeWorkPhoto, workForm, workOf } from "./work";
export { doorRequestOf, raiseDoorRequest } from "./door";
export { supervisorBoard } from "./board";
export { bedCleans, housekeepingBoard } from "./reads";
// HK-2 (#974, decision 0086) — floor stores and monthly consumables, random inspections, the contractor SLA and daily reports.
export { floorConsumables, floorStoresView, linkFloorStore } from "./floor-stores";
export { drawInspections, inspectionsOf, recordInspection, storeInspectionPhoto } from "./inspections";
export { contractorSla, dailyReport, toCheck } from "./reports";
