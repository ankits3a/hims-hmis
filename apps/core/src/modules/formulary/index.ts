/**
 * PLAN 16a — the formulary module's public surface.
 *
 * OTHER MODULES IMPORT FROM HERE AND FROM NOWHERE ELSE (DD1, and the `listAllergies` precedent):
 * `modules/opd` consumes the resolution read helpers T3 adds below; it never imports
 * `kernel/db/schema/formulary` and never queries these tables itself.
 */
export { formularyManifest } from "./manifest";
export { FormularyError, formularyHttpStatus } from "./errors";
export type { FormularyErrorCode } from "./errors";
export { FORMULARY_EVENTS } from "./events";
export {
  addInteraction, addMedicine, addSalt, listInteractions, listMedicines, listSalts,
  updateInteraction, updateMedicine, updateSalt,
} from "./masters";
export type { InteractionRow, MedicineWithSalts, MedicineRow, RouteClass, SaltRow, Severity } from "./masters";
/**
 * T3 — THE BOUNDARY `modules/opd` ACTUALLY CONSUMES. Everything above is the curation surface;
 * these four are what the prescription pipeline calls at issue time. DD2 lives in
 * `resolveDrugTexts`: exact resolution only, `null` for anything else.
 */
export { listInteractionsAmong, normalizeDrugName, resolveDrugTexts, resolveMedicines } from "./resolve";
export type { InteractionPair, ResolvedDrug, SaltRef } from "./resolve";
/** T7 — staging admission. `searchStaging` may match generously; nothing here resolves anything. */
export { admitStaging, getStagingRow, rejectStaging, searchStaging } from "./staging";
export type { StagingRow } from "./staging";
