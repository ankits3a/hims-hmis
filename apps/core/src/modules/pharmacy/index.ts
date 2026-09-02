/**
 * PLAN 16c — the pharmacy module's public surface.
 *
 * OTHER MODULES IMPORT FROM HERE AND FROM NOWHERE ELSE (spec §4, the `materials/index.ts`
 * precedent). And the traffic is mostly the OTHER way: this module is a CONSUMER of
 * `materials/index.ts` (the ledger), `opd/index.ts` (the prescription), `billing/index.ts` (the
 * invoice), `tariff/index.ts` (the service), `formulary/index.ts` (the medicine) and
 * `patients/index.ts` (the person) — it imports no schema file of theirs and queries none of their
 * tables. T2–T5 each append their own exports below.
 */
export { pharmacyManifest } from "./manifest";
export { PharmacyModule } from "./pharmacy.module";
export { PharmacyError, PHARMACY_ERROR_CODES, pharmacyHttpStatus } from "./errors";
export type { PharmacyErrorCode } from "./errors";
export {
  PHARMACY_EVENTS, dispenseBilled, dispenseCancelled, dispenseClaimed, dispenseHandedOver, dispenseLineDeclined,
  dispensePicked, dispenseQueued, dispenseVerified, substitutionRecorded,
} from "./events";
export {
  OPD_PHARMACY_STORE_CODE, PHARMACY_SUBSTITUTION_ENABLED, PICK_RESERVATION_MINUTES, REFUSED_FLAGS, REGISTER_FLAGS,
  SCHEDULED_FLAGS,
} from "./config";
export {
  PHARMACY_DISPENSE_DEFINITION_JSON, PHARMACY_DISPENSE_DEF_KEY, PHARMACY_DISPENSE_STATES,
} from "./workflow-def";
export type { PharmacyDispenseState } from "./workflow-def";
export { PHARMACY_DEFINITIONS, PHARMACY_DEF_KEYS, activatePharmacyDefinitions } from "./definitions";
export type { ActivatePharmacyDefinitionsReport } from "./definitions";
