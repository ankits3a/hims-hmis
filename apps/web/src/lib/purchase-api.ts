import { api } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * PHARMACY PARITY P2 — the buying wire: the office's own routes (`/pharmacy/office/*`) and the
 * purchase order's (`/materials/purchase-orders/*`, `/materials/stock-levels`). Transcribed from
 * `pharmacy-office.controller.ts` and `materials.controller.ts`; money is integer paise and
 * quantities integer base units, as everywhere on the materials wire.
 */
export type PoStatus = "draft" | "pending_approval" | "approved" | "sent" | "part_received" | "received" | "cancelled";

export type WirePoSummary = {
  id: string; poNo: string; status: PoStatus; source: "manual" | "agent";
  vendorId: string; vendorCode: string; vendorName: string; storeResourceId: string; storeCode: string;
  expectedDate: string | null; subtotalPaise: number; gstPaise: number; totalPaise: number; lineCount: number;
  approvalId: string | null; approvalTier: "head" | "owner" | null; rejectionNote: string | null;
  createdBy: string; createdAt: string; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; sentAt: string | null;
};

export type WirePoLine = {
  id: string; itemId: string; itemCode: string; itemName: string; baseUom: string; uom: string; multiplier: number;
  qtyPacks: number; freePacks: number; ratePaise: number; gstRateBps: number; gstPaise: number; mrpPaise: number | null;
  lineTotalPaise: number; orderedBase: number; receivedBase: number; freeReceivedBase: number; remainingBase: number;
};

export type WirePo = WirePoSummary & {
  terms: string | null; note: string | null; storeName: string; vendorGstin: string | null; cancelReason: string | null;
  names: Record<string, string>;
  approval: { status: string; approverRole: string; requesterId: string; decidedBy: string | null; decisionNote: string | null } | null;
  lines: WirePoLine[];
};

export type WirePoLineInput = {
  itemId: string; uom?: string | null; qtyPacks: number; freePacks?: number; ratePaise: number; gstRateBps?: number | null; mrpPaise?: number | null;
};

export type WireOfficeToday = {
  awaitingYou: WirePoSummary[]; drafts: WirePoSummary[]; waiting: WirePoSummary[]; toReceive: WirePoSummary[]; overdue: WirePoSummary[];
  shortages: { id: string; drugName: string; itemId: string | null; qtyWanted: number | null; notedAt: string; notedByName: string | null }[];
  plan: { orders: number; lines: number; unassigned: number; unmatched: number; alreadyDrafted: number };
};

export type WireDraftLine = {
  itemId: string; code: string; name: string; baseUom: string; uom: string; multiplier: number; needBase: number; qtyPacks: number;
  ratePaise: number; gstRateBps: number; mrpPaise: number | null; lineTotalPaise: number; reasons: ("reorder" | "short_book")[];
  shortBookIds: string[]; lastGrnNo: string | null;
};
export type WirePurchasePlan = {
  storeResourceId: string; storeCode: string; expectedDate: string;
  groups: { vendorId: string; vendorCode: string; vendorName: string; lines: WireDraftLine[]; subtotalPaise: number; gstPaise: number; totalPaise: number }[];
  unassigned: (WireDraftLine & { why: "no_history" | "vendor_inactive" })[];
  unmatched: { shortBookId: string; drugName: string }[];
  alreadyDrafted: { itemId: string; code: string; name: string; inDraftBase: number }[];
};

export type WireReceivable = {
  purchaseOrder: WirePoSummary;
  lines: { itemId: string; itemCode: string; itemName: string; uom: string; multiplier: number; remainingPacks: number; remainingBase: number; unitCostPaise: number; mrpPaise: number | null; freePacksRemaining: number }[];
};

export const fetchOfficeToday = (): Promise<WireOfficeToday> => api("GET", "/pharmacy/office/today");
export const fetchPurchasePlan = (): Promise<WirePurchasePlan> => api("GET", "/pharmacy/office/plan");
export const draftOrders = (assign: { itemId: string; vendorId: string; ratePaise?: number }[]): Promise<{ drafts: WirePo[] }> =>
  api("POST", "/pharmacy/office/draft-orders", { assign });
export const fetchPoDocument = (id: string): Promise<WireRenderedDocument> => api("GET", `/pharmacy/office/purchase-orders/${id}/document`);

export async function fetchPurchaseOrders(q: { status?: PoStatus[]; vendorId?: string } = {}): Promise<WirePoSummary[]> {
  const p = new URLSearchParams();
  if (q.status !== undefined && q.status.length > 0) p.set("status", q.status.join(","));
  if (q.vendorId !== undefined) p.set("vendorId", q.vendorId);
  const qs = p.toString();
  return (await api<{ purchaseOrders: WirePoSummary[] }>("GET", `/materials/purchase-orders${qs === "" ? "" : `?${qs}`}`)).purchaseOrders;
}
export const fetchPurchaseOrder = async (id: string): Promise<WirePo> => (await api<{ purchaseOrder: WirePo }>("GET", `/materials/purchase-orders/${id}`)).purchaseOrder;
export const fetchReceivable = (id: string): Promise<WireReceivable> => api("GET", `/materials/purchase-orders/${id}/receivable`);
export const updatePurchaseOrder = async (id: string, patch: { expectedDate?: string | null; terms?: string | null; note?: string | null; lines?: WirePoLineInput[] }): Promise<WirePo> =>
  (await api<{ purchaseOrder: WirePo }>("PATCH", `/materials/purchase-orders/${id}`, patch)).purchaseOrder;
export const submitPurchaseOrder = async (id: string): Promise<WirePo> => (await api<{ purchaseOrder: WirePo }>("POST", `/materials/purchase-orders/${id}/submit`)).purchaseOrder;
export const decidePurchaseOrder = async (id: string, verdict: "approve" | "reject", note: string): Promise<WirePo> =>
  (await api<{ purchaseOrder: WirePo }>("POST", `/materials/purchase-orders/${id}/decision`, { verdict, note })).purchaseOrder;
export const sendPurchaseOrder = async (id: string): Promise<WirePo> => (await api<{ purchaseOrder: WirePo }>("POST", `/materials/purchase-orders/${id}/send`)).purchaseOrder;
export const cancelPurchaseOrder = async (id: string, reason: string): Promise<WirePo> =>
  (await api<{ purchaseOrder: WirePo }>("POST", `/materials/purchase-orders/${id}/cancel`, { reason })).purchaseOrder;
export const fetchPurchaseVendors = async (): Promise<{ id: string; code: string; name: string }[]> =>
  (await api<{ vendors: { id: string; code: string; name: string }[] }>("GET", "/materials/purchase-vendors")).vendors;
export const setStockLevel = (input: { itemId: string; storeResourceId: string; minBase: number; reorderBase: number; maxBase: number }): Promise<{ level: unknown }> =>
  api("POST", "/materials/stock-levels", input);

/** ₹ with two decimals, Indian grouping — the office's one money formatter. */
export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
