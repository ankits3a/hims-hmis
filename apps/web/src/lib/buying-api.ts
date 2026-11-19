import { api } from "./api";
import type {
  StoresBand, WireDepartmentBudget, WirePurchaseRequest, WireStoresDelegation, WireStoresGrnForQc, WireStoresSupplier, WireSupplierKyc,
} from "@hmis/contracts";

/**
 * STORES S5a (#1115) — the client of `modules/stores/buying.controller.ts`: asking to buy, approving (one, or several in
 * one tap), handing over the approval, the month budgets, the supplier list and the non-drug GRN QC.
 */
const enc = encodeURIComponent;

export type BuyContext = {
  departments: { id: string; code: string; name: string; canAsk: boolean; canApprove: boolean; ownHod: boolean; shelves: { id: string; name: string }[] }[];
  can: { buying: boolean; masters: boolean; budget: boolean; qc: boolean; bulk: boolean };
};
export type LinePreview = {
  itemId: string; name: string; baseUom: string; unitEstimatePaise: number | null; estimateSource: "contract" | "last" | null; equipment: boolean; stockItem: boolean;
};
export type PrLineBody = {
  itemId: string; qtyBase: number; estimatePaise?: number | null; equipment?: { why: string; replacesTag?: string | null; usePerDay: string } | null;
};

export const buyContext = (): Promise<BuyContext> => api("GET", "/stores/buy/context");
export const previewLine = (itemId: string, departmentId: string | null): Promise<LinePreview> =>
  api("GET", `/stores/purchase-requests/preview?itemId=${enc(itemId)}${departmentId === null ? "" : `&departmentId=${enc(departmentId)}`}`);
export const raisePr = (body: { source: "department" | "central"; departmentId?: string | null; shelfId?: string | null; priority: "routine" | "urgent" | "emergency"; lines: PrLineBody[] }): Promise<WirePurchaseRequest> =>
  api("POST", "/stores/purchase-requests", body);
export const myPrs = (): Promise<{ requests: WirePurchaseRequest[] }> => api("GET", "/stores/purchase-requests/mine");
export const prsToApprove = (): Promise<{ requests: WirePurchaseRequest[] }> => api("GET", "/stores/purchase-requests/to-approve");
export const getPr = (id: string): Promise<WirePurchaseRequest> => api("GET", `/stores/purchase-requests/${enc(id)}`);
export const approvePr = (id: string): Promise<WirePurchaseRequest> => api("POST", `/stores/purchase-requests/${enc(id)}/approve`, {});
export const declinePr = (id: string, reason: string): Promise<WirePurchaseRequest> => api("POST", `/stores/purchase-requests/${enc(id)}/decline`, { reason });
export const bulkApprovePrs = (ids: string[]): Promise<{ requests: WirePurchaseRequest[] }> => api("POST", "/stores/purchase-requests/bulk-approve", { ids });
export const setPrBand = (id: string, band: StoresBand, reason: string): Promise<WirePurchaseRequest> => api("POST", `/stores/purchase-requests/${enc(id)}/band`, { band, reason });

export const budgetsForMonth = (month: string): Promise<{ departments: (WireDepartmentBudget & { code: string; name: string })[] }> =>
  api("GET", `/stores/budgets/month?month=${enc(month)}`);
export const setBudget = (body: { departmentId: string; month: string; amountPaise: number; annual?: boolean }): Promise<{ budgets: WireDepartmentBudget[] }> =>
  api("POST", "/stores/budgets", body);

export const myDelegations = (): Promise<{ delegations: WireStoresDelegation[] }> => api("GET", "/stores/delegations/mine");
export const delegationCandidates = (departmentId: string): Promise<{ people: { id: string; name: string }[] }> =>
  api("GET", `/stores/delegations/candidates?departmentId=${enc(departmentId)}`);
export const delegate = (body: { toUserId: string; scope: "hod_approval"; departmentId: string; from: string; to: string; reason?: string | null }): Promise<WireStoresDelegation> =>
  api("POST", "/stores/delegations", body);

export const grnsForQc = (): Promise<{ grns: WireStoresGrnForQc[] }> => api("GET", "/stores/grns/for-qc");
export const signQc = (grnId: string): Promise<{ status: string }> => api("POST", `/stores/grns/${enc(grnId)}/qc`, {});
export const postQcGrn = (grnId: string): Promise<{ status: string }> => api("POST", `/stores/grns/${enc(grnId)}/post`, {});

export const suppliers = (): Promise<{ suppliers: WireStoresSupplier[] }> => api("GET", "/stores/suppliers");
export const setSupplierFields = (vendorId: string, body: { msmeActivity?: "maker" | "service" | "trader" | null; einvoiceApplicable?: boolean | null }): Promise<WireSupplierKyc> =>
  api("POST", `/stores/suppliers/${enc(vendorId)}/fields`, body);
export const approveSupplierCategory = (vendorId: string, categoryId: string): Promise<{ ok: true }> =>
  api("POST", `/stores/suppliers/${enc(vendorId)}/categories`, { categoryId });

/* ─────────────── STORES S5b (#1115): the buying desk by hand (`buying-desk.controller.ts`) ─────────────── */
export const buyingDesk = (): Promise<import("@hmis/contracts").WireBuyingDesk> => api("GET", "/stores/buying/desk");
export const groupLines = (lines: { prId: string; lineIdx: number }[]): Promise<import("@hmis/contracts").WireBuyGroup> =>
  api("POST", "/stores/buying/groups", { lines });
export const moveLine = (body: { prId: string; lineIdx: number; toGroupId: string | null }): Promise<unknown> => api("POST", "/stores/buying/groups/move", body);
export const poFromGroup = (groupId: string, reason: string | null): Promise<unknown> => api("POST", `/stores/buying/groups/${enc(groupId)}/po`, { reason });
export const makeRfq = (body: { groupId: string; replyBy: string; deliveryDate?: string | null; vendorIds: string[] }): Promise<import("@hmis/contracts").WireRfq> =>
  api("POST", "/stores/rfqs", body);
export const sendRfq = (rfqId: string, channel: "email" | "print" | "hand"): Promise<import("@hmis/contracts").WireRfq> =>
  api("POST", `/stores/rfqs/${enc(rfqId)}/send`, { channel });
export const comparative = (rfqId: string): Promise<import("@hmis/contracts").WireComparative> => api("GET", `/stores/rfqs/${enc(rfqId)}/comparative`);
export const enterQuote = (body: { rfqId?: string; groupId?: string; vendorId: string; supplierRef?: string | null; lines: { itemId: string; ratePaise: number; discountBps?: number; gstRateBps?: number }[]; freightPaise?: number; otherPaise?: number }): Promise<unknown> =>
  api("POST", "/stores/quotes", body);
export const proposeAward = (body: { rfqId: string; vendorId: string; reason?: string | null }): Promise<import("@hmis/contracts").WireAward> => api("POST", "/stores/awards", body);
export const getAward = (id: string): Promise<import("@hmis/contracts").WireAward> => api("GET", `/stores/awards/${enc(id)}`);
export const approveAward = (id: string): Promise<import("@hmis/contracts").WireAward> => api("POST", `/stores/awards/${enc(id)}/approve`);
export const objectAward = (id: string, reason: string): Promise<import("@hmis/contracts").WireAward> => api("POST", `/stores/awards/${enc(id)}/object`, { reason });
export const poFromAward = (id: string): Promise<unknown> => api("POST", `/stores/awards/${enc(id)}/po`);
export const submitPo = (id: string): Promise<unknown> => api("POST", `/stores/buying/pos/${enc(id)}/submit`);
export const sendPo = (id: string): Promise<unknown> => api("POST", `/stores/buying/pos/${enc(id)}/send`);
export const poSheet = (id: string): Promise<import("@hmis/contracts").WireStoresPoSheet> => api("GET", `/stores/buying/pos/${enc(id)}`);
export const approvePoSheet = (id: string): Promise<import("@hmis/contracts").WireStoresPoSheet> => api("POST", `/stores/buying/pos/${enc(id)}/approve`);
