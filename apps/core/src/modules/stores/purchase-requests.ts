import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  episodeSeries, items, orgDepartments, roleAssignments, storesPrBandSettings, storesPurchaseRequestLines, storesPurchaseRequestStamps,
  storesPurchaseRequests, users,
} from "../../kernel/db/schema";
import { contractRatesFor, purchaseHistoryByItem } from "../materials";
import {
  STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, STORES_MASTERS, STORES_PURCHASE_REQUEST, departmentOf, holds, recordAct, requireShelf,
} from "./access";
import { categoryRules } from "./asset-rules";
import { bandFor, bandOf, higherBand } from "./bands";
import { budgetLineFor, warnBudget } from "./budgets";
import { delegationFor } from "./delegations";
import { StoresError } from "./errors";
import { requireStoresItem } from "./items";
import { approversToTell, holdersOf } from "./tickets";
import type { StoresBand, WirePurchaseRequest } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decisions 1–3, 11, 15) — THE PURCHASE REQUEST (`MPR` + yymmdd + 4 digits).
 *
 * A department asks to buy a non-stock or capital item (`stores.purchase.request` at the department; a stock item is
 * the store's to reorder: `stock_item`); the buyer raises the central store's shortfall (`stores.buying.manage`).
 * Every line names an `items` row (`item_required`; "Not in the list" is S1's new-item request) and carries an estimate
 * frozen at raise: the open rate contract, else the last paid receipt, else the requester's own figure for a new item.
 * A "Medical equipment" line (tag rule `always`) needs the three short answers.
 *
 * Approval: a department's request by the S2 rule — `stores.indents.approve` AT the department (the HOD), the medical
 * superintendent at hospital scope as stand-in, a delegate inside a live delegation (`delegations.ts`), never the
 * requester (`own_request`). The central store's by the materials head. The decision is one write-once stamp row; the
 * status is derived. Nothing is refused for budget: the stamp carries "over budget" (decision 15).
 *
 * Bulk (decision 11): the materials head and the owner approve several in one tap; each request gets its own stamp
 * and its own act, under each one's own rule. Every act appends one `stores.act_recorded` (refId = the request).
 */
export const PR_WORDS = {
  toApprove: ["Purchase to approve", "खरीद मंज़ूरी बाकी"],
  buyNow: ["Buy now", "अभी खरीदें"],
  approved: ["Approved", "मंज़ूर"],
  declined: ["Not approved", "मंज़ूर नहीं"],
} as const;
const NOTICE_KIND = "stores.purchase";
const LIST_LIMIT = 100;

export type PurchaseRequestLineInput = {
  itemId?: string | null; qtyBase: number; estimatePaise?: number | null;
  equipment?: { why: string; replacesTag?: string | null; usePerDay: string } | null;
};
export type RaisePurchaseRequestInput = {
  source: "department" | "central" | "planner"; departmentId?: string | null; shelfId?: string | null;
  priority?: "routine" | "urgent" | "emergency"; note?: string | null; lines: PurchaseRequestLineInput[];
};

type PrRow = typeof storesPurchaseRequests.$inferSelect;
type LineRow = typeof storesPurchaseRequestLines.$inferSelect;
type StampRow = typeof storesPurchaseRequestStamps.$inferSelect;

const clean = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

async function nextPrNo(tx: Tx, now: Date): Promise<string> {
  const day = istDayString(now);
  await (tx as unknown as Db).insert(episodeSeries).values({ seriesKey: "stores_purchase_request", serviceDate: day, nextNo: 1 }).onConflictDoNothing();
  const rows = await (tx as unknown as Db).update(episodeSeries).set({ nextNo: sql`${episodeSeries.nextNo} + 1` })
    .where(and(eq(episodeSeries.seriesKey, "stores_purchase_request"), eq(episodeSeries.serviceDate, day))).returning({ n: episodeSeries.nextNo });
  return `MPR${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${String(rows[0]!.n - 1).padStart(4, "0")}`;
}

/** A stock item: one the central (or a sub) store keeps at a par. A department never asks to buy it. */
async function isStockItem(db: Db | Tx, itemId: string): Promise<boolean> {
  const r = await (db as Db).execute(sql`select 1 from item_stock_levels l join resources r on r.id = l.store_resource_id
    where l.item_id = ${itemId} and r.attributes->>'domain' = 'stores' and r.attributes->>'kind' in ('central', 'sub') limit 1`);
  return r.rows.length > 0;
}

async function notifyPr(tx: Tx, userId: string, words: readonly [string, string], pr: { id: string; prNo: string }, key: string, now: Date): Promise<void> {
  await raiseNotice(tx as unknown as Db, {
    userId, kind: NOTICE_KIND, title: words[0], body: `${words[1]} · ${pr.prNo}`,
    refType: "stores_purchase_request", refId: pr.id, sourceKey: `stores-pr:${pr.id}:${key}`, at: now,
  });
}

/**
 * `opts.agent` (S5c, flow 3): the buyer agent's night shortfall request — a `central` request raised by the agent actor,
 * which holds no grant. Only that pairing skips the grant check; the materials head still approves it.
 */
export async function raisePurchaseRequest(
  db: Db, actor: Actor, input: RaisePurchaseRequestInput, now: Date = new Date(), opts: { agent?: boolean } = {},
): Promise<WirePurchaseRequest> {
  const priority = input.priority ?? "routine";
  let departmentId: string | null = null;
  let shelfId: string | null = null;
  if (input.source === "department") {
    if (input.departmentId == null) throw new StoresError("unknown_department", "name the department asking");
    departmentId = (await departmentOf(db, input.departmentId)).id;
    if (!(await holds(db, actor, STORES_PURCHASE_REQUEST, departmentId))) {
      throw new StoresError("not_permitted", "not your department", { permission: STORES_PURCHASE_REQUEST, departmentId });
    }
    if (input.shelfId != null) {
      const shelf = await requireShelf(db, input.shelfId);
      if (shelf.departmentId !== departmentId) throw new StoresError("not_this_shelf", "this shelf is another department's");
      shelfId = shelf.id;
    }
  } else if (input.source === "planner") {
    // S7 (#1117, decision 7): the stock planner's central shortfall, raised by the planner actor only; the materials head approves.
    if (!(opts.agent === true && actor.type === "agent")) throw new StoresError("not_permitted", "planner requests are raised by the planner");
  } else if (input.source === "central") {
    const agent = opts.agent === true && actor.type === "agent";
    if (!agent && !(await holds(db, actor, STORES_BUYING_MANAGE)) && !(await holds(db, actor, STORES_MASTERS))) {
      throw new StoresError("not_permitted", "the store's requests are the buyer's", { permission: STORES_BUYING_MANAGE });
    }
  } else {
    throw new StoresError("not_permitted", "requests come from a department or the central store");
  }
  if (input.lines.length === 0) throw new StoresError("item_required", "a request asks for at least one item");

  // ── each line: an item row, a quantity, an estimate, and for equipment the three answers ──
  const ids: string[] = [];
  for (const l of input.lines) {
    if (l.itemId == null || l.itemId.trim() === "") throw new StoresError("item_required", "choose the item from the list");
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new StoresError("bad_quantity", "a quantity is a whole number above zero");
    if (ids.includes(l.itemId)) throw new StoresError("bad_quantity", "an item appears twice in one request", { itemId: l.itemId });
    ids.push(l.itemId);
  }
  const resolved: { item: Awaited<ReturnType<typeof requireStoresItem>>; equipment: boolean }[] = [];
  for (const id of ids) {
    const item = await requireStoresItem(db, id);
    if (input.source === "department" && (await isStockItem(db, id))) {
      throw new StoresError("stock_item", `${item.name} is a stock item: ask the store`, { itemId: id });
    }
    resolved.push({ item, equipment: (await categoryRules(db, item.categoryId)).tagRule === "always" });
  }
  const [contracts, history] = await Promise.all([contractRatesFor(db, ids, now), purchaseHistoryByItem(db, ids, 1)]);
  const lines = input.lines.map((l, i) => {
    const { item, equipment } = resolved[i]!;
    const c = contracts.get(item.id)?.[0];
    const h = history.get(item.id)?.[0];
    let unit: number;
    let source: "contract" | "last" | "requester";
    if (c !== undefined) { unit = Math.round(c.ratePaise / c.multiplier); source = "contract"; }
    else if (h !== undefined) { unit = h.paisePerBase; source = "last"; }
    else {
      if (l.estimatePaise == null || !Number.isSafeInteger(l.estimatePaise) || l.estimatePaise <= 0) {
        throw new StoresError("estimate_required", `no price on record for ${item.name}: give an estimate`, { itemId: item.id });
      }
      unit = l.estimatePaise; source = "requester";
    }
    let answers: { why: string; replacesTag: string | null; usePerDay: string } | null = null;
    if (equipment) {
      const why = clean(l.equipment?.why);
      const use = clean(l.equipment?.usePerDay);
      if (input.source === "department" && (why === null || use === null)) {
        throw new StoresError("answers_required", `${item.name} is equipment: say why, what it replaces and the use per day`, { itemId: item.id });
      }
      answers = { why: why ?? "", replacesTag: clean(l.equipment?.replacesTag), usePerDay: use ?? "" };
    }
    return { lineIdx: i, item, qtyBase: l.qtyBase, unit, source, onContract: source === "contract", equipment, answers };
  });

  const id = newId();
  await withTx(db, async (tx) => {
    const prNo = await nextPrNo(tx, now);
    await tx.insert(storesPurchaseRequests).values({
      id, prNo, source: input.source, departmentId, shelfId, priority, note: clean(input.note), raisedBy: actor.id, raisedAt: now,
    });
    await tx.insert(storesPurchaseRequestLines).values(lines.map((l) => ({
      id: newId(), prId: id, lineIdx: l.lineIdx, itemId: l.item.id, categoryId: l.item.categoryId, qtyBase: l.qtyBase,
      unitEstimatePaise: l.unit, estimateSource: l.source, onContract: l.onContract, equipment: l.equipment, answers: l.answers,
    })));
    await recordAct(tx, actor, now, {
      act: "raise_purchase_request", refId: id, storeId: shelfId, after: { prNo, source: input.source, departmentId, priority },
      lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qtyBase, unitEstimatePaise: l.unit, estimateSource: l.source })),
    });
    const tell = departmentId !== null
      ? await approversToTell(tx, departmentId, actor.id)
      : (await holdersOf(tx, STORES_MASTERS, "hospital")).filter((u) => u !== actor.id);
    for (const u of tell) await notifyPr(tx, u, PR_WORDS.toApprove, { id, prNo }, "to-approve", now);
  });
  return getPurchaseRequest(db, id, now);
}

/** What "Ask to buy" shows before Send: the estimate that will fill itself, whether the three answers are asked, a stock item. */
export async function previewPurchaseLine(
  db: Db, actor: Actor, input: { itemId: string; departmentId?: string | null }, now: Date = new Date(),
): Promise<{ itemId: string; name: string; baseUom: string; unitEstimatePaise: number | null; estimateSource: "contract" | "last" | null; equipment: boolean; stockItem: boolean }> {
  const may = input.departmentId != null ? await holds(db, actor, STORES_PURCHASE_REQUEST, input.departmentId) : await holds(db, actor, STORES_BUYING_MANAGE);
  if (!may) throw new StoresError("not_permitted", "not your department", { permission: STORES_PURCHASE_REQUEST });
  const item = await requireStoresItem(db, input.itemId);
  const [contracts, history] = await Promise.all([contractRatesFor(db, [item.id], now), purchaseHistoryByItem(db, [item.id], 1)]);
  const c = contracts.get(item.id)?.[0];
  const h = history.get(item.id)?.[0];
  return {
    itemId: item.id, name: item.name, baseUom: item.baseUom,
    unitEstimatePaise: c !== undefined ? Math.round(c.ratePaise / c.multiplier) : (h?.paisePerBase ?? null),
    estimateSource: c !== undefined ? "contract" : h !== undefined ? "last" : null,
    equipment: (await categoryRules(db, item.categoryId)).tagRule === "always",
    stockItem: await isStockItem(db, item.id),
  };
}

// ═══════════════════════════════ approval ═══════════════════════════════

type Authority = { forRole: "hod" | "ms" | "delegate" | "materials"; onBehalfOf: string | null; delegationId: string | null };

/** Who may decide this request, and in which capacity (decision 1 + 11). Never the requester. */
async function authorityOver(tx: Tx, actor: Actor, pr: PrRow, now: Date): Promise<Authority> {
  if (actor.type !== "user") throw new StoresError("not_permitted", "a person decides a request");
  if (pr.raisedBy === actor.id) throw new StoresError("own_request", "your own request goes to another approver");
  if (pr.departmentId === null) {
    if (await holds(tx, actor, STORES_MASTERS)) return { forRole: "materials", onBehalfOf: null, delegationId: null };
    throw new StoresError("not_permitted", "the store's requests are the materials head's to approve", { permission: STORES_MASTERS });
  }
  if (await holds(tx, actor, STORES_INDENTS_APPROVE, pr.departmentId)) {
    const own = (await holdersOf(tx, STORES_INDENTS_APPROVE, { departmentId: pr.departmentId })).includes(actor.id);
    return { forRole: own ? "hod" : "ms", onBehalfOf: null, delegationId: null };
  }
  const d = await delegationFor(tx, actor.id, pr.departmentId, now);
  if (d.live !== null) {
    if (d.live.fromUserId === pr.raisedBy) throw new StoresError("own_request", "the HOD's own request goes to another approver");
    return { forRole: "delegate", onBehalfOf: d.live.fromUserId, delegationId: d.live.id };
  }
  if (d.ended) throw new StoresError("delegation_ended", "your delegation for this department has ended", { departmentId: pr.departmentId });
  throw new StoresError("not_permitted", "not your department", { permission: STORES_INDENTS_APPROVE, departmentId: pr.departmentId });
}

async function lockPr(tx: Tx, prId: string): Promise<PrRow> {
  const [row] = await tx.select().from(storesPurchaseRequests).where(eq(storesPurchaseRequests.id, prId)).for("update");
  if (row === undefined) throw new StoresError("unknown_purchase_request", `request ${prId} not found`, { prId });
  const [stamp] = await tx.select().from(storesPurchaseRequestStamps).where(eq(storesPurchaseRequestStamps.prId, prId));
  if (stamp !== undefined) throw new StoresError("already_decided", `${row.prNo} is already ${stamp.kind}`);
  return row;
}

/** Approve one request in the caller's transaction: the stamp, the act, the notices, the budget warnings. */
async function approveInTx(tx: Tx, actor: Actor, prId: string, now: Date): Promise<void> {
  const pr = await lockPr(tx, prId);
  const auth = await authorityOver(tx, actor, pr, now);
  const lines = await tx.select().from(storesPurchaseRequestLines).where(eq(storesPurchaseRequestLines.prId, prId));
  let overBudget = false;
  let budgetPct: number | null = null;
  if (pr.departmentId !== null) {
    const line = await budgetLineFor(tx, pr.departmentId, monthValue(lines), now);
    overBudget = line.over;
    budgetPct = line.pct;
  }
  await tx.insert(storesPurchaseRequestStamps).values({
    id: newId(), prId, kind: "approved", by: actor.id, at: now, reason: null, forRole: auth.forRole, onBehalfOf: auth.onBehalfOf,
    delegationId: auth.delegationId, overBudget, budgetPct,
  });
  await recordAct(tx, actor, now, {
    act: "approve_purchase_request", refId: prId, storeId: pr.shelfId,
    after: { forRole: auth.forRole, onBehalfOf: auth.onBehalfOf, delegationId: auth.delegationId, overBudget, budgetPct },
  });
  await notifyPr(tx, pr.raisedBy, PR_WORDS.approved, pr, "approved", now);
  if (pr.priority !== "routine") {
    for (const u of await holdersOf(tx, STORES_BUYING_MANAGE, "hospital")) await notifyPr(tx, u, PR_WORDS.buyNow, pr, "buy-now", now);
  }
  if (pr.departmentId !== null) await warnBudget(tx, pr.departmentId, now);
}

/** What a request adds to its department's month: nothing for equipment (decision 15), else its estimate. */
function monthValue(lines: readonly LineRow[]): number {
  if (lines.some((l) => l.equipment)) return 0;
  return lines.reduce((a, l) => a + l.qtyBase * l.unitEstimatePaise, 0);
}

export async function approvePurchaseRequest(db: Db, actor: Actor, prId: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  await withTx(db, (tx) => approveInTx(tx, actor, prId, now));
  return getPurchaseRequest(db, prId, now);
}

export async function declinePurchaseRequest(db: Db, actor: Actor, prId: string, reason: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "a decline says why");
  await withTx(db, async (tx) => {
    const pr = await lockPr(tx, prId);
    const auth = await authorityOver(tx, actor, pr, now);
    await tx.insert(storesPurchaseRequestStamps).values({
      id: newId(), prId, kind: "declined", by: actor.id, at: now, reason: why, forRole: auth.forRole, onBehalfOf: auth.onBehalfOf, delegationId: auth.delegationId,
    });
    await recordAct(tx, actor, now, { act: "decline_purchase_request", refId: prId, storeId: pr.shelfId, reason: why, after: { forRole: auth.forRole } });
    await notifyPr(tx, pr.raisedBy, PR_WORDS.declined, pr, "declined", now);
  });
  return getPurchaseRequest(db, prId, now);
}

/** The requester withdraws a request nobody has decided yet. */
export async function cancelPurchaseRequest(db: Db, actor: Actor, prId: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  await withTx(db, async (tx) => {
    const pr = await lockPr(tx, prId);
    if (pr.raisedBy !== actor.id) throw new StoresError("not_permitted", "only the requester withdraws a request");
    await tx.insert(storesPurchaseRequestStamps).values({ id: newId(), prId, kind: "cancelled", by: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "cancel_purchase_request", refId: prId, storeId: pr.shelfId });
  });
  return getPurchaseRequest(db, prId, now);
}

/** Decision 11: the materials head and the owner approve several in one tap. All or none; each its own stamp and act. */
export async function bulkApprovePurchaseRequests(db: Db, actor: Actor, prIds: readonly string[], now: Date = new Date()): Promise<WirePurchaseRequest[]> {
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return [];
  if (!(await holds(db, actor, STORES_MASTERS)) && !(await holdsRole(db, actor, "owner"))) {
    throw new StoresError("not_permitted", "bulk approval is the materials head's and the owner's", { permission: STORES_MASTERS });
  }
  await withTx(db, async (tx) => { for (const id of ids) await approveInTx(tx, actor, id, now); });
  return Promise.all(ids.map((id) => getPurchaseRequest(db, id, now)));
}

async function holdsRole(db: Db | Tx, actor: Actor, roleKey: string): Promise<boolean> {
  if (actor.type !== "user") return false;
  const [r] = await (db as Db).select({ u: roleAssignments.userId }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, roleKey))).limit(1);
  return r !== undefined;
}

/** Decision 3: the buyer may LIFT a band (a reason, one act), never lower it below the computed one (`band_lowered`). */
export async function setPurchaseRequestBand(db: Db, actor: Actor, prId: string, band: StoresBand, reason: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  if (!(await holds(db, actor, STORES_BUYING_MANAGE))) throw new StoresError("not_permitted", "bands are the buyer's", { permission: STORES_BUYING_MANAGE });
  const why = clean(reason);
  if (why === null) throw new StoresError("reason_required", "say why the band is lifted");
  const current = await getPurchaseRequest(db, prId, now);
  if (higherBand(band, current.band) !== band) {
    throw new StoresError("band_lowered", `a band is never lowered: this request is band ${current.band}`, { band: current.band });
  }
  if (band === current.band) return current;
  await withTx(db, async (tx) => {
    await tx.insert(storesPrBandSettings).values({ id: newId(), prId, band, reason: why, setBy: actor.id, at: now });
    await recordAct(tx, actor, now, { act: "set_band", refId: prId, before: current.band, after: band, reason: why });
  });
  return getPurchaseRequest(db, prId, now);
}

// ═══════════════════════════════ reads ═══════════════════════════════

export async function getPurchaseRequest(db: Db | Tx, prId: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  const [row] = await (db as Db).select().from(storesPurchaseRequests).where(eq(storesPurchaseRequests.id, prId));
  if (row === undefined) throw new StoresError("unknown_purchase_request", `request ${prId} not found`, { prId });
  return (await prViews(db, [row], now))[0]!;
}

/** The request as its requester, its approvers (own, stand-in or delegate), the buyer or the materials head reads it. */
export async function readPurchaseRequest(db: Db, actor: Actor, prId: string, now: Date = new Date()): Promise<WirePurchaseRequest> {
  const pr = await getPurchaseRequest(db, prId, now);
  if (actor.type === "user" && (pr.raisedBy.id === actor.id || (await holds(db, actor, STORES_BUYING_MANAGE)) || (await holds(db, actor, STORES_MASTERS))
    || (pr.department !== null && ((await holds(db, actor, STORES_INDENTS_APPROVE, pr.department.id))
      || (await delegationFor(db, actor.id, pr.department.id, now)).live !== null)))) return pr;
  throw new StoresError("not_permitted", "not your request", { permission: STORES_INDENTS_APPROVE });
}

/** Requests waiting for this person: their department's (HOD, stand-in, delegate) or the store's (materials head). */
export async function purchaseRequestsToApprove(db: Db, actor: Actor, now: Date = new Date()): Promise<WirePurchaseRequest[]> {
  if (actor.type !== "user") return [];
  const open = await db.select({ pr: storesPurchaseRequests }).from(storesPurchaseRequests)
    .leftJoin(storesPurchaseRequestStamps, eq(storesPurchaseRequestStamps.prId, storesPurchaseRequests.id))
    .where(isNull(storesPurchaseRequestStamps.id)).orderBy(asc(storesPurchaseRequests.raisedAt)).limit(LIST_LIMIT * 2);
  const mine: PrRow[] = [];
  for (const { pr } of open) {
    if (pr.raisedBy === actor.id) continue;
    if (pr.departmentId === null ? await holds(db, actor, STORES_MASTERS)
      : (await holds(db, actor, STORES_INDENTS_APPROVE, pr.departmentId)) || (await delegationFor(db, actor.id, pr.departmentId, now)).live !== null) {
      mine.push(pr);
    }
    if (mine.length >= LIST_LIMIT) break;
  }
  return prViews(db, mine, now);
}

/** The requests this person raised, newest first. */
export async function myPurchaseRequests(db: Db, actor: Actor, now: Date = new Date()): Promise<WirePurchaseRequest[]> {
  if (actor.type !== "user") return [];
  const rows = await db.select().from(storesPurchaseRequests).where(eq(storesPurchaseRequests.raisedBy, actor.id))
    .orderBy(desc(storesPurchaseRequests.raisedAt)).limit(LIST_LIMIT);
  return prViews(db, rows, now);
}

async function prViews(db: Db | Tx, rows: readonly PrRow[], now: Date): Promise<WirePurchaseRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await (db as Db).select({ line: storesPurchaseRequestLines, code: items.code, name: items.name, baseUom: items.baseUom })
    .from(storesPurchaseRequestLines).innerJoin(items, eq(items.id, storesPurchaseRequestLines.itemId))
    .where(inArray(storesPurchaseRequestLines.prId, ids)).orderBy(asc(storesPurchaseRequestLines.lineIdx));
  const stamps = new Map((await (db as Db).select().from(storesPurchaseRequestStamps).where(inArray(storesPurchaseRequestStamps.prId, ids)))
    .map((s) => [s.prId, s] as const));
  const deptIds = [...new Set(rows.map((r) => r.departmentId).filter((x): x is string => x !== null))];
  const depts = new Map(deptIds.length === 0 ? [] : (await (db as Db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name })
    .from(orgDepartments).where(inArray(orgDepartments.id, deptIds))).map((d) => [d.id, d] as const));
  const people = [...new Set(rows.map((r) => r.raisedBy).concat([...stamps.values()].flatMap((s) => [s.by, s.onBehalfOf]).filter((x): x is string => x !== null)))];
  const names = new Map((await (db as Db).select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.name] as const));
  const person = (id: string) => ({ id, name: names.get(id) ?? id });
  const out: WirePurchaseRequest[] = [];
  for (const pr of rows) {
    const mine = lines.filter((l) => l.line.prId === pr.id);
    const stamp: StampRow | undefined = stamps.get(pr.id);
    const band = await bandOf(db, pr, mine.map((l) => l.line), now);
    const status = stamp === undefined ? "requested" : stamp.kind as "approved" | "declined" | "cancelled";
    const budget = pr.departmentId === null ? null : await budgetLineFor(db, pr.departmentId, stamp === undefined ? monthValue(mine.map((l) => l.line)) : 0, now);
    out.push({
      id: pr.id, prNo: pr.prNo, source: pr.source as WirePurchaseRequest["source"], priority: pr.priority as WirePurchaseRequest["priority"],
      note: pr.note, status, department: pr.departmentId === null ? null : (depts.get(pr.departmentId) ?? null), shelfId: pr.shelfId,
      raisedBy: person(pr.raisedBy), raisedAt: pr.raisedAt.toISOString(),
      lines: mine.map(({ line: l, code, name, baseUom }) => ({
        lineIdx: l.lineIdx, itemId: l.itemId, itemCode: code, itemName: name, baseUom, qtyBase: l.qtyBase, unitEstimatePaise: l.unitEstimatePaise,
        estimateSource: l.estimateSource as "contract" | "last" | "requester", onContract: l.onContract, equipment: l.equipment, answers: l.answers ?? null,
      })),
      estimatePaise: band.estimatePaise, band: band.band, split: band.split, budget,
      stamp: stamp === undefined ? null : {
        decision: stamp.kind as "approved" | "declined" | "cancelled", by: person(stamp.by), at: stamp.at.toISOString(), reason: stamp.reason,
        forRole: stamp.forRole as "hod" | "ms" | "delegate" | "materials" | null, onBehalfOf: stamp.onBehalfOf === null ? null : person(stamp.onBehalfOf),
        overBudget: stamp.overBudget,
      },
    });
  }
  return out;
}

export { bandFor };
