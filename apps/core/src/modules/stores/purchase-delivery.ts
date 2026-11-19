import { asc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { grnLines, grns, purchaseOrders, storesAwards, storesPrDeliveries } from "../../kernel/db/schema";
import { groupLines } from "./buying-common";
import { raiseDeliveryTicketInTx } from "./tickets";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, decision 10, flow 11) — THE DELIVERY TO THE REQUESTER, RAISED FROM THE REQUEST.
 *
 * When a GRN against a PO made from an award is posted (its QC passed: only ACCEPTED quantity counts), the accepted
 * quantity of each item is shared over the group's DEPARTMENT request lines of that item, oldest request first, up to
 * what each line still lacks (its quantity less what was already ticketed: `stores_pr_deliveries`). Each request gets
 * one S2 ticket for its shelf with those lines, in the post's own transaction, riding on the request's HOD approval (no
 * second stamp), and its requester one "In store / स्टोर में आ गया" notice. A central request's lines are the store's
 * own stock: they take their share and raise no ticket. A second GRN tickets only what is still owed.
 */
export const IN_STORE = ["In store", "स्टोर में आ गया"] as const;

export async function raiseDeliveriesForGrn(tx: Tx, actor: Actor, grnId: string, now: Date): Promise<string[]> {
  const [g] = await tx.select({ poId: grns.purchaseOrderId }).from(grns).where(eq(grns.id, grnId));
  if (g?.poId == null) return [];
  const [po] = await tx.select({ awardId: purchaseOrders.awardId }).from(purchaseOrders).where(eq(purchaseOrders.id, g.poId));
  if (po?.awardId == null) return [];
  const [award] = await tx.select({ groupId: storesAwards.groupId }).from(storesAwards).where(eq(storesAwards.id, po.awardId));
  if (award === undefined) return [];
  const accepted = new Map<string, number>();
  for (const l of await tx.select({ itemId: grnLines.itemId, qty: grnLines.qtyAcceptedBase }).from(grnLines).where(eq(grnLines.grnId, grnId))) {
    accepted.set(l.itemId, (accepted.get(l.itemId) ?? 0) + l.qty);
  }
  const lines = (await groupLines(tx, award.groupId)).sort((a, b) => Number(a.source !== "department") - Number(b.source !== "department") || a.raisedAt.getTime() - b.raisedAt.getTime());
  const prIds = [...new Set(lines.map((l) => l.prId))];
  const done = prIds.length === 0 ? [] : await tx.select().from(storesPrDeliveries).where(inArray(storesPrDeliveries.prId, prIds));
  const share = new Map<string, { line: (typeof lines)[number]; qty: number }[]>();
  for (const l of lines) {
    const left = accepted.get(l.itemId) ?? 0;
    if (left <= 0) continue;
    const owed = l.qtyBase - done.filter((d) => d.prId === l.prId && d.lineIdx === l.lineIdx).reduce((a, d) => a + d.qtyBase, 0);
    const take = Math.min(left, owed);
    if (take <= 0) continue;
    accepted.set(l.itemId, left - take);
    if (l.source !== "department" || l.shelfId === null) continue;
    share.set(l.prId, [...(share.get(l.prId) ?? []), { line: l, qty: take }]);
  }
  const tickets: string[] = [];
  for (const [prId, parts] of share) {
    const first = parts[0]!.line;
    const priority = first.priority === "emergency" ? "emergency" : first.priority === "urgent" ? "urgent" : "routine";
    const t = await raiseDeliveryTicketInTx(tx, actor, {
      shelfId: first.shelfId!, priority, prId, prNo: first.prNo, lines: parts.map((p) => ({ itemId: p.line.itemId, qtyBase: p.qty })),
    }, now);
    await tx.insert(storesPrDeliveries).values(parts.map((p) => ({ id: newId(), prId, lineIdx: p.line.lineIdx, grnId, indentId: t.id, qtyBase: p.qty, at: now })));
    await raiseNotice(tx as unknown as Db, {
      userId: first.raisedBy, kind: "stores.purchase", title: IN_STORE[0], body: `${IN_STORE[1]} · ${first.prNo}`,
      refType: "store_indent", refId: t.id, sourceKey: `stores-pr:${prId}:in-store:${grnId}`, at: now,
    });
    tickets.push(t.id);
  }
  return tickets;
}

/** The delivery tickets raised from a request, oldest first. */
export async function purchaseDeliveries(db: Db | Tx, prId: string): Promise<{ lineIdx: number; qtyBase: number; indentId: string; grnId: string; at: string }[]> {
  const rows = await (db as Db).select().from(storesPrDeliveries).where(eq(storesPrDeliveries.prId, prId)).orderBy(asc(storesPrDeliveries.at), asc(storesPrDeliveries.id));
  return rows.map((r) => ({ lineIdx: r.lineIdx, qtyBase: r.qtyBase, indentId: r.indentId, grnId: r.grnId, at: r.at.toISOString() }));
}
