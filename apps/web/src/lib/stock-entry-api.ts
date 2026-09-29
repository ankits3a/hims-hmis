import { api } from "./api";
import { materialsErrorText } from "./materials-api";
import { pharmacyErrorCode, pharmacyErrorText } from "./pharmacy-api";
import en from "../locales/en.json";
import type { WireOpeningCapture, WireOpeningCheck } from "./materials-api";

/**
 * STOCK ENTRY ON SCREEN (2026-09-29) — the wire contract of `pharmacy-opening-stock.controller.ts`'s grid
 * routes and the new-drug door, transcribed. The grid sends cells AS TYPED (text): the server's planner reads
 * them exactly as it reads a CSV, so there is one judgement and this file never re-derives it.
 *
 * The two small sums the grid shows live — cost per unit after the trade discount, and the margin against
 * MRP — mirror `costPerBase` in `opening-stock.ts` for display only; the server's figure is the one captured.
 */
export const PACK_TYPES = ["tablet_strip", "capsule_strip", "bottle", "vial", "ampoule", "tube", "pouch", "sachet", "box", "other"] as const;
export type PackType = (typeof PACK_TYPES)[number];

export type WireStockItem = {
  itemId: string; code: string; name: string; baseUom: string;
  packs: { uom: string; multiplier: number }[];
  gstRateBps: number | null; hsnCode: string | null;
  onSale: boolean; active: boolean;
  strength: string | null; form: string | null; schedule: string | null;
  rack: string | null; mrpPaise: number | null; mrpUom: string | null;
};

export type WireGridRow = {
  itemId: string; batch: string; expiry: string; mrpPerPack: string; packSize: string; packs: string;
  freePacks?: string; ratePerPack?: string; discountPct?: string; packType?: string; rack?: string; supplier?: string;
};

export type WireStockCheck = WireOpeningCheck & {
  rows: (WireOpeningCheck["rows"][number] & { freePacks: number; ratePaise: number; discountBps: number })[];
};

export type NewDrugInput = {
  brandName: string; strength: string; medicineId: string; form: string; packType: PackType; packSize: number;
  hsnCode: string; gstRateBps: number; schedule: "H" | "H1" | "X" | "OTC" | null; mrpPerPackPaise: number;
  storage: "ambient" | "cold_2_8";
};
export type NewDrugResult = { itemId: string; code: string; name: string; uom: string; packSize: number; gstRateBps: number };

export const searchStockItems = async (search: string): Promise<WireStockItem[]> =>
  (await api<{ items: WireStockItem[] }>("GET", `/pharmacy/opening-stock/items?search=${encodeURIComponent(search)}`)).items;

export const fetchStockSuppliers = async (): Promise<{ id: string; code: string; name: string }[]> =>
  (await api<{ suppliers: { id: string; code: string; name: string }[] }>("GET", "/pharmacy/opening-stock/suppliers")).suppliers;

export const fetchStockMedicine = (id: string): Promise<{ id: string; name: string; form: string; strength: string | null; schedule: string | null }> =>
  api("GET", `/pharmacy/opening-stock/medicines/${encodeURIComponent(id)}`);

/** Judge the grid's rows. Writes nothing. */
export const checkStockRows = (rows: WireGridRow[]): Promise<WireStockCheck> =>
  api<WireStockCheck>("POST", "/pharmacy/opening-stock/check", { rows });

/** Judge them again on the server and capture them as GRNs for the pharmacist's QC. */
export const captureStockRows = (rows: WireGridRow[]): Promise<WireOpeningCapture> =>
  api<WireOpeningCapture>("POST", "/pharmacy/opening-stock/capture", { rows });

export const createNewDrug = (input: NewDrugInput): Promise<NewDrugResult> =>
  api<NewDrugResult>("POST", "/pharmacy/opening-stock/new-drug", input);

/** One drug's GST slab, with its sale category in the same transaction (`pharmacy.sale_items.manage`). */
export const setGstSlab = (itemId: string, rateBps: number): Promise<{ categoryChanged: boolean }> =>
  api("PUT", `/pharmacy/sale-items/${encodeURIComponent(itemId)}/gst-slab`, { rateBps });

/** A pharmacy refusal in the pharmacy's words, a materials one in the item master's, else the server's sentence. */
export function stockErrorText(e: unknown, t: (key: string) => string): string {
  const code = pharmacyErrorCode(e);
  if (code !== null && Object.prototype.hasOwnProperty.call(en.pharmacyErrors, code)) return pharmacyErrorText(e, t);
  return materialsErrorText(e, t);
}

/** "35.50" → 3550; null for anything that is not rupees with at most two decimals (the server's reader). */
export function paiseOf(text: string): number | null {
  if (!/^\s*\d+(\.\d{1,2})?\s*$/.test(text)) return null;
  const [r, p = ""] = text.trim().split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

/** The cost of one unit after the trade discount — `costPerBase` on the server, for the live figure only. */
export function unitCostPaise(ratePaise: number, discountBps: number, packSize: number): number {
  return Math.floor((ratePaise * (10_000 - discountBps)) / (10_000 * packSize));
}

/** A new pack size on an item (`materials.items.manage`) — a new unit; existing units are never resized. */
export const addPackSize = (itemId: string, uom: string, toBaseMultiplier: number): Promise<{ itemUomId: string }> =>
  api("POST", `/materials/items/${encodeURIComponent(itemId)}/uoms`, { uom, toBaseMultiplier, isPurchaseUom: true, isIssueUom: true });
