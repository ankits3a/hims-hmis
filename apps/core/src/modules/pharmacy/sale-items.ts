import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { pharmacySaleItems } from "../../kernel/db/schema";
import { getItem, itemsByIds, listItems } from "../materials";
import { createService, listServices } from "../tariff";
import { PharmacyError } from "./errors";
import { gstCategoryFor } from "./price";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ItemRow } from "../materials";

/**
 * PLAN 16c T2 / D3 — THE ITEM → SERVICE BRIDGE.
 *
 * A drug item (materials) is billed as a tariff SERVICE (tariff), and nothing in either module
 * says which. This table does, one row per saleable item, and `registerSaleItem` creates the
 * service in the same transaction it writes the row — through `tariff/index.ts`, never by an
 * insert into `services`. The service is `RX-<item code>`, in the GST-slab category the item's
 * rate names (S2), and NOT `regulated`: the regulated clamp this system already has is keyed by
 * service and a drug's lawful maximum is keyed by BATCH, so the law arrives per line as
 * `capUnitPaise` (Plan 15 DD11, T4) and never through `regulated_prices`.
 *
 * Reads go through `materials/index.ts` (`getItem`, `itemsByIds`, `listItems`) — this module
 * queries no materials table (Plan 14 §4A.2).
 */
export const SALE_SERVICE_PREFIX = "RX-";

export type SaleItemRow = typeof pharmacySaleItems.$inferSelect;

export type SaleItemView = {
  itemId: string;
  code: string;
  name: string;
  baseUom: string;
  gstRateBps: number | null;
  serviceId: string;
  serviceCode: string;
  category: string;
  active: boolean;
  itemActive: boolean;
};

export async function registerSaleItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
): Promise<{ itemId: string; serviceId: string; serviceCode: string; category: string }> {
  const item = await getItem(tx, itemId);
  if (item === undefined) throw new PharmacyError("unknown_item", `item ${itemId} not found`);
  if (item.class !== "drug") {
    throw new PharmacyError(
      "not_a_drug",
      `item ${item.code} is "${item.class}" — the dispensing counter sells medicines, and a consumable is billed by the department that uses it`,
      { itemId, class: item.class },
    );
  }
  const existing = await tx.select({ serviceId: pharmacySaleItems.serviceId }).from(pharmacySaleItems)
    .where(eq(pharmacySaleItems.itemId, itemId));
  if (existing.length > 0) {
    throw new PharmacyError("sale_item_exists", `item ${item.code} is already a sale item`, { itemId, serviceId: existing[0]!.serviceId });
  }
  const category = gstCategoryFor(item.gstRateBps);
  const serviceCode = `${SALE_SERVICE_PREFIX}${item.code}`;
  const { serviceId } = await createService(tx, actor, { code: serviceCode, name: item.name, category, regulated: false });
  await tx.insert(pharmacySaleItems).values({ itemId, serviceId, active: true, createdBy: actor.id, updatedBy: actor.id });
  return { itemId, serviceId, serviceCode, category };
}

export async function setSaleItemActive(tx: Tx, actor: Actor, itemId: string, active: boolean): Promise<void> {
  const rows = await tx.update(pharmacySaleItems)
    .set({ active, updatedBy: actor.id, updatedAt: sql`now()` })
    .where(eq(pharmacySaleItems.itemId, itemId))
    .returning({ itemId: pharmacySaleItems.itemId });
  if (rows.length === 0) throw new PharmacyError("unknown_sale_item", `item ${itemId} is not a sale item`);
}

export async function getSaleItem(db: Db | Tx, itemId: string): Promise<SaleItemRow | undefined> {
  const rows = await db.select().from(pharmacySaleItems).where(eq(pharmacySaleItems.itemId, itemId));
  return rows[0];
}

/** The ACTIVE sale item for a drug, or a typed refusal — what the counter's pick (T4) calls. */
export async function requireActiveSaleItem(db: Db | Tx, itemId: string): Promise<SaleItemRow> {
  const row = await getSaleItem(db, itemId);
  if (row === undefined) throw new PharmacyError("unknown_sale_item", `item ${itemId} is not a sale item — register it before dispensing it`, { itemId });
  if (!row.active) throw new PharmacyError("sale_item_inactive", `item ${itemId} is not for sale`, { itemId });
  return row;
}

export async function listSaleItems(db: Db | Tx, filter: { search?: string } = {}): Promise<SaleItemView[]> {
  const rows = await db.select().from(pharmacySaleItems).orderBy(asc(pharmacySaleItems.createdAt));
  if (rows.length === 0) return [];
  const [itemById, services] = await Promise.all([
    itemsByIds(db, rows.map((r) => r.itemId)),
    listServices(db),
  ]);
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const needle = filter.search?.trim().toLowerCase() ?? "";
  const views: SaleItemView[] = [];
  for (const r of rows) {
    const item = itemById.get(r.itemId);
    const service = serviceById.get(r.serviceId);
    if (item === undefined || service === undefined) continue;
    if (needle !== "" && !item.name.toLowerCase().includes(needle) && !item.code.toLowerCase().includes(needle)) continue;
    views.push({
      itemId: item.id, code: item.code, name: item.name, baseUom: item.baseUom, gstRateBps: item.gstRateBps,
      serviceId: service.id, serviceCode: service.code, category: service.category,
      active: r.active, itemActive: item.active,
    });
  }
  return views;
}

/** Active drug items that are NOT yet sale items — what the pharmacist registers from. */
export async function saleItemCandidates(db: Db | Tx, filter: { search?: string } = {}): Promise<ItemRow[]> {
  const drugs = await listItems(db, { class: "drug", active: true, ...(filter.search === undefined ? {} : { search: filter.search }) });
  if (drugs.length === 0) return [];
  const registered = await db.select({ itemId: pharmacySaleItems.itemId }).from(pharmacySaleItems)
    .where(and(inArray(pharmacySaleItems.itemId, drugs.map((d) => d.id))));
  const taken = new Set(registered.map((r) => r.itemId));
  return drugs.filter((d) => !taken.has(d.id));
}
