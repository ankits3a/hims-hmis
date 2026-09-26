import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import {
  approvals, consignmentLots, grnLines, grns, itemBarcodes, itemMerges, itemPriceRegulations, itemStockLevels, itemUoms, items,
  purchaseOrderLines, purchaseOrders, resources, stockAdjustments, stockBalances, stockBatches, stockCountLines, stockCounts,
  stockLedger, stockRecalls, stockReservations, stockWriteOffLines, stockWriteOffs, supplierBillLines, supplierReturnLines,
  supplierReturns, transferLines, transfers, users,
} from "../../kernel/db/schema";
import { isEquivalentMedicine, medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { STOCK_ADJUSTMENT_APPROVAL_TYPE } from "./approval-types";
import { isControlledStore } from "./controlled";
import { MaterialsError } from "./errors";
import { itemMergeRefused, itemMergeRequested, itemMerged } from "./events";
import { effectiveRegulation } from "./items";
import { postMovements } from "./ledger";
import type { ItemRow } from "./items";
import type { MovementInput } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 (HYGIENE) — MERGE A DUPLICATE ITEM: THE STOCK AND THE OPEN WORK MOVE, THE HISTORY STAYS ═══
 *
 * Real item masters grow duplicates: the same medicine registered twice, a typo'd brand, an opening-stock
 * import that made a second row. Healthray's Item Master has "Merge Items", which moves the transaction
 * history to the surviving item. Ours cannot and does not: the stock ledger, the registers (H1, Form 3H,
 * Schedule X) and every money document are append-only by design. So a merge here is:
 *
 *   raise (the materials head, `materials.items.merge`, with the reason)
 *     ─ approval `materials_stock_adjustment` — the medical superintendent, never the requester (the
 *       route a count's variance and a destruction take; DECIDED, see the plan doc)
 *     ─granted→ merge (a holder of `materials.items.merge`), ONE transaction, everything re-checked
 *     ─rejected→ refused, nothing moved
 *
 * **What stays (history, never rewritten):** B's `stock_ledger` rows and `stock_batches`, GRN, bill,
 * return and write-off lines, closed orders, price regulations, dispense and sale lines, the registers.
 * B becomes `items.merged_into_item_id = A`, inactive for ever, and every read that aggregates by item
 * over history resolves B to A (`survivorsOf`, `withMergedAliases` in `items.ts`).
 *
 * **What moves (live, mutable state):**
 *   - stock on hand: per batch per store, an `adjust` pair — out of B's batch, into A's batch of the SAME
 *     number, expiry, MRP, cost, supplier and receipt (created, or A's own when it already holds that
 *     physical batch) — `ref_type = 'item_merge'`, through the ledger's one writer. DECIDED: `adjust`
 *     rather than a seventh reason, because the ledger's reasons are a CHECK the controlled register and
 *     every report read; the pair nets to zero in every item-level total once B resolves to A;
 *   - open purchase-order lines (re-pointed); min / reorder / max levels (A's own win where both exist);
 *     barcodes; the pack units A lacks; the price regulation in force when A has none (copied, append-only);
 *   - through `ItemMergeHooks`, the pharmacy's own: the sale registration (B's retired; A takes it only when
 *     A has none), shelf locations, open short-book rows.
 *
 * **Refused** (the pair is not one thing): the same item; either already merged; the survivor inactive;
 * another class; drugs that are not the same formulary medicine nor the same composition, strength, form
 * and route; another base unit; a pack of the same name with another multiplier; one controlled (NDPS,
 * Schedule X, narcotic storage) and the other not. **Blocked** (open work names B): a held reservation, an
 * open dispense (hook), stock in transit, an unposted receipt, a live return or write-off, an open count or
 * adjustment, recalled stock, consignment or loaner stock, controlled stock (DEFERRED: moving cabinet stock
 * between two item records under two keys), an open order carrying both, a batch of the same number on A
 * that differs in expiry, MRP or cost.
 *
 * **Not undoable.** An unmerge would have to split history the merge never rewrote plus stock that has
 * since moved; the confirm sheet says so. DEFERRED (plan doc).
 */

const MERGE_PERM = "materials.items.merge";
const MERGE_READERS = [MERGE_PERM, "materials.stock.read", "approvals.requests.decide"];
const MAX_REASON = 500;
/** DECIDED — the "possible duplicates" list shows at most this many pairs, and scans at most this many items. */
const DUPLICATE_LIMIT = 50;
const DUPLICATE_SCAN_LIMIT = 5000;

const OPEN_PO_STATUSES = ["draft", "pending_approval", "approved", "sent", "part_received"] as const;
const OPEN_GRN_STATUSES = ["draft", "gate_qc", "accepted", "partially_accepted"] as const;

export type ItemMergeStatus = "requested" | "merged" | "refused";

/** Why a merge cannot go ahead — the pair's rules first, then the open work. */
export type MergeRule =
  | "same_item" | "already_merged" | "survivor_inactive" | "different_class" | "different_drug" | "different_base_unit"
  | "pack_conflict" | "controlled_mismatch" | "request_open"
  | "reserved" | "open_dispense" | "in_transit" | "grn_open" | "return_open" | "write_off_open" | "count_open"
  | "adjustment_open" | "recalled_stock" | "consignment_stock" | "controlled_stock" | "order_carries_both" | "batch_conflict"
  | "stock_arrived";

const PAIR_RULES: ReadonlySet<MergeRule> = new Set([
  "same_item", "already_merged", "survivor_inactive", "different_class", "different_drug", "different_base_unit", "pack_conflict",
  "controlled_mismatch", "request_open",
]);

export type MergeRefusal = { rule: MergeRule; message: string; ref: string | null };

/** One line of "what moves" or "what stays": a key the screen words, a count, and the particulars. */
export type MergeTally = { key: string; count: number; detail: string[] };

/**
 * The pharmacy's part, in the same transaction (the office federates; materials never imports it):
 * its open work that blocks, what it would move and what stays, and the move itself.
 */
export type ItemMergeHooks = {
  blockers?: (db: Db | Tx, survivor: ItemRow, merged: ItemRow) => Promise<MergeRefusal[]>;
  preview?: (db: Db | Tx, survivor: ItemRow, merged: ItemRow) => Promise<{ moves: MergeTally[]; stays: MergeTally[] }>;
  move?: (tx: Tx, actor: Actor, survivor: ItemRow, merged: ItemRow, now: Date) => Promise<Record<string, number>>;
};

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

async function requireReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user") {
    for (const p of MERGE_READERS) if (await hasPermission(db, actor.id, p, "hospital")) return;
  }
  throw new MaterialsError("permission_denied", `reading item merges needs one of ${MERGE_READERS.join(", ")}`);
}

async function itemPair(db: Db | Tx, survivorItemId: string, mergedItemId: string, lock = false): Promise<{ a: ItemRow; b: ItemRow }> {
  const ids = [...new Set([survivorItemId, mergedItemId])];
  const q = db.select().from(items).where(inArray(items.id, ids)).orderBy(asc(items.id));
  const rows = lock ? await q.for("update") : await q;
  const a = rows.find((r) => r.id === survivorItemId);
  const b = rows.find((r) => r.id === mergedItemId);
  if (a === undefined) throw new MaterialsError("unknown_item", `item ${survivorItemId} not found`, { itemId: survivorItemId });
  if (b === undefined) throw new MaterialsError("unknown_item", `item ${mergedItemId} not found`, { itemId: mergedItemId });
  return { a, b };
}

const lower = (s: string): string => s.trim().toLowerCase();

// ═══════════════════════════════════ the rules ═══════════════════════════════════

type Controlled = { controlled: boolean; why: string | null };

async function controlledness(db: Db | Tx, rows: readonly ItemRow[]): Promise<Map<string, Controlled>> {
  const medIds = [...new Set(rows.map((r) => r.formularyMedicineId).filter((x): x is string => x !== null))];
  const meds = medIds.length === 0 ? new Map() : await medicinesByIds(db, medIds);
  const ndps = medIds.length === 0 ? new Map<string, string>() : await ndpsClassByMedicine(db, medIds);
  const out = new Map<string, Controlled>();
  for (const r of rows) {
    const med = r.formularyMedicineId === null ? undefined : meds.get(r.formularyMedicineId);
    const n = r.formularyMedicineId === null ? undefined : ndps.get(r.formularyMedicineId);
    const why = n !== undefined ? `NDPS ${String(n)}` : med?.scheduleFlag === "X" ? "Schedule X" : r.storageClass === "narcotic" ? "narcotic storage" : null;
    out.set(r.id, { controlled: why !== null, why });
  }
  return out;
}

/** The pair's own rules: is B the same thing as A, and may it become part of A? */
async function pairRefusals(db: Db | Tx, a: ItemRow, b: ItemRow, exceptMergeId: string | null): Promise<MergeRefusal[]> {
  const out: MergeRefusal[] = [];
  const add = (rule: MergeRule, message: string, ref: string | null = null): void => { out.push({ rule, message, ref }); };
  if (a.id === b.id) { add("same_item", "an item cannot be merged into itself"); return out; }
  if (b.mergedIntoItemId !== null) add("already_merged", `${b.code} was already merged into another item`, b.code);
  if (a.mergedIntoItemId !== null) add("already_merged", `${a.code} was itself merged into another item — merge into that one`, a.code);
  if (a.mergedIntoItemId === null && !a.active) add("survivor_inactive", `${a.code} is inactive — the item that stays must be active`, a.code);
  if (a.class !== b.class) add("different_class", `${b.code} is a ${b.class} and ${a.code} a ${a.class}`);
  if (a.class === "drug" && b.class === "drug" && a.formularyMedicineId !== null && b.formularyMedicineId !== null
    && a.formularyMedicineId !== b.formularyMedicineId
    && !(await isEquivalentMedicine(db, b.formularyMedicineId, a.formularyMedicineId))
    && !(await isEquivalentMedicine(db, a.formularyMedicineId, b.formularyMedicineId))) {
    const meds = await medicinesByIds(db, [a.formularyMedicineId, b.formularyMedicineId]);
    const label = (id: string): string => {
      const m = meds.get(id);
      return m === undefined ? id : `${m.brandName}${m.strengthLabel === null ? "" : ` ${m.strengthLabel}`} (${m.form})`;
    };
    add("different_drug", `${b.code} stocks ${label(b.formularyMedicineId)} and ${a.code} ${label(a.formularyMedicineId)} — not the same medicine, nor the same composition, strength, form and route`);
  }
  if (lower(a.baseUom) !== lower(b.baseUom)) {
    add("different_base_unit", `${b.code} is counted in ${b.baseUom} and ${a.code} in ${a.baseUom} — a quantity cannot move between them one for one`);
  }
  const packs = await db.select().from(itemUoms).where(inArray(itemUoms.itemId, [a.id, b.id]));
  for (const pb of packs.filter((p) => p.itemId === b.id)) {
    const pa = packs.find((p) => p.itemId === a.id && lower(p.uom) === lower(pb.uom));
    if (pa !== undefined && pa.toBaseMultiplier !== pb.toBaseMultiplier) {
      add("pack_conflict", `a "${pb.uom}" of ${b.code} holds ${String(pb.toBaseMultiplier)} ${b.baseUom}, of ${a.code} ${String(pa.toBaseMultiplier)} — the barcodes and prices on that pack cannot mean both`, pb.uom);
    }
  }
  const ctl = await controlledness(db, [a, b]);
  const ca = ctl.get(a.id)!;
  const cb = ctl.get(b.id)!;
  if (ca.controlled !== cb.controlled) {
    add("controlled_mismatch", cb.controlled
      ? `${b.code} is a controlled drug (${cb.why ?? ""}) and ${a.code} is not — its registers cannot continue under an uncontrolled item`
      : `${a.code} is a controlled drug (${ca.why ?? ""}) and ${b.code} is not`);
  }
  const open = await db.select({ id: itemMerges.id, survivor: itemMerges.survivorItemId, merged: itemMerges.mergedItemId }).from(itemMerges)
    .where(and(eq(itemMerges.status, "requested"), or(
      inArray(itemMerges.mergedItemId, [a.id, b.id]), inArray(itemMerges.survivorItemId, [a.id, b.id]),
    ), ...(exceptMergeId === null ? [] : [sql`${itemMerges.id} <> ${exceptMergeId}`])));
  if (open.length > 0) add("request_open", "a merge naming one of these items is already waiting for its approval", open[0]!.id);
  return out;
}

/** B's stock on hand, per batch per store, with what the move needs to know about the batch and the store. */
async function stockOf(db: Db | Tx, itemId: string): Promise<{
  resourceId: string; storeCode: string; storeName: string; storeAttributes: unknown; batch: typeof stockBatches.$inferSelect;
  onHand: number; reserved: number; frozen: number;
}[]> {
  const rows = await db.select({ bal: stockBalances, batch: stockBatches, code: resources.code, name: resources.name, attributes: resources.attributes })
    .from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .innerJoin(resources, eq(resources.id, stockBalances.resourceId))
    .where(and(eq(stockBalances.itemId, itemId), sql`${stockBalances.qtyOnHand} > 0`))
    .orderBy(asc(resources.code), sql`${stockBatches.expiryDate} asc nulls last`, asc(stockBatches.batchNo));
  return rows.map((r) => ({
    resourceId: r.bal.resourceId, storeCode: r.code, storeName: r.name, storeAttributes: r.attributes, batch: r.batch,
    onHand: r.bal.qtyOnHand, reserved: r.bal.qtyReserved, frozen: r.bal.qtyFrozen,
  }));
}

/** A's batch a B batch's stock goes into: A's own of the same number and ownership, or a new one. */
async function targetBatches(db: Db | Tx, a: ItemRow, bBatches: readonly (typeof stockBatches.$inferSelect)[]): Promise<{
  into: Map<string, typeof stockBatches.$inferSelect | null>; conflicts: MergeRefusal[];
}> {
  const into = new Map<string, typeof stockBatches.$inferSelect | null>();
  const conflicts: MergeRefusal[] = [];
  if (bBatches.length === 0) return { into, conflicts };
  const mine = await db.select().from(stockBatches).where(and(
    eq(stockBatches.itemId, a.id),
    inArray(sql`lower(${stockBatches.batchNo})`, [...new Set(bBatches.map((x) => lower(x.batchNo)))]),
  ));
  for (const bb of bBatches) {
    const same = mine.find((m) => lower(m.batchNo) === lower(bb.batchNo) && m.ownership === bb.ownership);
    if (same === undefined) { into.set(bb.id, null); continue; }
    const differs = same.expiryDate !== bb.expiryDate || same.mrpPaise !== bb.mrpPaise
      || lower(same.mrpUom ?? "") !== lower(bb.mrpUom ?? "") || same.landedCostPaise !== bb.landedCostPaise || same.recallStatus !== bb.recallStatus;
    if (differs) {
      conflicts.push({
        rule: "batch_conflict",
        message: `${a.code} already holds batch ${same.batchNo} with another expiry, MRP or cost (${same.expiryDate ?? "no expiry"}, ${String(same.mrpPaise ?? "no MRP")}/${same.mrpUom ?? "-"}, cost ${String(same.landedCostPaise)}) than B's (${bb.expiryDate ?? "no expiry"}, ${String(bb.mrpPaise ?? "no MRP")}/${bb.mrpUom ?? "-"}, cost ${String(bb.landedCostPaise)}) — correct the wrong one first`,
        ref: bb.batchNo,
      });
    } else {
      into.set(bb.id, same);
    }
  }
  return { into, conflicts };
}

/** Open work that names B (and the one order that names both): each must be finished before the merge. */
async function openWork(db: Db | Tx, a: ItemRow, b: ItemRow, hooks: ItemMergeHooks): Promise<MergeRefusal[]> {
  const out: MergeRefusal[] = [];
  const add = (rule: MergeRule, message: string, ref: string | null = null): void => { out.push({ rule, message, ref }); };

  const held = await db.select({ refType: stockReservations.refType, refId: stockReservations.refId, qty: stockReservations.qty, batchNo: stockBatches.batchNo })
    .from(stockReservations).innerJoin(stockBatches, eq(stockBatches.id, stockReservations.batchId))
    .where(and(eq(stockBatches.itemId, b.id), eq(stockReservations.status, "held"))).limit(20);
  for (const r of held) add("reserved", `${String(r.qty)} of batch ${r.batchNo} is held for ${r.refType} ${r.refId} — hand it over or release it first`, `${r.refType}:${r.refId}`);

  const moving = await db.selectDistinct({ id: transfers.id }).from(transfers)
    .innerJoin(transferLines, eq(transferLines.transferId, transfers.id))
    .innerJoin(stockBatches, eq(stockBatches.id, transferLines.batchId))
    .where(and(eq(stockBatches.itemId, b.id), inArray(transfers.status, ["in_transit", "discrepancy"]))).limit(20);
  for (const t of moving) add("in_transit", "stock of it is on a transfer not yet received (or with a discrepancy) — receive or settle the transfer first", t.id);

  const receipts = await db.selectDistinct({ grnNo: grns.grnNo }).from(grns).innerJoin(grnLines, eq(grnLines.grnId, grns.id))
    .where(and(eq(grnLines.itemId, b.id), inArray(grns.status, [...OPEN_GRN_STATUSES]))).limit(20);
  for (const g of receipts) add("grn_open", `goods receipt ${g.grnNo} names it and is not posted — post or reject it first`, g.grnNo);

  const rets = await db.selectDistinct({ returnNo: supplierReturns.returnNo }).from(supplierReturns)
    .innerJoin(supplierReturnLines, eq(supplierReturnLines.returnId, supplierReturns.id))
    .where(and(eq(supplierReturnLines.itemId, b.id), inArray(supplierReturns.status, ["draft", "approved"]))).limit(20);
  for (const r of rets) add("return_open", `return to supplier ${r.returnNo} carries it and has not left — dispatch or cancel it first`, r.returnNo);

  const wos = await db.selectDistinct({ writeOffNo: stockWriteOffs.writeOffNo }).from(stockWriteOffs)
    .innerJoin(stockWriteOffLines, eq(stockWriteOffLines.writeOffId, stockWriteOffs.id))
    .where(and(eq(stockWriteOffLines.itemId, b.id), eq(stockWriteOffs.status, "requested"))).limit(20);
  for (const w of wos) add("write_off_open", `write-off ${w.writeOffNo} carries it and is not posted — post it, or let the superintendent refuse it, first`, w.writeOffNo);

  const counts = await db.selectDistinct({ id: stockCounts.id, store: resources.name }).from(stockCounts)
    .innerJoin(stockCountLines, eq(stockCountLines.countId, stockCounts.id))
    .innerJoin(resources, eq(resources.id, stockCounts.resourceId))
    .where(and(eq(stockCountLines.itemId, b.id), inArray(stockCounts.status, ["counting", "submitted"]))).limit(20);
  for (const c of counts) add("count_open", `a stock count at ${c.store} has it on its sheet and is not closed — close or cancel the count first`, c.id);

  const adj = await db.selectDistinct({ id: stockAdjustments.countId }).from(stockAdjustments)
    .where(and(eq(stockAdjustments.itemId, b.id), eq(stockAdjustments.status, "requested"))).limit(20);
  for (const x of adj) add("adjustment_open", "a count's variance on it waits for the superintendent — let it be decided first", x.id);

  const stock = await stockOf(db, b.id);
  for (const s of stock.filter((x) => x.batch.recallStatus === "frozen")) {
    add("recalled_stock", `batch ${s.batch.batchNo} is recalled and ${s.storeName} still holds ${String(s.onHand)} — return or destroy it first`, s.batch.batchNo);
  }
  const openRecalls = await db.select({ recallNo: stockRecalls.recallNo }).from(stockRecalls)
    .where(and(eq(stockRecalls.itemId, b.id), eq(stockRecalls.status, "open"))).limit(20);
  for (const r of openRecalls) if (!out.some((o) => o.rule === "recalled_stock")) add("recalled_stock", `recall ${r.recallNo} on it is still open — close it first`, r.recallNo);
  for (const s of stock.filter((x) => x.batch.ownership === "consignment" || x.batch.ownership === "loaner")) {
    add("consignment_stock", `${s.storeName} holds ${String(s.onHand)} of batch ${s.batch.batchNo} on ${s.batch.ownership} — the vendor's stock, tracked on its lot; return or buy it first`, s.batch.batchNo);
  }
  const lots = await db.select({ id: consignmentLots.id }).from(consignmentLots)
    .where(and(eq(consignmentLots.itemId, b.id), eq(consignmentLots.status, "open"))).limit(1);
  if (lots.length > 0 && !out.some((o) => o.rule === "consignment_stock")) add("consignment_stock", "an open consignment lot names it — reconcile or close the lot first", lots[0]!.id);

  const ctl = await controlledness(db, [a, b]);
  const inCabinet = stock.filter((s) => isControlledStore({ attributes: s.storeAttributes }));
  if (stock.length > 0 && (ctl.get(a.id)!.controlled || ctl.get(b.id)!.controlled || inCabinet.length > 0)) {
    add("controlled_stock", `it is a controlled drug and ${String(stock.reduce((n, s) => n + s.onHand, 0))} ${b.baseUom} are on hand — moving cabinet stock between two item records under two keys is not built yet; issue, return or destroy it first (DEFERRED)`);
  }

  const both = await db.select({ poNo: purchaseOrders.poNo }).from(purchaseOrders)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(and(inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]), eq(purchaseOrderLines.itemId, b.id), sql`exists (
      select 1 from purchase_order_lines x where x.purchase_order_id = ${purchaseOrders.id} and x.item_id = ${a.id})`)).limit(20);
  for (const p of both) add("order_carries_both", `purchase order ${p.poNo} carries both items on two lines — put them on one line first`, p.poNo);

  const { conflicts } = await targetBatches(db, a, [...new Map(stock.map((s) => [s.batch.id, s.batch])).values()]);
  out.push(...conflicts);

  if (hooks.blockers !== undefined) out.push(...(await hooks.blockers(db, a, b)));
  return out;
}

/** Every reason the merge cannot happen now: the pair's rules, then (when the pair is sound) the open work. */
async function refusalsFor(db: Db | Tx, a: ItemRow, b: ItemRow, hooks: ItemMergeHooks, exceptMergeId: string | null = null): Promise<MergeRefusal[]> {
  const pair = await pairRefusals(db, a, b, exceptMergeId);
  if (pair.some((p) => p.rule === "same_item")) return pair;
  return [...pair, ...(await openWork(db, a, b, hooks))];
}

function throwRefusals(refusals: readonly MergeRefusal[], a: ItemRow, b: ItemRow): void {
  if (refusals.length === 0) return;
  const message = `${b.code} cannot be merged into ${a.code}: ${refusals.map((r) => r.message).join("; ")}`;
  // The pair is not one thing (a rule of the items themselves), or open work names the duplicate.
  if (refusals.some((r) => PAIR_RULES.has(r.rule))) throw new MaterialsError("item_merge_invalid", message, { refusals });
  throw new MaterialsError("item_merge_blocked", message, { refusals });
}

// ═══════════════════════════════════ the preview (the merge sheet) ═══════════════════════════════════

export type MergeItemSide = {
  id: string; code: string; name: string; itemClass: string; baseUom: string; active: boolean; mergedIntoItemId: string | null;
  medicine: { id: string; brandName: string; strengthLabel: string | null; form: string } | null;
  controlled: boolean;
  packs: { uom: string; multiplier: number }[];
  onHandBase: number;
  barcodes: string[];
};

export type MergeStockLine = {
  storeResourceId: string; storeCode: string; storeName: string; batchId: string; batchNo: string; expiryDate: string | null;
  ownership: string; qtyBase: number; into: "new_batch" | "existing_batch";
};

export type MergePreview = {
  survivor: MergeItemSide;
  merged: MergeItemSide;
  refusals: MergeRefusal[];
  stock: MergeStockLine[];
  moves: MergeTally[];
  stays: MergeTally[];
  /** Always true: the confirm sheet says a merge is not undone. */
  irreversible: true;
};

async function sideOf(db: Db | Tx, r: ItemRow, controlled: boolean): Promise<MergeItemSide> {
  const [packs, codes, onHand] = await Promise.all([
    db.select({ uom: itemUoms.uom, multiplier: itemUoms.toBaseMultiplier }).from(itemUoms).where(eq(itemUoms.itemId, r.id)).orderBy(asc(itemUoms.toBaseMultiplier)),
    db.select({ code: itemBarcodes.code }).from(itemBarcodes).where(eq(itemBarcodes.itemId, r.id)).orderBy(asc(itemBarcodes.code)),
    db.select({ n: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)` }).from(stockBalances).where(eq(stockBalances.itemId, r.id)),
  ]);
  const med = r.formularyMedicineId === null ? undefined : (await medicinesByIds(db, [r.formularyMedicineId])).get(r.formularyMedicineId);
  return {
    id: r.id, code: r.code, name: r.name, itemClass: r.class, baseUom: r.baseUom, active: r.active, mergedIntoItemId: r.mergedIntoItemId,
    medicine: med === undefined ? null : { id: med.id, brandName: med.brandName, strengthLabel: med.strengthLabel, form: med.form },
    controlled, packs, onHandBase: Number(onHand[0]?.n ?? 0), barcodes: codes.map((c) => c.code),
  };
}

const count = async (q: PromiseLike<{ n: string | number }[]>): Promise<number> => Number((await q)[0]?.n ?? 0);

/** What the act would move and what stays, as it stands now. The same planner the act itself runs. */
async function planMoves(db: Db | Tx, a: ItemRow, b: ItemRow): Promise<{
  stock: MergeStockLine[]; packsToAdd: { uom: string; toBaseMultiplier: number }[];
  orderLines: { id: string; poNo: string; status: string; qtyPacks: number; uom: string }[];
  levelsMove: (typeof itemStockLevels.$inferSelect)[]; levelsDrop: (typeof itemStockLevels.$inferSelect)[];
  barcodes: string[]; regulation: typeof itemPriceRegulations.$inferSelect | null; now: Date;
}> {
  const now = new Date();
  const stockRows = await stockOf(db, b.id);
  const { into } = await targetBatches(db, a, [...new Map(stockRows.map((s) => [s.batch.id, s.batch])).values()]);
  const stock: MergeStockLine[] = stockRows.map((s) => ({
    storeResourceId: s.resourceId, storeCode: s.storeCode, storeName: s.storeName, batchId: s.batch.id, batchNo: s.batch.batchNo,
    expiryDate: s.batch.expiryDate, ownership: s.batch.ownership, qtyBase: s.onHand, into: into.get(s.batch.id) ? "existing_batch" : "new_batch",
  }));
  const packs = await db.select().from(itemUoms).where(inArray(itemUoms.itemId, [a.id, b.id]));
  const packsToAdd = packs.filter((p) => p.itemId === b.id && !packs.some((q) => q.itemId === a.id && lower(q.uom) === lower(p.uom)))
    .map((p) => ({ uom: p.uom, toBaseMultiplier: p.toBaseMultiplier }));
  const orderLines = await db.select({ id: purchaseOrderLines.id, poNo: purchaseOrders.poNo, status: purchaseOrders.status, qtyPacks: purchaseOrderLines.qtyPacks, uom: purchaseOrderLines.uom })
    .from(purchaseOrderLines).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(and(eq(purchaseOrderLines.itemId, b.id), inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]))).orderBy(asc(purchaseOrders.poNo));
  const levels = await db.select().from(itemStockLevels).where(inArray(itemStockLevels.itemId, [a.id, b.id]));
  const levelsMove = levels.filter((l) => l.itemId === b.id && !levels.some((x) => x.itemId === a.id && x.storeResourceId === l.storeResourceId));
  const levelsDrop = levels.filter((l) => l.itemId === b.id && levels.some((x) => x.itemId === a.id && x.storeResourceId === l.storeResourceId));
  const barcodes = (await db.select({ code: itemBarcodes.code }).from(itemBarcodes).where(eq(itemBarcodes.itemId, b.id)).orderBy(asc(itemBarcodes.code))).map((x) => x.code);
  const regulation = (await effectiveRegulation(db, a.id, now)) === undefined ? (await effectiveRegulation(db, b.id, now)) ?? null : null;
  return { stock, packsToAdd, orderLines, levelsMove, levelsDrop, barcodes, regulation, now };
}

export async function itemMergePreview(
  db: Db, actor: Actor, survivorItemId: string, mergedItemId: string, hooks: ItemMergeHooks = {},
): Promise<MergePreview> {
  await requireReader(db, actor);
  const { a, b } = await itemPair(db, survivorItemId, mergedItemId);
  const refusals = await refusalsFor(db, a, b, hooks);
  const ctl = await controlledness(db, [a, b]);
  const [survivor, merged] = [await sideOf(db, a, ctl.get(a.id)!.controlled), await sideOf(db, b, ctl.get(b.id)!.controlled)];
  const plan = await planMoves(db, a, b);
  const units = plan.stock.reduce((n, s) => n + s.qtyBase, 0);
  const moves: MergeTally[] = [
    { key: "stock", count: units, detail: [...new Set(plan.stock.map((s) => s.batchNo))] },
    { key: "orderLines", count: plan.orderLines.length, detail: plan.orderLines.map((o) => `${o.poNo} · ${String(o.qtyPacks)} ${o.uom}`) },
    { key: "levels", count: plan.levelsMove.length, detail: [] },
    { key: "levelsKept", count: plan.levelsDrop.length, detail: [] },
    { key: "barcodes", count: plan.barcodes.length, detail: plan.barcodes },
    { key: "packs", count: plan.packsToAdd.length, detail: plan.packsToAdd.map((p) => `${p.uom} × ${String(p.toBaseMultiplier)}`) },
    { key: "priceRegulation", count: plan.regulation === null ? 0 : 1, detail: plan.regulation?.gazetteRef === null || plan.regulation === null ? [] : [plan.regulation.gazetteRef] },
  ];
  const stays: MergeTally[] = [
    { key: "ledgerRows", count: await count(db.select({ n: sql<string>`count(*)` }).from(stockLedger).where(eq(stockLedger.itemId, b.id))), detail: [] },
    { key: "batches", count: await count(db.select({ n: sql<string>`count(*)` }).from(stockBatches).where(eq(stockBatches.itemId, b.id))), detail: [] },
    { key: "grnLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(grnLines).where(eq(grnLines.itemId, b.id))), detail: [] },
    { key: "billLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(supplierBillLines).where(eq(supplierBillLines.itemId, b.id))), detail: [] },
    { key: "returnLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(supplierReturnLines).where(eq(supplierReturnLines.itemId, b.id))), detail: [] },
    { key: "closedOrderLines", count: await count(db.select({ n: sql<string>`count(*)` }).from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
      .where(and(eq(purchaseOrderLines.itemId, b.id), notInArray(purchaseOrders.status, [...OPEN_PO_STATUSES])))), detail: [] },
    { key: "priceRegulations", count: await count(db.select({ n: sql<string>`count(*)` }).from(itemPriceRegulations).where(eq(itemPriceRegulations.itemId, b.id))), detail: [] },
  ];
  if (hooks.preview !== undefined) {
    const p = await hooks.preview(db, a, b);
    moves.push(...p.moves);
    stays.push(...p.stays);
  }
  return { survivor, merged, refusals, stock: plan.stock, moves, stays, irreversible: true };
}

// ═══════════════════════════════════ raise ═══════════════════════════════════

export async function raiseItemMerge(
  db: Db, actor: Actor,
  input: { survivorItemId: string; mergedItemId: string; reason: string; source?: "agent" | "manual" },
  hooks: ItemMergeHooks = {}, now: Date = new Date(),
): Promise<ItemMergeView> {
  await requirePerm(db, actor, MERGE_PERM, "raising an item merge");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > MAX_REASON) {
    throw new MaterialsError("item_merge_invalid", `a merge carries its reason, 3 to ${String(MAX_REASON)} characters`, { refusals: [] });
  }
  const id = await withTx(db, async (tx) => {
    const { a, b } = await itemPair(tx, input.survivorItemId, input.mergedItemId, true);
    throwRefusals(await refusalsFor(tx, a, b, hooks), a, b);
    const mergeId = newId();
    const stock = await stockOf(tx, b.id);
    const units = stock.reduce((n, s) => n + s.onHand, 0);
    const { approvalId } = await requestApproval(tx, actor, {
      typeKey: STOCK_ADJUSTMENT_APPROVAL_TYPE,
      subject: { type: "item_merge", id: mergeId },
      requestNote: `Item merge · ${b.code} ${b.name} → ${a.code} ${a.name} · ${String(units)} ${b.baseUom} on hand in ${String(new Set(stock.map((s) => s.batch.id)).size)} batch(es) move; B's history stays · ${reason}`,
    });
    await tx.insert(itemMerges).values({
      id: mergeId, survivorItemId: a.id, mergedItemId: b.id, reason, source: input.source ?? "manual", status: "requested", approvalId,
      requestedBy: actor.id, requestedAt: now,
    });
    await appendEvent(tx, itemMergeRequested.make({
      occurredAt: now, actor, correlationId: mergeId,
      payload: { mergeId, survivorItemId: a.id, mergedItemId: b.id, approvalId, reason, source: input.source ?? "manual" },
    }));
    return mergeId;
  });
  return (await readItemMerge(db, id))!;
}

// ═══════════════════════════════════ settle, decide, merge ═══════════════════════════════════

/** Requested merges whose approval was REJECTED become refused (idempotent; conditional updates). */
export async function settleItemMerges(db: Db, now: Date = new Date(), ids?: readonly string[]): Promise<number> {
  const rejected = await db.select({ m: itemMerges, ap: approvals }).from(itemMerges)
    .innerJoin(approvals, eq(approvals.id, itemMerges.approvalId))
    .where(and(eq(itemMerges.status, "requested"), eq(approvals.status, "rejected"), ...(ids === undefined ? [] : [inArray(itemMerges.id, [...ids])])));
  let moved = 0;
  for (const { m, ap } of rejected) {
    await withTx(db, async (tx) => {
      const won = await tx.update(itemMerges).set({ status: "refused", refusedAt: ap.decidedAt ?? now })
        .where(and(eq(itemMerges.id, m.id), eq(itemMerges.status, "requested"))).returning({ id: itemMerges.id });
      if (won.length === 0) return;
      await appendEvent(tx, itemMergeRefused.make({
        occurredAt: now, actor: { type: "user", id: ap.decidedBy ?? "unknown" }, correlationId: m.id,
        payload: { mergeId: m.id, survivorItemId: m.survivorItemId, mergedItemId: m.mergedItemId, approvalId: ap.id },
      }));
      moved += 1;
    });
  }
  return moved;
}

/**
 * THE MERGE. Once the approval is granted, by a holder of `materials.items.merge`, in ONE transaction:
 * the merge row and both items locked, every rule and every piece of open work asked again (the grant has
 * an age), then the stock, the open orders, the levels, the barcodes, the packs, the price, the pharmacy's
 * part — and B retired. A rejected approval settles the merge as refused instead; a pending one refuses.
 */
export async function executeItemMerge(
  db: Db, actor: Actor, mergeId: string, hooks: ItemMergeHooks = {}, now: Date = new Date(),
): Promise<ItemMergeView> {
  await requirePerm(db, actor, MERGE_PERM, "merging an item");
  await settleItemMerges(db, now, [mergeId]);
  const [m0] = await db.select().from(itemMerges).where(eq(itemMerges.id, mergeId));
  if (m0 === undefined) throw new MaterialsError("unknown_item_merge", `item merge ${mergeId} not found`);
  if (m0.status !== "requested") throw new MaterialsError("item_merge_wrong_status", `this merge is ${m0.status}; only a requested one is carried out`, { status: m0.status });
  const approval = await getApproval(db, m0.approvalId);
  if (approval?.status !== "granted") {
    throw new MaterialsError("item_merge_unapproved", `the merge's approval is ${approval?.status ?? "missing"}: nothing moves before the medical superintendent grants it`, {
      approvalStatus: approval?.status ?? null,
    });
  }
  await withTx(db, async (tx) => {
    const [m] = await tx.select().from(itemMerges).where(eq(itemMerges.id, mergeId)).for("update");
    if (m?.status !== "requested") throw new MaterialsError("item_merge_wrong_status", `this merge is ${m?.status ?? "missing"}`, { status: m?.status ?? null });
    const { a, b } = await itemPair(tx, m.survivorItemId, m.mergedItemId, true);
    // The request itself is the one open request the rule would otherwise find.
    throwRefusals(await refusalsFor(tx, a, b, hooks, m.id), a, b);
    const plan = await planMoves(tx, a, b);

    // 1. The packs A lacks — B's barcodes, batch MRPs and order lines name them.
    if (plan.packsToAdd.length > 0) {
      await tx.insert(itemUoms).values(plan.packsToAdd.map((p) => ({
        id: newId(), itemId: a.id, uom: p.uom, toBaseMultiplier: p.toBaseMultiplier, isPurchaseUom: false, isIssueUom: false,
      })));
    }

    // 2. The stock: A's batch for each of B's (A's own of that number, or a new one carrying B's particulars),
    //    then one `adjust` pair per batch per store through the ledger's one writer.
    const bBatches = [...new Map((await stockOf(tx, b.id)).map((s) => [s.batch.id, s.batch])).values()];
    const { into } = await targetBatches(tx, a, bBatches);
    const target = new Map<string, string>();
    for (const bb of bBatches) {
      const existing = into.get(bb.id);
      if (existing !== null && existing !== undefined) { target.set(bb.id, existing.id); continue; }
      const idNew = newId();
      await tx.insert(stockBatches).values({
        id: idNew, itemId: a.id, batchNo: bb.batchNo, mfgDate: bb.mfgDate, expiryDate: bb.expiryDate, mrpPaise: bb.mrpPaise, mrpUom: bb.mrpUom,
        landedCostPaise: bb.landedCostPaise, vendorId: bb.vendorId, grnLineId: bb.grnLineId, ownership: bb.ownership,
        consignmentLotId: null, recallStatus: "none", expiryNotifiedThresholds: bb.expiryNotifiedThresholds, createdBy: actor.id,
      });
      target.set(bb.id, idNew);
    }
    const movements: MovementInput[] = plan.stock.flatMap((s) => [
      { resourceId: s.storeResourceId, batchId: s.batchId, qtyDelta: -s.qtyBase, reason: "adjust" as const, refType: "item_merge", refId: mergeId, occurredAt: now },
      { resourceId: s.storeResourceId, batchId: target.get(s.batchId)!, qtyDelta: s.qtyBase, reason: "adjust" as const, refType: "item_merge", refId: mergeId, occurredAt: now },
    ]);
    const posted = await postMovements(tx, actor, movements);

    // 3. Open order lines follow the item; A's own levels win where both have one; barcodes move.
    if (plan.orderLines.length > 0) {
      await tx.update(purchaseOrderLines).set({ itemId: a.id }).where(inArray(purchaseOrderLines.id, plan.orderLines.map((o) => o.id)));
    }
    if (plan.levelsMove.length > 0) {
      await tx.update(itemStockLevels).set({ itemId: a.id, updatedBy: actor.id, updatedAt: now }).where(inArray(itemStockLevels.id, plan.levelsMove.map((l) => l.id)));
    }
    if (plan.levelsDrop.length > 0) await tx.delete(itemStockLevels).where(inArray(itemStockLevels.id, plan.levelsDrop.map((l) => l.id)));
    if (plan.barcodes.length > 0) await tx.update(itemBarcodes).set({ itemId: a.id }).where(eq(itemBarcodes.itemId, b.id));

    // 4. The price in force: A's stays; when A has none, B's is copied onto A (append-only — B's rows stay).
    if (plan.regulation !== null) {
      await tx.insert(itemPriceRegulations).values({
        id: newId(), itemId: a.id, mrpDefaultPaise: plan.regulation.mrpDefaultPaise, mrpUom: plan.regulation.mrpUom,
        ceilingPaise: plan.regulation.ceilingPaise, effectiveFrom: plan.regulation.effectiveFrom, gazetteRef: plan.regulation.gazetteRef, createdBy: actor.id,
      });
    }

    // 5. The pharmacy's part (sale registration, shelf, short book), in this transaction.
    const pharmacy = hooks.move === undefined ? {} : await hooks.move(tx, actor, a, b, now);

    // 6. Whatever reached B while the act ran (a receipt posted between the read and the move) would be left on a
    // retired item: asked again after the move, and the whole act undone if so. Read-committed sees it.
    const [left] = await tx.select({ n: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)` }).from(stockBalances).where(eq(stockBalances.itemId, b.id));
    if (Number(left?.n ?? 0) !== 0) {
      throw new MaterialsError("item_merge_blocked", `stock of ${b.code} arrived while the merge ran — nothing was merged; try again`, {
        refusals: [{ rule: "stock_arrived", message: `stock of ${b.code} arrived while the merge ran`, ref: null }],
      });
    }

    // 7. B retired: merged into A, inactive for ever; whatever was merged into B now stands under A (one hop).
    await tx.update(items).set({ mergedIntoItemId: a.id, mergedAt: now, active: false, updatedBy: actor.id, updatedAt: now }).where(eq(items.id, b.id));
    await tx.update(items).set({ mergedIntoItemId: a.id, updatedBy: actor.id, updatedAt: now }).where(eq(items.mergedIntoItemId, b.id));

    const units = plan.stock.reduce((n, s) => n + s.qtyBase, 0);
    const moved = {
      stock: plan.stock.map((s) => ({ ...s, intoBatchId: target.get(s.batchId)! })),
      unitsMoved: units,
      ledgerEntryIds: posted.map((p) => p.ledgerEntryId),
      orderLines: plan.orderLines,
      levelsMoved: plan.levelsMove.map((l) => ({ storeResourceId: l.storeResourceId, minBase: l.minBase, reorderBase: l.reorderBase, maxBase: l.maxBase })),
      levelsDropped: plan.levelsDrop.map((l) => ({ storeResourceId: l.storeResourceId, minBase: l.minBase, reorderBase: l.reorderBase, maxBase: l.maxBase })),
      barcodes: plan.barcodes,
      packsAdded: plan.packsToAdd,
      priceRegulationCopied: plan.regulation === null ? null : plan.regulation.id,
      pharmacy,
    };
    await tx.update(itemMerges).set({ status: "merged", mergedBy: actor.id, mergedAt: now, moved }).where(eq(itemMerges.id, mergeId));
    await appendEvent(tx, itemMerged.make({
      occurredAt: now, actor, correlationId: mergeId,
      payload: {
        mergeId, survivorItemId: a.id, mergedItemId: b.id, approvalId: m.approvalId, mergedBy: actor.id,
        batchesMoved: new Set(plan.stock.map((s) => s.batchId)).size, unitsMoved: units, orderLinesMoved: plan.orderLines.length,
        barcodesMoved: plan.barcodes.length, ledgerEntryIds: posted.map((p) => p.ledgerEntryId),
      },
    }));
  });
  return (await readItemMerge(db, mergeId))!;
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

export type ItemMergeSummary = {
  id: string; status: ItemMergeStatus; source: "agent" | "manual"; reason: string;
  survivor: { id: string; code: string; name: string }; merged: { id: string; code: string; name: string };
  approvalId: string; approvalStatus: string; requestedBy: string; requestedAt: string; mergedBy: string | null; mergedAt: string | null;
};

export type ItemMergeView = ItemMergeSummary & {
  names: Record<string, string>;
  approval: { status: string; approverRole: string; decidedBy: string | null; decisionNote: string | null } | null;
  moved: Record<string, unknown> | null;
};

type MergeRow = typeof itemMerges.$inferSelect;

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

async function summariesOf(db: Db, rows: readonly MergeRow[]): Promise<ItemMergeSummary[]> {
  if (rows.length === 0) return [];
  const itemRows = await db.select({ id: items.id, code: items.code, name: items.name }).from(items)
    .where(inArray(items.id, [...new Set(rows.flatMap((r) => [r.survivorItemId, r.mergedItemId]))]));
  const aps = await db.select({ id: approvals.id, status: approvals.status }).from(approvals).where(inArray(approvals.id, rows.map((r) => r.approvalId)));
  const it = (id: string): { id: string; code: string; name: string } => itemRows.find((x) => x.id === id) ?? { id, code: id, name: id };
  return rows.map((r) => ({
    id: r.id, status: r.status as ItemMergeStatus, source: r.source as "agent" | "manual", reason: r.reason,
    survivor: it(r.survivorItemId), merged: it(r.mergedItemId),
    approvalId: r.approvalId, approvalStatus: aps.find((x) => x.id === r.approvalId)?.status ?? "missing",
    requestedBy: r.requestedBy, requestedAt: r.requestedAt.toISOString(), mergedBy: r.mergedBy, mergedAt: r.mergedAt?.toISOString() ?? null,
  }));
}

async function readItemMerge(db: Db, mergeId: string): Promise<ItemMergeView | undefined> {
  const [row] = await db.select().from(itemMerges).where(eq(itemMerges.id, mergeId));
  if (row === undefined) return undefined;
  const [summary] = await summariesOf(db, [row]);
  const ap = await getApproval(db, row.approvalId);
  return {
    ...summary!,
    names: await namesOf(db, [row.requestedBy, row.mergedBy, ap?.decidedBy ?? null]),
    approval: ap === null ? null : { status: ap.status, approverRole: ap.approverRole, decidedBy: ap.decidedBy, decisionNote: ap.decisionNote },
    moved: row.moved ?? null,
  };
}

export async function getItemMerge(db: Db, actor: Actor, mergeId: string, now: Date = new Date()): Promise<ItemMergeView> {
  await requireReader(db, actor);
  await settleItemMerges(db, now, [mergeId]);
  const v = await readItemMerge(db, mergeId);
  if (v === undefined) throw new MaterialsError("unknown_item_merge", `item merge ${mergeId} not found`);
  return v;
}

export async function listItemMerges(
  db: Db, actor: Actor, filter: { statuses?: readonly ItemMergeStatus[]; limit?: number } = {},
): Promise<ItemMergeSummary[]> {
  await requireReader(db, actor);
  await settleItemMerges(db);
  const rows = await db.select().from(itemMerges)
    .where(filter.statuses === undefined || filter.statuses.length === 0 ? undefined : inArray(itemMerges.status, [...filter.statuses]))
    .orderBy(desc(itemMerges.requestedAt), desc(itemMerges.id)).limit(Math.min(filter.limit ?? 100, 500));
  return summariesOf(db, rows);
}

// ═══════════════════════════════ the agent's draft: possible duplicates ═══════════════════════════════

export type DuplicateWhy = "same_medicine" | "same_composition" | "similar_name";

export type DuplicateSuggestion = {
  why: DuplicateWhy;
  itemClass: string;
  survivor: { id: string; code: string; name: string; onHandBase: number };
  merged: { id: string; code: string; name: string; onHandBase: number };
};

/** Lower case, letters and digits only, words kept apart by one space. */
function normalName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Classic edit distance, bounded: anything past `max` returns `max + 1`. */
function editDistance(x: string, y: string, max: number): number {
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[y.length]!;
}

/**
 * Near-identical names: the same letters once spaces and punctuation go ("Crocin 500 Tab" / "Crocin-500 tab"),
 * or at most two letters apart ("Pantocid 40" / "Pantocide 40") — and ALWAYS the same numbers in the same
 * order, because "Paracetamol 500" and "Paracetamol 650", or a size 7 glove and a size 8, are two things.
 */
export function similarNames(p: string, q: string): boolean {
  const a = normalName(p);
  const b = normalName(q);
  if (a === "" || b === "") return false;
  const digits = (s: string): string => (s.match(/\d+/g) ?? []).join(" ");
  if (digits(a) !== digits(b)) return false;
  const ka = a.replace(/ /g, "");
  const kb = b.replace(/ /g, "");
  if (ka === kb) return true;
  if (ka.length < 6 || kb.length < 6 || ka.slice(0, 3) !== kb.slice(0, 3)) return false;
  return editDistance(ka, kb, 2) <= 2;
}

/**
 * THE AGENT'S DRAFT — pairs of live items that look like one thing twice, for a person to open:
 *   - `same_medicine`: two drug items stocking the same formulary medicine;
 *   - `same_composition`: near-identical names over two medicines of the same composition, strength, form
 *     and route (a typo'd brand registered as a second medicine);
 *   - `similar_name`: near-identical names, same class and base unit (a glove typed twice).
 * The item with more stock on hand (then the older, then the lower code) is proposed to stay. Read-only:
 * nothing is raised until a person opens the pair and submits it, and the sheet asks every rule again.
 */
export async function findDuplicateItems(db: Db, actor: Actor, opts: { limit?: number } = {}): Promise<{ suggestions: DuplicateSuggestion[]; scanned: number }> {
  await requirePerm(db, actor, MERGE_PERM, "listing possible duplicate items");
  const limit = Math.max(1, Math.min(opts.limit ?? DUPLICATE_LIMIT, DUPLICATE_LIMIT));
  const live = await db.select({
    id: items.id, code: items.code, name: items.name, itemClass: items.class, baseUom: items.baseUom,
    medicineId: items.formularyMedicineId, createdAt: items.createdAt,
  }).from(items).where(and(eq(items.active, true), sql`${items.mergedIntoItemId} is null`)).orderBy(asc(items.code)).limit(DUPLICATE_SCAN_LIMIT);
  const busy = new Set((await db.select({ a: itemMerges.survivorItemId, b: itemMerges.mergedItemId }).from(itemMerges)
    .where(eq(itemMerges.status, "requested"))).flatMap((r) => [r.a, r.b]));
  const stock = new Map((await db.select({ itemId: stockBalances.itemId, n: sql<string>`sum(${stockBalances.qtyOnHand})` }).from(stockBalances)
    .where(sql`${stockBalances.qtyOnHand} > 0`).groupBy(stockBalances.itemId)).map((r) => [r.itemId, Number(r.n)] as const));
  const pool = live.filter((i) => !busy.has(i.id));
  type Row = (typeof pool)[number];
  const rank = (x: Row, y: Row): number => (stock.get(y.id) ?? 0) - (stock.get(x.id) ?? 0) || x.createdAt.getTime() - y.createdAt.getTime() || x.code.localeCompare(y.code);
  const out: DuplicateSuggestion[] = [];
  const seen = new Set<string>();
  const push = (x: Row, y: Row, why: DuplicateWhy): void => {
    const key = [x.id, y.id].sort().join("|");
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    const [keep, go] = rank(x, y) <= 0 ? [x, y] : [y, x];
    out.push({
      why, itemClass: keep.itemClass,
      survivor: { id: keep.id, code: keep.code, name: keep.name, onHandBase: stock.get(keep.id) ?? 0 },
      merged: { id: go.id, code: go.code, name: go.name, onHandBase: stock.get(go.id) ?? 0 },
    });
  };

  // 1. Two items over one formulary medicine.
  const byMedicine = new Map<string, Row[]>();
  for (const r of pool) if (r.medicineId !== null) byMedicine.set(r.medicineId, [...(byMedicine.get(r.medicineId) ?? []), r]);
  for (const group of byMedicine.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort(rank);
    for (const r of rest) push(keep!, r, "same_medicine");
  }

  // 2 & 3. Near-identical names within one class and base unit, bucketed by the first three letters.
  const buckets = new Map<string, Row[]>();
  for (const r of pool) {
    const k = `${r.itemClass}|${lower(r.baseUom)}|${normalName(r.name).replace(/ /g, "").slice(0, 3)}`;
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length && out.length < limit; i++) {
      for (let j = i + 1; j < group.length && out.length < limit; j++) {
        const x = group[i]!;
        const y = group[j]!;
        if (!similarNames(x.name, y.name)) continue;
        if (x.itemClass === "drug") {
          if (x.medicineId === null || y.medicineId === null) continue;
          if (x.medicineId === y.medicineId) { push(x, y, "same_medicine"); continue; }
          if (await isEquivalentMedicine(db, x.medicineId, y.medicineId)) push(x, y, "same_composition");
          continue;
        }
        push(x, y, "similar_name");
      }
    }
  }
  return { suggestions: out, scanned: live.length };
}
