import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { stockBatches, stockLedger } from "../../kernel/db/schema";
import { postMovements, requireStore } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — ADDITIVE: the opening balance of a store, counted on day one.
 *
 * Pharmacy opened its counter through a GRN against a pseudo-supplier (`opening-stock.ts`), because a
 * medicine's batch, expiry and MRP matter from the first sale. A Stores opening count is a different
 * thing: the dustbins and the toner already on the shelf, with no supplier and often no rate. So each
 * line becomes ONE batch, numbered `OPEN-<store code>` (unique per item, so one store's opening never
 * collides with another's), at the rate the caller states or at 0 marked `estimated_cost` (ruling 0093's
 * flag), and ONE `adjust` row into the store with `ref_type = 'opening_balance'`. No cost centre: an
 * opening count charges nobody.
 *
 * THE CALLER checks, under the store's row lock (`FOR UPDATE` on the resource), that the store has no
 * opening yet (`hasOpeningBalance`), that each quantity is a positive whole number and that no item is
 * counted twice (two lines of one item would collide on the batch number). This function only writes.
 */
export const OPENING_BALANCE_REF_TYPE = "opening_balance";

export type OpeningLine = { itemId: string; qtyBase: number; unitCostPaise?: number | null; expiryDate?: string | null };

export async function hasOpeningBalance(db: Db | Tx, resourceId: string): Promise<boolean> {
  const rows = await db.select({ id: stockLedger.id }).from(stockLedger)
    .where(and(eq(stockLedger.resourceId, resourceId), eq(stockLedger.refType, OPENING_BALANCE_REF_TYPE))).limit(1);
  return rows.length > 0;
}

export async function postOpeningBalances(
  tx: Tx,
  actor: Actor,
  input: { resourceId: string; refId: string; occurredAt: Date; lines: readonly OpeningLine[] },
): Promise<{ ledgerEntryIds: string[]; batchIds: string[] }> {
  const store = await requireStore(tx, input.resourceId);
  const batchIds: string[] = [];
  for (const l of input.lines) {
    const batchId = newId();
    const cost = l.unitCostPaise ?? null;
    await tx.insert(stockBatches).values({
      id: batchId, itemId: l.itemId, batchNo: `OPEN-${store.code}`, expiryDate: l.expiryDate ?? null,
      landedCostPaise: cost ?? 0, estimatedCost: cost === null, ownership: "owned", createdBy: actor.id,
    });
    batchIds.push(batchId);
  }
  const posted = await postMovements(tx, actor, input.lines.map((l, i) => ({
    resourceId: store.id, batchId: batchIds[i]!, qtyDelta: l.qtyBase, reason: "adjust" as const,
    refType: OPENING_BALANCE_REF_TYPE, refId: input.refId, occurredAt: input.occurredAt,
  })));
  return { ledgerEntryIds: posted.map((p) => p.ledgerEntryId), batchIds };
}
