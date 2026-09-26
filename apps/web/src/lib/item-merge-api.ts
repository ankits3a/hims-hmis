import { api } from "./api";

/**
 * PHARMACY P6 (hygiene) — the item-merge wire: the office's items side (`/pharmacy/office/items`), the
 * merge sheet (`/pharmacy/office/item-merges/preview`), raising a merge and carrying it out
 * (`/pharmacy/office/item-merges/*`). Transcribed from `modules/materials/item-merge.ts` and
 * `modules/pharmacy/item-merge.ts`; quantities are base units.
 */
export type MergeStatus = "requested" | "merged" | "refused";
export type DuplicateWhy = "same_medicine" | "same_composition" | "similar_name";

export type MergeRule =
  | "same_item" | "already_merged" | "survivor_inactive" | "different_class" | "different_drug" | "different_base_unit"
  | "pack_conflict" | "controlled_mismatch" | "request_open"
  | "reserved" | "open_dispense" | "in_transit" | "grn_open" | "return_open" | "write_off_open" | "count_open"
  | "adjustment_open" | "recalled_stock" | "consignment_stock" | "controlled_stock" | "order_carries_both" | "batch_conflict"
  | "stock_arrived";

/** The rules that say the two are not one thing (the rest are open work to finish first). */
export const PAIR_RULES: readonly MergeRule[] = [
  "same_item", "already_merged", "survivor_inactive", "different_class", "different_drug", "different_base_unit", "pack_conflict",
  "controlled_mismatch", "request_open",
];

export type WireItemRef = { id: string; code: string; name: string };
export type WireDuplicate = {
  why: DuplicateWhy; itemClass: string;
  survivor: WireItemRef & { onHandBase: number }; merged: WireItemRef & { onHandBase: number };
};
export type WireMergeSummary = {
  id: string; status: MergeStatus; source: "agent" | "manual"; reason: string; survivor: WireItemRef; merged: WireItemRef;
  approvalId: string; approvalStatus: string; requestedBy: string; requestedAt: string; mergedBy: string | null; mergedAt: string | null;
};
export type WireMerge = WireMergeSummary & {
  names: Record<string, string>;
  approval: { status: string; approverRole: string; decidedBy: string | null; decisionNote: string | null } | null;
  moved: Record<string, unknown> | null;
};
export type WireOfficeItems = {
  duplicates: WireDuplicate[]; scanned: number; awaitingApproval: WireMergeSummary[]; readyToMerge: WireMergeSummary[]; recent: WireMergeSummary[];
};
export type WireMergeSide = {
  id: string; code: string; name: string; itemClass: string; baseUom: string; active: boolean; mergedIntoItemId: string | null;
  medicine: { id: string; brandName: string; strengthLabel: string | null; form: string } | null;
  controlled: boolean; packs: { uom: string; multiplier: number }[]; onHandBase: number; barcodes: string[];
};
export type WireRefusal = { rule: MergeRule; message: string; ref: string | null };
export type WireTally = { key: string; count: number; detail: string[] };
export type WireMergeStock = {
  storeResourceId: string; storeCode: string; storeName: string; batchId: string; batchNo: string; expiryDate: string | null; ownership: string;
  qtyBase: number; into: "new_batch" | "existing_batch";
};
export type WireMergePreview = {
  survivor: WireMergeSide; merged: WireMergeSide; refusals: WireRefusal[]; stock: WireMergeStock[]; moves: WireTally[]; stays: WireTally[]; irreversible: true;
};

export const fetchOfficeItems = (): Promise<WireOfficeItems> => api("GET", "/pharmacy/office/items");
export const fetchMergePreview = (survivorItemId: string, mergedItemId: string): Promise<WireMergePreview> =>
  api("GET", `/pharmacy/office/item-merges/preview?${new URLSearchParams({ survivorItemId, mergedItemId }).toString()}`);
export const raiseMerge = async (input: { survivorItemId: string; mergedItemId: string; reason: string; source?: "agent" | "manual" }): Promise<WireMerge> =>
  (await api<{ merge: WireMerge }>("POST", "/pharmacy/office/item-merges", input)).merge;
export const fetchMerge = async (id: string): Promise<WireMerge> => (await api<{ merge: WireMerge }>("GET", `/pharmacy/office/item-merges/${id}`)).merge;
export const executeMerge = async (id: string): Promise<WireMerge> => (await api<{ merge: WireMerge }>("POST", `/pharmacy/office/item-merges/${id}/merge`, {})).merge;
