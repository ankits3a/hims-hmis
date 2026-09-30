import { api } from "./api";
import type { WireRenderedDocument } from "./print-api";

/** GAP A6 — the office's rack and strip labels (`/pharmacy/labels`). Mirrors `modules/pharmacy/labels.ts`. */
export const LABELS_PERMISSION = "pharmacy.sale_items.manage";
export const MAX_LABELS_PER_JOB = 500;

export type LabelKind = "rack" | "strip";
export type WireLabelBatch = { batchId: string; batchNo: string; expiryDate: string | null; mrpPaise: number | null; mrpUom: string | null; qtyOnHand: number };
export type WireLabelCandidate = {
  itemId: string; code: string; name: string; baseUom: string; rack: string | null;
  packs: { uom: string; toBase: number }[];
  batches: WireLabelBatch[];
};
export type WireLabelStore = { id: string; code: string; name: string };
export type LabelLine = { itemId: string; batchId?: string | null; packUom?: string | null; copies: number };
export type WireSendLabels =
  | { via: "relay"; job: { id: string; status: string; createdAt: string } }
  | { via: "browser"; document: WireRenderedDocument };

export const fetchLabelCandidates = (store: string | null, q: string): Promise<{ stores: WireLabelStore[]; rows: WireLabelCandidate[] }> => {
  const p = new URLSearchParams();
  if (store !== null) p.set("store", store);
  if (q.trim() !== "") p.set("q", q.trim());
  const qs = p.toString();
  return api("GET", `/pharmacy/labels${qs === "" ? "" : `?${qs}`}`);
};
export const printLabels = (input: { kind: LabelKind; storeResourceId: string; lines: LabelLine[] }): Promise<WireSendLabels> =>
  api("POST", "/pharmacy/labels/print", input);
