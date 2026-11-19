import { eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { appendEvent } from "../../kernel/events/append";
import { orgDepartments, resources } from "../../kernel/db/schema";
import { StoresError } from "./errors";
import { storesActRecorded } from "./events";
import type { StoresAct } from "./events";
import type { StoresStoreKind } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — WHO MAY, AND AT WHICH SCOPE (decision 7, the roster precedent `roster/access.ts`).
 *
 * The masters are the materials head's, at hospital scope. Every shelf act is asked AT THE SHELF'S
 * DEPARTMENT: `hasPermission(…, "department", { departmentId })`. A hospital-scoped holding satisfies any
 * department (`kernel/auth/permissions.ts`), so there is no second "hospital fallback" call here, and
 * there must not be. A machine actor holds nothing.
 */
export const STORES_MASTERS = "stores.masters.manage";
export const STORES_SHELF_READ = "stores.shelf.read";
export const STORES_SHELF_WORK = "stores.shelf.work";

export async function holds(db: Db | Tx, actor: Actor, permission: string, departmentId?: string): Promise<boolean> {
  if (actor.type !== "user") return false;
  return departmentId === undefined
    ? hasPermission(db as Db, actor.id, permission, "hospital")
    : hasPermission(db as Db, actor.id, permission, "department", { departmentId });
}

export async function requireMasters(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_MASTERS))) {
    throw new StoresError("not_permitted", "only the materials head keeps the Stores masters", { permission: STORES_MASTERS });
  }
}

export type StoresStore = {
  id: string; code: string; name: string; parentId: string | null; kind: StoresStoreKind;
  departmentId: string | null; departmentCode: string | null; suppliedBy: string | null; custodianRoles: string[];
};

function attrsOf(row: { attributes: unknown }): Record<string, unknown> {
  return (row.attributes ?? {}) as Record<string, unknown>;
}

/** True for a store Stores itself created: `attributes.domain = 'stores'`. Pharmacy's stores carry no domain. */
export function isStoresStore(row: { kind: string; attributes: unknown }): boolean {
  return row.kind === "store" && attrsOf(row).domain === "stores";
}

export function toStoresStore(row: { id: string; code: string; name: string; parentId: string | null; attributes: unknown }): StoresStore {
  const a = attrsOf(row);
  const str = (k: string): string | null => (typeof a[k] === "string" ? a[k] : null);
  return {
    id: row.id, code: row.code, name: row.name, parentId: row.parentId,
    kind: (str("kind") ?? "sub") as StoresStoreKind,
    departmentId: str("departmentId"), departmentCode: str("departmentCode"), suppliedBy: str("suppliedBy"),
    custodianRoles: Array.isArray(a.custodianRoles) ? a.custodianRoles.filter((r): r is string => typeof r === "string") : [],
  };
}

/** A Stores store (any kind), or `unknown_store`. */
export async function requireStoresStore(db: Db | Tx, storeId: string): Promise<StoresStore> {
  const [row] = await db.select().from(resources).where(eq(resources.id, storeId));
  if (row === undefined || !isStoresStore(row) || row.status === "retired") {
    throw new StoresError("unknown_store", `store ${storeId} is not a Stores store`, { storeId });
  }
  return toStoresStore(row);
}

/** A department shelf, or `unknown_store` / `not_a_shelf`. */
export async function requireShelf(db: Db | Tx, shelfId: string): Promise<StoresStore & { departmentId: string; departmentCode: string }> {
  const store = await requireStoresStore(db, shelfId);
  if (store.kind !== "shelf" || store.departmentId === null) {
    throw new StoresError("not_a_shelf", `${store.code} is not a department shelf`, { storeId: shelfId });
  }
  const code = store.departmentCode ?? (await departmentOf(db, store.departmentId)).code;
  return { ...store, departmentId: store.departmentId, departmentCode: code };
}

export async function departmentOf(db: Db | Tx, departmentId: string): Promise<{ id: string; code: string; name: string; opdDepartmentId: string | null }> {
  const [d] = await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name, opdDepartmentId: orgDepartments.opdDepartmentId })
    .from(orgDepartments).where(eq(orgDepartments.id, departmentId));
  if (d === undefined) throw new StoresError("unknown_department", `department ${departmentId} not found`, { departmentId });
  return d;
}

/**
 * The shelf act's grant, at the shelf's department. `read` is also open to the materials head (hospital
 * scope), who reads every shelf; `work` is the department's own.
 */
export async function requireShelfAct(db: Db | Tx, actor: Actor, shelf: { departmentId: string }, need: "read" | "work"): Promise<void> {
  const permission = need === "work" ? STORES_SHELF_WORK : STORES_SHELF_READ;
  if (await holds(db, actor, permission, shelf.departmentId)) return;
  if (need === "read" && (await holds(db, actor, STORES_MASTERS))) return;
  throw new StoresError("not_permitted", "not your department", { permission, departmentId: shelf.departmentId });
}

/** The one event every Stores act appends, inside the act's own transaction. */
export async function recordAct(
  tx: Tx,
  actor: Actor,
  now: Date,
  p: { act: StoresAct; storeId?: string | null; itemId?: string | null; before?: unknown; after?: unknown; reason?: string | null; refId?: string | null; lines?: Record<string, unknown>[] },
): Promise<void> {
  await appendEvent(tx, storesActRecorded.make({
    actor, occurredAt: now, correlationId: p.refId ?? p.storeId ?? p.itemId ?? undefined,
    payload: {
      act: p.act, storeId: p.storeId ?? null, itemId: p.itemId ?? null, before: p.before ?? null, after: p.after ?? null,
      reason: p.reason ?? null, refId: p.refId ?? null, lines: p.lines ?? [],
    },
  }));
}
