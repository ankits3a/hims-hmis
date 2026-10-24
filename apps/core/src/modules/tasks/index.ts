/**
 * E0.1 TASK ENGINE (issue #713, decision 0072) — other modules import this one only through here
 * (lint-enforced). An owning module declares its kind with `defineTaskKind` (and its skill with
 * `defineSkill`), raises with `raiseTask`, and cancels a place's work with `cancelTasksForPlace`.
 */
export { tasksManifest, TASKS_SUPERVISE, TASKS_VIEW, TASKS_WORK } from "./manifest";
export { TasksModule } from "./tasks.module";
export {
  DEFAULT_LADDER_MIN, GENERAL_TASK, SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE,
  allSkills, defineSkill, defineTaskKind, requireTaskKind, skillRoles, taskKind, taskKinds, verifierPermissionsOf,
} from "./kinds";
export type { TaskKindDecl } from "./kinds";
export { TaskError, taskHttpStatus } from "./errors";
export {
  DISPATCH_ACTOR, MERGE_WINDOW_MS, acceptTask, assignTask, cancelTask, cancelTasksForPlace, completeTask, raiseTask,
  returnToPool, startTask, verifyTask,
} from "./engine";
export type { ActOptions, CancelOptions, RaiseResult, TaskRow } from "./engine";
export { dutyCovering, onDutyForSkill, openLoad, pickWorker } from "./dispatch";
export type { OnDutyWorker } from "./dispatch";
export { SWEEP_ACTOR, SWEEP_BATCH, nudgeTask, sweepTasks } from "./sweep";
export type { SweepResult } from "./sweep";
export { findTasks, getTask, myTasks, taskBoard } from "./reads";
