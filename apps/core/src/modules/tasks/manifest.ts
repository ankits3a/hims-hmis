import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E0.1 TASK ENGINE (issue #713, decision 0072) — three permissions.
 *   · `tasks.view` — the supervisor board (open work by floor, late first, worker load).
 *   · `tasks.work` — my own list: raise, accept, start, done, hand back.
 *   · `tasks.supervise` — assign, cancel, verify where the kind says, take a task back, see all.
 * No subscription: owning modules call the intents through `index.ts`. The worker runs `sweepTasks`
 * and needs no permission to, so the manifest is installed in the API only (the `roster` shape).
 */
export const TASKS_VIEW = "tasks.view";
export const TASKS_WORK = "tasks.work";
export const TASKS_SUPERVISE = "tasks.supervise";

export const tasksManifest: ModuleManifest = {
  key: "tasks",
  title: "Tasks",
  menu: [
    { label: "My tasks", path: "/tasks", permission: TASKS_WORK },
    { label: "Task board", path: "/tasks/board", permission: TASKS_VIEW },
  ],
  permissions: [TASKS_VIEW, TASKS_WORK, TASKS_SUPERVISE],
  subscriptions: [],
};
