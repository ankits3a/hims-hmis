import { SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, defineSkill, defineTaskKind } from "../tasks";

/**
 * THE COLLECTION TASK. Generating a bag raises a `bmw_collection` task at its place (the engine merges a
 * second bag at the same place within ten minutes into the same task), so the ward's bags are fetched by
 * whoever is on duty with the `waste_handler` skill. Collecting the place's last waiting bag closes the task
 * with the bag's scan as proof.
 *
 * DEFINED HERE, IMPORTED BY `index.ts`: the API (controller) and the worker (`kernel/worker/jobs.ts` imports
 * `sweepBmwStorage` from the index) both load this file, so both registries know the kind (tasks MAP §4).
 *
 * DECIDED: the skill is its own (`waste_handler`), held today by `support_staff` — ward attendants and
 * housekeeping carry waste in an Indian corporate hospital; a dedicated waste role can be added to the skill later.
 */
export const WASTE_HANDLER_SKILL = "waste_handler";
defineSkill(WASTE_HANDLER_SKILL, [SUPPORT_STAFF_ROLE]);

/** The role told of a storage clock breach and of late collections. */
export const BMW_SUPERVISOR_ROLE = SERVICES_SUPERVISOR_ROLE;

export const BMW_COLLECTION_TASK = defineTaskKind({
  kind: "bmw_collection",
  label: "Collect waste bags",
  skill: WASTE_HANDLER_SKILL,
  acceptWithinMin: 10,
  // DECIDED: a ward's bags reach the central store within an hour of the first one being sealed.
  doneWithinMin: 60,
  escalateTo: BMW_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: false,
});
