import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import {
  controlledStockRegister, pharmacyDispenseLines, pharmacyDispenses, pharmacyRetailSaleLines, pharmacySaleItems, pharmacyShelfLocations,
  pharmacyShortBook,
} from "../../kernel/db/schema";
import {
  executeItemMerge, findDuplicateItems, getItemMerge, itemMergePreview, listItemMerges, raiseItemMerge,
} from "../materials";
import { shortBookResolved } from "./events";
import { registerSaleItem, setSaleItemActive } from "./sale-items";
import type {
  DuplicateSuggestion, ItemMergeHooks, ItemMergeSummary, ItemMergeView, ItemRow, MergePreview, MergeRefusal, MergeTally,
} from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 (HYGIENE) — ITEM MERGE, THE PHARMACY'S PART AND THE OFFICE'S SIDE ═══
 *
 * The act is materials' (`modules/materials/item-merge.ts`: the item master, the stock, the orders, the
 * levels, the barcodes). The office FEDERATES: these hooks add what only the pharmacy knows, inside the
 * same transaction —
 *   - **blocks** while a dispense that is not handed over names the duplicate (its line was verified or
 *     picked against B's batch: the patient's ticket finishes first);
 *   - **moves** the sale registration (B's is retired; when A was never registered for sale and B was, A
 *     is registered as `registerSaleItem` does — its own `RX-` service under its own name — at B's on/off),
 *     the shelf locations (A's own label wins at a store where both have one) and the open short-book rows
 *     (A's own open row wins; B's is closed as dismissed);
 *   - **stays**: dispense and walk-in sale lines, the H1 and controlled registers — all still say B.
 */

const OPEN_DISPENSE_STATUSES = ["queued", "claimed", "verified", "picked", "billed"] as const;

async function count(q: PromiseLike<{ n: string | number }[]>): Promise<number> {
  return Number((await q)[0]?.n ?? 0);
}

export const pharmacyMergeHooks: ItemMergeHooks = {
  async blockers(db: Db | Tx, _a: ItemRow, b: ItemRow): Promise<MergeRefusal[]> {
    const open = await db.selectDistinct({ id: pharmacyDispenses.id, no: pharmacyDispenses.dispenseNo, status: pharmacyDispenses.status })
      .from(pharmacyDispenseLines).innerJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
      .where(and(eq(pharmacyDispenseLines.itemId, b.id), eq(pharmacyDispenseLines.status, "open"), inArray(pharmacyDispenses.status, [...OPEN_DISPENSE_STATUSES])))
      .limit(20);
    return open.map((d) => ({
      rule: "open_dispense" as const,
      message: `dispense ${d.no ?? "(not yet claimed)"} is ${d.status} with a line on it — hand it over or cancel it first`,
      ref: d.no ?? d.id,
    }));
  },

  async preview(db: Db | Tx, a: ItemRow, b: ItemRow): Promise<{ moves: MergeTally[]; stays: MergeTally[] }> {
    const sale = await db.select().from(pharmacySaleItems).where(inArray(pharmacySaleItems.itemId, [a.id, b.id]));
    const aSale = sale.find((s) => s.itemId === a.id);
    const bSale = sale.find((s) => s.itemId === b.id);
    const shelf = await db.select().from(pharmacyShelfLocations).where(inArray(pharmacyShelfLocations.itemId, [a.id, b.id]));
    const shelfMove = shelf.filter((x) => x.itemId === b.id && !shelf.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId));
    const shelfKept = shelf.filter((x) => x.itemId === b.id && shelf.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId));
    const short = await db.select().from(pharmacyShortBook).where(and(inArray(pharmacyShortBook.itemId, [a.id, b.id]), isNull(pharmacyShortBook.resolvedAt)));
    const shortMove = short.filter((x) => x.itemId === b.id && !short.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId));
    const shortClose = short.filter((x) => x.itemId === b.id && short.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId));
    const moves: MergeTally[] = [
      { key: bSale === undefined ? "saleItemNone" : aSale === undefined ? "saleItemRegistered" : "saleItemRetired", count: bSale === undefined ? 0 : 1, detail: [] },
      { key: "shelf", count: shelfMove.length, detail: shelfMove.map((x) => x.location) },
      { key: "shelfKept", count: shelfKept.length, detail: shelfKept.map((x) => x.location) },
      { key: "shortBook", count: shortMove.length, detail: [] },
      { key: "shortBookClosed", count: shortClose.length, detail: [] },
    ];
    const stays: MergeTally[] = [
      { key: "dispenseLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.itemId, b.id))), detail: [] },
      { key: "retailLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.itemId, b.id))), detail: [] },
      { key: "controlledRegister", count: await count(db.select({ n: sql<string>`count(*)` }).from(controlledStockRegister).where(eq(controlledStockRegister.itemId, b.id))), detail: [] },
    ];
    return { moves, stays };
  },

  async move(tx: Tx, actor: Actor, a: ItemRow, b: ItemRow, now: Date): Promise<Record<string, number>> {
    const out = { saleItemRetired: 0, saleItemRegistered: 0, shelfMoved: 0, shelfDropped: 0, shortBookMoved: 0, shortBookClosed: 0 };
    // The sale registration: B's retired; A registered for sale only when it never was and B was.
    const sale = await tx.select().from(pharmacySaleItems).where(inArray(pharmacySaleItems.itemId, [a.id, b.id]));
    const aSale = sale.find((s) => s.itemId === a.id);
    const bSale = sale.find((s) => s.itemId === b.id);
    if (bSale !== undefined) {
      if (aSale === undefined) {
        await registerSaleItem(tx, actor, a.id);
        if (!bSale.active) await setSaleItemActive(tx, actor, a.id, false);
        out.saleItemRegistered = 1;
      }
      if (bSale.active) await setSaleItemActive(tx, actor, b.id, false);
      out.saleItemRetired = 1;
    }
    // Shelf labels: A's own wins where both have one.
    const shelf = await tx.select().from(pharmacyShelfLocations).where(inArray(pharmacyShelfLocations.itemId, [a.id, b.id]));
    for (const x of shelf.filter((r) => r.itemId === b.id)) {
      if (shelf.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId)) {
        await tx.delete(pharmacyShelfLocations).where(eq(pharmacyShelfLocations.id, x.id));
        out.shelfDropped += 1;
      } else {
        await tx.update(pharmacyShelfLocations).set({ itemId: a.id, setBy: actor.id, setAt: now }).where(eq(pharmacyShelfLocations.id, x.id));
        out.shelfMoved += 1;
      }
    }
    // Open short-book rows: A's own open row wins at a store; otherwise B's row is A's, named as A is.
    const short = await tx.select().from(pharmacyShortBook).where(and(inArray(pharmacyShortBook.itemId, [a.id, b.id]), isNull(pharmacyShortBook.resolvedAt)));
    for (const x of short.filter((r) => r.itemId === b.id)) {
      if (short.some((y) => y.itemId === a.id && y.storeResourceId === x.storeResourceId)) {
        await tx.update(pharmacyShortBook).set({ resolvedAt: now, resolvedBy: actor.id, resolution: "dismissed" }).where(eq(pharmacyShortBook.id, x.id));
        await appendEvent(tx, shortBookResolved.make({
          occurredAt: now, actor, correlationId: x.id, payload: { entryId: x.id, storeResourceId: x.storeResourceId, resolution: "dismissed" },
        }));
        out.shortBookClosed += 1;
      } else {
        await tx.update(pharmacyShortBook).set({ itemId: a.id, drugName: a.name.slice(0, 120) }).where(eq(pharmacyShortBook.id, x.id));
        out.shortBookMoved += 1;
      }
    }
    return out;
  },
};

// ═══════════════════════════════════ the office's side ═══════════════════════════════════

export type OfficeItems = {
  /** The agent's draft: pairs that look like one item twice. Nothing is raised until a person opens one. */
  duplicates: DuplicateSuggestion[];
  scanned: number;
  /** Raised, waiting on the medical superintendent. */
  awaitingApproval: ItemMergeSummary[];
  /** Approved: ready to merge. */
  readyToMerge: ItemMergeSummary[];
  /** The last merges carried out or refused. */
  recent: ItemMergeSummary[];
};

/** `/pharmacy/office?view=items` — the duplicates the agent found and the merges in flight. */
export async function officeItems(db: Db, actor: Actor): Promise<OfficeItems> {
  const { suggestions, scanned } = await findDuplicateItems(db, actor);
  const requested = await listItemMerges(db, actor, { statuses: ["requested"] });
  const done = await listItemMerges(db, actor, { statuses: ["merged", "refused"], limit: 20 });
  return {
    duplicates: suggestions, scanned,
    awaitingApproval: requested.filter((m) => m.approvalStatus === "pending"),
    readyToMerge: requested.filter((m) => m.approvalStatus === "granted"),
    recent: done,
  };
}

export async function officeMergePreview(db: Db, actor: Actor, survivorItemId: string, mergedItemId: string): Promise<MergePreview> {
  return itemMergePreview(db, actor, survivorItemId, mergedItemId, pharmacyMergeHooks);
}

export async function officeRaiseMerge(
  db: Db, actor: Actor, input: { survivorItemId: string; mergedItemId: string; reason: string; source?: "agent" | "manual" }, now: Date = new Date(),
): Promise<ItemMergeView> {
  return raiseItemMerge(db, actor, input, pharmacyMergeHooks, now);
}

export async function officeExecuteMerge(db: Db, actor: Actor, mergeId: string, now: Date = new Date()): Promise<ItemMergeView> {
  return executeItemMerge(db, actor, mergeId, pharmacyMergeHooks, now);
}

export async function officeGetMerge(db: Db, actor: Actor, mergeId: string): Promise<ItemMergeView> {
  return getItemMerge(db, actor, mergeId);
}
