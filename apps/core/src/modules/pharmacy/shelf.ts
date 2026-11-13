import { eq, sql } from "drizzle-orm";
import { anyOfText } from "../../kernel/db/any-of";
import { pharmacySaleItems, stockBalances } from "../../kernel/db/schema";
import { listItems } from "../materials";
import type { Db, Tx } from "../../kernel/db/client";
import type { ItemRow } from "../materials";

export type ShelfEntry = { medicineId: string; item: ItemRow; serviceId: string };

/**
 * ═══ WHAT THIS COUNTER CAN ACTUALLY SELL, KEYED BY MEDICINE ═══
 *
 * The pharmacy's universe is its OWN SHELF — the active drug items bridged to an active sale item —
 * and it is hundreds of rows, not the hundred thousand the national catalogue carries. Every
 * question the counter asks about "which other medicine would do" is therefore asked against this,
 * not against `formulary_medicines`. That is the whole bound: the cost of a substitution lookup
 * becomes a property of what this hospital stocks rather than of what the nation manufactures.
 *
 * ═══ TWO ITEMS MAY NAME ONE MEDICINE: THE ONE HOLDING THE STOCK, THEN THE FIRST CODE (#1047) ═══
 *
 * `items_class_formulary_ck` makes `formulary_medicine_id` present-iff-drug; it does NOT make it
 * unique, and must not: a formulary medicine can be a generic, so two brands on one medicine are
 * ordinary data. This list holds every one of them, the medicine's OWN item first:
 *   1. the most sellable stock summed over every store (on hand − reserved − frozen, each row
 *      floored at 0) — so the item the counter sells, quotes and shows is never the empty one
 *      while its twin holds the tablets;
 *   2. a tie (none anywhere, or equal) goes to the item whose code sorts first.
 * It used to be "last by item code", an accident of `new Map(...)` over a code-ordered list: on
 * staging (2026-11-13) a second item registered on a medicine hid the first one's 380 tablets
 * behind its own 75. The stock is read ONLY for medicines with two or more items, in one grouped
 * query, so the common one-item shelf costs nothing more than it did.
 */
export async function shelfItemsByMedicine(db: Db | Tx): Promise<Map<string, ShelfEntry[]>> {
  const drugItems = await listItems(db, { class: "drug", active: true });
  if (drugItems.length === 0) return new Map();

  const sale = await db.select({ itemId: pharmacySaleItems.itemId, serviceId: pharmacySaleItems.serviceId })
    .from(pharmacySaleItems).where(eq(pharmacySaleItems.active, true));
  const serviceByItem = new Map(sale.map((s) => [s.itemId, s.serviceId]));

  const out = new Map<string, ShelfEntry[]>();
  for (const item of drugItems) {
    if (item.formularyMedicineId === null) continue;
    const serviceId = serviceByItem.get(item.id);
    if (serviceId === undefined) continue;
    const entries = out.get(item.formularyMedicineId) ?? [];
    entries.push({ medicineId: item.formularyMedicineId, item, serviceId });
    out.set(item.formularyMedicineId, entries);
  }

  const shared = [...out.values()].filter((entries) => entries.length > 1);
  if (shared.length === 0) return out;
  const ids = shared.flatMap((entries) => entries.map((e) => e.item.id));
  const rows = await db.select({
    itemId: stockBalances.itemId,
    qty: sql<number>`coalesce(sum(greatest(${stockBalances.qtyOnHand} - ${stockBalances.qtyReserved} - ${stockBalances.qtyFrozen}, 0)), 0)::int`,
  }).from(stockBalances).where(anyOfText(stockBalances.itemId, ids)).groupBy(stockBalances.itemId);
  const sellable = new Map(rows.map((r) => [r.itemId, Number(r.qty)]));
  const byCode = (a: ShelfEntry, b: ShelfEntry): number => (a.item.code < b.item.code ? -1 : a.item.code > b.item.code ? 1 : 0);
  for (const entries of shared) {
    entries.sort((a, b) => (sellable.get(b.item.id) ?? 0) - (sellable.get(a.item.id) ?? 0) || byCode(a, b));
  }
  return out;
}

/** One entry per medicine: its own item, as `shelfItemsByMedicine` orders them. */
export async function shelfByMedicine(db: Db | Tx): Promise<Map<string, ShelfEntry>> {
  const out = new Map<string, ShelfEntry>();
  for (const [medicineId, entries] of await shelfItemsByMedicine(db)) out.set(medicineId, entries[0]!);
  return out;
}
