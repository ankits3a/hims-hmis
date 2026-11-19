import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  episodeSeries, items, resources, roleAssignments, storesBuyGroupMoves, storesPurchaseRequestLines, storesPurchaseRequestStamps, storesPurchaseRequests,
  storesRfqSteps, users, vendors,
} from "../../kernel/db/schema";
import { lineGstPaise, netRatePaise } from "../materials";
import { StoresError } from "./errors";
import { supplierKyc } from "./suppliers";
import type { Actor, StoresPerson } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5b (#1115) — THE PIECES THE BUYING DESK'S FILES SHARE: a request line's current group (the newest move row),
 * the money of a quote line (the PO's own rounding: net rate per unit half up, GST half up per line, so a PO made from
 * an award prices to the paisa what the comparative showed), the RFQ's effective reply-by, the hospital's central
 * store, numbers from `episode_series`, names. No act is written here.
 */
export type Exec = Db | Tx;
export const ex = (e: Exec): Db => e as Db;
export const clean = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());
export const lineKey = (prId: string, lineIdx: number): string => `${prId}:${String(lineIdx)}`;

/** One quote (or award) line's money, the way materials prices a PO line. */
export function lineMoney(qtyBase: number, ratePaise: number, discountBps: number, gstRateBps: number): {
  grossPaise: number; netUnitPaise: number; taxablePaise: number; discountPaise: number; gstPaise: number;
} {
  const netUnitPaise = discountBps === 0 ? ratePaise : netRatePaise(ratePaise, discountBps);
  const grossPaise = qtyBase * ratePaise;
  const taxablePaise = qtyBase * netUnitPaise;
  return { grossPaise, netUnitPaise, taxablePaise, discountPaise: grossPaise - taxablePaise, gstPaise: lineGstPaise(taxablePaise, gstRateBps) };
}

/** Spread `amount` over `weights` by value, the remainder paisa to the largest shares first; sums to `amount` exactly. */
export function apportion(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  if (amount === 0 || weights.length === 0) return weights.map(() => 0);
  if (total === 0) return weights.map((_, i) => (i === 0 ? amount : 0));
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map((r) => Math.floor(r));
  let left = amount - out.reduce((a, v) => a + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; out[o.i]! += 1; left -= 1; }
  return out;
}

/** `RFQ` + yymmdd + 4 digits from `episode_series` (no kernel series entry), as S5a's `MPR`. */
export async function nextNo(tx: Tx, key: string, prefix: string, now: Date): Promise<string> {
  const day = istDayString(now);
  await ex(tx).insert(episodeSeries).values({ seriesKey: key, serviceDate: day, nextNo: 1 }).onConflictDoNothing();
  const rows = await ex(tx).update(episodeSeries).set({ nextNo: sql`${episodeSeries.nextNo} + 1` })
    .where(and(eq(episodeSeries.seriesKey, key), eq(episodeSeries.serviceDate, day))).returning({ n: episodeSeries.nextNo });
  return `${prefix}${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${String(rows[0]!.n - 1).padStart(4, "0")}`;
}

/** The newest move per request line: which group it sits in now (absent or null = in none). */
export async function membership(db: Exec, prIds?: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await ex(db).select().from(storesBuyGroupMoves)
    .where(prIds === undefined ? undefined : prIds.length === 0 ? sql`false` : inArray(storesBuyGroupMoves.prId, [...prIds]))
    .orderBy(asc(storesBuyGroupMoves.at), asc(storesBuyGroupMoves.id));
  const out = new Map<string, string | null>();
  for (const r of rows) out.set(lineKey(r.prId, r.lineIdx), r.groupId);
  return out;
}

export type GroupLine = {
  prId: string; prNo: string; lineIdx: number; itemId: string; itemName: string; baseUom: string; categoryId: string | null; qtyBase: number;
  unitEstimatePaise: number; onContract: boolean; equipment: boolean; source: string; departmentId: string | null; shelfId: string | null;
  priority: string; raisedBy: string; raisedAt: Date;
};

/** The request lines that sit in `groupId` now. */
export async function groupLines(db: Exec, groupId: string): Promise<GroupLine[]> {
  const prIds = (await ex(db).selectDistinct({ prId: storesBuyGroupMoves.prId }).from(storesBuyGroupMoves).where(eq(storesBuyGroupMoves.groupId, groupId))).map((r) => r.prId);
  if (prIds.length === 0) return [];
  const where = await membership(db, prIds);
  const rows = await ex(db).select({ l: storesPurchaseRequestLines, pr: storesPurchaseRequests, name: items.name, baseUom: items.baseUom })
    .from(storesPurchaseRequestLines).innerJoin(storesPurchaseRequests, eq(storesPurchaseRequests.id, storesPurchaseRequestLines.prId))
    .innerJoin(items, eq(items.id, storesPurchaseRequestLines.itemId))
    .where(inArray(storesPurchaseRequestLines.prId, prIds)).orderBy(asc(storesPurchaseRequests.raisedAt), asc(storesPurchaseRequestLines.lineIdx));
  return rows.filter((r) => where.get(lineKey(r.l.prId, r.l.lineIdx)) === groupId).map(({ l, pr, name, baseUom }) => ({
    prId: pr.id, prNo: pr.prNo, lineIdx: l.lineIdx, itemId: l.itemId, itemName: name, baseUom, categoryId: l.categoryId, qtyBase: l.qtyBase,
    unitEstimatePaise: l.unitEstimatePaise, onContract: l.onContract, equipment: l.equipment, source: pr.source, departmentId: pr.departmentId,
    shelfId: pr.shelfId, priority: pr.priority, raisedBy: pr.raisedBy, raisedAt: pr.raisedAt,
  }));
}

/** A group's lines summed by item, in first-seen order: what an RFQ asks for. */
export function byItem(lines: readonly GroupLine[]): { itemId: string; itemName: string; baseUom: string; categoryId: string | null; qtyBase: number; equipment: boolean }[] {
  const out = new Map<string, { itemId: string; itemName: string; baseUom: string; categoryId: string | null; qtyBase: number; equipment: boolean }>();
  for (const l of lines) {
    const cur = out.get(l.itemId);
    if (cur === undefined) out.set(l.itemId, { itemId: l.itemId, itemName: l.itemName, baseUom: l.baseUom, categoryId: l.categoryId, qtyBase: l.qtyBase, equipment: l.equipment });
    else { cur.qtyBase += l.qtyBase; cur.equipment ||= l.equipment; }
  }
  return [...out.values()];
}

/** Is the request approved (its one stamp)? */
export async function approvedPrIds(db: Exec, prIds: readonly string[]): Promise<Set<string>> {
  if (prIds.length === 0) return new Set();
  const rows = await ex(db).select({ prId: storesPurchaseRequestStamps.prId }).from(storesPurchaseRequestStamps)
    .where(and(inArray(storesPurchaseRequestStamps.prId, [...prIds]), eq(storesPurchaseRequestStamps.kind, "approved")));
  return new Set(rows.map((r) => r.prId));
}

/** The RFQ's reply-by now: the moved one when it was moved, else its own. Closed = a `closed` step. */
export async function rfqClock(db: Exec, rfq: { id: string; replyBy: Date }): Promise<{ replyBy: Date; moved: boolean; closed: boolean; sentTo: Set<string>; sent: typeof storesRfqSteps.$inferSelect | null }> {
  const steps = await ex(db).select().from(storesRfqSteps).where(eq(storesRfqSteps.rfqId, rfq.id)).orderBy(asc(storesRfqSteps.at), asc(storesRfqSteps.id));
  const move = steps.find((s) => s.kind === "reply_by_moved");
  const sends = steps.filter((s) => s.kind === "sent");
  return {
    replyBy: move?.replyBy ?? rfq.replyBy, moved: move !== undefined, closed: steps.some((s) => s.kind === "closed"),
    sentTo: new Set(sends.flatMap((s) => s.vendorIds ?? [])), sent: sends[0] ?? null,
  };
}

/** The Stores central store (`GEN-MAIN` when there are several): where an RFQ's goods are delivered and its PO received. */
export async function centralStoreId(db: Exec): Promise<string> {
  const rows = await ex(db).select({ id: resources.id, code: resources.code }).from(resources)
    .where(and(eq(resources.kind, "store"), sql`${resources.attributes}->>'domain' = 'stores'`, sql`${resources.attributes}->>'kind' = 'central'`))
    .orderBy(asc(resources.code));
  const pick = rows.find((r) => r.code === "GEN-MAIN") ?? rows[0];
  if (pick === undefined) throw new StoresError("unknown_store", "no Stores central store");
  return pick.id;
}

export async function holdsRole(db: Exec, actor: Actor, roleKey: string): Promise<boolean> {
  if (actor.type !== "user") return false;
  const [r] = await ex(db).select({ u: roleAssignments.userId }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, roleKey))).limit(1);
  return r !== undefined;
}

export async function usersWithRole(db: Exec, roleKey: string): Promise<string[]> {
  const rows = await ex(db).selectDistinct({ u: roleAssignments.userId }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAssignments.roleKey, roleKey), eq(users.active, true)));
  return rows.map((r) => r.u).sort();
}

export async function peopleNamed(db: Exec, ids: readonly (string | null)[]): Promise<(id: string) => StoresPerson> {
  const want = [...new Set(ids.filter((x): x is string => x !== null))];
  const names = new Map(want.length === 0 ? [] : (await ex(db).select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, want))).map((u) => [u.id, u.n] as const));
  return (id) => ({ id, name: names.get(id) ?? id });
}

export async function vendorNames(db: Exec, ids: readonly string[]): Promise<Map<string, { name: string; code: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await ex(db).select({ id: vendors.id, code: vendors.code, legal: vendors.legalName, trade: vendors.tradeName }).from(vendors).where(inArray(vendors.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { name: r.trade ?? r.legal, code: r.code }] as const));
}

/** Decision 12: "can quote" to be invited; refused with what is missing. */
export async function requireCanQuote(db: Exec, vendorId: string, now: Date): Promise<void> {
  const k = await supplierKyc(db, vendorId, now);
  if (k.level === "none") throw new StoresError("cannot_quote", "this supplier cannot quote yet", { vendorId, missing: k.missing });
}

/** Decision 12: "KYC complete" for an award and a Stores PO, for every category it supplies here. */
export async function requireKycComplete(db: Exec, vendorId: string, categoryIds: readonly (string | null)[], now: Date): Promise<void> {
  const cats = [...new Set(categoryIds)];
  for (const categoryId of cats.length === 0 ? [null] : cats) {
    const k = await supplierKyc(db, vendorId, now, { categoryId });
    if (k.level !== "complete") throw new StoresError("kyc_incomplete", `KYC incomplete: ${k.missing.join(", ")}`, { vendorId, missing: k.missing });
  }
}

/** The newest version of each supplier's quote for a group (or an RFQ). */
export function latestByVendor<T extends { vendorId: string; version: number }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) { const cur = out.get(r.vendorId); if (cur === undefined || r.version > cur.version) out.set(r.vendorId, r); }
  return out;
}

