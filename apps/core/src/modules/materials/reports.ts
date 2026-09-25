import { and, asc, eq, gte, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import {
  items, resources, stockBalances, stockBatches, stockLedger, stockWriteOffs, supplierBillLines, supplierBills, supplierCreditNotes,
  supplierPaymentRuns, supplierReturnLines, supplierReturns, vendors,
} from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { TRANSIT_STORE_CODE } from "./config";
import { istDay } from "./grn";
import { uomsByItems } from "./items";
import { returnVerdict, returnWindowDays, supplierKindOf } from "./supplier-returns";
import { addDays, daysBetween } from "./supplier-bills";
import { mrpPerBaseUnit } from "./uom";
import type { SupplierKind } from "./supplier-returns";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — WHAT MATERIALS KNOWS, AS REPORTS ═══
 *
 * The office's Reports read stock, purchases and payables, and materials owns every one of those
 * tables. These are its READ-ONLY report shapes; nothing here writes. They take no actor: the gate is
 * the caller's (`pharmacy.reports.read`, held by the owner, who reads no stock screen), as
 * `balances` and `expiringBatches` take none.
 *
 *   - `purchaseRegister`: the supplier bills booked as payable (P3), our debit notes (P4) and the
 *     vendors' credit notes (P4), each its own row, with the input GST as billed.
 *   - `stockValuationAt`: what the hospital held at the end of an IST day, batch by batch, from the
 *     LEDGER (so any past day can be asked), at each batch's GRN cost and at its MRP.
 *   - `nonMovingStock`: stock on hand whose item has not left the store in N days, with what the
 *     agent would do about it.
 *   - `billsForReconciliation`: the bills a GSTR-2B statement is matched against.
 *   - `findDocumentByNo`: a document number a person types, to its document (the activity view).
 */

const CHUNK = 5_000;
const VALUATION_ROW_LIMIT = 20_000;
const NON_MOVING_ROW_LIMIT = 5_000;

async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const wanted = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < wanted.length; i += CHUNK) out.push(...(await read(wanted.slice(i, i + CHUNK))));
  return out;
}

/** The instants an IST calendar day starts and ends — the kernel's one IST clock (`test/ist-clock-parity.test.ts`). */
const istDayStart = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).start;
const istDayEnd = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).end;

const vendorName = sql<string>`coalesce(${vendors.tradeName}, ${vendors.legalName})`;

// ═══════════════════════════════════ batches, for a register's lines ═══════════════════════════════════

export type BatchFacts = {
  id: string; itemId: string; batchNo: string; expiryDate: string | null; landedCostPaise: number; mrpPaise: number | null; mrpUom: string | null;
  ownership: string; vendorId: string | null;
};

/** The named batches, by id: the number, expiry and GRN cost a sales line's batch carried. */
export async function batchesByIds(db: Db | Tx, ids: readonly string[]): Promise<Map<string, BatchFacts>> {
  const rows = await inChunks(ids, (chunk) => db.select({
    id: stockBatches.id, itemId: stockBatches.itemId, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
    landedCostPaise: stockBatches.landedCostPaise, mrpPaise: stockBatches.mrpPaise, mrpUom: stockBatches.mrpUom,
    ownership: stockBatches.ownership, vendorId: stockBatches.vendorId,
  }).from(stockBatches).where(inArray(stockBatches.id, chunk)));
  return new Map(rows.map((r) => [r.id, r] as const));
}

// ═══════════════════════════════════ the purchase register ═══════════════════════════════════

/** The bill statuses booked as payable: what the books carry. Drafts, held and matched bills are not booked yet. */
export const BOOKED_BILL_STATUSES = ["accepted", "part_paid", "paid"] as const;

export type PurchaseRegisterLine = {
  itemId: string; itemCode: string; itemName: string; hsnCode: string | null; batchNo: string | null;
  qty: number; uom: string; ratePaise: number; taxablePaise: number; gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
};

export type PurchaseRegisterRow = {
  kind: "bill" | "debit_note" | "credit_note";
  id: string;
  /** OUR number: the bill as booked (`MSB…`), our debit note (`MDN…`), the vendor's credit as booked (`MCN…`). */
  docNo: string;
  /** The vendor's own number (their invoice or credit note); null on our debit note. */
  vendorDocNo: string | null;
  /** The other document it answers: a debit note's return (`MRT…`), a credit note's debit note. */
  ref: string | null;
  date: string;
  vendorId: string; vendorCode: string; vendorName: string; gstin: string | null; interState: boolean;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number;
  /** Bills: what has been settled (payments and credit offset); due = total − paid. Null on the notes. */
  paidPaise: number | null;
  duePaise: number | null;
  status: string;
  lines: PurchaseRegisterLine[];
};

type Money = { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number };
export type PurchaseRegister = {
  from: string; to: string;
  rows: PurchaseRegisterRow[];
  totals: {
    bills: Money & { paidPaise: number; duePaise: number };
    debitNotes: Money;
    creditNotes: Money;
    /** Purchases net of returns: bills − debit notes. A vendor's credit note CONFIRMS a debit note, so it is not subtracted twice. */
    net: Omit<Money, "count">;
  };
};

/** On one day: the bills, then our debit notes, then the vendors' credits that answer them. */
const KIND_ORDER: Record<PurchaseRegisterRow["kind"], number> = { bill: 0, debit_note: 1, credit_note: 2 };
const zero = (): Money => ({ count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, roundOffPaise: 0, totalPaise: 0 });
function add(m: Money, r: PurchaseRegisterRow): void {
  m.count += 1;
  m.taxablePaise += r.taxablePaise;
  m.cgstPaise += r.cgstPaise;
  m.sgstPaise += r.sgstPaise;
  m.igstPaise += r.igstPaise;
  m.roundOffPaise += r.roundOffPaise;
  m.totalPaise += r.totalPaise;
}

/**
 * A vendor's credit note carries an amount, not a GST split (P4 books it against our debit note). It
 * is split here in the debit note's proportions, so a credit equal to the debit note reads exactly
 * like it and a short credit reads as the same mix, smaller. The taxable value takes the rounding.
 */
export function splitLikeDebitNote(
  amountPaise: number, note: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number },
): { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (note.totalPaise <= 0 || amountPaise >= note.totalPaise) {
    return { taxablePaise: note.taxablePaise, cgstPaise: note.cgstPaise, sgstPaise: note.sgstPaise, igstPaise: note.igstPaise };
  }
  const part = (x: number): number => Math.round((x * amountPaise) / note.totalPaise);
  const cgstPaise = part(note.cgstPaise);
  const sgstPaise = part(note.sgstPaise);
  const igstPaise = part(note.igstPaise);
  return { taxablePaise: amountPaise - cgstPaise - sgstPaise - igstPaise, cgstPaise, sgstPaise, igstPaise };
}

/** Every purchase document dated in `from`..`to` (IST calendar days, inclusive). */
export async function purchaseRegister(db: Db | Tx, from: string, to: string): Promise<PurchaseRegister> {
  const bills = await db.select({
    id: supplierBills.id, billNo: supplierBills.billNo, vendorBillNo: supplierBills.vendorBillNo, billDate: supplierBills.billDate,
    vendorId: supplierBills.vendorId, vendorCode: vendors.code, vendorName, gstin: vendors.gstin, interState: supplierBills.interState,
    taxablePaise: supplierBills.taxablePaise, cgstPaise: supplierBills.cgstPaise, sgstPaise: supplierBills.sgstPaise, igstPaise: supplierBills.igstPaise,
    roundOffPaise: supplierBills.roundOffPaise, totalPaise: supplierBills.totalPaise, paidPaise: supplierBills.paidPaise, status: supplierBills.status,
  }).from(supplierBills).innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
    .where(and(gte(supplierBills.billDate, from), lte(supplierBills.billDate, to), inArray(supplierBills.status, [...BOOKED_BILL_STATUSES])))
    .orderBy(asc(supplierBills.billDate), asc(supplierBills.billNo));
  const notes = await db.select({
    id: supplierReturns.id, returnNo: supplierReturns.returnNo, debitNoteNo: supplierReturns.debitNoteNo, debitNoteDate: supplierReturns.debitNoteDate,
    vendorId: supplierReturns.vendorId, vendorCode: vendors.code, vendorName, gstin: sql<string | null>`coalesce(${supplierReturns.vendorGstin}, ${vendors.gstin})`,
    interState: supplierReturns.interState, taxablePaise: supplierReturns.taxablePaise, cgstPaise: supplierReturns.cgstPaise,
    sgstPaise: supplierReturns.sgstPaise, igstPaise: supplierReturns.igstPaise, totalPaise: supplierReturns.totalPaise, status: supplierReturns.status,
  }).from(supplierReturns).innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId))
    .where(and(gte(supplierReturns.debitNoteDate, from), lte(supplierReturns.debitNoteDate, to)))
    .orderBy(asc(supplierReturns.debitNoteDate), asc(supplierReturns.debitNoteNo));
  const credits = await db.select({
    id: supplierCreditNotes.id, creditNo: supplierCreditNotes.creditNo, vendorCreditNoteNo: supplierCreditNotes.vendorCreditNoteNo,
    date: supplierCreditNotes.creditNoteDate, amountPaise: supplierCreditNotes.amountPaise, status: supplierCreditNotes.status,
    vendorId: supplierCreditNotes.vendorId, vendorCode: vendors.code, vendorName, gstin: vendors.gstin, debitNoteNo: supplierReturns.debitNoteNo,
    interState: supplierReturns.interState, rTaxable: supplierReturns.taxablePaise, rCgst: supplierReturns.cgstPaise, rSgst: supplierReturns.sgstPaise,
    rIgst: supplierReturns.igstPaise, rTotal: supplierReturns.totalPaise,
  }).from(supplierCreditNotes)
    .innerJoin(vendors, eq(vendors.id, supplierCreditNotes.vendorId))
    .innerJoin(supplierReturns, eq(supplierReturns.id, supplierCreditNotes.returnId))
    .where(and(eq(supplierCreditNotes.status, "accepted"), gte(supplierCreditNotes.creditNoteDate, from), lte(supplierCreditNotes.creditNoteDate, to)))
    .orderBy(asc(supplierCreditNotes.creditNoteDate), asc(supplierCreditNotes.creditNo));

  const billLines = await inChunks(bills.map((b) => b.id), (chunk) => db.select({
    billId: supplierBillLines.billId, itemId: supplierBillLines.itemId, itemCode: items.code, itemName: items.name, hsnCode: items.hsnCode,
    qty: supplierBillLines.qtyPacks, uom: supplierBillLines.uom, ratePaise: supplierBillLines.ratePaise, taxablePaise: supplierBillLines.taxablePaise,
    gstRateBps: supplierBillLines.gstRateBps, cgstPaise: supplierBillLines.cgstPaise, sgstPaise: supplierBillLines.sgstPaise, igstPaise: supplierBillLines.igstPaise,
  }).from(supplierBillLines).innerJoin(items, eq(items.id, supplierBillLines.itemId)).where(inArray(supplierBillLines.billId, chunk)));
  const returnLines = await inChunks(notes.map((n) => n.id), (chunk) => db.select({
    returnId: supplierReturnLines.returnId, itemId: supplierReturnLines.itemId, itemCode: items.code, itemName: items.name,
    hsnCode: sql<string | null>`coalesce(${supplierReturnLines.hsnCode}, ${items.hsnCode})`, batchNo: stockBatches.batchNo, qty: supplierReturnLines.qtyBase,
    uom: items.baseUom, ratePaise: supplierReturnLines.ratePaise, taxablePaise: supplierReturnLines.taxablePaise, gstRateBps: supplierReturnLines.gstRateBps,
    cgstPaise: supplierReturnLines.cgstPaise, sgstPaise: supplierReturnLines.sgstPaise, igstPaise: supplierReturnLines.igstPaise,
  }).from(supplierReturnLines).innerJoin(items, eq(items.id, supplierReturnLines.itemId)).innerJoin(stockBatches, eq(stockBatches.id, supplierReturnLines.batchId))
    .where(inArray(supplierReturnLines.returnId, chunk)));
  const linesOf = <K extends string>(rows: (PurchaseRegisterLine & Record<K, string>)[], key: K, id: string): PurchaseRegisterLine[] =>
    rows.filter((r) => r[key] === id).map((r): PurchaseRegisterLine => ({
      itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, hsnCode: r.hsnCode, batchNo: r.batchNo, qty: r.qty, uom: r.uom,
      ratePaise: r.ratePaise, taxablePaise: r.taxablePaise, gstRateBps: r.gstRateBps, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise,
    })).sort((a, b) => a.itemName.localeCompare(b.itemName));

  const rows: PurchaseRegisterRow[] = [
    ...bills.map((b): PurchaseRegisterRow => ({
      kind: "bill", id: b.id, docNo: b.billNo, vendorDocNo: b.vendorBillNo, ref: null, date: b.billDate,
      vendorId: b.vendorId, vendorCode: b.vendorCode, vendorName: b.vendorName, gstin: b.gstin, interState: b.interState,
      taxablePaise: b.taxablePaise, cgstPaise: b.cgstPaise, sgstPaise: b.sgstPaise, igstPaise: b.igstPaise, roundOffPaise: b.roundOffPaise,
      totalPaise: b.totalPaise, paidPaise: b.paidPaise, duePaise: b.totalPaise - b.paidPaise, status: b.status,
      lines: linesOf(billLines.map((l) => ({ ...l, batchNo: null })), "billId", b.id),
    })),
    ...notes.filter((n) => n.debitNoteNo !== null && n.debitNoteDate !== null).map((n): PurchaseRegisterRow => ({
      kind: "debit_note", id: n.id, docNo: n.debitNoteNo!, vendorDocNo: null, ref: n.returnNo, date: n.debitNoteDate!,
      vendorId: n.vendorId, vendorCode: n.vendorCode, vendorName: n.vendorName, gstin: n.gstin, interState: n.interState,
      taxablePaise: n.taxablePaise, cgstPaise: n.cgstPaise, sgstPaise: n.sgstPaise, igstPaise: n.igstPaise, roundOffPaise: 0,
      totalPaise: n.totalPaise, paidPaise: null, duePaise: null, status: n.status, lines: linesOf(returnLines, "returnId", n.id),
    })),
    ...credits.map((c): PurchaseRegisterRow => {
      const split = splitLikeDebitNote(c.amountPaise, { taxablePaise: c.rTaxable, cgstPaise: c.rCgst, sgstPaise: c.rSgst, igstPaise: c.rIgst, totalPaise: c.rTotal });
      return {
        kind: "credit_note", id: c.id, docNo: c.creditNo, vendorDocNo: c.vendorCreditNoteNo, ref: c.debitNoteNo, date: c.date,
        vendorId: c.vendorId, vendorCode: c.vendorCode, vendorName: c.vendorName, gstin: c.gstin, interState: c.interState,
        ...split, roundOffPaise: 0, totalPaise: c.amountPaise, paidPaise: null, duePaise: null, status: c.status, lines: [],
      };
    }),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.docNo.localeCompare(b.docNo)));

  const totals = { bills: { ...zero(), paidPaise: 0, duePaise: 0 }, debitNotes: zero(), creditNotes: zero() };
  for (const r of rows) {
    if (r.kind === "bill") {
      add(totals.bills, r);
      totals.bills.paidPaise += r.paidPaise ?? 0;
      totals.bills.duePaise += r.duePaise ?? 0;
    } else add(r.kind === "debit_note" ? totals.debitNotes : totals.creditNotes, r);
  }
  const net = {
    taxablePaise: totals.bills.taxablePaise - totals.debitNotes.taxablePaise, cgstPaise: totals.bills.cgstPaise - totals.debitNotes.cgstPaise,
    sgstPaise: totals.bills.sgstPaise - totals.debitNotes.sgstPaise, igstPaise: totals.bills.igstPaise - totals.debitNotes.igstPaise,
    roundOffPaise: totals.bills.roundOffPaise, totalPaise: totals.bills.totalPaise - totals.debitNotes.totalPaise,
  };
  return { from, to, rows, totals: { ...totals, net } };
}

// ═══════════════════════════════════ stock valuation ═══════════════════════════════════

/** Ownerships the hospital's books carry. Consignment and loaner stock is the vendor's (counted apart). */
const VALUED_OWNERSHIPS = ["owned", "donated"] as const;

export type ValuationRow = {
  storeResourceId: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; baseUom: string; hsnCode: string | null;
  batchId: string; batchNo: string; expiryDate: string | null; ownership: string;
  qtyBase: number; landedCostPaise: number; costValuePaise: number; mrpPerBasePaise: number | null; mrpValuePaise: number | null;
};
export type ValuationGroup = { key: string; code: string; name: string; batches: number; qtyBase: number | null; costValuePaise: number; mrpValuePaise: number };
export type StockValuation = {
  asOf: string;
  rows: ValuationRow[];
  byStore: ValuationGroup[];
  byItem: (ValuationGroup & { baseUom: string })[];
  totals: { batches: number; costValuePaise: number; mrpValuePaise: number; noMrpBatches: number };
  /** Consignment and loaner stock held on the day: the vendor's, so outside the value. */
  vendorOwned: { batches: number; qtyBase: number };
  truncated: boolean;
};

/**
 * THE STOCK THE HOSPITAL HELD AT THE END OF `asOf` (an IST calendar day), from the LEDGER — every
 * movement that occurred before the next IST midnight, summed per store and batch — so any past day
 * can be asked and today's answer equals `stock_balances` (the ledger's own invariant).
 *
 * Valued per BATCH at its GRN cost (`stock_batches.landed_cost_paise`, per base unit): per-batch
 * costing is FIFO by construction, since each receipt is its own batch at its own price. And at MRP
 * per base unit, where the batch carries one. `IN-TRANSIT` is included: stock between two of the
 * hospital's stores is still the hospital's.
 */
export async function stockValuationAt(db: Db | Tx, asOf: string, opts: { storeResourceId?: string | null } = {}): Promise<StockValuation> {
  const end = istDayEnd(asOf);
  const held = await db.select({
    resourceId: stockLedger.resourceId, batchId: stockLedger.batchId, qty: sql<string>`sum(${stockLedger.qtyDelta})`,
  }).from(stockLedger)
    .where(and(lt(stockLedger.occurredAt, end), ...(opts.storeResourceId == null ? [] : [eq(stockLedger.resourceId, opts.storeResourceId)])))
    .groupBy(stockLedger.resourceId, stockLedger.batchId)
    .having(sql`sum(${stockLedger.qtyDelta}) <> 0`);
  const truncated = held.length > VALUATION_ROW_LIMIT;
  const pairs = held.slice(0, VALUATION_ROW_LIMIT);
  const batchRows = await inChunks(pairs.map((p) => p.batchId), (chunk) => db.select({
    id: stockBatches.id, itemId: stockBatches.itemId, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
    mrpPaise: stockBatches.mrpPaise, mrpUom: stockBatches.mrpUom, landedCostPaise: stockBatches.landedCostPaise, ownership: stockBatches.ownership,
    itemCode: items.code, itemName: items.name, baseUom: items.baseUom, hsnCode: items.hsnCode,
  }).from(stockBatches).innerJoin(items, eq(items.id, stockBatches.itemId)).where(inArray(stockBatches.id, chunk)));
  const batches = new Map(batchRows.map((b) => [b.id, b] as const));
  const stores = new Map((await inChunks(pairs.map((p) => p.resourceId), (chunk) => db.select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources).where(inArray(resources.id, chunk)))).map((s) => [s.id, s] as const));
  const uoms = await uomsByItems(db, batchRows.map((b) => b.itemId));

  const rows: ValuationRow[] = [];
  const vendorOwned = { batches: 0, qtyBase: 0 };
  for (const p of pairs) {
    const b = batches.get(p.batchId);
    const s = stores.get(p.resourceId);
    if (b === undefined || s === undefined) continue;
    const qtyBase = Number(p.qty);
    if (!(VALUED_OWNERSHIPS as readonly string[]).includes(b.ownership)) {
      vendorOwned.batches += 1;
      vendorOwned.qtyBase += qtyBase;
      continue;
    }
    let mrpPerBasePaise: number | null = null;
    try {
      mrpPerBasePaise = mrpPerBaseUnit((uoms.get(b.itemId) ?? []).map((u) => ({ uom: u.uom, toBaseMultiplier: u.toBaseMultiplier })), b.mrpPaise, b.mrpUom);
    } catch {
      mrpPerBasePaise = null; // an MRP printed on a pack the item does not have: shown as missing, never guessed
    }
    rows.push({
      storeResourceId: p.resourceId, storeCode: s.code, storeName: s.name,
      itemId: b.itemId, itemCode: b.itemCode, itemName: b.itemName, baseUom: b.baseUom, hsnCode: b.hsnCode,
      batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, ownership: b.ownership,
      qtyBase, landedCostPaise: b.landedCostPaise, costValuePaise: qtyBase * b.landedCostPaise,
      mrpPerBasePaise, mrpValuePaise: mrpPerBasePaise === null ? null : qtyBase * mrpPerBasePaise,
    });
  }
  rows.sort((a, b) => a.storeCode.localeCompare(b.storeCode) || a.itemName.localeCompare(b.itemName) || a.batchNo.localeCompare(b.batchNo));

  const byStore = new Map<string, ValuationGroup>();
  const byItem = new Map<string, ValuationGroup & { baseUom: string }>();
  for (const r of rows) {
    const s = byStore.get(r.storeResourceId) ?? { key: r.storeResourceId, code: r.storeCode, name: r.storeName, batches: 0, qtyBase: null, costValuePaise: 0, mrpValuePaise: 0 };
    s.batches += 1;
    s.costValuePaise += r.costValuePaise;
    s.mrpValuePaise += r.mrpValuePaise ?? 0;
    byStore.set(r.storeResourceId, s);
    const i = byItem.get(r.itemId) ?? { key: r.itemId, code: r.itemCode, name: r.itemName, baseUom: r.baseUom, batches: 0, qtyBase: 0, costValuePaise: 0, mrpValuePaise: 0 };
    i.batches += 1;
    i.qtyBase = (i.qtyBase ?? 0) + r.qtyBase;
    i.costValuePaise += r.costValuePaise;
    i.mrpValuePaise += r.mrpValuePaise ?? 0;
    byItem.set(r.itemId, i);
  }
  return {
    asOf, rows,
    byStore: [...byStore.values()].sort((a, b) => a.code.localeCompare(b.code)),
    byItem: [...byItem.values()].sort((a, b) => b.costValuePaise - a.costValuePaise || a.name.localeCompare(b.name)),
    totals: {
      batches: rows.length, costValuePaise: rows.reduce((s, r) => s + r.costValuePaise, 0),
      mrpValuePaise: rows.reduce((s, r) => s + (r.mrpValuePaise ?? 0), 0), noMrpBatches: rows.filter((r) => r.mrpValuePaise === null).length,
    },
    vendorOwned, truncated,
  };
}

// ═══════════════════════════════════ non-moving / dead stock ═══════════════════════════════════

export const NON_MOVING_PRESETS = [30, 60, 90, 180] as const;
/** Movements that take stock OUT to be used: a sale or dispense (`consume`) and an issue to another store. */
const MOVING_REASONS = ["consume", "issue"] as const;

export type NonMovingSuggestion = "return" | "write_off" | "watch";
export type NonMovingRow = {
  storeResourceId: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; baseUom: string;
  batchId: string; batchNo: string; expiryDate: string | null; ownership: string; recalled: boolean;
  qtyBase: number; landedCostPaise: number; costValuePaise: number;
  /** The last time the ITEM left THIS store (a sale, a dispense or an issue), or null if it never has. */
  lastMovedAt: string | null;
  /** Whole IST days since then; null when it never moved. */
  idleDays: number | null;
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind;
  /**
   * What the agent would do: `return` it to the supplier (P4's draft return — expired inside the
   * window, near expiry or recalled, owned, from a real supplier), `write_off` it (expired and it
   * cannot go back), or `watch` it (in date: a person decides — transfer it, ask the supplier).
   */
  suggestion: NonMovingSuggestion;
  returnableUntil: string | null;
};
export type NonMovingReport = {
  asOf: string; days: number; since: string; rows: NonMovingRow[];
  totals: { batches: number; items: number; costValuePaise: number; returnValuePaise: number; writeOffValuePaise: number };
  truncated: boolean;
};

/**
 * STOCK ON HAND WHOSE ITEM HAS NOT MOVED IN `days` DAYS, by store: no `consume` or `issue` out of
 * that store since the IST midnight `days` days before today. The boundary is inclusive of that day
 * — something that moved on it has moved within the window. Only the hospital's own stock is listed
 * (the vendor's consignment is the vendor's to worry about).
 */
export async function nonMovingStock(
  db: Db | Tx, now: Date, days: number, opts: { storeResourceId?: string | null } = {},
): Promise<NonMovingReport> {
  const today = istDay(now);
  const since = addDays(today, -days);
  const sinceAt = istDayStart(since);
  const onHand = await db.select({
    storeResourceId: stockBalances.resourceId, storeCode: resources.code, storeName: resources.name,
    itemId: items.id, itemCode: items.code, itemName: items.name, baseUom: items.baseUom,
    batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, ownership: stockBatches.ownership,
    recallStatus: stockBatches.recallStatus, landedCostPaise: stockBatches.landedCostPaise, qtyBase: stockBalances.qtyOnHand,
    vendorId: stockBatches.vendorId, vendorCode: vendors.code, vendorName: sql<string | null>`coalesce(${vendors.tradeName}, ${vendors.legalName})`,
    vendorReturnDays: vendors.expiryReturnDays,
  }).from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .innerJoin(resources, eq(resources.id, stockBalances.resourceId))
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(and(
      sql`${stockBalances.qtyOnHand} > 0`,
      sql`lower(${resources.code}) <> ${TRANSIT_STORE_CODE.toLowerCase()}`,
      inArray(stockBatches.ownership, [...VALUED_OWNERSHIPS]),
      ...(opts.storeResourceId == null ? [] : [eq(stockBalances.resourceId, opts.storeResourceId)]),
    ));
  // The last time each (store, item) had stock leave to be used — one grouped read over the pairs held.
  const itemIds = [...new Set(onHand.map((r) => r.itemId))];
  const last = await inChunks(itemIds, (chunk) => db.select({
    resourceId: stockLedger.resourceId, itemId: stockLedger.itemId, at: sql<Date>`max(${stockLedger.occurredAt})`,
  }).from(stockLedger)
    .where(and(inArray(stockLedger.itemId, chunk), inArray(stockLedger.reason, [...MOVING_REASONS]), lt(stockLedger.qtyDelta, 0)))
    .groupBy(stockLedger.resourceId, stockLedger.itemId));
  const lastAt = new Map(last.map((l) => [`${l.resourceId}|${l.itemId}`, new Date(l.at)] as const));

  const rows: NonMovingRow[] = [];
  for (const r of onHand) {
    const moved = lastAt.get(`${r.storeResourceId}|${r.itemId}`) ?? null;
    if (moved !== null && moved >= sinceAt) continue;
    const kind = supplierKindOf(r.vendorCode === null ? null : { code: r.vendorCode });
    const recalled = r.recallStatus === "frozen";
    const v = returnVerdict({ expiryDate: r.expiryDate, windowDays: returnWindowDays({ expiryReturnDays: r.vendorReturnDays }), recalled, today });
    const canGoBack = kind === "supplier" && r.ownership === "owned";
    const suggestion: NonMovingSuggestion = canGoBack && v.returnable ? "return"
      : v.reason === "expired" || (recalled && !canGoBack) ? "write_off" : "watch";
    rows.push({
      storeResourceId: r.storeResourceId, storeCode: r.storeCode, storeName: r.storeName,
      itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, baseUom: r.baseUom,
      batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate, ownership: r.ownership, recalled,
      qtyBase: r.qtyBase, landedCostPaise: r.landedCostPaise, costValuePaise: r.qtyBase * r.landedCostPaise,
      lastMovedAt: moved === null ? null : moved.toISOString(), idleDays: moved === null ? null : daysBetween(istDay(moved), today),
      vendorId: r.vendorId, supplierName: r.vendorName ?? "—", supplierKind: kind, suggestion,
      returnableUntil: canGoBack && v.until !== null && !recalled ? v.until : null,
    });
  }
  rows.sort((a, b) => b.costValuePaise - a.costValuePaise || a.itemName.localeCompare(b.itemName) || a.batchNo.localeCompare(b.batchNo));
  const truncated = rows.length > NON_MOVING_ROW_LIMIT;
  const shown = rows.slice(0, NON_MOVING_ROW_LIMIT);
  return {
    asOf: today, days, since, rows: shown,
    totals: {
      batches: rows.length, items: new Set(rows.map((r) => `${r.storeResourceId}|${r.itemId}`)).size,
      costValuePaise: rows.reduce((s, r) => s + r.costValuePaise, 0),
      returnValuePaise: rows.filter((r) => r.suggestion === "return").reduce((s, r) => s + r.costValuePaise, 0),
      writeOffValuePaise: rows.filter((r) => r.suggestion === "write_off").reduce((s, r) => s + r.costValuePaise, 0),
    },
    truncated,
  };
}

// ═══════════════════════════════════ what a GSTR-2B statement is matched against ═══════════════════════════════════

export type ReconBill = {
  id: string; billNo: string; vendorId: string; vendorName: string; gstin: string | null; vendorBillNo: string; billDate: string; status: string;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number;
};

/**
 * The bills IN THE BOOKS for a return period: every bill dated `from`..`to` that has been entered and
 * matched — held and matched bills included (the vendor filed them whatever our match said), drafts
 * and cancelled bills not.
 */
export async function billsForReconciliation(db: Db | Tx, from: string, to: string): Promise<ReconBill[]> {
  return db.select({
    id: supplierBills.id, billNo: supplierBills.billNo, vendorId: supplierBills.vendorId, vendorName, gstin: vendors.gstin,
    vendorBillNo: supplierBills.vendorBillNo, billDate: supplierBills.billDate, status: supplierBills.status,
    taxablePaise: supplierBills.taxablePaise, cgstPaise: supplierBills.cgstPaise, sgstPaise: supplierBills.sgstPaise, igstPaise: supplierBills.igstPaise,
    totalPaise: supplierBills.totalPaise,
  }).from(supplierBills).innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
    .where(and(gte(supplierBills.billDate, from), lte(supplierBills.billDate, to), notInArray(supplierBills.status, ["draft", "cancelled"])))
    .orderBy(asc(supplierBills.billDate), asc(supplierBills.billNo));
}

// ═══════════════════════════════════ a document number, to its document ═══════════════════════════════════

export type MaterialsDocKind = "supplier_bill" | "payment_run" | "supplier_return" | "supplier_credit" | "write_off";
export type MaterialsDocRef = { kind: MaterialsDocKind; id: string; no: string; label: string; ids: string[] };

/**
 * The document a person typed the number of: our bill (`MSB…`), payment run (`MPR…`), return
 * (`MRT…`) or its debit note (`MDN…`), the vendor's credit as booked (`MCN…`, which answers to its
 * return), or a write-off (`MWO…`). Case and surrounding spaces are ignored. `ids` are every id whose
 * events belong on the document's timeline (a credit note's return, a return's credit notes).
 */
export async function findDocumentByNo(db: Db | Tx, typed: string): Promise<MaterialsDocRef | null> {
  const no = typed.trim().toUpperCase();
  if (no === "") return null;
  const eqNo = (col: AnyPgColumn): SQL => sql`upper(${col}) = ${no}`;
  const bill = (await db.select({ id: supplierBills.id, no: supplierBills.billNo, v: vendorName, vb: supplierBills.vendorBillNo })
    .from(supplierBills).innerJoin(vendors, eq(vendors.id, supplierBills.vendorId)).where(eqNo(supplierBills.billNo)).limit(1))[0];
  if (bill !== undefined) return { kind: "supplier_bill", id: bill.id, no: bill.no, label: `${bill.v} · ${bill.vb}`, ids: [bill.id] };
  const run = (await db.select({ id: supplierPaymentRuns.id, no: supplierPaymentRuns.runNo }).from(supplierPaymentRuns).where(eqNo(supplierPaymentRuns.runNo)).limit(1))[0];
  if (run !== undefined) return { kind: "payment_run", id: run.id, no: run.no, label: run.no, ids: [run.id] };
  const ret = (await db.select({ id: supplierReturns.id, no: supplierReturns.returnNo, dn: supplierReturns.debitNoteNo, v: vendorName })
    .from(supplierReturns).innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId))
    .where(sql`upper(${supplierReturns.returnNo}) = ${no} or upper(${supplierReturns.debitNoteNo}) = ${no}`).limit(1))[0];
  if (ret !== undefined) {
    const credits = await db.select({ id: supplierCreditNotes.id }).from(supplierCreditNotes).where(eq(supplierCreditNotes.returnId, ret.id));
    return { kind: "supplier_return", id: ret.id, no: ret.dn ?? ret.no, label: `${ret.v} · ${ret.no}`, ids: [ret.id, ...credits.map((c) => c.id)] };
  }
  const credit = (await db.select({ id: supplierCreditNotes.id, no: supplierCreditNotes.creditNo, returnId: supplierCreditNotes.returnId, v: vendorName })
    .from(supplierCreditNotes).innerJoin(vendors, eq(vendors.id, supplierCreditNotes.vendorId)).where(eqNo(supplierCreditNotes.creditNo)).limit(1))[0];
  if (credit !== undefined) return { kind: "supplier_credit", id: credit.id, no: credit.no, label: `${credit.v} · ${credit.no}`, ids: [credit.returnId, credit.id] };
  const wo = (await db.select({ id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo, s: resources.name })
    .from(stockWriteOffs).innerJoin(resources, eq(resources.id, stockWriteOffs.storeResourceId)).where(eqNo(stockWriteOffs.writeOffNo)).limit(1))[0];
  if (wo !== undefined) return { kind: "write_off", id: wo.id, no: wo.no, label: `${wo.s} · ${wo.no}`, ids: [wo.id] };
  return null;
}

