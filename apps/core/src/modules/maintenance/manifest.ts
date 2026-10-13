import { MAINTENANCE_CONFIRM, MAINTENANCE_MANAGE, MAINTENANCE_RAISE, MAINTENANCE_VIEW, MAINTENANCE_WORK } from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E1.5 MAINTENANCE (issue #722, decision 0072) — five permissions, one menu entry, no subscription and no job
 * (the repeat-fault flag is computed in the raise transaction; the ticket follows its repair task through the
 * task engine's `onDone` / `onVerified` hooks).
 *   · `maintenance.view` — the maintenance board (open tickets by floor, blocked beds, replacement flags).
 *   · `maintenance.raise` — report a fault (anyone on a ward: nurses' side, front office, duty manager, supervisors).
 *   · `maintenance.work` — the technicians (engineering and biomedical): the board; their acts are the task
 *     engine's (`tasks.work`) on "My tasks".
 *   · `maintenance.confirm` — confirm a fixed repair (the nurse's check). A holder of `ipd.beds.clean` may too.
 *   · `maintenance.manage` — cancel a ticket raised in error, dispatch a ticket whose task was cancelled.
 * Importing this module defines its task kinds, which the API and the worker's task clock both need (tasks MAP §4).
 */
export { MAINTENANCE_CONFIRM, MAINTENANCE_MANAGE, MAINTENANCE_RAISE, MAINTENANCE_VIEW, MAINTENANCE_WORK };

export const maintenanceManifest: ModuleManifest = {
  key: "maintenance",
  title: "Maintenance",
  menu: [{ label: "Maintenance", path: "/maintenance", permission: MAINTENANCE_VIEW }],
  permissions: [MAINTENANCE_VIEW, MAINTENANCE_RAISE, MAINTENANCE_WORK, MAINTENANCE_CONFIRM, MAINTENANCE_MANAGE],
  subscriptions: [],
};
