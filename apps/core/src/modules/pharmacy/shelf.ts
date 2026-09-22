import { eq } from "drizzle-orm";
import { pharmacySaleItems } from "../../kernel/db/schema";
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
 * ═══ TWO ITEMS MAY NAME ONE MEDICINE, AND LAST-BY-CODE WINS ═══
 *
 * `items_class_formulary_ck` makes `formulary_medicine_id` present-iff-drug; it does NOT make it
 * unique. So a store may hold two saleable items for one brand, and this map keeps ONE of them.
 *
 * It keeps the LAST BY ITEM CODE, and that is not a choice made here — it is what the code this
 * replaced already did. `listItems` orders by `asc(items.code)` and the old
 * `new Map(drugItems.filter(...).map(...))` therefore kept the last-written key. PRESERVED
 * BYTE-FOR-BYTE and stated out loud, because which of two items a substitution bills is a
 * behaviour with money attached, and changing it has nothing to do with bounding a read. If
 * somebody wants it deterministic-by-intent rather than deterministic-by-accident, that is a
 * separate ruling with a separate test.
 */
export async function shelfByMedicine(db: Db | Tx): Promise<Map<string, ShelfEntry>> {
  const drugItems = await listItems(db, { class: "drug", active: true });
  if (drugItems.length === 0) return new Map();

  const sale = await db.select({ itemId: pharmacySaleItems.itemId, serviceId: pharmacySaleItems.serviceId })
    .from(pharmacySaleItems).where(eq(pharmacySaleItems.active, true));
  const serviceByItem = new Map(sale.map((s) => [s.itemId, s.serviceId]));

  const out = new Map<string, ShelfEntry>();
  for (const item of drugItems) {
    if (item.formularyMedicineId === null) continue;
    const serviceId = serviceByItem.get(item.id);
    if (serviceId === undefined) continue;
    out.set(item.formularyMedicineId, { medicineId: item.formularyMedicineId, item, serviceId });
  }
  return out;
}
