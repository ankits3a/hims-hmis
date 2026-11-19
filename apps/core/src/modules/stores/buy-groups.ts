import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  items, orgDepartments, purchaseOrders, storesAwards, storesAwardSignatures, storesBuyGroupMoves, storesBuyGroups, storesPurchaseRequestLines,
  storesPurchaseRequestStamps, storesPurchaseRequests, storesQuotes, storesRfqs,
} from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, holds, recordAct } from "./access";
import { bandFor, bandOf, higherBand } from "./bands";
import { approvedPrIds, ex, groupLines, lineKey, membership } from "./buying-common";
import { StoresError } from "./errors";
import type { GroupLine } from "./buying-common";
import type { StoresBand, StoresBuyStage, WireBuyGroup, WireBuyLine, WireBuyRow } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, flow 4; decision 5 by hand) — BUY NOW AND THE BUYER'S OWN GROUPS.
 *
 * "Buy now / अभी खरीदें" is a READ: every approved urgent or emergency request not yet on an order, the moment its stamp is
 * written (no job, no queue). A group is the buyer's: approved request lines put together (by category, by likely
 * supplier), one `stores_buy_groups` row and a move row per line; a line moved out or across is a new move row. The
 * group's band is the highest of its requests' bands (each with S5a's 30-day split check and any band the buyer lifted)
 * and of its own sum (equipment = C); it is recomputed on every read until an RFQ freezes it, and a group with an RFQ or
 * an award is locked (`group_locked`). S5c's agent drafts the same groups at night; nothing here waits for it.
 */
type GroupRow = typeof storesBuyGroups.$inferSelect;
const LIST_LIMIT = 200;

async function requireBuyer(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "the buying desk is the buyer's", { permission: STORES_BUYING_MANAGE });
}

export async function requireGroup(db: Db | Tx, groupId: string): Promise<GroupRow> {
  const [g] = await ex(db).select().from(storesBuyGroups).where(eq(storesBuyGroups.id, groupId));
  if (g === undefined) throw new StoresError("unknown_group", `group ${groupId} not found`, { groupId });
  return g;
}

/** A group with an RFQ or an award is locked: its band is frozen and its lines stay. */
async function lockedBy(db: Db | Tx, groupId: string): Promise<boolean> {
  const [r] = await ex(db).select({ id: storesRfqs.id }).from(storesRfqs).where(eq(storesRfqs.groupId, groupId)).limit(1);
  if (r !== undefined) return true;
  const [a] = await ex(db).select({ id: storesAwards.id }).from(storesAwards).where(eq(storesAwards.groupId, groupId)).limit(1);
  return a !== undefined;
}

/** The band of a set of request lines: the highest of their requests' bands and of their own sum (decisions 2, 3). */
export async function bandOfLines(db: Db | Tx, lines: readonly GroupLine[], now: Date): Promise<{ band: StoresBand; split: boolean }> {
  let band: StoresBand = bandFor(lines.filter((l) => !l.onContract).reduce((a, l) => a + l.qtyBase * l.unitEstimatePaise, 0), { equipment: lines.some((l) => l.equipment) });
  let split = false;
  const prIds = [...new Set(lines.map((l) => l.prId))];
  if (prIds.length === 0) return { band: "A", split };
  const prs = await ex(db).select().from(storesPurchaseRequests).where(inArray(storesPurchaseRequests.id, prIds));
  const all = await ex(db).select().from(storesPurchaseRequestLines).where(inArray(storesPurchaseRequestLines.prId, prIds));
  for (const pr of prs) {
    const b = await bandOf(db, pr, all.filter((l) => l.prId === pr.id), now);
    band = higherBand(band, b.band);
    if (b.split !== null) split = true;
  }
  return { band, split };
}

export async function groupRequests(db: Db, actor: Actor, input: { lines: { prId: string; lineIdx: number }[]; label?: string | null }, now: Date = new Date()): Promise<WireBuyGroup> {
  await requireBuyer(db, actor);
  if (input.lines.length === 0) throw new StoresError("item_required", "a group takes at least one request line");
  const prIds = [...new Set(input.lines.map((l) => l.prId))];
  const ok = await approvedPrIds(db, prIds);
  const rows = await db.select({ prId: storesPurchaseRequestLines.prId, lineIdx: storesPurchaseRequestLines.lineIdx }).from(storesPurchaseRequestLines)
    .where(inArray(storesPurchaseRequestLines.prId, prIds));
  const exists = new Set(rows.map((r) => lineKey(r.prId, r.lineIdx)));
  const where = await membership(db, prIds);
  for (const l of input.lines) {
    if (!exists.has(lineKey(l.prId, l.lineIdx))) throw new StoresError("unknown_purchase_request", "no such request line", l);
    if (!ok.has(l.prId)) throw new StoresError("line_not_approved", "only an approved request is bought", { prId: l.prId });
    if ((where.get(lineKey(l.prId, l.lineIdx)) ?? null) !== null) throw new StoresError("group_locked", "this line is already in a group", l);
  }
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesBuyGroups).values({ id, label: input.label?.trim() || null, createdBy: actor.id, createdAt: now });
    await tx.insert(storesBuyGroupMoves).values(input.lines.map((l) => ({ id: newId(), prId: l.prId, lineIdx: l.lineIdx, groupId: id, by: actor.id, at: now })));
    await recordAct(tx, actor, now, { act: "group_requests", refId: id, after: { prIds }, lines: input.lines.map((l) => ({ prId: l.prId, lineIdx: l.lineIdx })) });
  });
  return getBuyGroup(db, id, now);
}

/** Move one line into another group, or out of every group (`toGroupId` null). Neither group may be locked. */
export async function moveGroupLine(
  db: Db, actor: Actor, input: { prId: string; lineIdx: number; toGroupId: string | null }, now: Date = new Date(),
): Promise<{ from: WireBuyGroup | null; to: WireBuyGroup | null }> {
  await requireBuyer(db, actor);
  const from = (await membership(db, [input.prId])).get(lineKey(input.prId, input.lineIdx)) ?? null;
  if (from === null && input.toGroupId === null) throw new StoresError("not_in_group", "this line is in no group");
  if (from !== null && from === input.toGroupId) return { from: await getBuyGroup(db, from, now), to: await getBuyGroup(db, from, now) };
  if (from !== null && (await lockedBy(db, from))) throw new StoresError("group_locked", "this group has an RFQ or an award", { groupId: from });
  if (input.toGroupId !== null) {
    await requireGroup(db, input.toGroupId);
    if (await lockedBy(db, input.toGroupId)) throw new StoresError("group_locked", "that group has an RFQ or an award", { groupId: input.toGroupId });
    if (!(await approvedPrIds(db, [input.prId])).has(input.prId)) throw new StoresError("line_not_approved", "only an approved request is bought");
  }
  await withTx(db, async (tx) => {
    await tx.insert(storesBuyGroupMoves).values({ id: newId(), prId: input.prId, lineIdx: input.lineIdx, groupId: input.toGroupId, by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "move_group_line", refId: input.toGroupId ?? from, before: from, after: input.toGroupId, lines: [{ prId: input.prId, lineIdx: input.lineIdx }] });
  });
  return { from: from === null ? null : await getBuyGroup(db, from, now), to: input.toGroupId === null ? null : await getBuyGroup(db, input.toGroupId, now) };
}

const wireLine = (l: GroupLine, groupId: string | null): WireBuyLine => ({
  prId: l.prId, lineIdx: l.lineIdx, itemId: l.itemId, itemName: l.itemName, qtyBase: l.qtyBase, baseUom: l.baseUom,
  estimatePaise: l.qtyBase * l.unitEstimatePaise, groupId,
});

/** Where a group stands, in the desk's words (derived). */
async function groupStage(db: Db | Tx, groupId: string): Promise<{ stage: StoresBuyStage; rfqId: string | null; awardId: string | null; quotes: number; band: StoresBand | null }> {
  const [rfq] = await ex(db).select().from(storesRfqs).where(eq(storesRfqs.groupId, groupId)).orderBy(desc(storesRfqs.createdAt)).limit(1);
  const quotes = (await ex(db).selectDistinct({ v: storesQuotes.vendorId }).from(storesQuotes).where(eq(storesQuotes.groupId, groupId))).length;
  const awards = await ex(db).select().from(storesAwards).where(eq(storesAwards.groupId, groupId)).orderBy(desc(storesAwards.proposedAt));
  const sigs = awards.length === 0 ? [] : await ex(db).select().from(storesAwardSignatures).where(inArray(storesAwardSignatures.awardId, awards.map((a) => a.id)));
  const live = awards.find((a) => !sigs.some((s) => s.awardId === a.id && s.kind === "object")) ?? null;
  if (live !== null) {
    const pos = await ex(db).select({ status: purchaseOrders.status }).from(purchaseOrders).where(and(eq(purchaseOrders.awardId, live.id), ne(purchaseOrders.status, "cancelled")));
    const stage: StoresBuyStage = pos.length > 0 && pos.every((p) => p.status === "received") ? "received"
      : pos.some((p) => ["sent", "part_received", "received"].includes(p.status)) ? "ordered" : "awarded";
    return { stage, rfqId: rfq?.id ?? null, awardId: live.id, quotes, band: (rfq?.band as StoresBand | undefined) ?? (live.band as StoresBand) };
  }
  if (rfq !== undefined) return { stage: quotes > 0 ? "compared" : "quoting", rfqId: rfq.id, awardId: null, quotes, band: rfq.band as StoresBand };
  return { stage: "grouped", rfqId: null, awardId: null, quotes, band: null };
}

export async function getBuyGroup(db: Db | Tx, groupId: string, now: Date = new Date()): Promise<WireBuyGroup> {
  const g = await requireGroup(db, groupId);
  const lines = await groupLines(db, groupId);
  const computed = await bandOfLines(db, lines, now);
  const st = await groupStage(db, groupId);
  return {
    id: g.id, label: g.label, band: st.band ?? computed.band, estimatePaise: lines.reduce((a, l) => a + l.qtyBase * l.unitEstimatePaise, 0),
    equipment: lines.some((l) => l.equipment), split: computed.split, status: st.stage, lines: lines.map((l) => wireLine(l, g.id)),
    rfqId: st.rfqId, awardId: st.awardId, quotes: st.quotes, createdAt: g.createdAt.toISOString(),
  };
}

export async function buyGroups(db: Db, actor: Actor, now: Date = new Date()): Promise<WireBuyGroup[]> {
  await requireBuyer(db, actor);
  const rows = await db.select().from(storesBuyGroups).orderBy(desc(storesBuyGroups.createdAt)).limit(LIST_LIMIT);
  const out: WireBuyGroup[] = [];
  for (const g of rows) {
    const v = await getBuyGroup(db, g.id, now);
    if (v.lines.length > 0 || v.awardId !== null) out.push(v);
  }
  return out;
}

/** Approved requests as desk rows: Buy now (urgent/emergency, not yet ordered) and the lines not yet in a group. */
async function approvedRows(db: Db, now: Date, filter: (pr: typeof storesPurchaseRequests.$inferSelect) => boolean): Promise<WireBuyRow[]> {
  const prs = (await db.select({ pr: storesPurchaseRequests }).from(storesPurchaseRequests)
    .innerJoin(storesPurchaseRequestStamps, and(eq(storesPurchaseRequestStamps.prId, storesPurchaseRequests.id), eq(storesPurchaseRequestStamps.kind, "approved")))
    .orderBy(asc(storesPurchaseRequests.raisedAt)).limit(LIST_LIMIT * 2)).map((r) => r.pr).filter(filter);
  if (prs.length === 0) return [];
  const ids = prs.map((p) => p.id);
  const lines = await db.select({ l: storesPurchaseRequestLines, name: items.name, baseUom: items.baseUom }).from(storesPurchaseRequestLines)
    .innerJoin(items, eq(items.id, storesPurchaseRequestLines.itemId)).where(inArray(storesPurchaseRequestLines.prId, ids)).orderBy(asc(storesPurchaseRequestLines.lineIdx));
  const where = await membership(db, ids);
  const deptIds = [...new Set(prs.map((p) => p.departmentId).filter((x): x is string => x !== null))];
  const depts = new Map(deptIds.length === 0 ? [] : (await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, deptIds))).map((d) => [d.id, d] as const));
  const out: WireBuyRow[] = [];
  for (const pr of prs) {
    const mine = lines.filter((x) => x.l.prId === pr.id);
    const groups = [...new Set(mine.map((x) => where.get(lineKey(pr.id, x.l.lineIdx)) ?? null))];
    const band = await bandOf(db, pr, mine.map((x) => x.l), now);
    let status: StoresBuyStage = "approved";
    const gid = groups.find((g): g is string => g !== null);
    if (gid !== undefined) status = (await groupStage(db, gid)).stage;
    out.push({
      prId: pr.id, prNo: pr.prNo, priority: pr.priority as WireBuyRow["priority"], department: pr.departmentId === null ? null : (depts.get(pr.departmentId) ?? null),
      band: band.band, estimatePaise: band.estimatePaise, status,
      lines: mine.map((x) => ({
        prId: pr.id, lineIdx: x.l.lineIdx, itemId: x.l.itemId, itemName: x.name, qtyBase: x.l.qtyBase, baseUom: x.baseUom,
        estimatePaise: x.l.qtyBase * x.l.unitEstimatePaise, groupId: where.get(lineKey(pr.id, x.l.lineIdx)) ?? null,
      })),
    });
  }
  return out;
}

/** Flow 3 / D8: urgent and emergency requests are on "Buy now" in the read after their approval, until ordered. */
export async function buyNow(db: Db, actor: Actor, now: Date = new Date()): Promise<WireBuyRow[]> {
  await requireBuyer(db, actor);
  const rows = await approvedRows(db, now, (pr) => pr.priority !== "routine");
  return rows.filter((r) => !["ordered", "received"].includes(r.status));
}

/** Approved request lines in no group yet (the Grouping tab's left side). */
export async function groupableRequests(db: Db, actor: Actor, now: Date = new Date()): Promise<WireBuyRow[]> {
  await requireBuyer(db, actor);
  const rows = await approvedRows(db, now, () => true);
  return rows.map((r) => ({ ...r, lines: r.lines.filter((l) => l.groupId === null) })).filter((r) => r.lines.length > 0);
}

/** The groups that hold a request's lines (the audit pack follows them). */
export async function groupsOfRequest(db: Db | Tx, prId: string): Promise<string[]> {
  const rows = await ex(db).selectDistinct({ g: storesBuyGroupMoves.groupId }).from(storesBuyGroupMoves)
    .where(and(eq(storesBuyGroupMoves.prId, prId), isNotNull(storesBuyGroupMoves.groupId)));
  return rows.map((r) => r.g!).filter((x) => x !== null);
}
