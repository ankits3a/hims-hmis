import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  grns, items, resources, stockAdjustments, stockBatches, stockLedger, stockWriteOffLines, stockWriteOffs, supplierReturnLines,
  supplierReturns, users,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { withMergedAliases } from "./items";
import { packsOf } from "./supplier-returns";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GAP-CLOSURE A5 — THE STOCK LEDGER, AS A PERSON READS IT: "WHERE DID THESE 50 STRIPS GO" ═══
 *
 * `GET /materials/stock/movements` (`movementsFor`) is the ledger's raw rows: ids, signed deltas, a
 * reason code and a ref. The office's Stock → Stock ledger page needs the same rows as a statement —
 * one item (with the duplicates merged into it), optionally one store and one batch, a date range —
 * with an OPENING balance (everything that matched before the range), each row's RUNNING balance, the
 * CLOSING balance, who did it by name, and the document by its number where the materials module owns
 * the document (GRN, return / debit note, write-off, count adjustment). A read; nothing is written.
 *
 * Rows are in the order things happened (`occurred_at`, then the ledger's `seq`). The range is IST
 * calendar days, inclusive. Opening + Σ rows = closing, whatever the order — the arithmetic is the
 * statement's own check.
 *
 * The movement's KIND is named here rather than on the screen, from `reason` and `ref_type` together:
 * `consume` is a dispense, a counter sale or a ward / lab / OT use depending on who wrote it.
 */

const STOCK_READ = "materials.stock.read";
const ROW_LIMIT = 2_000;
const IST_OFFSET = "+05:30";

export type LedgerKind =
  | "grn" | "dispense" | "sale" | "consume" | "patient_return" | "transfer_out" | "transfer_in" | "supplier_return"
  | "adjustment" | "write_off" | "merge" | "issue" | "receive" | "return" | "adjust";

export type LedgerDocLink = { kind: "return"; id: string } | { kind: "writeoff"; id: string } | { kind: "grn" } | { kind: "transfer" } | { kind: "count" };

export type StockLedgerRow = {
  seq: number; occurredAt: string; kind: LedgerKind; reason: string; refType: string | null; refId: string | null;
  docNo: string | null; link: LedgerDocLink | null;
  storeResourceId: string; storeCode: string; storeName: string; batchId: string; batchNo: string; expiryDate: string | null;
  qtyIn: number; qtyOut: number; balance: number; actorId: string; actorName: string | null;
};

export type StockLedgerView = {
  item: { id: string; code: string; name: string; baseUom: string; pack: { uom: string; multiplier: number } | null };
  storeResourceId: string | null; batchId: string | null; from: string | null; to: string | null;
  opening: number; closing: number; totalIn: number; totalOut: number;
  rows: StockLedgerRow[]; truncated: boolean;
  /** Every batch of the item the ledger has ever moved — the screen's batch picker. */
  batches: { id: string; batchNo: string; expiryDate: string | null }[];
};

export function ledgerKind(reason: string, refType: string | null): LedgerKind {
  switch (refType) {
    case "grn": return "grn";
    case "pharmacy_dispense": return reason === "consume" ? "dispense" : "receive";
    case "pharmacy_retail_sale": return "sale";
    case "pharmacy_return": case "pharmacy_retail_return": return "patient_return";
    case "transfer": return reason === "issue" ? "transfer_out" : "transfer_in";
    case "supplier_return": return "supplier_return";
    case "stock_adjustment": return "adjustment";
    case "stock_write_off": return "write_off";
    case "item_merge": return "merge";
    default: break;
  }
  if (reason === "consume") return "consume";
  if (reason === "grn") return "grn";
  return reason as LedgerKind;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** The instant an IST calendar day starts. */
const istStart = (day: string): Date => new Date(`${day}T00:00:00${IST_OFFSET}`);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

async function requireStockRead(db: Db, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, STOCK_READ, "hospital"))) {
    throw new MaterialsError("permission_denied", `reading the stock ledger needs ${STOCK_READ}`);
  }
}

/** The item picker's search: items whose name or code contains `q`, merged duplicates left out. */
export async function ledgerItems(db: Db, actor: Actor, q: string): Promise<{ id: string; code: string; name: string; baseUom: string }[]> {
  await requireStockRead(db, actor);
  const text = q.trim().toLowerCase();
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.select({ id: items.id, code: items.code, name: items.name, baseUom: items.baseUom }).from(items)
    .where(and(sql`${items.mergedIntoItemId} is null`, sql`(lower(${items.name}) like ${like} or lower(${items.code}) like ${like})`))
    .orderBy(asc(items.name)).limit(20);
}

/**
 * THE STATEMENT. `itemId` is required; `storeResourceId`, `batchId`, `from` and `to` (IST dates,
 * inclusive) narrow it. A range over 3 years, `from` after `to`, or a batch of another item is refused.
 */
export async function stockLedgerView(
  db: Db, actor: Actor,
  input: { itemId: string; storeResourceId?: string | null; batchId?: string | null; from?: string | null; to?: string | null },
): Promise<StockLedgerView> {
  await requireStockRead(db, actor);
  const [item] = await db.select().from(items).where(eq(items.id, input.itemId));
  if (item === undefined) throw new MaterialsError("unknown_item", `item ${input.itemId} not found`);
  const from = input.from ?? null;
  const to = input.to ?? null;
  if ((from !== null && !isIsoDate(from)) || (to !== null && !isIsoDate(to))) throw new MaterialsError("ledger_invalid", "a date is YYYY-MM-DD");
  if (from !== null && to !== null && from > to) throw new MaterialsError("ledger_invalid", "the from date is on or before the to date");
  const { ids } = await withMergedAliases(db, [item.id]);
  if (input.batchId != null) {
    const [b] = await db.select({ itemId: stockBatches.itemId }).from(stockBatches).where(eq(stockBatches.id, input.batchId));
    if (b === undefined) throw new MaterialsError("unknown_batch", `batch ${input.batchId} not found`);
    if (!ids.includes(b.itemId)) throw new MaterialsError("ledger_invalid", "that batch is of another item");
  }
  const scope = [
    inArray(stockLedger.itemId, ids),
    ...(input.storeResourceId == null ? [] : [eq(stockLedger.resourceId, input.storeResourceId)]),
    ...(input.batchId == null ? [] : [eq(stockLedger.batchId, input.batchId)]),
  ];
  const [open] = from === null ? [{ q: "0" }] : await db.select({ q: sql<string>`coalesce(sum(${stockLedger.qtyDelta}), 0)` }).from(stockLedger)
    .where(and(...scope, lt(stockLedger.occurredAt, istStart(from))));
  const opening = Number(open?.q ?? 0);
  const inRange = and(
    ...scope,
    ...(from === null ? [] : [gte(stockLedger.occurredAt, istStart(from))]),
    ...(to === null ? [] : [lt(stockLedger.occurredAt, istStart(nextDay(to)))]),
  );
  const [sums] = await db.select({
    inQ: sql<string>`coalesce(sum(case when ${stockLedger.qtyDelta} > 0 then ${stockLedger.qtyDelta} else 0 end), 0)`,
    outQ: sql<string>`coalesce(sum(case when ${stockLedger.qtyDelta} < 0 then -${stockLedger.qtyDelta} else 0 end), 0)`,
  }).from(stockLedger).where(inRange);
  const totalIn = Number(sums?.inQ ?? 0);
  const totalOut = Number(sums?.outQ ?? 0);
  const raw = await db.select({
    l: stockLedger, storeCode: resources.code, storeName: resources.name, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
  }).from(stockLedger)
    .innerJoin(resources, eq(resources.id, stockLedger.resourceId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId))
    .where(inRange)
    .orderBy(asc(stockLedger.occurredAt), asc(stockLedger.seq))
    .limit(ROW_LIMIT + 1);
  const truncated = raw.length > ROW_LIMIT;
  const shown = truncated ? raw.slice(0, ROW_LIMIT) : raw;
  const docs = await docNumbers(db, shown.map((r) => ({ refType: r.l.refType, refId: r.l.refId })));
  const actorIds = [...new Set(shown.map((r) => r.l.actorId))];
  const names = actorIds.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, actorIds));
  let balance = opening;
  const rows: StockLedgerRow[] = shown.map(({ l, storeCode, storeName, batchNo, expiryDate }) => {
    balance += l.qtyDelta;
    const doc = l.refId === null ? undefined : docs.get(`${l.refType ?? ""}|${l.refId}`);
    return {
      seq: l.seq, occurredAt: l.occurredAt.toISOString(), kind: ledgerKind(l.reason, l.refType), reason: l.reason, refType: l.refType, refId: l.refId,
      docNo: doc?.no ?? null, link: doc?.link ?? null,
      storeResourceId: l.resourceId, storeCode, storeName, batchId: l.batchId, batchNo, expiryDate,
      qtyIn: l.qtyDelta > 0 ? l.qtyDelta : 0, qtyOut: l.qtyDelta < 0 ? -l.qtyDelta : 0, balance,
      actorId: l.actorId, actorName: names.find((n) => n.id === l.actorId)?.name ?? null,
    };
  });
  const batches = await db.selectDistinct({ id: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate })
    .from(stockBatches).innerJoin(stockLedger, eq(stockLedger.batchId, stockBatches.id))
    .where(inArray(stockBatches.itemId, ids)).orderBy(asc(stockBatches.batchNo)).limit(500);
  const packs = await packsOf(db, [item.id]);
  return {
    item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, pack: packs.get(item.id) ?? null },
    storeResourceId: input.storeResourceId ?? null, batchId: input.batchId ?? null, from, to,
    opening, closing: opening + totalIn - totalOut, totalIn, totalOut, rows, truncated, batches,
  };
}

/**
 * The document behind each row, where the materials module owns it: a GRN by its number; a supplier
 * return (the ledger names the RETURN LINE) by its debit note, else its return number; a write-off
 * (its line) by its number; a count adjustment as its count. Keyed `refType|refId`.
 */
async function docNumbers(db: Db, refs: readonly { refType: string | null; refId: string | null }[]): Promise<Map<string, { no: string | null; link: LedgerDocLink | null }>> {
  const out = new Map<string, { no: string | null; link: LedgerDocLink | null }>();
  const idsOf = (type: string): string[] => [...new Set(refs.filter((r) => r.refType === type && r.refId !== null).map((r) => r.refId!))];
  const grnIds = idsOf("grn");
  if (grnIds.length > 0) {
    for (const g of await db.select({ id: grns.id, no: grns.grnNo }).from(grns).where(inArray(grns.id, grnIds))) out.set(`grn|${g.id}`, { no: g.no, link: { kind: "grn" } });
  }
  const retLines = idsOf("supplier_return");
  if (retLines.length > 0) {
    const rows = await db.select({ lineId: supplierReturnLines.id, id: supplierReturns.id, returnNo: supplierReturns.returnNo, debit: supplierReturns.debitNoteNo })
      .from(supplierReturnLines).innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId)).where(inArray(supplierReturnLines.id, retLines));
    for (const r of rows) out.set(`supplier_return|${r.lineId}`, { no: r.debit ?? r.returnNo, link: { kind: "return", id: r.id } });
  }
  const woLines = idsOf("stock_write_off");
  if (woLines.length > 0) {
    const rows = await db.select({ lineId: stockWriteOffLines.id, id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo })
      .from(stockWriteOffLines).innerJoin(stockWriteOffs, eq(stockWriteOffs.id, stockWriteOffLines.writeOffId)).where(inArray(stockWriteOffLines.id, woLines));
    for (const r of rows) out.set(`stock_write_off|${r.lineId}`, { no: r.no, link: { kind: "writeoff", id: r.id } });
  }
  const adj = idsOf("stock_adjustment");
  if (adj.length > 0) {
    for (const a of await db.select({ id: stockAdjustments.id, reasonCode: stockAdjustments.reasonCode }).from(stockAdjustments).where(inArray(stockAdjustments.id, adj))) {
      out.set(`stock_adjustment|${a.id}`, { no: a.reasonCode, link: { kind: "count" } });
    }
  }
  for (const id of idsOf("transfer")) out.set(`transfer|${id}`, { no: null, link: { kind: "transfer" } });
  return out;
}
