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
  dispensePicked, dispenseQueued, dispenseVerified, pharmacistRegistered, pharmacistRegistrationEnded,
  substitutionRecorded,
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

// ── T2 — the sale-items bridge, and the price rule at batch grain ──
export { PHARMACY_GST_CATEGORIES, gstCategoryFor, priceForBatch } from "./price";
export type { BatchPrice, BatchPriceInput, BatchPriceWinner } from "./price";
export {
  SALE_SERVICE_PREFIX, getSaleItem, listSaleItems, registerSaleItem, requireActiveSaleItem, saleItemCandidates,
  setSaleItemActive,
} from "./sale-items";
export type { SaleItemRow, SaleItemView } from "./sale-items";
export { PHARMACY_IDEMPOTENT_ROUTES, toHttp as pharmacyToHttp } from "./pharmacy-http";

// ── T3 — the counter: queue, the three doors, claim, verify, decline, cancel; the Rx-issued consumer ──
export { PHARMACY_RX_ISSUED_CONSUMER, handlePrescriptionIssued, rxIssuedConsumer } from "./consumers";
export { enqueueDispense, getDispense, getDispenseRow, linesOf, listQueue, liveDispenseFor } from "./queue";
export type { DispenseLineRow, DispenseLineView, DispenseRow, DispenseView, QueueRow } from "./queue";
export { claimDispense, findAtCounter } from "./claim";
export type { CounterDoor, FindResult } from "./claim";
export { alternativesFor, cancelDispense, declineLine, verifyDispense } from "./verify";
export type { Alternative, VerifyInput, VerifyLineInput } from "./verify";
export { doseUnits, dosesPerDay, prefillQtyBase } from "./qty";
export { istDateOf } from "./config";

// ── T4 — pick, bill, hand over, the label ──
export { pickDispense } from "./pick";
export type { PickInput, PickLineInput } from "./pick";
export { billDispense, previewDispenseBill } from "./bill";
export type { BillInput } from "./bill";
export { handOverDispense } from "./handover";
export type { HandoverInput } from "./handover";
export { labelFor } from "./label";
export type { LabelData, LabelLine } from "./label";

// ── CLOSE REVIEW / F11 — the pick reservation expires (the worker's sixteenth job) ──
export { PHARMACY_PICK_SWEEP_ACTOR, PICK_EXPIRED_REASON, sweepExpiredPicks } from "./expiry";
/**
 * P2 — the register of pharmacists (Pharmacy Act 1948 §42). `currentRegistration` is exported for
 * the go-live census, which asks whether anyone who may complete a scheduled dispense holds one.
 */
export {
  PHARMACIST_ROLE, currentRegistration, endPharmacistRegistration, listPharmacists, recordPharmacistRegistration,
  requireRegisteredPharmacist,
} from "./pharmacists";
export type { PharmacistRegistration, PharmacistView } from "./pharmacists";
/** P5 — a paid dispense that cannot be collected: cancelled, credited, a refund requested. */
export { cancelBilledDispense } from "./refund";
export type { CancelBilledInput, CancelBilledResult } from "./refund";
/** P4 — the reorder list (doc 16 §9 Replenishment, drafting tier). Read-only. */
export { reorderAdvice } from "./replenishment";
export type { ReorderAdvice, ReorderLine, ReorderStatus } from "./replenishment";
/** P6 — sales returns at the counter (doc 16 O-7). */
export { acceptReturn } from "./returns";
export type { ReturnInput, ReturnResult } from "./returns";
/** P7 — the counter's day (doc 16 §8 KPIs, 16f's first strip). Read-only. */
export { counterSummary } from "./summary";
/** P15 — the renewal notice and the arithmetic the census shares with the register screen. */
export { REGISTRATION_RENEWAL_NOTICE_DAYS } from "./config";
export { renewalDaysLeft } from "./pharmacists";
/** P12 — the leakage triangle (doc 16 I1). Read-only. */
export { pharmacyLeakage } from "./leakage";
export type { LeakageMismatch, LeakageReport } from "./leakage";
/** P16 — each drug's GST slab from the notification, and the sale category that follows it. */
export {
  GST_NOTIFICATION, NIL_RATED_DRUGS, applyGstSlabPlan, gstSlabPlan, setItemGstSlab, suggestGstSlab, syncSaleItemCategory,
} from "./gst-slab";
export type { GstSlabPlanRow, GstSuggestion } from "./gst-slab";
/** P9 — the Schedule H1 register, read (Drugs and Cosmetics Rules 1945 r.65(3A)). */
export { H1_REGISTER_MAX_DAYS, h1Register } from "./registers";
export type { H1Register, H1RegisterRow } from "./registers";
export type { CounterSummary } from "./summary";
/** P19 — walk-in retail sales (doc 16 §3.1b, register row R-174). */
export { DOWNTIME_BACKFILL_DAYS, RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE } from "./config";
export { retailLicenceRecorded, retailLineReturned, retailSold } from "./events";
export {
  counterBatches, enterPaperDispense, getRetailSale, inspectSheet, pharmacyStaff, listPaperDispenses, listRetailLicences, listRetailSales,
  previewPaperDispense, previewRetailSale, recordRetailLicence, retailLicenceState, retailStore, searchCounterShelf,
  searchRetailShelf, sellRetail,
} from "./retail";
export type {
  CounterBatch, PaperDispenseInput, PharmacyStaffMember, SheetCheck, RecordLicenceInput, RetailCustomerInput, RetailLicenceState, RetailLicenceView, RetailLineInput, RetailPrescriptionInput,
  RetailPreview, RetailSaleInput, RetailSaleRow, RetailSaleView, RetailShelfEntry,
} from "./retail";
/** P19b — a sealed pack back at the walk-in counter, found by its bill. */
export { acceptRetailReturn, findRetailSaleByInvoiceNo } from "./retail-returns";
export type { RetailReturnInput, RetailReturnResult } from "./retail-returns";
export { setShelfLocation, shelfLocationsFor } from "./shelf-locations";
/** Consult v2 — the doctor's read of the shelf: sellable count per medicine, and alternatives at zero. */
export { stockForDoctor } from "./doctor-stock";
export type { DoctorStock, DoctorStockAlternative } from "./doctor-stock";

// ── PARITY P5 — the Tally export: whether the accountant has confirmed the ledger names (the census reads it) ──
export { tallyLedgersConfirmed } from "./tally";

// ── PHARMACY P6 — narcotic, psychotropic and Schedule X drugs under the law (brief 2026-09-26) ──
export { CONTROLLED_STORE_CODE, LICENCE_RENEWAL_NOTICE_DAYS } from "./config";
export {
  CONTROLLED_LICENCE_KINDS, CUSTODY_PERMISSION, LICENCES_PERMISSION, WITNESS_PERMISSION, anyEndPrescriber, controlOf, controlledLicenceStates,
  controlledStore, isEndPrescriber, recordControlledLicence, recordEndPrescriber,
} from "./controlled";
export type { ControlledLicenceKind, ControlledLicenceState, ControlledLicenceView, LineControl } from "./controlled";
export { controlledToday, custodianPairHeld } from "./controlled-office";
export type { ControlledToday } from "./controlled-office";
export { PharmacyControlledController } from "./pharmacy-controlled.controller";
export { classifyControlledDrugs } from "./controlled-classify";
export type { ControlledClassification } from "./controlled-classify";

// ── PHARMACY P6 (patient messages) — the bill and the opt-in refill reminder, through the notify kernel ──
export { PHARMACY_BILL_TEMPLATE, PHARMACY_MESSAGE_TEMPLATES, PHARMACY_REFILL_TEMPLATE, REFILL_MIN_SUPPLY_DAYS, REFILL_REMINDER_LEAD_DAYS, REFILL_REMINDER_NAMES_DRUGS } from "./config";
export {
  PHARMACY_MESSAGES_CONSUMER, enqueueBillMessage, handlePharmacyMessageEvent, messagesOffice, namableDrugs, patientMessagesFor,
  pharmacyDltTemplateIdsRecorded, pharmacyMessagesConsumer, pharmacyMessagingProviderLive, recordContactPhone, refillDue,
  runRefillReminders, supplyDays,
} from "./messages";
export type { BillMessageState, MessagesOffice, PatientMessagesView, RefillLine, RefillRunResult } from "./messages";
