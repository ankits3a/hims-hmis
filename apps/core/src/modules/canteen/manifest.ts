import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * CN-1 CANTEEN (#977, decision 0088) — four permissions (`names.ts` says who holds them), no subscriptions. The stale
 * bed-order sweep rides the worker's tick (`kernel/worker/jobs.ts`). Off until `HMIS_MODULES_ON` names it.
 */
export const canteenManifest: ModuleManifest = {
  key: "canteen",
  title: "Canteen",
  menu: [
    { label: "Canteen till", path: "/canteen/till", permission: CANTEEN_SELL },
    { label: "Canteen setup", path: "/canteen/setup", permission: CANTEEN_MANAGE },
    { label: "Canteen finance", path: "/canteen/finance", permission: CANTEEN_FINANCE },
  ],
  permissions: [CANTEEN_SELL, CANTEEN_MANAGE, CANTEEN_FINANCE, CANTEEN_VIEW],
  subscriptions: [],
};
