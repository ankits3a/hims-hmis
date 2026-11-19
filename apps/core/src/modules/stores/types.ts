/**
 * STORES S1 (#1111) — the module's public shapes, in one place so the controller, the contracts and the
 * screens read one definition.
 */

/** Decision 4: how a Stores item is kept at a department. `tagged` arrives with S4 (#1114). */
export type TrackMode = "expensed" | "shelf" | "durable";
export const TRACK_MODES: readonly TrackMode[] = ["expensed", "shelf", "durable"];

/**
 * Decision 2: the classes Stores registers. `drug` (pharmacy) and `implant` (patient-billable, ruling
 * 0099 Q1) are refused; linen, uniforms and kitchen dry stock are Stores items (Q5).
 */
export const STORES_ITEM_CLASSES = [
  "consumable", "consumable_dated", "stationery", "asset", "service", "reagent", "gas", "linen",
] as const;
export type StoresItemClass = (typeof STORES_ITEM_CLASSES)[number];

/** Decision 6: what a Stores store is. Every one carries `attributes.domain = 'stores'`. */
export type StoresStoreKind = "central" | "sub" | "night" | "shelf";

export type CategoryRow = { id: string; code: string; name: string; nameHi: string | null; parentId: string | null; active: boolean };

export type StoresItemView = {
  id: string; code: string; name: string; class: string; baseUom: string;
  categoryId: string | null; categoryName: string | null; trackMode: TrackMode;
  searchAliases: string[]; active: boolean;
  /** The issue pack (the unit marked `is_issue_uom` with the largest multiplier), for the reorder rounding. */
  issuePack: { uom: string; multiplier: number };
};

export type RegisterStoresItemInput = {
  code: string;
  name: string;
  class: string;
  baseUom: string;
  categoryId: string | null;
  trackMode: TrackMode | null;
  searchAliases?: string[];
  patientBillable?: boolean;
  /** One more unit the item is issued in (a box of 10), beyond the base. */
  issuePack?: { uom: string; multiplier: number } | null;
  hsnCode?: string | null;
  gstRateBps?: number | null;
};

export type StoresImportRow = {
  code: string; name: string; class: string; baseUom: string;
  /** The category's CODE, as a sheet carries it. */
  category: string;
  trackMode: string;
  /** Aliases separated by `;`. */
  aliases?: string | null;
};
export type ImportRefusal = { row: number; code: string; message: string };
export type ImportResult = { dryRun: boolean; created: number; wouldCreate: number; refusals: ImportRefusal[] };

export type ItemRequestView = {
  id: string; name: string; note: string | null; status: "open" | "created" | "use_existing";
  requestedBy: string; shelfId: string | null; departmentId: string | null;
  resolvedItemId: string | null; createdAt: string;
  /** The duplicate finder's guesses (decision 5): existing items whose name is close. */
  similar: { itemId: string; code: string; name: string }[];
};

export type StoresStoreView = {
  id: string; code: string; name: string; kind: StoresStoreKind; parentId: string | null;
  departmentId: string | null; suppliedBy: string | null; custodianRoles: string[];
};

export type ShelfSummary = StoresStoreView & { departmentCode: string | null; departmentName: string | null; floorName: string | null };

export type ShelfStatusWord = "ok" | "low" | "out";

export type ShelfItemView = {
  itemId: string; code: string; name: string; baseUom: string; trackMode: TrackMode;
  onHand: number; status: ShelfStatusWord;
  par: { minBase: number; reorderBase: number; maxBase: number } | null;
  lastCheckAt: string | null;
  /** Use per day over the last 30 days (decision 13). */
  usePerDay30: number;
  /** Use per OPD visit over the last 30 days; null for a department with no OPD clinic or no visits. */
  usePerOpdVisit: number | null;
  /** Use per occupied bed-day; null while IPD is off production (owner 2026-10-13). */
  usePerBedDay: number | null;
};

export type ArrivingTransfer = { transferId: string; fromName: string; issuedAt: string; lines: { lineId: string; itemId: string; name: string; qty: number }[] };

export type ShelfView = {
  shelf: ShelfSummary;
  /** Department staff see no money (decision 14). No figure on this view is a price. */
  items: ShelfItemView[];
  arriving: ArrivingTransfer[];
  /** What this viewer may do here: the screen hides what the server would refuse. */
  may: { work: boolean };
};

export type ReorderDraftLine = { itemId: string; code: string; name: string; onHand: number; proposed: number; packUom: string; packSize: number };

export type CheckResult = {
  checkId: string;
  used: { itemId: string; qty: number }[];
  overBook: { itemId: string; book: number; counted: number }[];
  /** `durable` items counted short: not posted as use (they leave only by return or condemnation, S4). */
  shortDurable: { itemId: string; book: number; counted: number }[];
};

export type OverBookCard = { cardId: string; shelfId: string; shelfName: string; checkId: string; at: string; lines: { itemId: string; name: string; book: number; counted: number }[] };
