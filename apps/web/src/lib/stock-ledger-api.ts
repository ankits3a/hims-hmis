import { api } from "./api";
import type { Pack } from "./returns-api";

/**
 * GAP-CLOSURE A5 — the stock ledger as a statement (`GET /materials/stock/ledger`), transcribed from
 * `apps/core/src/modules/materials/stock-ledger-view.ts`. Quantities are base units, signed by column.
 */
export type LedgerKind =
  | "grn" | "dispense" | "sale" | "consume" | "patient_return" | "transfer_out" | "transfer_in" | "supplier_return"
  | "adjustment" | "write_off" | "merge" | "issue" | "receive" | "return" | "adjust";
export type LedgerDocLink = { kind: "return"; id: string } | { kind: "writeoff"; id: string } | { kind: "grn" } | { kind: "transfer" } | { kind: "count" };
export type WireLedgerRow = {
  seq: number; occurredAt: string; kind: LedgerKind; reason: string; refType: string | null; refId: string | null;
  docNo: string | null; link: LedgerDocLink | null;
  storeResourceId: string; storeCode: string; storeName: string; batchId: string; batchNo: string; expiryDate: string | null;
  qtyIn: number; qtyOut: number; balance: number; actorId: string; actorName: string | null;
};
export type WireStockLedger = {
  item: { id: string; code: string; name: string; baseUom: string; pack: Pack };
  storeResourceId: string | null; batchId: string | null; from: string | null; to: string | null;
  opening: number; closing: number; totalIn: number; totalOut: number;
  rows: WireLedgerRow[]; truncated: boolean;
  batches: { id: string; batchNo: string; expiryDate: string | null }[];
};
export type LedgerFilter = { itemId: string; resourceId?: string; batchId?: string; from?: string; to?: string };

export function fetchStockLedger(f: LedgerFilter): Promise<WireStockLedger> {
  const p = new URLSearchParams({ itemId: f.itemId });
  for (const k of ["resourceId", "batchId", "from", "to"] as const) {
    const v = f[k];
    if (v !== undefined && v !== "") p.set(k, v);
  }
  return api("GET", `/materials/stock/ledger?${p.toString()}`);
}

export const fetchLedgerItems = async (q: string): Promise<{ id: string; code: string; name: string; baseUom: string }[]> =>
  (await api<{ items: { id: string; code: string; name: string; baseUom: string }[] }>("GET", `/materials/stock/ledger/items?q=${encodeURIComponent(q)}`)).items;
