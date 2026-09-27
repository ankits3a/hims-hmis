import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  items, resources, stockBalances, stockBatches, stockLedger, stockRecalls, stockWriteOffLines, stockWriteOffs, supplierReturnLines,
  supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { batchLineage } from "./items";
import { stockRecallClosed } from "./events";
import { istDay } from "./grn";
import { recallBatch } from "./ledger";
import { supplierKindOf } from "./supplier-returns";
import type { SupplierKind } from "./supplier-returns";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P4 — THE RECALL REGISTER ═══
 *
 * A recall FREEZES a batch at every store in one action (`ledger.ts` `recallBatch`, DD14). This file
 * is its register and its screen's reads: which alert it answers (a CDSCO / drug-controller alert,
 * the manufacturer's notice, or the hospital's own finding), where the batch still sits, and what was
 * already DISPENSED from it — the `consume` rows of the ledger, with the patient and the visit, so a
 * person can call them back. That list is read-only here; the pharmacy office adds the names and
 * phone numbers under its own PHI read.
 *
 *   raise (`materials.recall.manage`) → open ─every store's stock returned or destroyed─ close → closed
 *
 * Recalled stock leaves only two ways, both through the ledger's `recallExit`: back to the supplier
 * on a return (one tap: `draftReturnFromRecall`), or into destruction on a write-off.
 */

const RECALL_MANAGE = "materials.recall.manage";
const RECALL_READERS = [RECALL_MANAGE, "materials.stock.read"];

export type RecallSource = "cdsco" | "manufacturer" | "internal";
export const RECALL_SOURCES: readonly RecallSource[] = ["cdsco", "manufacturer", "internal"];
export type RecallStatus = "open" | "closed";

async function requirePerm(db: Db, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

async function requireReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user") {
    for (const p of RECALL_READERS) if (await hasPermission(db, actor.id, p, "hospital")) return;
  }
  throw new MaterialsError("permission_denied", `reading recalls needs one of ${RECALL_READERS.join(", ")}`);
}

export type RecallSummary = {
  id: string; recallNo: string; status: RecallStatus; source: RecallSource; reference: string | null; reason: string;
  batchId: string; batchNo: string; expiryDate: string | null; itemId: string; itemCode: string; itemName: string;
  vendorId: string | null; supplierName: string | null; supplierKind: SupplierKind;
  /** What every store still holds of the batch. */
  onHand: number;
  raisedBy: string; raisedAt: string; closedAt: string | null;
};

export type RecallView = RecallSummary & {
  closeNote: string | null; closedBy: string | null; names: Record<string, string>;
  locations: { storeResourceId: string; storeCode: string; storeName: string; onHand: number; reserved: number; frozen: number }[];
  /** Every `consume` row of the batch: who it went to, on which visit, when, how much. Read-only. */
  dispensed: { ledgerEntryId: string; storeResourceId: string; patientId: string | null; encounterId: string | null; qtyBase: number; occurredAt: string; refType: string | null; refId: string | null }[];
  returns: { returnId: string; returnNo: string; status: string; qtyBase: number }[];
  writeOffs: { writeOffId: string; writeOffNo: string; status: string; qtyBase: number }[];
};

/**
 * A recall raised: the register's entry (`MRC…`) and the freeze at every store, in ONE transaction.
 * A batch with an open recall is refused (`recall_open`) — one alert, one entry.
 */
export async function raiseRecall(
  db: Db, actor: Actor, input: { batchId: string; source?: RecallSource; reference?: string | null; reason: string }, now: Date = new Date(),
): Promise<{ recall: RecallView; locations: { storeResourceId: string; qtyFrozen: number }[] }> {
  await requirePerm(db, actor, RECALL_MANAGE, "raising a recall");
  const source: RecallSource = input.source !== undefined && RECALL_SOURCES.includes(input.source) ? input.source : "internal";
  const reason = input.reason.trim();
  if (reason === "") throw new MaterialsError("reason_required", "say why the batch is recalled");
  const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.id, input.batchId));
  if (batch === undefined) throw new MaterialsError("unknown_batch", `batch ${input.batchId} not found`);
  const reference = input.reference?.trim() || null;
  const { id, locations } = await withTx(db, async (tx) => {
    const [open] = await tx.select({ recallNo: stockRecalls.recallNo }).from(stockRecalls)
      .where(and(eq(stockRecalls.batchId, batch.id), eq(stockRecalls.status, "open")));
    if (open !== undefined) throw new MaterialsError("recall_open", `batch ${batch.batchNo} is already under recall ${open.recallNo}`, { recallNo: open.recallNo });
    const recallId = newId();
    const recallNo = await nextEpisodeNo(tx, "stock_recall", istDay(now));
    await tx.insert(stockRecalls).values({
      id: recallId, recallNo, batchId: batch.id, itemId: batch.itemId, source, reference: reference === null ? null : reference.slice(0, 120),
      reason: reason.slice(0, 500), status: "open", raisedBy: actor.id, raisedAt: now,
    });
    const frozen = await recallBatch(tx, actor, batch.id, reason.slice(0, 500), { recallId, recallNo, source, reference });
    return { id: recallId, locations: frozen.locations };
  });
  return { recall: (await readRecall(db, id))!, locations };
}

/** An open recall closed: no store holds any of the batch any more (returned or destroyed). */
export async function closeRecall(db: Db, actor: Actor, recallId: string, note: string, now: Date = new Date()): Promise<RecallView> {
  await requirePerm(db, actor, RECALL_MANAGE, "closing a recall");
  await withTx(db, async (tx) => {
    const [r] = await tx.select().from(stockRecalls).where(eq(stockRecalls.id, recallId)).for("update");
    if (r === undefined) throw new MaterialsError("unknown_recall", `recall ${recallId} not found`);
    if (r.status !== "open") throw new MaterialsError("recall_wrong_status", `recall ${r.recallNo} is ${r.status}`, { status: r.status });
    const left = await tx.select({ onHand: stockBalances.qtyOnHand, store: stockBalances.resourceId }).from(stockBalances)
      .where(and(eq(stockBalances.batchId, r.batchId), ne(stockBalances.qtyOnHand, 0)));
    const qty = left.reduce((s, l) => s + l.onHand, 0);
    if (qty > 0) {
      throw new MaterialsError("recall_stock_remaining", `${String(left.length)} store(s) still hold ${String(qty)} of the batch; return it or destroy it first`, { stores: left.length, qtyBase: qty });
    }
    const why = note.trim().slice(0, 500);
    await tx.update(stockRecalls).set({ status: "closed", closedBy: actor.id, closedAt: now, closeNote: why === "" ? null : why }).where(eq(stockRecalls.id, recallId));
    await appendEvent(tx, stockRecallClosed.make({ occurredAt: now, actor, correlationId: recallId, payload: { recallId, recallNo: r.recallNo, batchId: r.batchId, closedBy: actor.id, note: why } }));
  });
  return (await readRecall(db, recallId))!;
}

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

const summarySelect = {
  r: stockRecalls, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, vendorId: stockBatches.vendorId,
  itemCode: items.code, itemName: items.name, vendorCode: vendors.code, vendorTrade: vendors.tradeName, vendorLegal: vendors.legalName,
};

type SummaryRow = {
  r: typeof stockRecalls.$inferSelect; batchNo: string; expiryDate: string | null; vendorId: string | null; itemCode: string; itemName: string;
  vendorCode: string | null; vendorTrade: string | null; vendorLegal: string | null;
};

function summaryOf(x: SummaryRow, onHand: number): RecallSummary {
  return {
    id: x.r.id, recallNo: x.r.recallNo, status: x.r.status as RecallStatus, source: x.r.source as RecallSource, reference: x.r.reference, reason: x.r.reason,
    batchId: x.r.batchId, batchNo: x.batchNo, expiryDate: x.expiryDate, itemId: x.r.itemId, itemCode: x.itemCode, itemName: x.itemName,
    vendorId: x.vendorId, supplierName: x.vendorTrade ?? x.vendorLegal, supplierKind: supplierKindOf(x.vendorCode === null ? null : { code: x.vendorCode }),
    onHand, raisedBy: x.r.raisedBy, raisedAt: x.r.raisedAt.toISOString(), closedAt: x.r.closedAt?.toISOString() ?? null,
  };
}

async function readRecall(db: Db, recallId: string): Promise<RecallView | undefined> {
  const [x] = await db.select(summarySelect).from(stockRecalls)
    .innerJoin(stockBatches, eq(stockBatches.id, stockRecalls.batchId))
    .innerJoin(items, eq(items.id, stockRecalls.itemId))
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(eq(stockRecalls.id, recallId));
  if (x === undefined) return undefined;
  const locations = await db.select({
    storeResourceId: stockBalances.resourceId, storeCode: resources.code, storeName: resources.name,
    onHand: stockBalances.qtyOnHand, reserved: stockBalances.qtyReserved, frozen: stockBalances.qtyFrozen,
  }).from(stockBalances).innerJoin(resources, eq(resources.id, stockBalances.resourceId))
    .where(and(eq(stockBalances.batchId, x.r.batchId), ne(stockBalances.qtyOnHand, 0))).orderBy(asc(resources.code));
  // PHARMACY P6 — the physical batch's whole lineage: a duplicate item merged into this one sold it too.
  const dispensed = await db.select().from(stockLedger)
    .where(and(inArray(stockLedger.batchId, await batchLineage(db, x.r.batchId)), eq(stockLedger.reason, "consume")))
    .orderBy(desc(stockLedger.seq)).limit(1_000);
  const returns = await db.select({ id: supplierReturns.id, no: supplierReturns.returnNo, status: supplierReturns.status, qty: supplierReturnLines.qtyBase })
    .from(supplierReturnLines).innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
    .where(eq(supplierReturnLines.batchId, x.r.batchId)).orderBy(desc(supplierReturns.createdAt));
  const writeOffs = await db.select({ id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo, status: stockWriteOffs.status, qty: stockWriteOffLines.qtyBase })
    .from(stockWriteOffLines).innerJoin(stockWriteOffs, eq(stockWriteOffs.id, stockWriteOffLines.writeOffId))
    .where(eq(stockWriteOffLines.batchId, x.r.batchId)).orderBy(desc(stockWriteOffs.requestedAt));
  const sum = <T extends { id: string; no: string; status: string; qty: number }>(rows: T[]): { id: string; no: string; status: string; qty: number }[] => {
    const m = new Map<string, { id: string; no: string; status: string; qty: number }>();
    for (const r of rows) { const e = m.get(r.id) ?? { id: r.id, no: r.no, status: r.status, qty: 0 }; e.qty += r.qty; m.set(r.id, e); }
    return [...m.values()];
  };
  return {
    ...summaryOf(x, locations.reduce((s, l) => s + l.onHand, 0)),
    closeNote: x.r.closeNote, closedBy: x.r.closedBy, names: await namesOf(db, [x.r.raisedBy, x.r.closedBy]),
    locations,
    dispensed: dispensed.map((d) => ({
      ledgerEntryId: d.id, storeResourceId: d.resourceId, patientId: d.patientId, encounterId: d.encounterId, qtyBase: -d.qtyDelta,
      occurredAt: d.occurredAt.toISOString(), refType: d.refType, refId: d.refId,
    })),
    returns: sum(returns).map((r) => ({ returnId: r.id, returnNo: r.no, status: r.status, qtyBase: r.qty })),
    writeOffs: sum(writeOffs).map((w) => ({ writeOffId: w.id, writeOffNo: w.no, status: w.status, qtyBase: w.qty })),
  };
}

export async function getRecall(db: Db, actor: Actor, recallId: string): Promise<RecallView> {
  await requireReader(db, actor);
  const r = await readRecall(db, recallId);
  if (r === undefined) throw new MaterialsError("unknown_recall", `recall ${recallId} not found`);
  return r;
}

export async function listRecalls(db: Db, actor: Actor, filter: { statuses?: readonly RecallStatus[]; limit?: number } = {}): Promise<RecallSummary[]> {
  await requireReader(db, actor);
  const rows = await db.select(summarySelect).from(stockRecalls)
    .innerJoin(stockBatches, eq(stockBatches.id, stockRecalls.batchId))
    .innerJoin(items, eq(items.id, stockRecalls.itemId))
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(filter.statuses === undefined || filter.statuses.length === 0 ? undefined : inArray(stockRecalls.status, [...filter.statuses]))
    .orderBy(desc(stockRecalls.raisedAt)).limit(Math.min(filter.limit ?? 200, 1000));
  const batchIds = [...new Set(rows.map((r) => r.r.batchId))];
  const held = batchIds.length === 0 ? [] : await db.select({ batchId: stockBalances.batchId, qty: stockBalances.qtyOnHand }).from(stockBalances)
    .where(inArray(stockBalances.batchId, batchIds));
  return rows.map((x) => summaryOf(x, held.filter((h) => h.batchId === x.r.batchId).reduce((s, h) => s + h.qty, 0)));
}

/** The batches an item has at any store with stock — the recall screen's picker. */
export async function recallableBatches(db: Db, actor: Actor, itemId: string): Promise<{ batchId: string; batchNo: string; expiryDate: string | null; onHand: number; recalled: boolean; supplierName: string | null }[]> {
  await requireReader(db, actor);
  const batches = await db.select({ b: stockBatches, vendorTrade: vendors.tradeName, vendorLegal: vendors.legalName }).from(stockBatches)
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(eq(stockBatches.itemId, itemId)).orderBy(asc(stockBatches.expiryDate), asc(stockBatches.batchNo)).limit(200);
  const ids = batches.map((b) => b.b.id);
  const held = ids.length === 0 ? [] : await db.select({ batchId: stockBalances.batchId, qty: stockBalances.qtyOnHand }).from(stockBalances).where(inArray(stockBalances.batchId, ids));
  return batches.map((x) => ({
    batchId: x.b.id, batchNo: x.b.batchNo, expiryDate: x.b.expiryDate, recalled: x.b.recallStatus === "frozen",
    onHand: held.filter((h) => h.batchId === x.b.id).reduce((s, h) => s + h.qty, 0), supplierName: x.vendorTrade ?? x.vendorLegal,
  }));
}
