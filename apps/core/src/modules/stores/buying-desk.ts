import { desc, eq, isNotNull } from "drizzle-orm";
import { purchaseOrders, vendors } from "../../kernel/db/schema";
import { STORES_AWARD_SIGN, STORES_BUYING_MANAGE, holds } from "./access";
import { listAwards } from "./awards";
import { buyGroups, buyNow, groupableRequests } from "./buy-groups";
import { holdsRole } from "./buying-common";
import { listRfqs } from "./rfq";
import type { WireBuyingDesk, WireStoresPoRow } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, spec "Buying desk") — THE DESK'S ONE READ: Buy now, the lines still to group, the groups, the RFQs,
 * the awards and the POs made from awards. A reader who is not the buyer (a committee member, the owner) gets only the
 * awards waiting for them; the phone sheet opens one award or PO by its id.
 */
export async function buyingDesk(db: Db, actor: Actor, now: Date = new Date()): Promise<WireBuyingDesk> {
  const buy = await holds(db, actor, STORES_BUYING_MANAGE);
  const can = { buy, approveAward: await holds(db, actor, STORES_AWARD_SIGN), owner: await holdsRole(db, actor, "owner") };
  const awards = await listAwards(db, actor, now);
  if (!buy) return { can, buyNow: [], groupable: [], groups: [], rfqs: [], awards, pos: [] };
  const rows = await db.select({ po: purchaseOrders, legal: vendors.legalName, trade: vendors.tradeName }).from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId)).where(isNotNull(purchaseOrders.awardId)).orderBy(desc(purchaseOrders.createdAt)).limit(100);
  const pos: WireStoresPoRow[] = rows.map(({ po, legal, trade }) => ({
    id: po.id, poNo: po.poNo, status: po.status, vendorName: trade ?? legal, totalPaise: po.totalPaise, tier: po.approvalTier as "head" | "owner" | null,
    awardId: po.awardId, createdAt: po.createdAt.toISOString(),
  }));
  return {
    can, buyNow: await buyNow(db, actor, now), groupable: await groupableRequests(db, actor, now), groups: await buyGroups(db, actor, now),
    rfqs: await listRfqs(db, actor, now), awards, pos,
  };
}
