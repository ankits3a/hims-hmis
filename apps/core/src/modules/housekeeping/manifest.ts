import { resourceAssigned, resourceReleased, resourceStatusChanged } from "../../kernel/resources";
import {
  HOUSEKEEPING_BED_CONSUMER, HOUSEKEEPING_CONFIRM, HOUSEKEEPING_ROTA_MANAGE, HOUSEKEEPING_SETUP_MANAGE,
  HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW,
} from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E1.4 HOUSEKEEPING (issue #721, decision 0072) — two permissions and one subscription.
 *   · `housekeeping.view` — the housekeeping supervisor's board (open cleans by floor, late first, clocks).
 *   · `housekeeping.verify_terminal` — check a TERMINAL clean (isolation, infection, death): the housekeeping
 *     supervisor alone (infection control). A routine clean is checked by a holder of `ipd.beds.clean` (the ward
 *     nurse side) or of this permission.
 *   · HK-1 (#973, decision 0086): `housekeeping.setup.manage` (areas, classes, checklists, door QR, contractors and
 *     staff), `housekeeping.rota.manage` (the shift rota) and `housekeeping.confirm` (Pass or Fail a clean or a
 *     round; the ward nurse side confirms with `ipd.beds.clean` as before).
 * The workers themselves need only `tasks.work` (their list is the task engine's "My tasks").
 *
 * The subscription is the bed's own kernel events: released into cleaning, moved into or out of cleaning, assigned.
 * INSTALLED IN BOTH PROCESSES (the pharmacy shape): the API mounts the routes; the worker runs the subscription,
 * and its handler is `workerConsumers`' `housekeeping.bed_turnover` entry — one without the other is a boot error.
 * Importing this module also defines its task kinds, which both processes need (tasks MAP §4). Its seeded cursor
 * skips older releases; `workerBackfills` (run by `seedCursors`) gives every bed already in cleaning its clean.
 */
export { HOUSEKEEPING_CONFIRM, HOUSEKEEPING_ROTA_MANAGE, HOUSEKEEPING_SETUP_MANAGE, HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW };

export const housekeepingManifest: ModuleManifest = {
  key: "housekeeping",
  title: "Housekeeping",
  menu: [
    { label: "Housekeeping", path: "/housekeeping", permission: HOUSEKEEPING_VIEW },
    { label: "Housekeeping rota", path: "/housekeeping/rota", permission: HOUSEKEEPING_ROTA_MANAGE },
    { label: "Housekeeping setup", path: "/housekeeping/setup", permission: HOUSEKEEPING_SETUP_MANAGE },
    // HK-2 (#974) — the department's reports and this shift's random inspections.
    { label: "Housekeeping reports", path: "/housekeeping/reports", permission: HOUSEKEEPING_VIEW },
  ],
  permissions: [HOUSEKEEPING_VIEW, HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_SETUP_MANAGE, HOUSEKEEPING_ROTA_MANAGE, HOUSEKEEPING_CONFIRM],
  subscriptions: [
    { event: resourceReleased.name, consumer: HOUSEKEEPING_BED_CONSUMER },
    { event: resourceStatusChanged.name, consumer: HOUSEKEEPING_BED_CONSUMER },
    { event: resourceAssigned.name, consumer: HOUSEKEEPING_BED_CONSUMER },
  ],
};
