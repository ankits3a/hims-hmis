/**
 * E1.5 MAINTENANCE (issue #722, decision 0072) — other modules import this one only through here (lint-enforced).
 * Importing it DEFINES maintenance's task kinds and skills (`./kinds`), which both the API and the worker need.
 */
import "./kinds";
export { maintenanceManifest } from "./manifest";
export {
  BIOMEDICAL_ENGINEER_ROLE, MAINTENANCE_ACTOR, MAINTENANCE_CONFIRM, MAINTENANCE_MANAGE, MAINTENANCE_RAISE,
  MAINTENANCE_STAFF_ROLE, MAINTENANCE_VIEW, MAINTENANCE_WORK,
} from "./names";
export { BIOMEDICAL_SKILL, MAINTENANCE_SKILL, REPAIR_BIOMEDICAL, REPAIR_GENERAL } from "./kinds";
export { MaintenanceModule } from "./maintenance.module";
export { MaintenanceRefusal, maintenanceHttpStatus } from "./errors";
export { cancelTicket, confirmTicket, dispatchTicket, raiseTicket } from "./tickets";
export { MAINTENANCE_BOARD_LIMIT, bedTickets, maintenanceBoard, placesForRaise } from "./reads";
export type { TicketRow } from "./store";
