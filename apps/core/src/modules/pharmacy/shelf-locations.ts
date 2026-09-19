import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyShelfLocations } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { anyOfText } from "../../kernel/db/any-of";
import { findStoreByCode } from "../materials";
import { OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE } from "./config";
import { PharmacyError } from "./errors";
import { shelfLocationSet } from "./events";
import { getSaleItem } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PD-D18 — WHERE THE DRUG IS ═══
 *
 * One short label per (counter's store, item) — "R-12", "rack 3 · shelf 2", "fridge" — printed on the
 * dispense line beside the batch, because the walk to the shelf is the pharmacist's slowest act and
 * nothing used to say where to walk. Route-gated on `pharmacy.sale_items.manage`, the permission that
 * already manages what the counter sells; the aide who picks reads it, the pharmacist in charge sets it.
 */
export const SHELF_LABEL_MAX = 24;

/** Set, replace, or — with an empty label — clear. Returns the label now in force. */
export async function setShelfLocation(
  db: Db,
  actor: Actor,
  input: { storeResourceId: string; itemId: string; location: string },
  now: Date,
): Promise<{ location: string | null }> {
  /* Only a counter's store: a bin in the main store is the store's business, not the counter's. */
  const counters = await Promise.all([findStoreByCode(db, OPD_PHARMACY_STORE_CODE), findStoreByCode(db, RETAIL_PHARMACY_STORE_CODE)]);
  if (!counters.some((s) => s !== undefined && s.id === input.storeResourceId)) {
    throw new PharmacyError("store_missing", "a shelf location is kept for a pharmacy counter's store only");
  }
  if ((await getSaleItem(db, input.itemId)) === undefined) {
    throw new PharmacyError("unknown_sale_item", "only an item the counter sells has a place on its shelf");
  }
  const label = input.location.trim();
  if (label.length > SHELF_LABEL_MAX) {
    throw new PharmacyError("invalid_shelf_location", `a shelf label is at most ${String(SHELF_LABEL_MAX)} characters — "R-12", "rack 3 · shelf 2"`);
  }
  await withTx(db, async (tx) => {
    const where = and(eq(pharmacyShelfLocations.storeResourceId, input.storeResourceId), eq(pharmacyShelfLocations.itemId, input.itemId));
    if (label === "") {
      await tx.delete(pharmacyShelfLocations).where(where);
    } else {
      await tx.insert(pharmacyShelfLocations)
        .values({ id: newId(), storeResourceId: input.storeResourceId, itemId: input.itemId, location: label, setBy: actor.id, setAt: now })
        .onConflictDoUpdate({
          target: [pharmacyShelfLocations.storeResourceId, pharmacyShelfLocations.itemId],
          set: { location: label, setBy: actor.id, setAt: now },
        });
    }
    await appendEvent(tx, shelfLocationSet.make({
      occurredAt: now, actor, correlationId: input.itemId,
      payload: { storeResourceId: input.storeResourceId, itemId: input.itemId, location: label === "" ? null : label },
    }));
  });
  return { location: label === "" ? null : label };
}

/** The labels for these items in one store — the dispense view's read. Items with none are absent. */
export async function shelfLocationsFor(db: Db | Tx, storeResourceId: string, itemIds: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(itemIds)];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ itemId: pharmacyShelfLocations.itemId, location: pharmacyShelfLocations.location })
    .from(pharmacyShelfLocations)
    .where(and(eq(pharmacyShelfLocations.storeResourceId, storeResourceId), anyOfText(pharmacyShelfLocations.itemId, wanted)));
  return new Map(rows.map((r) => [r.itemId, r.location]));
}
