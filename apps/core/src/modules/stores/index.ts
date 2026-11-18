/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type {
  CategoryRow, CheckResult, ImportResult, ItemRequestView, OverBookCard, RegisterStoresItemInput, ReorderDraftLine, ShelfSummary,
  ShelfView, StoresImportRow, StoresItemView, StoresStoreView, TrackMode,
} from "./types";

/**
 * STORES S1 (#1111) — RED-FIRST STUB. The acceptance tests (`acceptance/stores-s1-1111.test.ts`) are
 * written against these signatures; every one throws until the build commit replaces this file.
 */
const notBuilt = (): never => { throw new Error("stores S1 not built (spec #1111)"); };

export async function registerStoresItem(_db: Db, _a: Actor, _i: RegisterStoresItemInput): Promise<{ itemId: string }> { return notBuilt(); }
export async function updateStoresItem(_db: Db, _a: Actor, _id: string, _p: { categoryId?: string; trackMode?: TrackMode; searchAliases?: string[] }, _r: string | null): Promise<void> { return notBuilt(); }
export async function createCategory(_db: Db, _a: Actor, _i: { code: string; name: string; nameHi?: string | null; parentId?: string | null }): Promise<{ categoryId: string }> { return notBuilt(); }
export async function listCategories(_db: Db): Promise<CategoryRow[]> { return notBuilt(); }
export async function seedStoresMasters(_db: Db, _a?: Actor): Promise<{ categories: number; centralStoreId: string; nightStoreId: string }> { return notBuilt(); }
export async function listStoresItems(_db: Db, _f?: { categoryId?: string }): Promise<StoresItemView[]> { return notBuilt(); }
export async function searchStoresItems(_db: Db, _q: string): Promise<StoresItemView[]> { return notBuilt(); }
export async function importStoresItems(_db: Db, _a: Actor, _rows: StoresImportRow[], _o: { dryRun: boolean }): Promise<ImportResult> { return notBuilt(); }
export async function requestNewItem(_db: Db, _a: Actor, _i: { name: string; note?: string | null; shelfId: string }): Promise<{ requestId: string }> { return notBuilt(); }
export async function listNewItemRequests(_db: Db, _a: Actor, _f?: { status?: string }): Promise<ItemRequestView[]> { return notBuilt(); }
export async function resolveNewItemRequest(_db: Db, _a: Actor, _id: string, _i: { outcome: "created" | "use_existing"; itemId: string }, _now?: Date): Promise<void> { return notBuilt(); }
export async function saveReorderDraft(_db: Db, _a: Actor, _s: string, _l: { itemId?: string | null; qty: number }[], _now: Date): Promise<{ draftId: string }> { return notBuilt(); }
export async function createStoresStore(_db: Db, _a: Actor, _i: { code: string; name: string; kind: "central" | "sub" | "night"; parentId?: string | null; trade?: string | null; serviceHours?: string | null; custodianRoles?: string[] }): Promise<{ storeId: string }> { return notBuilt(); }
export async function createShelf(_db: Db, _a: Actor, _i: { code: string; name: string; floorId: string; departmentId: string; suppliedBy: string }): Promise<{ shelfId: string }> { return notBuilt(); }
export async function listStoresStores(_db: Db): Promise<StoresStoreView[]> { return notBuilt(); }
export async function listShelves(_db: Db, _f?: { departmentId?: string }): Promise<ShelfSummary[]> { return notBuilt(); }
export async function setShelfPar(_db: Db, _a: Actor, _i: { shelfId: string; itemId: string; minBase: number; reorderBase: number; maxBase: number }, _now?: Date): Promise<void> { return notBuilt(); }
export async function openShelf(_db: Db, _a: Actor, _s: string, _l: { itemId: string; qty: number }[], _now: Date): Promise<{ ledgerEntryIds: string[] }> { return notBuilt(); }
export async function openStore(_db: Db, _a: Actor, _code: string, _l: { itemId: string; qty: number; unitCostPaise?: number | null }[], _now: Date): Promise<{ ledgerEntryIds: string[] }> { return notBuilt(); }
export async function receiveAtShelf(_db: Db, _a: Actor, _t: string, _now: Date, _l?: { lineId: string; qtyReceived: number }[]): Promise<{ status: string }> { return notBuilt(); }
export async function recordShelfUse(_db: Db, _a: Actor, _i: { shelfId: string; itemId: string; qty: number }, _now: Date): Promise<{ ledgerEntryIds: string[] }> { return notBuilt(); }
export async function reverseShelfUse(_db: Db, _a: Actor, _rowId: string, _reason: string, _now: Date): Promise<{ ledgerEntryId: string }> { return notBuilt(); }
export async function recordShelfCheck(_db: Db, _a: Actor, _i: { shelfId: string; lines: { itemId: string; counted: number }[] }, _now: Date): Promise<CheckResult> { return notBuilt(); }
export async function shelfReorderDraft(_db: Db, _a: Actor, _s: string): Promise<{ lines: ReorderDraftLine[] }> { return notBuilt(); }
export async function shelfView(_db: Db, _a: Actor, _s: string, _now: Date): Promise<ShelfView> { return notBuilt(); }
export async function floorShelfUseByMonth(_db: Db, _a: Actor, _s: string, _m: string): Promise<{ itemId: string; used: number }[]> { return notBuilt(); }
export async function departmentChargeOn(_db: Db, _code: string, _day: string): Promise<{ chargePaise: number; rows: number }> { return notBuilt(); }
export async function overBookCards(_db: Db, _a: Actor): Promise<OverBookCard[]> { return notBuilt(); }
export const STORES_ACT_EVENT = "stores.act_recorded";
export { StoresError } from "./errors";
export type * from "./types";
