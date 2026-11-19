/**
 * STORES S1 (#1111, decision 0099) — the non-drug Stores module's public surface. A leaf over `materials`:
 * other modules reach Stores only through this file (lint-enforced), and Stores reaches materials only
 * through `materials/index.ts`.
 */
export { storesManifest } from "./manifest";
export { StoresError, STORES_ERROR_CODES, storesHttpStatus } from "./errors";
export type { StoresErrorCode } from "./errors";
export { STORES_ACTS, STORES_ACT_EVENT, STORES_EVENTS, storesActRecorded } from "./events";
export type { StoresAct } from "./events";
export { STORES_AUDIT_READ, STORES_GATEPASS_RAISE, STORES_GATEPASS_SCAN, STORES_INDENTS_APPROVE, STORES_MASTERS, STORES_NIGHTSTORE_ISSUE, STORES_SHELF_READ, STORES_SHELF_WORK } from "./access";
export {
  CENTRAL_STORE_CODE, NIGHT_STORE_CODE, STORES_TOP_CATEGORIES, createCategory, importStoresItems, listCategories, listNewItemRequests,
  listStoresItems, registerStoresItem, requestNewItem, resolveNewItemRequest, searchStoresItems, seedStoresMasters, updateStoresItem,
} from "./items";
export { createShelf, createStoresStore, listShelves, listStoresStores, openShelf, openStore, setShelfPar } from "./shelves";
export {
  EXPENSED_REF, REVERSAL_REF, SHELF_CHECK_REF, SHELF_USE_REF, receiveAtShelf, recordShelfCheck, recordShelfUse, reverseShelfUse,
  saveReorderDraft, shelfReorderDraft,
} from "./use";
export { departmentChargeOn, floorShelfUseByMonth, myShelves, overBookCards, shelfView, storesPickers } from "./reads";
export { STORES_ITEM_CLASSES, TICKET_CHANNELS, TICKET_PRIORITIES, TRACK_MODES } from "./types";
export type * from "./types";
export { StoresModule } from "./stores.module";
export {
  CLAIM_IDLE_MS, EMERGENCY_REVIEW_MS, approveTicket, claimPicking, declineTicket, getTicket, issueTicket, overdueEmergencyReviews, raiseTicket,
  reRaiseTicket, reviewEmergency, ticketsToApprove, ticketsToPick, ticketsToReceive, withinServiceHours,
} from "./tickets";
export { ticketTimeline } from "./timeline";
export { storesAuditPack } from "./audit-pack";
export { STORES_DESK_PROVIDERS, storesApproveDesk, storesPickDesk, storesReceiveDesk, storesStuckDesk, storesTakeBackDesk } from "./desk";
export {
  LATE_SCAN_MS, STORES_CARRY, acceptReturn, confirmLateScan, deliverTicket, handOver, lateScansToConfirm, myCustody, postTransitLoss, raiseReturn,
  receiveReturn, resolveShort, returnUndelivered, returnsToReceive, scanClock, takeCustody, takeOverCustody, custodyLookup, ticketsComingBack,
} from "./custody";
export { ISSUE_VOUCHER_DOCUMENT, addToOpenTicket, openTicketFor, reAskShort, shelfTickets, whoToAsk } from "./tickets";
export { registerStoresPrinting, renderIssueVoucher } from "./voucher";
// S2c (#1119) — gate passes: raise, the guard's lookup and scan, close, the overdue list and its notice, the print.
export {
  GATE_PASS_DOCUMENT, closeGatePass, gatePassForm, gatePassLookup, gatePassSources, getGatePass, listGatePasses, notifyOverdueGatePasses,
  overdueGatePasses, raiseGatePass, scanGatePass,
} from "./gate-pass";
export { renderGatePass } from "./gate-pass-print";
// S3 (#1113): the control tower, the owner's one line, the Stuck Now card, the chaser, the concierge.
export { CLOCKS, RED_CARD_LIMIT, STORES_SPEND_READ, STORES_TOWER_READ, boardCards, departmentSpendByMonth, towerSummary, towerView } from "./tower";
export { APPROVAL_NUDGE_MIN, CHASER_WORDS, runStoresChaser } from "./chaser";
export { storesCopilotIntents } from "./copilot-intents";
export { indentNoOf, storesCopilotReadTools } from "./copilot-tools";
export { reorderTool } from "./copilot-acts";
// S4a (#1114): the asset passport — tag rule and decisions, units and events, passport, transfer, found here, repairs,
// device link, reminders, verification, the opening sweep, the additions export.
export { TAG_THRESHOLD_PAISE, categoryRules, tagDecisionFor, taggedBatchIds } from "./asset-rules";
export {
  ASSET_LABEL_DOCUMENT, ASSET_WORDS, STORES_ASSETS_EXPORT, STORES_ASSETS_MANAGE, STORES_ASSETS_READ, acceptUnitTransfer, addAssetDetails, assetPassport,
  assetRegister, closeRepair, fillUnitCost, grnLineTagging, linkDevice, myAssets, openRepair, openUnit, proposeUnitTransfer, reportFault, reportFoundHere,
  addRegulatorPaper, retag, returnToUse, setItemRegulation, tagUnits, unitsToAccept, voidTag, withdrawUnit,
} from "./assets";
export { assetAdditions, assetLedgerCheck, assetsCostUnknown, assetsDue, equipmentReceivedByMonth, runAssetReminders } from "./asset-reads";
export { closeVerification, roundView, scanVerification, startVerification, verificationRounds } from "./verification";
export { renderAssetLabel } from "./asset-label";
// S4b (#1114): condemnation, loss, disposal.
export {
  CONDEMN_OWNER_LINE_PAISE, STORES_ASSETS_CONDEMN, assetRemovals, condemnationsToSign, disposeUnit, getCondemnation, listCondemnations, markFound,
  objectCondemnation, proposeCondemnation, runLossProposals, settleCondemnations, signCondemnation, writeOffLoss,
} from "./condemnation";
// S5a (#1115): the front of the buying desk — purchase requests, bands and the split check, budgets, delegation and
// bulk approval, non-drug GRN QC, supplier KYC levels.
export {
  PR_WORDS, approvePurchaseRequest, bulkApprovePurchaseRequests, cancelPurchaseRequest, declinePurchaseRequest, getPurchaseRequest,
  myPurchaseRequests, purchaseRequestsToApprove, raisePurchaseRequest, setPurchaseRequestBand,
} from "./purchase-requests";
export type { PurchaseRequestLineInput, RaisePurchaseRequestInput } from "./purchase-requests";
export { BAND_A_MAX_PAISE, BAND_B_MAX_PAISE, bandFor } from "./bands";
export { BUDGET_WORDS, budgetView, departmentBudget, setDepartmentBudget, sweepBudgetWarnings } from "./budgets";
export { DELEGATION_MAX_DAYS, delegateApprovals, myDelegations } from "./delegations";
export { postStoresGrn, signStoresQc, storesGrnsForQc } from "./grn-qc";
export { approveSupplierCategory, setSupplierFields, storesSuppliers, supplierKyc } from "./suppliers";
export { STORES_BUDGET_MANAGE, STORES_BUYING_MANAGE, STORES_GRN_QC, STORES_PURCHASE_REQUEST } from "./access";
// S5b (#1115): the buying desk by hand — Buy now, the buyer's groups, RFQs, quotes, the comparative, awards and the
// committee, PO from award (one sheet, two stamps), bulk, the delivery ticket from a request.
export { STORES_AWARD_SIGN } from "./access";
export { buyGroups, buyNow, getBuyGroup, groupRequests, groupableRequests, moveGroupLine } from "./buy-groups";
export { RFQ_DOCUMENT, closeRfq, createRfq, getRfq, inviteSuppliers, listRfqs, moveReplyBy, sendRfq } from "./rfq";
export { admitLateQuote, enterQuote, getQuote, markTechnical, openQuote } from "./quotes";
export { comparativeStatement } from "./comparative";
export {
  AWARD_WORDS, PAY_AFTER_GRN, approveAward, approveAwardAndPo, approvePoFromSheet, bulkApprove, committeeSeats, getAward, listAwards, makePoFromAward,
  makePoFromGroup, objectAward, poSheet, proposeAward, sendStoresPo, setCommitteeSeat, signAward, submitStoresPo,
} from "./awards";
export { purchaseDeliveries } from "./purchase-delivery";
export { renderRfq } from "./rfq-print";
export { buyingDesk } from "./buying-desk";
// S5c (#1115): the buyer agent (night grouping, central shortfall, RFQ and PO drafts, quotes read from PDFs), the supplier
// scorecard, single-source and emergency purchases, equipment advances, the owner's over-budget list, the two Now cards.
export {
  AGENT_TOOLS, BUYER_AGENT, PROPOSAL_CAP_PER_DEPARTMENT, agentProposals, confirmGroupingProposal, confirmPoDraft, confirmRfqDraft, dismissProposal, draftPo,
  draftRfq, getProposal, raiseCentralShortfall, runBuyerNight,
} from "./buyer-agent";
export type { BuyerNightRun } from "./buyer-agent";
export { QUOTE_READ_INTENT, confirmQuoteLine, readQuotePdf, readByRules } from "./quote-reader";
export type { QuoteReadDeps } from "./quote-reader";
export { pdfPages } from "./pdf-text";
export { quarterBounds, quarterOf, supplierScorecard } from "./scorecard";
export { EMERGENCY_CONFIRM_MS, EXCEPTION_WORDS, advanceBuyException, getBuyException, listBuyExceptions, refuseBuyException, requestBuyException } from "./buy-exceptions";
export { ADVANCE_MAX_BPS, ADVANCE_WORDS, advancesToDecide, decidePoAdvance, payTermsOf, requestPoAdvance } from "./advances";
export { OVER_BUDGET_WORDS, overBudgetList, sendOwnerOverBudgetList } from "./budgets";
export { storesAwardSignDesk, storesPurchaseApproveDesk } from "./desk";
