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

// ── T3 — the item master, UoM conversion, barcodes and price regulations ──
export {
  addBarcode, addItemUom, effectiveRegulation, getItem, itemUomRows, itemsByIds, listItems,
  registerItem, resolveBarcode, setPriceRegulation, updateItem, uomsByItems,
} from "./items";
export type { ItemBarcodeRow, ItemRow, ItemUomRow, ItemWithUoms, PriceRegulationRow, RegisterItemInput } from "./items";
/** DD7's one place a multiplier is applied. Pure; T6's gate and 16c's dispense both read it. */
export { fromBase, mrpPerBaseUnit, multiplierFor, toBase } from "./uom";
export type { UomRow } from "./uom";

// ── T4 — the vendor master: documents, lifecycle, blacklist, the bank change ──
export {
  activateVendor, addVendorDocument, applyBankChange, assertVendorPurchasable, blacklistVendor,
  getBankChange, getVendor, hasValidDocument, listBankChanges, listVendorDocuments, listVendors,
  registerVendor, reinstateVendor, requestBankChange, suspendVendor, updateVendor,
} from "./vendors";
export type {
  BankDetails, MaskedBank, VendorBankChangeRow, VendorDocumentRow, VendorRow, VendorView,
} from "./vendors";

// ── T5 — stores, and the stock ledger: movements, balances under lock, FEFO, reservations, recall ──
export { createStore, ensureTransitStore, findStoreByCode, listStores, requireStore, setStoreCustodianRoles, storeCustodianRoles } from "./stores";
export type { StoreRow } from "./stores";
export {
  availableQty, availableQtyByItem, balances, batchLocations, consumeReservation, consumedQtyByItem, fefoPick, getBatch, movementsFor, postMovement, returnedQtyByRef,
  consumptionRowsAt, ledgerQtyByIds, refIdsWithMovementBetween, batchesByNo,
  postMovements, recallBatch, releaseReservation, reserveStock, expiredStockAt, sellableBatchesByItem,
} from "./ledger";
export type { BalanceRow, BatchRow, LedgerRow, MovementInput, MovementReason, ReservationRow } from "./ledger";

// ── T6 — the GRN gate: capture, deterministic QC, near-expiry approval, post ──
export { daysBetween, nearExpiryMinDays, qcLine } from "./qc";
export type { QcContext, QcLine, QcVerdict, RuleCode } from "./qc";
export {
  captureGrn, getGrn, listGrns, lotsForBatch, postGrn, requestNearExpiryAcceptance, runGateQc,
} from "./grn";
export type { CaptureLine, GrnLineRow, GrnRow, GrnWithLines } from "./grn";

// ── T7 — two-sided issue, discrepancies, and the consignment.deployed consumer ──
export {
  getTransfer, issueStock, listDiscrepancies, listTransfers, receiveStock, transferWorklist,
} from "./transfers";
export type { IssueLine, TransferLineRow, TransferRow, TransferView, TransferWithLines } from "./transfers";
/**
 * DD13's half of the interface Plan 15 imports: it appends `consignmentDeployed` (exported above,
 * from T2) and reads `consumptionsFor` to compose the discharge bill.
 */
export {
  MATERIALS_CONSUMPTION_CONSUMER, consumptionConsumer, consumptionsFor, handleConsignmentDeployed,
} from "./consumption";
export type { ConsumptionRow } from "./consumption";

// ── T8 — the routes, and the batch-expiry sweep ──
export { MaterialsController } from "./materials.controller";
export { MaterialsModule } from "./materials.module";
export { expiringBatches, sweepBatchExpiry, thresholdToAnnounce } from "./expiry";
/** Plan 14c, first slice — blind counts and the variance register. No adjustment (runbook O1). */
/** Plan 14c, second slice — booking a count's variance with a second key. */
export { ADJUSTMENT_REASONS, listAdjustments, postAdjustments, requestCountAdjustment } from "./adjustments";
export type { AdjustmentReason, AdjustmentView } from "./adjustments";
export { STOCK_ADJUSTMENT_APPROVAL_TYPE } from "./approval-types";
export { cancelCount, closeCount, countSheet, countVariancesBetween, getCount, listCounts, myCounts, scheduleCount, submitCount } from "./counts";
export type { CountFlag, CountHeader, CountReview, CountReviewLine, CountSheet, CountSheetLine, CountStatus, SubmitCountInput } from "./counts";
export type { ExpiringBatch } from "./expiry";
