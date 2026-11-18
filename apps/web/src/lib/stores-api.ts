import { ApiError, api } from "./api";
import type {
  WireImportResult, WireItemRequest, WireOverBookCard, WireReorderLine, WireShelfView, WireStoresCategory, WireStoresItem, WireStoresPickers,
  WireStoresShelf, WireStoresStore, WireTicket, WireTicketTimeline,
} from "@hmis/contracts";

/**
 * STORES S1 (#1111) — the client of `modules/stores/stores.controller.ts`. The wire shapes live in
 * `packages/contracts/src/stores.ts`; nothing a department screen reads carries money.
 */
const enc = encodeURIComponent;

/** The server's refusal code (`not_permitted`, `more_than_on_hand`…), or null for anything else. */
export function storesErrorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  if (body !== null && typeof body === "object" && typeof body.code === "string") return body.code;
  return e.status === 403 ? "not_permitted" : null;
}

/* ── the shelf (department) ── */
export const getShelf = (shelfId: string): Promise<WireShelfView> => api("GET", `/stores/shelves/${enc(shelfId)}`);
export const myShelves = (): Promise<{ shelves: WireStoresShelf[] }> => api("GET", "/stores/my-shelves");
export const recordUse = (shelfId: string, itemId: string, qty: number): Promise<{ ledgerEntryIds: string[] }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/use`, { itemId, qty });
export const undoUse = (shelfId: string, rowId: string, reason: string): Promise<{ ledgerEntryId: string }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/undo`, { rowId, reason });
export const saveCheck = (shelfId: string, lines: { itemId: string; counted: number }[]): Promise<{ checkId: string; overBook: { itemId: string }[] }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/check`, { lines });
export const reorderDraft = (shelfId: string): Promise<{ lines: WireReorderLine[] }> => api("GET", `/stores/shelves/${enc(shelfId)}/reorder`);
export const saveReorder = (shelfId: string, lines: { itemId: string; qty: number }[]): Promise<{ draftId: string }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/reorder`, { lines });
export const receiveTransfer = (shelfId: string, transferId: string): Promise<{ status: string }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/receive`, { transferId });
export const requestItem = (shelfId: string, name: string): Promise<{ requestId: string }> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/requests`, { name });
export const searchItems = (q: string): Promise<{ items: { id: string; code: string; name: string; baseUom: string; trackMode: string }[] }> =>
  api("GET", `/stores/search?q=${enc(q.trim())}`);

/* ── the masters (the materials head) ── */
export const listCategories = (): Promise<{ categories: WireStoresCategory[] }> => api("GET", "/stores/categories");
export const addCategory = (b: { code: string; name: string; nameHi?: string | null; parentId?: string | null }): Promise<{ categoryId: string }> =>
  api("POST", "/stores/categories", b);
export const listItems = (): Promise<{ items: WireStoresItem[] }> => api("GET", "/stores/items");
export const addItem = (b: {
  code: string; name: string; class: string; baseUom: string; categoryId: string | null; trackMode: "expensed" | "shelf" | "durable" | null; searchAliases?: string[];
}): Promise<{ itemId: string }> => api("POST", "/stores/items", b);
export const importItems = (rows: { code: string; name: string; class: string; baseUom: string; category: string; trackMode: string; aliases?: string | null }[], dryRun: boolean): Promise<WireImportResult> =>
  api("POST", "/stores/items/import", { rows, dryRun });
export const listStores = (): Promise<{ stores: WireStoresStore[] }> => api("GET", "/stores/stores");
export const addStore = (b: { code: string; name: string; kind: "central" | "sub" | "night" }): Promise<{ storeId: string }> => api("POST", "/stores/stores", b);
export const listAllShelves = (): Promise<{ shelves: WireStoresShelf[] }> => api("GET", "/stores/shelves");
export const addShelf = (b: { code: string; name: string; floorId: string; departmentId: string; suppliedBy: string }): Promise<{ shelfId: string }> =>
  api("POST", "/stores/shelves", b);
export const pickers = (): Promise<WireStoresPickers> => api("GET", "/stores/pickers");
export const setPar = (b: { shelfId: string; itemId: string; minBase: number; reorderBase: number; maxBase: number }): Promise<{ ok: true }> =>
  api("POST", "/stores/par", b);
export const listRequests = (): Promise<{ requests: WireItemRequest[] }> => api("GET", "/stores/requests?status=open");
export const resolveRequest = (requestId: string, outcome: "created" | "use_existing", itemId: string): Promise<{ ok: true }> =>
  api("POST", `/stores/requests/${enc(requestId)}/resolve`, { outcome, itemId });
export const overBookCards = (): Promise<{ cards: WireOverBookCard[] }> => api("GET", "/stores/cards");

/* ── S2a (#1112): tickets — raise, approve, pick, the timeline ── */
export type TicketPriority = "routine" | "urgent" | "emergency";
export const raiseTicket = (shelfId: string, b: { lines: { itemId: string; qtyBase: number }[]; priority: TicketPriority; emergencyReason?: string | null }): Promise<WireTicket> =>
  api("POST", `/stores/shelves/${enc(shelfId)}/tickets`, { ...b, channel: "phone" });
export const ticketsToApprove = (): Promise<{ tickets: WireTicket[] }> => api("GET", "/stores/tickets/to-approve");
export const ticketsToPick = (): Promise<{ tickets: WireTicket[] }> => api("GET", "/stores/tickets/to-pick");
export const getTicket = (indentId: string): Promise<{ ticket: WireTicket; timeline: WireTicketTimeline }> => api("GET", `/stores/tickets/${enc(indentId)}`);
export const approveTicket = (indentId: string, lines: { lineIdx: number; qtyBase: number }[]): Promise<WireTicket> =>
  api("POST", `/stores/tickets/${enc(indentId)}/approve`, { lines });
export const declineTicket = (indentId: string, reason: string): Promise<WireTicket> => api("POST", `/stores/tickets/${enc(indentId)}/decline`, { reason });
export const claimTicket = (indentId: string): Promise<WireTicket> => api("POST", `/stores/tickets/${enc(indentId)}/claim`, {});
export const issueTicket = (indentId: string): Promise<WireTicket> => api("POST", `/stores/tickets/${enc(indentId)}/issue`, {});
