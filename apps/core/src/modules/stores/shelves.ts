import { eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { orgDepartments, resources } from "../../kernel/db/schema";
import { ResourceError } from "../../kernel/resources/errors";
import { balances, createStore, findStoreByCode, hasOpeningBalance, listStores, postOpeningBalances, writeStockLevel } from "../materials";
import {
  departmentOf, isStoresStore, recordAct, requireMasters, requireShelf, requireShelfAct, requireStoresStore, toStoresStore,
} from "./access";
import { StoresError } from "./errors";
import { requireStoresItem } from "./items";
import type { ShelfSummary, StoresStoreView } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — STORES AND DEPARTMENT SHELVES (decision 6), PAR (11) AND OPENING DAY (10).
 *
 * Every Stores place is a registry `store` resource made by `materials.createStore`, marked
 * `attributes.domain = 'stores'` and `attributes.kind` (`central` | `sub` | `night` | `shelf`). A shelf's
 * parent is its FLOOR, and it names its org department (`departmentId`, `departmentCode`) and the Stores
 * store it indents on (`suppliedBy`). Stores never lists a store without the domain mark: pharmacy's
 * stores are invisible here, and these are invisible to nothing (the ledger treats a place as a place).
 */

async function created<T>(run: () => Promise<T>, code: string): Promise<T> {
  try { return await run(); } catch (e) {
    if (e instanceof ResourceError && e.code === "duplicate_code") throw new StoresError("duplicate_code", `a store with code "${code}" already exists`);
    throw e;
  }
}

export async function createStoresStore(
  db: Db, actor: Actor,
  input: { code: string; name: string; kind: "central" | "sub" | "night"; parentId?: string | null; trade?: string | null; serviceHours?: string | null; custodianRoles?: string[] },
  now: Date = new Date(),
): Promise<{ storeId: string }> {
  await requireMasters(db, actor);
  return withTx(db, async (tx) => {
    const roles = input.custodianRoles ?? (input.kind === "central" ? ["storekeeper"] : []);
    const { resourceId } = await created(() => tx.transaction((sp) => createStore(sp, actor, {
      code: input.code.trim(), name: input.name.trim(), parentId: input.parentId ?? null,
      attributes: {
        domain: "stores", kind: input.kind, custodianRoles: [...new Set(roles)].sort(),
        ...(input.trade ? { trade: input.trade } : {}), ...(input.serviceHours ? { serviceHours: input.serviceHours } : {}),
      },
    })), input.code);
    await recordAct(tx, actor, now, { act: "create_store", storeId: resourceId, after: { code: input.code, kind: input.kind } });
    return { storeId: resourceId };
  });
}

export async function createShelf(
  db: Db, actor: Actor, input: { code: string; name: string; floorId: string; departmentId: string; suppliedBy: string }, now: Date = new Date(),
): Promise<{ shelfId: string }> {
  await requireMasters(db, actor);
  return withTx(db, async (tx) => {
    const [floor] = await tx.select().from(resources).where(eq(resources.id, input.floorId));
    if (floor === undefined || floor.kind !== "floor") throw new StoresError("floor_required", "a shelf sits on a floor: choose the floor");
    const dept = await departmentOf(tx, input.departmentId);
    const supplier = await requireStoresStore(tx, input.suppliedBy).catch(() => {
      throw new StoresError("supplier_not_stores", "a shelf indents on a Stores store", { suppliedBy: input.suppliedBy });
    });
    if (supplier.kind === "shelf") throw new StoresError("supplier_not_stores", "a shelf indents on a store, not on another shelf");
    const { resourceId } = await created(() => tx.transaction((sp) => createStore(sp, actor, {
      code: input.code.trim(), name: input.name.trim(), parentId: floor.id, siteId: floor.siteId,
      attributes: { domain: "stores", kind: "shelf", departmentId: dept.id, departmentCode: dept.code, suppliedBy: supplier.id, custodianRoles: [] },
    })), input.code);
    await recordAct(tx, actor, now, { act: "create_shelf", storeId: resourceId, after: { code: input.code, departmentId: dept.id, floorId: floor.id, suppliedBy: supplier.id } });
    return { shelfId: resourceId };
  });
}

export async function listStoresStores(db: Db | Tx): Promise<StoresStoreView[]> {
  return (await listStores(db, { includeStoresDomain: true })).filter((r) => isStoresStore(r)).map(toStoresStore).filter((s) => s.kind !== "shelf");
}

export async function listShelves(db: Db | Tx, filter: { departmentId?: string } = {}): Promise<ShelfSummary[]> {
  const shelves = (await listStores(db, { includeStoresDomain: true })).filter((r) => isStoresStore(r)).map(toStoresStore)
    .filter((s) => s.kind === "shelf" && (filter.departmentId === undefined || s.departmentId === filter.departmentId));
  if (shelves.length === 0) return [];
  const depts = new Map((await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)).map((d) => [d.id, d]));
  const parentIds = [...new Set(shelves.map((s) => s.parentId).filter((p): p is string => p !== null))];
  const floors = new Map(parentIds.length === 0 ? [] : (await db.select({ id: resources.id, name: resources.name }).from(resources)
    .where(inArray(resources.id, parentIds))).map((f) => [f.id, f.name]));
  return shelves.map((s) => ({
    ...s,
    departmentCode: s.departmentId === null ? null : depts.get(s.departmentId)?.code ?? s.departmentCode,
    departmentName: s.departmentId === null ? null : depts.get(s.departmentId)?.name ?? null,
    floorName: s.parentId === null ? null : floors.get(s.parentId) ?? null,
  })).sort((a, b) => (a.departmentName ?? "").localeCompare(b.departmentName ?? "") || a.code.localeCompare(b.code));
}

/** Decision 11: par per shelf item, set by the materials head. An `expensed` item never carries one. */
export async function setShelfPar(
  db: Db, actor: Actor, input: { shelfId: string; itemId: string; minBase: number; reorderBase: number; maxBase: number }, now: Date = new Date(),
): Promise<void> {
  await requireMasters(db, actor);
  await withTx(db, async (tx) => {
    const shelf = await requireStoresStore(tx, input.shelfId);
    const item = await requireStoresItem(tx, input.itemId);
    if (item.trackMode === "expensed") throw new StoresError("par_on_expensed", "an expensed item is used on receipt and carries no par");
    const levels = { minBase: input.minBase, reorderBase: input.reorderBase, maxBase: input.maxBase };
    const { previous } = await writeStockLevel(tx, actor, { itemId: item.id, storeResourceId: shelf.id, ...levels }, now);
    await recordAct(tx, actor, now, { act: "par", storeId: shelf.id, itemId: item.id, before: previous, after: levels });
  });
}

async function onHandByItem(db: Db | Tx, storeId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const b of await balances(db, { resourceId: storeId })) out.set(b.itemId, (out.get(b.itemId) ?? 0) + b.qtyOnHand);
  return out;
}

async function open(
  tx: Tx, actor: Actor, storeId: string, lines: readonly { itemId: string; qty: number; unitCostPaise?: number | null }[], now: Date,
): Promise<{ ledgerEntryIds: string[] }> {
  await tx.execute(sql`select id from resources where id = ${storeId} for update`);
  if (await hasOpeningBalance(tx, storeId)) throw new StoresError("already_opened", "this store has already been opened; opening is once");
  if (lines.length === 0) throw new StoresError("bad_quantity", "count at least one item");
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw new StoresError("bad_quantity", "an item appears twice in one opening count");
  for (const l of lines) {
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new StoresError("bad_quantity", "an opening quantity is a positive whole number", { itemId: l.itemId });
    await requireStoresItem(tx, l.itemId);
  }
  const before = await onHandByItem(tx, storeId);
  const refId = newId();
  const posted = await postOpeningBalances(tx, actor, {
    resourceId: storeId, refId, occurredAt: now,
    lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qty, unitCostPaise: l.unitCostPaise ?? null })),
  });
  await recordAct(tx, actor, now, {
    act: "open", storeId, refId, reason: "opening",
    lines: lines.map((l) => ({ itemId: l.itemId, before: before.get(l.itemId) ?? 0, after: (before.get(l.itemId) ?? 0) + l.qty })),
  });
  return { ledgerEntryIds: posted.ledgerEntryIds };
}

/** Decision 10: a shelf's opening count, once, with no charge (no cost centre). The department's own act. */
export async function openShelf(db: Db, actor: Actor, shelfId: string, lines: readonly { itemId: string; qty: number }[], now: Date): Promise<{ ledgerEntryIds: string[] }> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  return withTx(db, (tx) => open(tx, actor, shelf.id, lines.map((l) => ({ itemId: l.itemId, qty: l.qty })), now));
}

/** Decision 10: `GEN-MAIN`'s (or another Stores store's) opening stock, once, at the rates the head states. */
export async function openStore(
  db: Db, actor: Actor, storeCode: string, lines: readonly { itemId: string; qty: number; unitCostPaise?: number | null }[], now: Date,
): Promise<{ ledgerEntryIds: string[] }> {
  await requireMasters(db, actor);
  const found = await findStoreByCode(db, storeCode);
  if (found === undefined || !isStoresStore(found)) throw new StoresError("unknown_store", `no Stores store with code ${storeCode}`);
  const store = toStoresStore(found);
  if (store.kind === "shelf") throw new StoresError("unknown_store", "a shelf opens through its own count");
  return withTx(db, (tx) => open(tx, actor, store.id, lines, now));
}
