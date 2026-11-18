import { z } from "zod";

/**
 * STORES S1 (#1111, decision 0099) — the wire of `apps/core/src/modules/stores/stores.controller.ts`, read by
 * the controller (request bodies, parsed here) and by the web screens (`/stores`, the phone shelf).
 *
 * No shape a department screen reads carries money: the shelf view is quantities and status words.
 */

const id = z.string().min(1).max(64);
const qty = z.number().int().positive().max(10_000_000);
export const STORES_TRACK_MODES = ["expensed", "shelf", "durable"] as const;
export const storesTrackModeSchema = z.enum(STORES_TRACK_MODES);

export const storesCategoryBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  nameHi: z.string().trim().max(120).nullish(),
  parentId: id.nullish(),
});

export const storesItemBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  class: z.string().min(1).max(40),
  baseUom: z.string().trim().min(1).max(20),
  categoryId: id.nullable(),
  trackMode: storesTrackModeSchema.nullable(),
  searchAliases: z.array(z.string().max(80)).max(20).optional(),
  patientBillable: z.boolean().optional(),
  issuePack: z.object({ uom: z.string().trim().min(1).max(20), multiplier: z.number().int().min(2).max(100_000) }).nullish(),
  hsnCode: z.string().max(12).nullish(),
  gstRateBps: z.number().int().min(0).max(2800).nullish(),
});

export const storesItemPatchBody = z.object({
  categoryId: id.optional(),
  trackMode: storesTrackModeSchema.optional(),
  searchAliases: z.array(z.string().max(80)).max(20).optional(),
  reason: z.string().max(200).nullish(),
});

export const storesImportBody = z.object({
  dryRun: z.boolean(),
  rows: z.array(z.object({
    code: z.string().max(40), name: z.string().max(160), class: z.string().max(40), baseUom: z.string().max(20),
    category: z.string().max(20), trackMode: z.string().max(20), aliases: z.string().max(400).nullish(),
  })).min(1).max(2000),
});

export const storesStoreBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["central", "sub", "night"]),
  parentId: id.nullish(),
  trade: z.string().max(40).nullish(),
  serviceHours: z.string().max(40).nullish(),
});

export const storesShelfBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  floorId: id,
  departmentId: id,
  suppliedBy: id,
});

export const storesParBody = z.object({
  shelfId: id, itemId: id,
  minBase: z.number().int().min(0), reorderBase: z.number().int().min(0), maxBase: z.number().int().min(1),
});

export const storesOpenBody = z.object({
  lines: z.array(z.object({ itemId: id, qty, unitCostPaise: z.number().int().min(0).nullish() })).min(1).max(2000),
});

export const storesUseBody = z.object({ itemId: id, qty });
export const storesUndoBody = z.object({ rowId: id, reason: z.string().trim().min(1).max(200) });
export const storesCheckBody = z.object({ lines: z.array(z.object({ itemId: id, counted: z.number().int().min(0).max(10_000_000) })).min(1).max(500) });
export const storesReorderBody = z.object({ lines: z.array(z.object({ itemId: id.nullish(), qty })).min(1).max(500) });
export const storesReceiveBody = z.object({ transferId: id });
export const storesRequestBody = z.object({ name: z.string().trim().min(1).max(160), note: z.string().max(400).nullish() });
export const storesResolveBody = z.object({ outcome: z.enum(["created", "use_existing"]), itemId: id });

/* ═══ wire shapes the screens read ═══ */

export type StoresTrackMode = (typeof STORES_TRACK_MODES)[number];
export type StoresStatusWord = "ok" | "low" | "out";

export type WireStoresCategory = { id: string; code: string; name: string; nameHi: string | null; parentId: string | null; active: boolean };
export type WireStoresItem = {
  id: string; code: string; name: string; class: string; baseUom: string; categoryId: string | null; categoryName: string | null;
  trackMode: StoresTrackMode; searchAliases: string[]; active: boolean; issuePack: { uom: string; multiplier: number };
};
export type WireStoresStore = {
  id: string; code: string; name: string; kind: "central" | "sub" | "night" | "shelf"; parentId: string | null;
  departmentId: string | null; suppliedBy: string | null; custodianRoles: string[];
};
export type WireStoresShelf = WireStoresStore & { departmentCode: string | null; departmentName: string | null; floorName: string | null };
export type WireShelfItem = {
  itemId: string; code: string; name: string; baseUom: string; trackMode: StoresTrackMode; onHand: number; status: StoresStatusWord;
  par: { minBase: number; reorderBase: number; maxBase: number } | null; lastCheckAt: string | null;
  usePerDay30: number; usePerOpdVisit: number | null; usePerBedDay: number | null;
};
export type WireShelfView = {
  shelf: WireStoresShelf;
  items: WireShelfItem[];
  arriving: { transferId: string; fromName: string; issuedAt: string; lines: { lineId: string; itemId: string; name: string; qty: number }[] }[];
  may: { work: boolean };
};
export type WireReorderLine = { itemId: string; code: string; name: string; onHand: number; proposed: number; packUom: string; packSize: number };
export type WireItemRequest = {
  id: string; name: string; note: string | null; status: "open" | "created" | "use_existing"; requestedBy: string;
  shelfId: string | null; departmentId: string | null; resolvedItemId: string | null; createdAt: string;
  similar: { itemId: string; code: string; name: string }[];
};
export type WireImportResult = { dryRun: boolean; created: number; wouldCreate: number; refusals: { row: number; code: string; message: string }[] };
export type WireOverBookCard = { cardId: string; shelfId: string; shelfName: string; checkId: string; at: string; lines: { itemId: string; name: string; book: number; counted: number }[] };
export type WireStoresPickers = {
  floors: { id: string; code: string; name: string }[];
  departments: { id: string; code: string; name: string }[];
};
