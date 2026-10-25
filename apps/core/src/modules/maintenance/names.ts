import type { Actor } from "@hmis/contracts";

/** The module's names, in one leaf file so the manifest, the kinds and the intents import no cycle. */
export const MAINTENANCE_VIEW = "maintenance.view";
export const MAINTENANCE_RAISE = "maintenance.raise";
export const MAINTENANCE_WORK = "maintenance.work";
export const MAINTENANCE_CONFIRM = "maintenance.confirm";
export const MAINTENANCE_MANAGE = "maintenance.manage";
/** The engineering department's technicians (electrician, plumber, AC, carpenter): the general repair skill. */
export const MAINTENANCE_STAFF_ROLE = "maintenance_staff";
/** Biomedical engineering: the equipment repair skill (the role already exists, `scripts/seed-roles.ts`). */
export const BIOMEDICAL_ENGINEER_ROLE = "biomedical_engineer";
/** Told when an item is flagged for replacement when no services supervisor exists. */
export const MAINTENANCE_FALLBACK_ROLE = "admin";
/** Who acts when the system ends a block or a task on the ticket's behalf. */
export const MAINTENANCE_ACTOR: Actor = { type: "system", id: "maintenance" };
