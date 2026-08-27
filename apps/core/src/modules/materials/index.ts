/**
 * PLAN 14 — the materials module's public surface.
 *
 * OTHER MODULES IMPORT FROM HERE AND FROM NOWHERE ELSE (DD1, spec §4, and the `formulary/index.ts`
 * precedent): pharmacy (16c), the mini-OT (15) and the lab (17) call `stores.issue()`,
 * `postMovement` and `consumptionsFor` through this file. **None of them imports
 * `kernel/db/schema/materials` and none of them queries these tables itself.** § 4A item 2 rules
 * that there is ONE ledger and that every other module is a caller of it; this file is where that
 * ruling is mechanically true.
 *
 * T3–T8 each append their own exports here. The list grows downward, task by task, so a reader can
 * see what each task added.
 */
export { materialsManifest } from "./manifest";
export { MaterialsError, materialsHttpStatus } from "./errors";
export type { MaterialsErrorCode } from "./errors";
export { MATERIALS_EVENTS, consignmentDeployed, materialConsumed } from "./events";
export { MATERIALS_RESOURCE_KINDS } from "./kinds";
export {
  MATERIALS_APPROVAL_TYPES, NEAR_EXPIRY_APPROVAL_TYPE, VENDOR_BANK_CHANGE_APPROVAL_TYPE,
  registerMaterialsApprovalTypes,
} from "./approval-types";
export {
  BANK_CHANGE_COOLING_OFF_DAYS, BATCH_MANDATORY_CLASSES, BLACKLIST_REASONS, BLACKLIST_YEARS,
  DEEMED_SUPPLY_DAYS, EXPIRY_THRESHOLD_DAYS, MRP_MANDATORY_CLASSES, NEAR_EXPIRY_MIN_FRACTION,
  NEAR_EXPIRY_MIN_MONTHS, TRANSIT_STORE_CODE,
} from "./config";
export type { BlacklistReason } from "./config";
