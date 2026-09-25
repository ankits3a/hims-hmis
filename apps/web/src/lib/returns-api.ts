import { api } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * PHARMACY PARITY P4 — the returning wire: the expiry report (`/materials/expiry-report`), returns
 * to the supplier and the vendor's credit note (`/materials/supplier-returns/*`), destruction
 * write-offs (`/materials/write-offs/*`), recalls (`/materials/recalls/*`), and the office's own
 * reads and acts (`/pharmacy/office/returns*`, `/pharmacy/office/recalls/*`). Transcribed from
 * `supplier-returns.ts`, `write-offs.ts`, `recalls.ts` and `office.ts`; money is integer paise,
 * quantities are base units.
 */
export type SupplierKind = "supplier" | "opening" | "trial" | "none";
export type ExpiryPreset = "expired" | "30" | "60" | "90" | "custom";
export const EXPIRY_PRESETS: readonly ExpiryPreset[] = ["expired", "30", "60", "90", "custom"];
export type ReturnStatus = "draft" | "approved" | "dispatched" | "credited" | "closed" | "cancelled";
export type ReturnLineReason = "expired" | "near_expiry" | "damaged" | "recalled";
export type WriteOffReason = "expiry" | "damage" | "recall";
export type RecallSource = "cdsco" | "manufacturer" | "internal";
export const RECALL_SOURCES: readonly RecallSource[] = ["cdsco", "manufacturer", "internal"];

export type Pack = { uom: string; multiplier: number } | null;

export type WireExpiryRow = {
  storeResourceId: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; baseUom: string;
  batchId: string; batchNo: string; expiryDate: string; daysToExpiry: number;
  qtyBase: number; pack: Pack; packs: number; loose: number;
  mrpPaise: number | null; mrpUom: string | null; landedCostPaise: number; costValuePaise: number;
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind; ownership: string;
  recalled: boolean; reserved: number; frozen: number;
  returnableUntil: string | null; returnable: boolean;
  returnRaised: { returnId: string; returnNo: string; status: ReturnStatus } | null;
  writeOffRaised: { writeOffId: string; writeOffNo: string; status: string } | null;
};
export type WireExpirySupplier = {
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind; rows: number; qtyBase: number; costValuePaise: number; returnableValuePaise: number;
};
export type WireExpiryReport = {
  asOf: string; preset: ExpiryPreset; from: string | null; to: string | null;
  rows: WireExpiryRow[]; suppliers: WireExpirySupplier[]; costValuePaise: number; truncated: boolean;
};

export type WireReturnPlanLine = {
  itemId: string; itemCode: string; itemName: string; hsnCode: string | null;
  batchId: string; batchNo: string; expiryDate: string | null; storeResourceId: string; storeCode: string; storeName: string;
  reason: ReturnLineReason; qtyBase: number; baseUom: string; pack: Pack; ratePaise: number; gstRateBps: number; taxablePaise: number; returnableUntil: string | null;
};
export type WireReturnPlanGroup = { vendorId: string; vendorCode: string; vendorName: string; gstin: string | null; lines: WireReturnPlanLine[]; taxablePaise: number };
export type WireDestroyCandidate = {
  itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string; expiryDate: string | null;
  storeResourceId: string; storeCode: string; storeName: string; qtyBase: number; baseUom: string; valuePaise: number;
  supplierName: string; why: "past_window" | "no_supplier";
};
export type WireReturnPlan = { asOf: string; groups: WireReturnPlanGroup[]; toDestroy: WireDestroyCandidate[]; alreadyHeld: number; taxablePaise: number };

export type WireReturnSummary = {
  id: string; returnNo: string; status: ReturnStatus; source: "manual" | "agent" | "recall"; vendorId: string; vendorCode: string; vendorName: string;
  recallId: string | null; lineCount: number; interState: boolean;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; creditedPaise: number;
  debitNoteNo: string | null; debitNoteDate: string | null;
  createdBy: string; createdAt: string; approvedBy: string | null; approvedAt: string | null; dispatchedBy: string | null; dispatchedAt: string | null;
};
export type WireReturnLine = {
  id: string; itemId: string; itemCode: string; itemName: string; hsnCode: string | null; baseUom: string; pack: Pack;
  batchId: string; batchNo: string; expiryDate: string | null; storeResourceId: string; storeCode: string; storeName: string;
  reason: ReturnLineReason; qtyBase: number; ratePaise: number; taxablePaise: number; gstRateBps: number;
  cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; ledgerEntryId: string | null;
};
export type WireReturn = WireReturnSummary & {
  note: string | null; vendorGstin: string | null; closeReason: string | null; cancelReason: string | null; recallNo: string | null;
  names: Record<string, string>; lines: WireReturnLine[];
  credit: {
    id: string; creditNo: string; vendorCreditNoteNo: string; creditNoteDate: string; amountPaise: number; differencePaise: number;
    differenceReason: string | null; recordedBy: string; recordedAt: string;
  } | null;
};

export type WireWriteOffSummary = {
  id: string; writeOffNo: string; status: "requested" | "posted" | "refused"; reason: WriteOffReason; storeResourceId: string; storeCode: string; storeName: string;
  totalValuePaise: number; lineCount: number; approvalId: string; approvalStatus: string;
  disposalAgency: string | null; manifestNo: string | null; disposalDate: string | null;
  requestedBy: string; requestedAt: string; postedBy: string | null; postedAt: string | null;
};
export type WireWriteOff = WireWriteOffSummary & {
  note: string | null; names: Record<string, string>;
  lines: { id: string; itemId: string; itemCode: string; itemName: string; hsnCode: string | null; baseUom: string; batchId: string; batchNo: string; expiryDate: string | null; supplierName: string | null; qtyBase: number; valuePaise: number; ledgerEntryId: string | null }[];
  approval: { status: string; approverRole: string; decidedBy: string | null; decisionNote: string | null } | null;
};

export type WireRecallSummary = {
  id: string; recallNo: string; status: "open" | "closed"; source: RecallSource; reference: string | null; reason: string;
  batchId: string; batchNo: string; expiryDate: string | null; itemId: string; itemCode: string; itemName: string;
  vendorId: string | null; supplierName: string | null; supplierKind: SupplierKind; onHand: number;
  raisedBy: string; raisedAt: string; closedAt: string | null;
};
export type WireRecall = WireRecallSummary & {
  closeNote: string | null; closedBy: string | null; names: Record<string, string>;
  locations: { storeResourceId: string; storeCode: string; storeName: string; onHand: number; reserved: number; frozen: number }[];
  dispensed: { ledgerEntryId: string; storeResourceId: string; patientId: string | null; encounterId: string | null; qtyBase: number; occurredAt: string; refType: string | null; refId: string | null }[];
  returns: { returnId: string; returnNo: string; status: string; qtyBase: number }[];
  writeOffs: { writeOffId: string; writeOffNo: string; status: string; qtyBase: number }[];
  /** Only on the office's read (`/pharmacy/office/recalls/:id`): the callback list's people. */
  patients?: Record<string, { uhid: string; name: string | null; phone: string | null; restricted: boolean }>;
};
export type WireRecallBatch = { batchId: string; batchNo: string; expiryDate: string | null; onHand: number; recalled: boolean; supplierName: string | null };

export type WireOfficeReturns = {
  expiring: {
    expired: number; d30: number; d60: number; d90: number;
    expiredValuePaise: number; d30ValuePaise: number; d60ValuePaise: number; d90ValuePaise: number;
  };
  plan: { vendors: number; lines: number; taxablePaise: number; toDestroy: number; toDestroyValuePaise: number };
  drafts: WireReturnSummary[]; toDispatch: WireReturnSummary[]; awaitingCredit: WireReturnSummary[];
  writeOffsAwaiting: WireWriteOffSummary[]; writeOffsToPost: WireWriteOffSummary[]; openRecalls: WireRecallSummary[];
  creditPaise: number;
};

// ── the office ──
export const fetchOfficeReturns = (): Promise<WireOfficeReturns> => api("GET", "/pharmacy/office/returns");
export const fetchReturnPlan = (): Promise<WireReturnPlan> => api("GET", "/materials/supplier-returns/plan");
export const draftReturns = async (vendorIds?: string[]): Promise<WireReturn[]> =>
  (await api<{ drafts: WireReturn[] }>("POST", "/pharmacy/office/returns/draft", vendorIds === undefined ? {} : { vendorIds })).drafts;
export const fetchDebitNote = (id: string): Promise<WireRenderedDocument> => api("GET", `/pharmacy/office/returns/${id}/debit-note`);
export const fetchManifest = (id: string): Promise<WireRenderedDocument> => api("GET", `/pharmacy/office/write-offs/${id}/manifest`);

// ── the expiry report ──
export function fetchExpiryReport(q: { preset: ExpiryPreset; from?: string; to?: string }): Promise<WireExpiryReport> {
  const p = new URLSearchParams({ preset: q.preset });
  if (q.preset === "custom") {
    if (q.from !== undefined && q.from !== "") p.set("from", q.from);
    if (q.to !== undefined && q.to !== "") p.set("to", q.to);
  }
  return api("GET", `/materials/expiry-report?${p.toString()}`);
}

// ── returns and the vendor's credit ──
export const fetchReturn = async (id: string): Promise<WireReturn> => (await api<{ return: WireReturn }>("GET", `/materials/supplier-returns/${id}`)).return;
export const approveReturn = async (id: string): Promise<WireReturn> => (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/approve`)).return;
export const dispatchReturn = async (id: string): Promise<WireReturn> => (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/dispatch`)).return;
export const cancelReturn = async (id: string, reason: string): Promise<WireReturn> =>
  (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/cancel`, { reason })).return;
export const closeReturn = async (id: string, reason: string): Promise<WireReturn> =>
  (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/close`, { reason })).return;
export const recordCredit = async (id: string, input: { vendorCreditNoteNo: string; creditNoteDate: string; amountPaise: number; differenceReason?: string | null }): Promise<WireReturn> =>
  (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/credit-note`, input)).return;
export const cancelCredit = async (id: string, reason: string): Promise<WireReturn> =>
  (await api<{ return: WireReturn }>("POST", `/materials/supplier-returns/${id}/credit-note/cancel`, { reason })).return;

// ── destruction ──
export const fetchWriteOff = async (id: string): Promise<WireWriteOff> => (await api<{ writeOff: WireWriteOff }>("GET", `/materials/write-offs/${id}`)).writeOff;
export const raiseWriteOff = async (input: {
  storeResourceId: string; reason: WriteOffReason; note?: string | null; lines: { batchId: string; qtyBase: number }[];
  disposal?: { disposalAgency?: string | null; manifestNo?: string | null; disposalDate?: string | null };
}): Promise<WireWriteOff> => (await api<{ writeOff: WireWriteOff }>("POST", "/materials/write-offs", input)).writeOff;
export const postWriteOff = async (id: string, disposal: { disposalAgency?: string | null; manifestNo?: string | null; disposalDate?: string | null }): Promise<WireWriteOff> =>
  (await api<{ writeOff: WireWriteOff }>("POST", `/materials/write-offs/${id}/post`, disposal)).writeOff;

// ── recalls ──
export const fetchRecall = (id: string): Promise<WireRecall> => api("GET", `/pharmacy/office/recalls/${id}`);
export const fetchRecallBatches = async (itemId: string): Promise<WireRecallBatch[]> =>
  (await api<{ batches: WireRecallBatch[] }>("GET", `/materials/recalls/batches?itemId=${encodeURIComponent(itemId)}`)).batches;
export const raiseRecall = async (input: { batchId: string; source: RecallSource; reference?: string | null; reason: string }): Promise<{ recall: WireRecall }> =>
  api("POST", "/materials/recalls", input);
export const closeRecall = async (id: string, note: string): Promise<WireRecall> => (await api<{ recall: WireRecall }>("POST", `/materials/recalls/${id}/close`, { note })).recall;
export const returnFromRecall = async (id: string): Promise<WireReturn> => (await api<{ return: WireReturn }>("POST", `/pharmacy/office/recalls/${id}/return`)).return;

/** "3 strip + 4 tablet" — packs and loose base units, as a person counts a shelf. */
export function qtyText(qty: number, baseUom: string, pack: Pack): string {
  if (pack === null || qty < pack.multiplier) return `${String(qty)} ${baseUom}`;
  const packs = Math.floor(qty / pack.multiplier);
  const loose = qty % pack.multiplier;
  return `${String(packs)} ${pack.uom}${loose === 0 ? "" : ` + ${String(loose)} ${baseUom}`}`;
}
