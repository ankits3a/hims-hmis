import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { assertNotSodPair } from "../../kernel/auth/sod";
import { hasPermission } from "../../kernel/auth/permissions";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  grnLines, grns, itemUoms, items, purchaseOrderLines, resources, stockBalances, stockBatches, stockRecalls, stockWriteOffLines,
  stockWriteOffs, supplierBillLines, supplierBills, supplierCreditNotes, supplierReturnLines, supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import {
  EXPIRY_REPORT_PRESET_DAYS, EXPIRY_RETURN_WINDOW_DAYS, NEAR_EXPIRY_RETURN_DAYS, NON_SUPPLIER_VENDOR_CODES, TRANSIT_STORE_CODE,
} from "./config";
import { MaterialsError } from "./errors";
import {
  supplierCreditCancelled, supplierCreditRecorded, supplierReturnApproved, supplierReturnCancelled, supplierReturnClosed,
  supplierReturnDispatched, supplierReturnDrafted, supplierReturnUpdated,
} from "./events";
import { istDay } from "./grn";
import { postMovements } from "./ledger";
import { lineGstPaise } from "./purchase-orders";
import { addDays, daysBetween, vendorCredits } from "./supplier-bills";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P4 — THE RETURN TO THE SUPPLIER, OUR DEBIT NOTE, THE VENDOR'S CREDIT ═══
 *
 * Plan `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md`, P4. Healthray's expiry report
 * (s13/s14) and its "Credit Note Created" flag, our way: the expiry list tells a person what can still
 * go back, the AGENT drafts one return per vendor, and people do the rest.
 *
 *   draft ─approve (`materials.returns.approve`, the head; never the drafter)→ approved
 *     ─dispatch (`materials.returns.manage`; never the approver)→ dispatched + OUR DEBIT NOTE (`MDN…`)
 *     ─the vendor's credit note (`materials.bills.manage`)→ credited      or ─no credit coming (the head)→ closed
 *   draft / approved ─cancel→ cancelled
 *
 * - **What may go back** (`returnVerdict`, pure): an EXPIRED batch up to the vendor's return window
 *   after expiry (`EXPIRY_RETURN_WINDOW_DAYS` = 90, `vendors.expiry_return_days` overrides —
 *   DEFAULT, owner may change); a NEAR-EXPIRY batch (expiring within `NEAR_EXPIRY_RETURN_DAYS`) at any
 *   time; a RECALLED batch whatever its date; a DAMAGED batch when a person says so. Only OWNED stock,
 *   only to the vendor whose GRN brought the batch in, never the hospital's own opening or trial
 *   stock (`NON_SUPPLIER_VENDOR_CODES`).
 * - **How much**: never more than the store holds less what is RESERVED (a pick in progress), less
 *   what is FROZEN unless the batch itself is recalled (then the frozen stock is exactly what goes),
 *   less what other live returns and requested write-offs already hold of that store's batch.
 * - **At what rate**: the GRN's cost for the batch (`stock_batches.landed_cost_paise`, per base unit,
 *   before GST); GST at the rate the purchase was billed at (the supplier bill's line, else the PO's,
 *   else the item's), half up per line, split CGST + SGST or IGST as the purchase was — the input-GST
 *   reversal P5 exports.
 * - **Dispatch** posts one `return` ledger row out per line (a recalled batch through the ledger's
 *   `recallExit`, its only way out) and issues the debit note: number, date, the vendor's GSTIN as it
 *   stands, the lines and the GST split.
 * - **The vendor's credit note** may be less than the debit note; the difference needs a reason and
 *   the head (`materials.bills.accept_difference`). Accepted, it is an OFFSET the next payment run
 *   spends (`payments.ts`), and a debit row in the supplier ledger.
 */

const RETURNS_MANAGE = "materials.returns.manage";
const RETURNS_APPROVE = "materials.returns.approve";
const BILLS_MANAGE = "materials.bills.manage";
const ACCEPT_DIFFERENCE = "materials.bills.accept_difference";
const STOCK_READ = "materials.stock.read";
const RETURN_READERS = [RETURNS_MANAGE, RETURNS_APPROVE, BILLS_MANAGE, ACCEPT_DIFFERENCE, "materials.payments.prepare"];

export type ReturnStatus = "draft" | "approved" | "dispatched" | "credited" | "closed" | "cancelled";
export type ReturnSource = "manual" | "agent" | "recall";
export type ReturnLineReason = "expired" | "near_expiry" | "damaged" | "recalled";
export const RETURN_LINE_REASONS: readonly ReturnLineReason[] = ["expired", "near_expiry", "damaged", "recalled"];
const LIVE_RETURN: readonly ReturnStatus[] = ["draft", "approved"];

export type ReturnLineInput = {
  batchId: string;
  storeResourceId: string;
  qtyBase: number;
  reason: ReturnLineReason;
  /** Per BASE unit before GST. Defaults to the GRN's cost for the batch. */
  ratePaise?: number | null;
  /** Defaults to the rate the purchase was billed at. */
  gstRateBps?: number | null;
};

export type ReturnInput = { vendorId: string; interState?: boolean; note?: string | null; lines: ReturnLineInput[] };

export type SupplierKind = "supplier" | "opening" | "trial" | "none";

const MAX_LINES = 300;
const MAX_RATE_PAISE = 1_000_000_000;
const MAX_QTY = 10_000_000;
const MAX_TEXT = 500;

// ═══════════════════════════════════ small pure pieces ═══════════════════════════════════

/** The vendor's return window in days after expiry: its own, else the configured default. */
export function returnWindowDays(vendor: { expiryReturnDays: number | null } | null): number {
  return vendor?.expiryReturnDays ?? EXPIRY_RETURN_WINDOW_DAYS;
}

/** The last day an expired batch may still go back: expiry + window (inclusive). */
export function returnableUntil(expiryDate: string, windowDays: number): string {
  return addDays(expiryDate, windowDays);
}

export type ReturnVerdict = {
  /** Why it would go back now, or null when nothing about its date sends it back. */
  reason: "expired" | "near_expiry" | "recalled" | null;
  returnable: boolean;
  until: string | null;
  /** Expired and past the window: it is destroyed, not returned. */
  pastWindow: boolean;
};

/**
 * THE RETURN WINDOW, PURE. `today` and `expiryDate` are IST calendar dates; the expiry date is the
 * last day the batch may be used, so a batch expiring TODAY is near expiry, not expired.
 *   - recalled → goes back whatever its date;
 *   - expired → goes back while `today ≤ expiry + window`, and is past the window after;
 *   - expiring within `NEAR_EXPIRY_RETURN_DAYS` → goes back at any time;
 *   - otherwise, or no expiry recorded → nothing about its date sends it back.
 */
export function returnVerdict(input: { expiryDate: string | null; windowDays: number; recalled: boolean; today: string }): ReturnVerdict {
  const until = input.expiryDate === null ? null : returnableUntil(input.expiryDate, input.windowDays);
  if (input.recalled) return { reason: "recalled", returnable: true, until, pastWindow: false };
  if (input.expiryDate === null) return { reason: null, returnable: false, until: null, pastWindow: false };
  if (input.expiryDate < input.today) {
    const inside = input.today <= until!;
    return { reason: "expired", returnable: inside, until, pastWindow: !inside };
  }
  if (daysBetween(input.today, input.expiryDate) <= NEAR_EXPIRY_RETURN_DAYS) return { reason: "near_expiry", returnable: true, until, pastWindow: false };
  return { reason: null, returnable: false, until, pastWindow: false };
}

/** Who a batch came from: a real supplier, the hospital's opening or trial stock, or nobody. */
export function supplierKindOf(vendor: { code: string } | null): SupplierKind {
  if (vendor === null) return "none";
  const code = vendor.code.toUpperCase();
  if (code === NON_SUPPLIER_VENDOR_CODES[0]) return "opening";
  if (code === NON_SUPPLIER_VENDOR_CODES[1]) return "trial";
  return "supplier";
}

/**
 * What may leave a (store, batch) for a supplier or for destruction: on hand, less reserved, less
 * frozen — unless the batch is recalled, when the frozen stock is exactly what may go.
 */
export function exitAvailable(b: { qtyOnHand: number; qtyReserved: number; qtyFrozen: number }, recalled: boolean): number {
  return Math.max(0, b.qtyOnHand - b.qtyReserved - (recalled ? 0 : b.qtyFrozen));
}

/** CGST + SGST halves (SGST takes the odd paisa) or IGST whole — the supplier bill's split. */
export function splitGst(gst: number, interState: boolean): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (interState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: gst };
  const c = Math.floor(gst / 2);
  return { cgstPaise: c, sgstPaise: gst - c, igstPaise: 0 };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const pairKey = (storeResourceId: string, batchId: string): string => `${storeResourceId}|${batchId}`;
const isTransit = (code: string): boolean => code.toLowerCase() === TRANSIT_STORE_CODE.toLowerCase();

// ═══════════════════════════════════ who may ═══════════════════════════════════

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

/** Returns are read by whoever drafts, approves or dispatches them, records their credit, or pays. */
export async function requireReturnsReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user") {
    for (const p of RETURN_READERS) if (await hasPermission(db, actor.id, p, "hospital")) return;
  }
  throw new MaterialsError("permission_denied", `reading supplier returns needs one of ${RETURN_READERS.join(", ")}`);
}

// ═══════════════════════════════════ what live documents already hold ═══════════════════════════════════

/**
 * What live documents already hold of each (store, batch): draft and approved returns, and
 * write-offs awaiting their approval. Keyed `store|batch`. A document named in `except` is left out
 * (it is being re-written).
 */
export async function committedByPair(
  db: Db | Tx, batchIds: readonly string[], except: { returnId?: string; writeOffId?: string } = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(batchIds)];
  if (wanted.length === 0) return out;
  const onReturns = await db.select({
    store: supplierReturnLines.storeResourceId, batch: supplierReturnLines.batchId, qty: sql<string>`sum(${supplierReturnLines.qtyBase})`,
  }).from(supplierReturnLines).innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
    .where(and(
      inArray(supplierReturnLines.batchId, wanted), inArray(supplierReturns.status, [...LIVE_RETURN]),
      ...(except.returnId === undefined ? [] : [ne(supplierReturns.id, except.returnId)]),
    ))
    .groupBy(supplierReturnLines.storeResourceId, supplierReturnLines.batchId);
  const onWriteOffs = await db.select({
    store: stockWriteOffs.storeResourceId, batch: stockWriteOffLines.batchId, qty: sql<string>`sum(${stockWriteOffLines.qtyBase})`,
  }).from(stockWriteOffLines).innerJoin(stockWriteOffs, eq(stockWriteOffs.id, stockWriteOffLines.writeOffId))
    .where(and(
      inArray(stockWriteOffLines.batchId, wanted), eq(stockWriteOffs.status, "requested"),
      ...(except.writeOffId === undefined ? [] : [ne(stockWriteOffs.id, except.writeOffId)]),
    ))
    .groupBy(stockWriteOffs.storeResourceId, stockWriteOffLines.batchId);
  for (const r of [...onReturns, ...onWriteOffs]) {
    const k = pairKey(r.store, r.batch);
    out.set(k, (out.get(k) ?? 0) + Number(r.qty));
  }
  return out;
}

// ═══════════════════════════════════ the stock the report and the plan read ═══════════════════════════════════

type StockRow = {
  storeResourceId: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; baseUom: string; hsnCode: string | null; itemGstRateBps: number | null;
  batchId: string; batchNo: string; expiryDate: string | null; mrpPaise: number | null; mrpUom: string | null; landedCostPaise: number;
  ownership: string; recalled: boolean; grnLineId: string | null;
  vendorId: string | null; vendorCode: string | null; vendorName: string | null; vendorGstin: string | null; vendorReturnDays: number | null;
  onHand: number; reserved: number; frozen: number;
};

const ROW_LIMIT = 5_000;

async function stockRows(
  db: Db | Tx,
  where: {
    expiryFrom?: string | null; expiryTo?: string | null; orRecalled?: boolean; storeResourceId?: string | null; batchIds?: readonly string[];
    /** Every batch named, whatever its date (the recall's return). */
    anyExpiry?: boolean;
  },
): Promise<StockRow[]> {
  const dated = [
    sql`${stockBatches.expiryDate} is not null`,
    ...(where.expiryFrom == null ? [] : [gte(stockBatches.expiryDate, where.expiryFrom)]),
    ...(where.expiryTo == null ? [] : [lte(stockBatches.expiryDate, where.expiryTo)]),
  ];
  const window = where.anyExpiry === true ? undefined
    : where.orRecalled === true ? or(and(...dated), eq(stockBatches.recallStatus, "frozen")) : and(...dated);
  const rows = await db.select({
    storeResourceId: stockBalances.resourceId, storeCode: resources.code, storeName: resources.name,
    itemId: items.id, itemCode: items.code, itemName: items.name, baseUom: items.baseUom, hsnCode: items.hsnCode, itemGstRateBps: items.gstRateBps,
    batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, mrpPaise: stockBatches.mrpPaise,
    mrpUom: stockBatches.mrpUom, landedCostPaise: stockBatches.landedCostPaise, ownership: stockBatches.ownership,
    recallStatus: stockBatches.recallStatus, grnLineId: stockBatches.grnLineId,
    vendorId: stockBatches.vendorId, vendorCode: vendors.code, vendorName: sql<string | null>`coalesce(${vendors.tradeName}, ${vendors.legalName})`,
    vendorGstin: vendors.gstin, vendorReturnDays: vendors.expiryReturnDays,
    onHand: stockBalances.qtyOnHand, reserved: stockBalances.qtyReserved, frozen: stockBalances.qtyFrozen,
  })
    .from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .innerJoin(resources, eq(resources.id, stockBalances.resourceId))
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(and(
      sql`${stockBalances.qtyOnHand} > 0`,
      sql`lower(${resources.code}) <> ${TRANSIT_STORE_CODE.toLowerCase()}`,
      window,
      ...(where.storeResourceId == null ? [] : [eq(stockBalances.resourceId, where.storeResourceId)]),
      ...(where.batchIds === undefined ? [] : [inArray(stockBalances.batchId, [...where.batchIds])]),
    ))
    .orderBy(sql`${stockBatches.expiryDate} asc nulls last`, asc(items.name), asc(stockBatches.batchNo), asc(resources.code))
    .limit(ROW_LIMIT);
  return rows.map(({ recallStatus, ...r }) => ({ ...r, recalled: recallStatus === "frozen" }));
}

/** The pack a person counts in: the item's purchase pack, if it has one bigger than the base unit. */
async function packsOf(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, { uom: string; multiplier: number }>> {
  const out = new Map<string, { uom: string; multiplier: number }>();
  const wanted = [...new Set(itemIds)];
  if (wanted.length === 0) return out;
  const rows = await db.select().from(itemUoms).where(inArray(itemUoms.itemId, wanted));
  for (const id of wanted) {
    const mine = rows.filter((r) => r.itemId === id && r.toBaseMultiplier > 1);
    const pick = mine.find((r) => r.isPurchaseUom) ?? mine.sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier)[0];
    if (pick !== undefined) out.set(id, { uom: pick.uom, multiplier: pick.toBaseMultiplier });
  }
  return out;
}

/**
 * The GST rate each batch was PURCHASED at: the live supplier bill's line for its GRN and item, else
 * the purchase order's line, else absent (the caller falls back to the item's rate). The debit note
 * reverses the input tax actually taken, so it reads what was billed first.
 */
async function purchaseGstRates(db: Db | Tx, batches: readonly { batchId: string; itemId: string; grnLineId: string | null }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lineIds = [...new Set(batches.map((b) => b.grnLineId).filter((x): x is string => x !== null))];
  if (lineIds.length === 0) return out;
  const gl = await db.select({ id: grnLines.id, grnId: grnLines.grnId, itemId: grnLines.itemId, poId: grns.purchaseOrderId })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).where(inArray(grnLines.id, lineIds));
  const grnIds = [...new Set(gl.map((g) => g.grnId))];
  const billed = grnIds.length === 0 ? [] : await db.select({ grnId: supplierBillLines.grnId, itemId: supplierBillLines.itemId, bps: supplierBillLines.gstRateBps })
    .from(supplierBillLines).innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(inArray(supplierBillLines.grnId, grnIds), ne(supplierBills.status, "cancelled")));
  const poIds = [...new Set(gl.map((g) => g.poId).filter((x): x is string => x !== null))];
  const ordered = poIds.length === 0 ? [] : await db.select().from(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, poIds));
  for (const b of batches) {
    const g = gl.find((x) => x.id === b.grnLineId);
    if (g === undefined) continue;
    const bill = billed.find((x) => x.grnId === g.grnId && x.itemId === b.itemId);
    const po = g.poId === null ? undefined : ordered.find((x) => x.purchaseOrderId === g.poId && x.itemId === b.itemId);
    const bps = bill?.bps ?? po?.gstRateBps;
    if (bps !== undefined) out.set(b.batchId, bps);
  }
  return out;
}

// ═══════════════════════════════════ the expiry report ═══════════════════════════════════

export type ExpiryPreset = "expired" | "30" | "60" | "90" | "custom";
export const EXPIRY_PRESETS: readonly ExpiryPreset[] = ["expired", ...EXPIRY_REPORT_PRESET_DAYS.map((d) => String(d) as ExpiryPreset), "custom"];

export type ExpiryReportRow = {
  storeResourceId: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; baseUom: string;
  batchId: string; batchNo: string; expiryDate: string; daysToExpiry: number;
  qtyBase: number; pack: { uom: string; multiplier: number } | null; packs: number; loose: number;
  mrpPaise: number | null; mrpUom: string | null; landedCostPaise: number; costValuePaise: number;
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind; ownership: string;
  recalled: boolean; reserved: number; frozen: number;
  /** The last day it may go back to its supplier (expiry + window), or null when it cannot go back at all. */
  returnableUntil: string | null;
  /** Could a return be drafted for it today. */
  returnable: boolean;
  /** Healthray's "Credit Note Created": the latest return (not cancelled) carrying this store's batch. */
  returnRaised: { returnId: string; returnNo: string; status: ReturnStatus } | null;
  writeOffRaised: { writeOffId: string; writeOffNo: string; status: string } | null;
};

export type ExpirySupplierRow = {
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind; rows: number; qtyBase: number;
  costValuePaise: number; returnableValuePaise: number;
};

export type ExpiryReport = {
  asOf: string; preset: ExpiryPreset; from: string | null; to: string | null;
  rows: ExpiryReportRow[]; suppliers: ExpirySupplierRow[]; costValuePaise: number; truncated: boolean;
};

/** The dates a preset means, today in IST: expired = before today; N = today … today + N; custom = as given. */
export function expiryRange(preset: ExpiryPreset, today: string, custom: { from?: string | null; to?: string | null } = {}): { from: string | null; to: string | null } {
  if (preset === "expired") return { from: null, to: addDays(today, -1) };
  if (preset === "custom") {
    const from = custom.from ?? null;
    const to = custom.to ?? null;
    if (from === null || to === null || !isIsoDate(from) || !isIsoDate(to) || from > to) {
      throw new MaterialsError("return_invalid", "a custom expiry range needs a from date on or before its to date");
    }
    if (daysBetween(from, to) > 3 * 366) throw new MaterialsError("return_invalid", "a custom expiry range spans at most three years");
    return { from, to };
  }
  return { from: today, to: addDays(today, Number(preset)) };
}

/**
 * THE EXPIRY REPORT (Healthray s13/s14): every store's stock of a batch expiring in the range, with
 * its cost value, its supplier (the vendor of the GRN that brought it in; the hospital's OPENING and
 * TRIAL stock shown as such), the last day it may go back, and whether a return or a write-off has
 * been raised for it. Item-wise rows and the Supplier-wise sums; the screen exports both.
 */
export async function expiryReport(
  db: Db, actor: Actor,
  input: { preset: ExpiryPreset; from?: string | null; to?: string | null; storeResourceId?: string | null },
  now: Date = new Date(),
): Promise<ExpiryReport> {
  await requirePerm(db, actor, STOCK_READ, "reading the expiry report");
  if (!EXPIRY_PRESETS.includes(input.preset)) throw new MaterialsError("return_invalid", `"${String(input.preset)}" is not an expiry preset`);
  const today = istDay(now);
  const { from, to } = expiryRange(input.preset, today, input);
  const rows = await stockRows(db, { expiryFrom: from, expiryTo: to, storeResourceId: input.storeResourceId ?? null });
  const batchIds = [...new Set(rows.map((r) => r.batchId))];
  const packs = await packsOf(db, rows.map((r) => r.itemId));
  const committed = await committedByPair(db, batchIds);
  const raised = batchIds.length === 0 ? [] : await db.select({
    store: supplierReturnLines.storeResourceId, batch: supplierReturnLines.batchId, id: supplierReturns.id, no: supplierReturns.returnNo,
    status: supplierReturns.status, at: supplierReturns.createdAt,
  }).from(supplierReturnLines).innerJoin(supplierReturns, eq(supplierReturns.id, supplierReturnLines.returnId))
    .where(and(inArray(supplierReturnLines.batchId, batchIds), ne(supplierReturns.status, "cancelled")))
    .orderBy(desc(supplierReturns.createdAt));
  const destroyed = batchIds.length === 0 ? [] : await db.select({
    store: stockWriteOffs.storeResourceId, batch: stockWriteOffLines.batchId, id: stockWriteOffs.id, no: stockWriteOffs.writeOffNo, status: stockWriteOffs.status,
  }).from(stockWriteOffLines).innerJoin(stockWriteOffs, eq(stockWriteOffs.id, stockWriteOffLines.writeOffId))
    .where(and(inArray(stockWriteOffLines.batchId, batchIds), ne(stockWriteOffs.status, "refused")))
    .orderBy(desc(stockWriteOffs.requestedAt));
  const out: ExpiryReportRow[] = rows.map((r) => {
    const kind = supplierKindOf(r.vendorCode === null ? null : { code: r.vendorCode });
    const canGoBack = kind === "supplier" && r.ownership === "owned";
    const v = returnVerdict({ expiryDate: r.expiryDate, windowDays: returnWindowDays({ expiryReturnDays: r.vendorReturnDays }), recalled: r.recalled, today });
    const pack = packs.get(r.itemId) ?? null;
    const free = exitAvailable({ qtyOnHand: r.onHand, qtyReserved: r.reserved, qtyFrozen: r.frozen }, r.recalled) - (committed.get(pairKey(r.storeResourceId, r.batchId)) ?? 0);
    const ret = raised.find((x) => x.store === r.storeResourceId && x.batch === r.batchId);
    const wo = destroyed.find((x) => x.store === r.storeResourceId && x.batch === r.batchId);
    return {
      storeResourceId: r.storeResourceId, storeCode: r.storeCode, storeName: r.storeName,
      itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, baseUom: r.baseUom,
      batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate!, daysToExpiry: daysBetween(today, r.expiryDate!),
      qtyBase: r.onHand, pack, packs: pack === null ? 0 : Math.floor(r.onHand / pack.multiplier), loose: pack === null ? r.onHand : r.onHand % pack.multiplier,
      mrpPaise: r.mrpPaise, mrpUom: r.mrpUom, landedCostPaise: r.landedCostPaise, costValuePaise: r.onHand * r.landedCostPaise,
      vendorId: r.vendorId, supplierName: r.vendorName ?? "—", supplierKind: kind, ownership: r.ownership,
      recalled: r.recalled, reserved: r.reserved, frozen: r.frozen,
      returnableUntil: canGoBack ? (r.recalled ? null : v.until) : null,
      returnable: canGoBack && v.returnable && free > 0,
      returnRaised: ret === undefined ? null : { returnId: ret.id, returnNo: ret.no, status: ret.status as ReturnStatus },
      writeOffRaised: wo === undefined ? null : { writeOffId: wo.id, writeOffNo: wo.no, status: wo.status },
    };
  });
  const bySupplier = new Map<string, ExpirySupplierRow>();
  for (const r of out) {
    const k = r.vendorId ?? "none";
    const s = bySupplier.get(k) ?? { vendorId: r.vendorId, supplierName: r.supplierName, supplierKind: r.supplierKind, rows: 0, qtyBase: 0, costValuePaise: 0, returnableValuePaise: 0 };
    s.rows += 1;
    s.qtyBase += r.qtyBase;
    s.costValuePaise += r.costValuePaise;
    if (r.returnable) s.returnableValuePaise += r.costValuePaise;
    bySupplier.set(k, s);
  }
  const suppliers = [...bySupplier.values()].sort((a, b) =>
    Number(a.supplierKind !== "supplier") - Number(b.supplierKind !== "supplier") || b.costValuePaise - a.costValuePaise || a.supplierName.localeCompare(b.supplierName));
  return {
    asOf: today, preset: input.preset, from, to, rows: out, suppliers,
    costValuePaise: out.reduce((s, r) => s + r.costValuePaise, 0), truncated: rows.length >= ROW_LIMIT,
  };
}

// ═══════════════════════════════════ the agent's plan ═══════════════════════════════════

export type ReturnPlanLine = {
  itemId: string; itemCode: string; itemName: string; hsnCode: string | null;
  batchId: string; batchNo: string; expiryDate: string | null; storeResourceId: string; storeCode: string; storeName: string;
  reason: ReturnLineReason; qtyBase: number; baseUom: string; pack: { uom: string; multiplier: number } | null;
  ratePaise: number; gstRateBps: number; taxablePaise: number; returnableUntil: string | null;
};
export type ReturnPlanGroup = {
  vendorId: string; vendorCode: string; vendorName: string; gstin: string | null; lines: ReturnPlanLine[]; taxablePaise: number;
};
export type DestroyCandidate = {
  itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string; expiryDate: string | null;
  storeResourceId: string; storeCode: string; storeName: string; qtyBase: number; baseUom: string; valuePaise: number;
  supplierName: string; why: "past_window" | "no_supplier";
};
export type ReturnPlan = {
  asOf: string;
  /** One draft return per vendor: expired within the window, near expiry, and recalled stock. */
  groups: ReturnPlanGroup[];
  /** Expired stock that cannot go back — the destruction write-off's list. */
  toDestroy: DestroyCandidate[];
  /** (store, batch) quantities left out because a live return or write-off already holds them. */
  alreadyHeld: number;
  taxablePaise: number;
};

/**
 * What the agent would put on returns now (writes nothing): every OWNED batch at every store that is
 * expired within its vendor's window, near expiry, or recalled, less what is reserved, frozen (unless
 * recalled) or already on a live return or write-off, grouped by the vendor that supplied it, at the
 * GRN's cost and the purchase's GST rate. Expired stock that cannot go back is listed apart.
 */
export async function planSupplierReturns(db: Db | Tx, now: Date = new Date(), opts: { storeResourceId?: string | null } = {}): Promise<ReturnPlan> {
  const today = istDay(now);
  const rows = (await stockRows(db, { expiryTo: addDays(today, NEAR_EXPIRY_RETURN_DAYS), orRecalled: true, storeResourceId: opts.storeResourceId ?? null }))
    .filter((r) => r.ownership === "owned" || r.ownership === "donated");
  const committed = await committedByPair(db, rows.map((r) => r.batchId));
  const gst = await purchaseGstRates(db, rows);
  const packs = await packsOf(db, rows.map((r) => r.itemId));
  const groups = new Map<string, ReturnPlanGroup>();
  const toDestroy: DestroyCandidate[] = [];
  let alreadyHeld = 0;
  for (const r of rows) {
    const held = committed.get(pairKey(r.storeResourceId, r.batchId)) ?? 0;
    const free = exitAvailable({ qtyOnHand: r.onHand, qtyReserved: r.reserved, qtyFrozen: r.frozen }, r.recalled) - held;
    if (held > 0) alreadyHeld += 1;
    if (free <= 0) continue;
    const kind = supplierKindOf(r.vendorCode === null ? null : { code: r.vendorCode });
    const v = returnVerdict({ expiryDate: r.expiryDate, windowDays: returnWindowDays({ expiryReturnDays: r.vendorReturnDays }), recalled: r.recalled, today });
    const destroy = (why: DestroyCandidate["why"]): void => {
      toDestroy.push({
        itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate,
        storeResourceId: r.storeResourceId, storeCode: r.storeCode, storeName: r.storeName, qtyBase: free, baseUom: r.baseUom,
        valuePaise: free * r.landedCostPaise, supplierName: r.vendorName ?? "—", why,
      });
    };
    if (kind !== "supplier" || r.ownership !== "owned" || r.vendorId === null) {
      // Nobody to send it back to: expired or recalled, it is destroyed. Near expiry, it is sold.
      if (v.reason === "expired" || v.reason === "recalled") destroy("no_supplier");
      continue;
    }
    if (v.pastWindow) { destroy("past_window"); continue; }
    if (!v.returnable || v.reason === null) continue;
    const rate = r.landedCostPaise;
    const g = groups.get(r.vendorId) ?? {
      vendorId: r.vendorId, vendorCode: r.vendorCode!, vendorName: r.vendorName ?? r.vendorCode!, gstin: r.vendorGstin, lines: [], taxablePaise: 0,
    };
    const line: ReturnPlanLine = {
      itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName, hsnCode: r.hsnCode,
      batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate, storeResourceId: r.storeResourceId, storeCode: r.storeCode, storeName: r.storeName,
      reason: v.reason, qtyBase: free, baseUom: r.baseUom, pack: packs.get(r.itemId) ?? null,
      ratePaise: rate, gstRateBps: gst.get(r.batchId) ?? r.itemGstRateBps ?? 0, taxablePaise: free * rate,
      returnableUntil: v.reason === "recalled" ? null : v.until,
    };
    g.lines.push(line);
    g.taxablePaise += line.taxablePaise;
    groups.set(r.vendorId, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.taxablePaise - a.taxablePaise || a.vendorName.localeCompare(b.vendorName));
  return { asOf: today, groups: ordered, toDestroy, alreadyHeld, taxablePaise: ordered.reduce((s, g) => s + g.taxablePaise, 0) };
}

// ═══════════════════════════════════ lines ═══════════════════════════════════

type ResolvedLine = {
  itemId: string; batchId: string; storeResourceId: string; reason: ReturnLineReason; qtyBase: number; ratePaise: number;
  taxablePaise: number; gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number; hsnCode: string | null;
};

type VendorRow = typeof vendors.$inferSelect;

/**
 * Every line checked against the stock as it stands, INSIDE the caller's transaction: the batch is
 * this vendor's and owned; the reason fits its date (and the window has not passed); the store holds
 * it; the quantity is no more than on hand less reserved, less frozen unless the batch is recalled,
 * less what other live returns and write-offs hold. Rate and GST default to the purchase's.
 */
async function resolveLines(
  tx: Tx, vendor: VendorRow, input: readonly ReturnLineInput[], interState: boolean, today: string, exceptReturnId: string | null,
): Promise<ResolvedLine[]> {
  if (input.length === 0) throw new MaterialsError("return_invalid", "a return carries at least one line");
  if (input.length > MAX_LINES) throw new MaterialsError("return_invalid", `a return carries at most ${String(MAX_LINES)} lines`);
  const keys = input.map((l) => pairKey(l.storeResourceId, l.batchId));
  if (new Set(keys).size !== keys.length) throw new MaterialsError("return_invalid", "a store's batch appears twice on the return");
  const batchIds = [...new Set(input.map((l) => l.batchId))];
  const storeIds = [...new Set(input.map((l) => l.storeResourceId))];
  const batches = await tx.select().from(stockBatches).where(inArray(stockBatches.id, batchIds));
  const its = batches.length === 0 ? [] : await tx.select().from(items).where(inArray(items.id, [...new Set(batches.map((b) => b.itemId))]));
  const stores = await tx.select().from(resources).where(inArray(resources.id, storeIds));
  const bals = await tx.select().from(stockBalances).where(and(inArray(stockBalances.batchId, batchIds), inArray(stockBalances.resourceId, storeIds)));
  const committed = await committedByPair(tx, batchIds, exceptReturnId === null ? {} : { returnId: exceptReturnId });
  const gst = await purchaseGstRates(tx, batches.map((b) => ({ batchId: b.id, itemId: b.itemId, grnLineId: b.grnLineId })));
  const windowDays = returnWindowDays(vendor);
  return input.map((l) => {
    const batch = batches.find((b) => b.id === l.batchId);
    if (batch === undefined) throw new MaterialsError("unknown_batch", `batch ${l.batchId} not found`);
    const item = its.find((i) => i.id === batch.itemId)!;
    const store = stores.find((s) => s.id === l.storeResourceId);
    if (store === undefined || store.kind !== "store") throw new MaterialsError("unknown_store", `resource ${l.storeResourceId} is not a store`);
    if (isTransit(store.code)) throw new MaterialsError("return_invalid", "stock in transit is received first, then returned");
    if (batch.ownership !== "owned") {
      throw new MaterialsError("not_returnable", `batch ${batch.batchNo} is ${batch.ownership} stock; only the hospital's own purchased stock goes back on a debit note`, { batchNo: batch.batchNo });
    }
    if (batch.vendorId !== vendor.id) {
      throw new MaterialsError("return_invalid", `batch ${batch.batchNo} came from another supplier; it goes back to the vendor whose GRN brought it in`, { batchNo: batch.batchNo });
    }
    if (!RETURN_LINE_REASONS.includes(l.reason)) throw new MaterialsError("return_invalid", `"${String(l.reason)}" is not a return reason`);
    const recalled = batch.recallStatus === "frozen";
    const byDate = returnVerdict({ expiryDate: batch.expiryDate, windowDays, recalled: false, today });
    if (l.reason === "recalled" && !recalled) throw new MaterialsError("return_invalid", `batch ${batch.batchNo} is not recalled`, { batchNo: batch.batchNo });
    if (l.reason === "expired") {
      if (byDate.reason !== "expired") throw new MaterialsError("return_invalid", `batch ${batch.batchNo} has not expired (expiry ${batch.expiryDate ?? "none"})`, { batchNo: batch.batchNo });
      if (!byDate.returnable) {
        throw new MaterialsError("return_window_passed", `batch ${batch.batchNo} expired ${batch.expiryDate!}; this vendor takes expired stock back until ${byDate.until!} — it is destroyed instead`, {
          batchNo: batch.batchNo, expiryDate: batch.expiryDate, returnableUntil: byDate.until, windowDays,
        });
      }
    }
    if (l.reason === "near_expiry" && byDate.reason !== "near_expiry") {
      throw new MaterialsError("return_invalid", `batch ${batch.batchNo} is not within ${String(NEAR_EXPIRY_RETURN_DAYS)} days of its expiry`, { batchNo: batch.batchNo });
    }
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0 || l.qtyBase > MAX_QTY) throw new MaterialsError("return_invalid", "a line returns a whole number of base units, at least one");
    const bal = bals.find((b) => b.resourceId === l.storeResourceId && b.batchId === l.batchId);
    const held = committed.get(pairKey(l.storeResourceId, l.batchId)) ?? 0;
    const can = (bal === undefined ? 0 : exitAvailable(bal, recalled)) - held;
    if (l.qtyBase > can) {
      throw new MaterialsError("insufficient_stock", `${store.name} can return ${String(Math.max(0, can))} of batch ${batch.batchNo}; the line asks ${String(l.qtyBase)}`, {
        batchNo: batch.batchNo, onHand: bal?.qtyOnHand ?? 0, reserved: bal?.qtyReserved ?? 0, frozen: bal?.qtyFrozen ?? 0,
        onOtherDocuments: held, available: Math.max(0, can), required: l.qtyBase,
      });
    }
    const rate = l.ratePaise ?? batch.landedCostPaise;
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > MAX_RATE_PAISE) throw new MaterialsError("return_invalid", "a rate is a whole number of paise, zero or more");
    const bps = l.gstRateBps ?? gst.get(batch.id) ?? item.gstRateBps ?? 0;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new MaterialsError("return_invalid", "a GST rate is between 0 and 100%");
    const taxable = l.qtyBase * rate;
    return {
      itemId: batch.itemId, batchId: batch.id, storeResourceId: l.storeResourceId, reason: l.reason, qtyBase: l.qtyBase, ratePaise: rate,
      taxablePaise: taxable, gstRateBps: bps, ...splitGst(lineGstPaise(taxable, bps), interState), hsnCode: item.hsnCode,
    };
  });
}

function totalsOf(lines: readonly ResolvedLine[]): { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number } {
  const t = lines.reduce((s, l) => ({
    taxablePaise: s.taxablePaise + l.taxablePaise, cgstPaise: s.cgstPaise + l.cgstPaise, sgstPaise: s.sgstPaise + l.sgstPaise, igstPaise: s.igstPaise + l.igstPaise,
  }), { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  return { ...t, totalPaise: t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise };
}

async function insertLines(tx: Tx, returnId: string, lines: readonly ResolvedLine[]): Promise<void> {
  await tx.insert(supplierReturnLines).values(lines.map((l) => ({ id: newId(), returnId, ...l })));
}

type ReturnRow = typeof supplierReturns.$inferSelect;

async function lockReturn(tx: Tx, returnId: string): Promise<ReturnRow> {
  const [row] = await tx.select().from(supplierReturns).where(eq(supplierReturns.id, returnId)).for("update");
  if (row === undefined) throw new MaterialsError("unknown_supplier_return", `supplier return ${returnId} not found`);
  return row;
}

function wrongStatus(r: ReturnRow, act: string, need: readonly string[]): MaterialsError {
  return new MaterialsError("return_wrong_status", `return ${r.returnNo} is ${r.status}; ${act} needs it ${need.join(" or ")}`, { status: r.status, returnNo: r.returnNo });
}

const header = (r: Pick<ReturnRow, "id" | "returnNo" | "vendorId" | "totalPaise">): { returnId: string; returnNo: string; vendorId: string; totalPaise: number } =>
  ({ returnId: r.id, returnNo: r.returnNo, vendorId: r.vendorId, totalPaise: r.totalPaise });

function cleanNote(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  return t === "" ? null : t.slice(0, MAX_TEXT);
}

async function returnableVendor(db: Db | Tx, vendorId: string): Promise<VendorRow> {
  const [v] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
  if (v === undefined) throw new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`);
  const kind = supplierKindOf(v);
  if (kind !== "supplier") {
    throw new MaterialsError("not_returnable", `${v.tradeName ?? v.legalName} is the hospital's ${kind} stock, not a supplier — nothing goes back to it`, { supplierKind: kind });
  }
  return v;
}

/** Intra- or inter-state, as the purchase was: the vendor's GSTIN state against the hospital's. */
function interStateFor(vendor: VendorRow, hospitalStateCode: string | null | undefined): boolean {
  const vendorState = vendor.gstin?.slice(0, 2) ?? null;
  return vendorState !== null && hospitalStateCode != null && vendorState !== hospitalStateCode;
}

// ═══════════════════════════════════ draft, edit ═══════════════════════════════════

export async function createSupplierReturn(
  db: Db, actor: Actor, input: ReturnInput,
  opts: { source?: ReturnSource; recallId?: string | null; now?: Date; hospitalStateCode?: string | null } = {},
): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_MANAGE, "drafting a return to a supplier");
  const now = opts.now ?? new Date();
  const today = istDay(now);
  const vendor = await returnableVendor(db, input.vendorId);
  const interState = input.interState ?? interStateFor(vendor, opts.hospitalStateCode);
  const source = opts.source ?? "manual";
  const id = await withTx(db, async (tx) => {
    const lines = await resolveLines(tx, vendor, input.lines, interState, today, null);
    const returnId = newId();
    const returnNo = await nextEpisodeNo(tx, "supplier_return", today);
    const totals = totalsOf(lines);
    await tx.insert(supplierReturns).values({
      id: returnId, returnNo, vendorId: vendor.id, status: "draft", source, recallId: opts.recallId ?? null, interState, ...totals,
      note: cleanNote(input.note), createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    });
    await insertLines(tx, returnId, lines);
    await appendEvent(tx, supplierReturnDrafted.make({
      occurredAt: now, actor, correlationId: returnId,
      payload: { returnId, returnNo, vendorId: vendor.id, totalPaise: totals.totalPaise, source, lines: lines.length, recallId: opts.recallId ?? null },
    }));
    return returnId;
  });
  return (await readSupplierReturn(db, id))!;
}

/**
 * The person's press of "make the drafts": the agent's plan as one DRAFT return per vendor. Nothing
 * is approved or dispatched. `vendorIds` narrows it to the vendors the person ticked.
 */
export async function draftSupplierReturns(
  db: Db, actor: Actor, now: Date = new Date(),
  opts: { hospitalStateCode?: string | null; storeResourceId?: string | null; vendorIds?: readonly string[] } = {},
): Promise<ReturnView[]> {
  await requirePerm(db, actor, RETURNS_MANAGE, "drafting returns to suppliers");
  const plan = await planSupplierReturns(db, now, { storeResourceId: opts.storeResourceId ?? null });
  const groups = opts.vendorIds === undefined ? plan.groups : plan.groups.filter((g) => opts.vendorIds!.includes(g.vendorId));
  if (groups.length === 0) throw new MaterialsError("return_invalid", "nothing is due to go back: no expired-within-window, near-expiry or recalled stock that a return does not already hold");
  const made: ReturnView[] = [];
  for (const g of groups) {
    made.push(await createSupplierReturn(db, actor, {
      vendorId: g.vendorId,
      note: `Drafted by the agent from the expiry list (${plan.asOf})`,
      lines: g.lines.map((l) => ({ batchId: l.batchId, storeResourceId: l.storeResourceId, qtyBase: l.qtyBase, reason: l.reason, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { source: "agent", now, hospitalStateCode: opts.hospitalStateCode ?? null }));
  }
  return made;
}

/**
 * ONE TAP FROM A RECALL: a draft return to the batch's supplier of everything every store still
 * holds of it (less what is reserved or already on a live document). The recall stays open until
 * the stock is gone.
 */
export async function draftReturnFromRecall(
  db: Db, actor: Actor, recallId: string, now: Date = new Date(), opts: { hospitalStateCode?: string | null } = {},
): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_MANAGE, "drafting a return from a recall");
  const [recall] = await db.select().from(stockRecalls).where(eq(stockRecalls.id, recallId));
  if (recall === undefined) throw new MaterialsError("unknown_recall", `recall ${recallId} not found`);
  if (recall.status !== "open") throw new MaterialsError("recall_wrong_status", `recall ${recall.recallNo} is ${recall.status}`, { status: recall.status });
  const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.id, recall.batchId));
  if (batch === undefined || batch.vendorId === null) throw new MaterialsError("not_returnable", "the recalled batch has no supplier on record — destroy it instead");
  if (batch.ownership !== "owned") throw new MaterialsError("not_returnable", `batch ${batch.batchNo} is ${batch.ownership} stock; only owned stock goes back on a debit note`);
  await returnableVendor(db, batch.vendorId);
  const rows = await stockRows(db, { anyExpiry: true, batchIds: [batch.id] });
  const committed = await committedByPair(db, [batch.id]);
  const lines = rows.map((r) => ({
    batchId: r.batchId, storeResourceId: r.storeResourceId, reason: "recalled" as const,
    qtyBase: exitAvailable({ qtyOnHand: r.onHand, qtyReserved: r.reserved, qtyFrozen: r.frozen }, r.recalled) - (committed.get(pairKey(r.storeResourceId, r.batchId)) ?? 0),
  })).filter((l) => l.qtyBase > 0);
  if (lines.length === 0) throw new MaterialsError("return_invalid", `no store holds batch ${batch.batchNo} free to return (reserved, or already on a return or write-off)`);
  return createSupplierReturn(db, actor, {
    vendorId: batch.vendorId, note: `Recall ${recall.recallNo}: ${recall.reason}`.slice(0, MAX_TEXT), lines,
  }, { source: "recall", recallId, now, hospitalStateCode: opts.hospitalStateCode ?? null });
}

/** A draft's lines (all of them), note and tax kind. */
export async function updateSupplierReturn(
  db: Db, actor: Actor, returnId: string, patch: { lines?: ReturnLineInput[]; note?: string | null; interState?: boolean }, now: Date = new Date(),
): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_MANAGE, "editing a return to a supplier");
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "draft") throw wrongStatus(r, "editing", ["draft"]);
    const vendor = await returnableVendor(tx, r.vendorId);
    const set: Partial<typeof supplierReturns.$inferInsert> = { updatedBy: actor.id, updatedAt: now };
    if (patch.note !== undefined) set.note = cleanNote(patch.note);
    const interState = patch.interState ?? r.interState;
    let count = (await tx.select({ id: supplierReturnLines.id }).from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId))).length;
    if (patch.lines !== undefined || patch.interState !== undefined) {
      const input = patch.lines ?? (await tx.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId)))
        .map((l) => ({ batchId: l.batchId, storeResourceId: l.storeResourceId, qtyBase: l.qtyBase, reason: l.reason as ReturnLineReason, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps }));
      const lines = await resolveLines(tx, vendor, input, interState, istDay(now), returnId);
      await tx.delete(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId));
      await insertLines(tx, returnId, lines);
      Object.assign(set, totalsOf(lines), { interState });
      count = lines.length;
    }
    const [after] = await tx.update(supplierReturns).set(set).where(eq(supplierReturns.id, returnId)).returning();
    await appendEvent(tx, supplierReturnUpdated.make({ occurredAt: now, actor, correlationId: returnId, payload: { ...header(after!), lines: count } }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

// ═══════════════════════════════════ approve, dispatch ═══════════════════════════════════

/**
 * Draft → approved, by the materials head (`materials.returns.approve`) — never whoever drafted it
 * (`requester_approver`: the SoD engine records the attempt, and the act refuses it whatever the
 * caller did). The lines are re-asked against today's stock and today's window.
 */
export async function approveSupplierReturn(db: Db, actor: Actor, returnId: string, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_APPROVE, "approving a return to a supplier");
  const [pre] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, returnId));
  if (pre === undefined) throw new MaterialsError("unknown_supplier_return", `supplier return ${returnId} not found`);
  if (pre.status !== "draft") throw wrongStatus(pre, "approving", ["draft"]);
  await assertNotSodPair(db, "requester_approver", { type: "user", id: pre.createdBy }, actor);
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "draft") throw wrongStatus(r, "approving", ["draft"]);
    if (r.createdBy === actor.id) throw new MaterialsError("return_self_approve", `you drafted return ${r.returnNo}; somebody else approves it`, { returnNo: r.returnNo });
    const vendor = await returnableVendor(tx, r.vendorId);
    const stored = await tx.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId));
    await resolveLines(tx, vendor, stored.map((l) => ({
      batchId: l.batchId, storeResourceId: l.storeResourceId, qtyBase: l.qtyBase, reason: l.reason as ReturnLineReason, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps,
    })), r.interState, istDay(now), returnId);
    await tx.update(supplierReturns).set({ status: "approved", approvedBy: actor.id, approvedAt: now, updatedBy: actor.id, updatedAt: now })
      .where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierReturnApproved.make({ occurredAt: now, actor, correlationId: returnId, payload: { ...header(r), approvedBy: actor.id } }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

/**
 * The SoD engine's half of `return_approver_dispatcher`, run on `db` BEFORE the dispatch's
 * transaction so the `sod.violation_blocked` event survives the refusal. `dispatchSupplierReturn`
 * refuses the same person in the act whatever the caller did.
 */
export async function assertNotReturnApprover(db: Db, actor: Actor, returnId: string): Promise<void> {
  const [r] = await db.select({ approvedBy: supplierReturns.approvedBy }).from(supplierReturns).where(eq(supplierReturns.id, returnId));
  if (r?.approvedBy === null || r?.approvedBy === undefined) return;
  await assertNotSodPair(db, "return_approver_dispatcher", { type: "user", id: r.approvedBy }, actor);
}

/**
 * Approved → dispatched: the goods leave. One `return` row out of each line's store (a recalled
 * batch through the ledger's `recallExit`), and OUR DEBIT NOTE — its number, today's date, the
 * vendor's GSTIN as it stands, and the lines' GST reversal. Never by whoever approved it.
 */
export async function dispatchSupplierReturn(db: Db, actor: Actor, returnId: string, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_MANAGE, "dispatching a return to a supplier");
  await assertNotReturnApprover(db, actor, returnId);
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "approved") throw wrongStatus(r, "dispatching", ["approved"]);
    if (r.approvedBy === actor.id) throw new MaterialsError("approver_dispatching", `you approved return ${r.returnNo}; somebody else dispatches it`, { returnNo: r.returnNo });
    const lines = await tx.select().from(supplierReturnLines).where(eq(supplierReturnLines.returnId, returnId)).orderBy(asc(supplierReturnLines.id));
    const moved = await postMovements(tx, actor, lines.map((l) => ({
      resourceId: l.storeResourceId, batchId: l.batchId, qtyDelta: -l.qtyBase, reason: "return" as const,
      refType: "supplier_return", refId: l.id, occurredAt: now, recallExit: true,
    })));
    for (const [i, l] of lines.entries()) {
      await tx.update(supplierReturnLines).set({ ledgerEntryId: moved[i]!.ledgerEntryId }).where(eq(supplierReturnLines.id, l.id));
    }
    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, r.vendorId));
    const today = istDay(now);
    const debitNoteNo = await nextEpisodeNo(tx, "debit_note", today);
    await tx.update(supplierReturns).set({
      status: "dispatched", dispatchedBy: actor.id, dispatchedAt: now, debitNoteNo, debitNoteDate: today, vendorGstin: vendor?.gstin ?? null,
      updatedBy: actor.id, updatedAt: now,
    }).where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierReturnDispatched.make({
      occurredAt: now, actor, correlationId: returnId,
      payload: {
        ...header(r), debitNoteNo, debitNoteDate: today, vendorGstin: vendor?.gstin ?? null, interState: r.interState,
        taxablePaise: r.taxablePaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise, dispatchedBy: actor.id,
        lines: lines.map((l, i) => ({ lineId: l.id, itemId: l.itemId, batchId: l.batchId, storeResourceId: l.storeResourceId, qtyBase: l.qtyBase, ledgerEntryId: moved[i]!.ledgerEntryId })),
      },
    }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

/** Draft or approved (nothing moved) → cancelled, with a reason. */
export async function cancelSupplierReturn(db: Db, actor: Actor, returnId: string, reason: string, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, RETURNS_MANAGE, "cancelling a return to a supplier");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the return is cancelled");
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (!LIVE_RETURN.includes(r.status as ReturnStatus)) throw wrongStatus(r, "cancelling", LIVE_RETURN);
    await tx.update(supplierReturns).set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: why.slice(0, MAX_TEXT), updatedBy: actor.id, updatedAt: now })
      .where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierReturnCancelled.make({ occurredAt: now, actor, correlationId: returnId, payload: { ...header(r), reason: why.slice(0, MAX_TEXT), fromStatus: r.status } }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

// ═══════════════════════════════════ the vendor's credit ═══════════════════════════════════

export type CreditInput = { vendorCreditNoteNo: string; creditNoteDate: string; amountPaise: number; differenceReason?: string | null };

/**
 * The vendor's credit note against a dispatched return, accepted: our number (`MCN…`), theirs, its
 * date and amount. Less than the debit note needs the reason and the head's
 * `materials.bills.accept_difference` (a short credit is a loss somebody accountable accepts); more
 * is refused. Accepted, it is an offset the next payment run spends.
 */
export async function recordVendorCredit(db: Db, actor: Actor, returnId: string, input: CreditInput, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, BILLS_MANAGE, "recording a supplier's credit note");
  const no = input.vendorCreditNoteNo.trim();
  if (no === "" || no.length > 64) throw new MaterialsError("credit_invalid", "the vendor's credit note number is 1 to 64 characters");
  const today = istDay(now);
  if (!isIsoDate(input.creditNoteDate) || input.creditNoteDate > today) throw new MaterialsError("credit_invalid", `"${input.creditNoteDate}" is not a date on or before today`);
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new MaterialsError("credit_invalid", "a credit note is for at least ₹0.01");
  const [pre] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, returnId));
  if (pre === undefined) throw new MaterialsError("unknown_supplier_return", `supplier return ${returnId} not found`);
  if (input.amountPaise > pre.totalPaise) {
    throw new MaterialsError("credit_invalid", `the credit ₹${(input.amountPaise / 100).toFixed(2)} is more than our debit note ₹${(pre.totalPaise / 100).toFixed(2)}`, {
      amountPaise: input.amountPaise, debitNotePaise: pre.totalPaise,
    });
  }
  const short = input.amountPaise < pre.totalPaise;
  const reason = cleanNote(input.differenceReason);
  if (short && reason === null) {
    throw new MaterialsError("credit_invalid", `the credit is ₹${((pre.totalPaise - input.amountPaise) / 100).toFixed(2)} less than our debit note; say why`, {
      differencePaise: pre.totalPaise - input.amountPaise,
    });
  }
  if (short) await requirePerm(db, actor, ACCEPT_DIFFERENCE, "accepting a credit short of the debit note");
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "dispatched") throw wrongStatus(r, "recording the vendor's credit", ["dispatched"]);
    const creditNoteId = newId();
    const creditNo = await nextEpisodeNo(tx, "supplier_credit", today);
    const difference = r.totalPaise - input.amountPaise;
    await tx.insert(supplierCreditNotes).values({
      id: creditNoteId, creditNo, returnId, vendorId: r.vendorId, vendorCreditNoteNo: no, creditNoteDate: input.creditNoteDate,
      amountPaise: input.amountPaise, debitNotePaise: r.totalPaise, differencePaise: difference, differenceReason: difference === 0 ? null : reason,
      status: "accepted", recordedBy: actor.id, recordedAt: now,
    });
    await tx.update(supplierReturns).set({ status: "credited", creditedPaise: input.amountPaise, updatedBy: actor.id, updatedAt: now })
      .where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierCreditRecorded.make({
      occurredAt: now, actor, correlationId: returnId,
      payload: {
        creditNoteId, creditNo, returnId, returnNo: r.returnNo, vendorId: r.vendorId, vendorCreditNoteNo: no, creditNoteDate: input.creditNoteDate,
        amountPaise: input.amountPaise, debitNotePaise: r.totalPaise, differencePaise: difference, differenceReason: difference === 0 ? null : reason,
      },
    }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

/**
 * A credit note recorded in error, cancelled — only while none of it is spent (the vendor's available
 * credit still covers it; a run holding it must be cancelled or edited first). The return goes back to
 * dispatched.
 */
export async function cancelVendorCredit(db: Db, actor: Actor, returnId: string, reason: string, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, BILLS_MANAGE, "cancelling a supplier's credit note");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the credit note is cancelled");
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "credited") throw wrongStatus(r, "cancelling its credit note", ["credited"]);
    // The vendor's row lock serialises this against a run spending the same credit.
    await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, r.vendorId)).for("update");
    const [c] = await tx.select().from(supplierCreditNotes).where(and(eq(supplierCreditNotes.returnId, returnId), eq(supplierCreditNotes.status, "accepted")));
    if (c === undefined) throw wrongStatus(r, "cancelling its credit note", ["credited"]);
    const available = (await vendorCredits(tx, [r.vendorId])).get(r.vendorId)?.availablePaise ?? 0;
    if (available < c.amountPaise) {
      throw new MaterialsError("credit_spent", `payment runs have spent ₹${((c.amountPaise - Math.max(0, available)) / 100).toFixed(2)} of this credit; it cannot be cancelled`, {
        amountPaise: c.amountPaise, availablePaise: available,
      });
    }
    await tx.update(supplierCreditNotes).set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: why.slice(0, MAX_TEXT) })
      .where(eq(supplierCreditNotes.id, c.id));
    await tx.update(supplierReturns).set({ status: "dispatched", creditedPaise: 0, updatedBy: actor.id, updatedAt: now }).where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierCreditCancelled.make({
      occurredAt: now, actor, correlationId: returnId,
      payload: { creditNoteId: c.id, creditNo: c.creditNo, returnId, vendorId: r.vendorId, amountPaise: c.amountPaise, reason: why.slice(0, MAX_TEXT) },
    }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

/** Dispatched and no credit is coming (the vendor refused it): closed by the head, with the reason. */
export async function closeSupplierReturn(db: Db, actor: Actor, returnId: string, reason: string, now: Date = new Date()): Promise<ReturnView> {
  await requirePerm(db, actor, ACCEPT_DIFFERENCE, "closing a return without a credit");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why no credit is coming");
  await withTx(db, async (tx) => {
    const r = await lockReturn(tx, returnId);
    if (r.status !== "dispatched") throw wrongStatus(r, "closing without a credit", ["dispatched"]);
    await tx.update(supplierReturns).set({ status: "closed", closedBy: actor.id, closedAt: now, closeReason: why.slice(0, MAX_TEXT), updatedBy: actor.id, updatedAt: now })
      .where(eq(supplierReturns.id, returnId));
    await appendEvent(tx, supplierReturnClosed.make({ occurredAt: now, actor, correlationId: returnId, payload: { ...header(r), reason: why.slice(0, MAX_TEXT) } }));
  });
  return (await readSupplierReturn(db, returnId))!;
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

export type ReturnSummary = {
  id: string; returnNo: string; status: ReturnStatus; source: ReturnSource; vendorId: string; vendorCode: string; vendorName: string;
  recallId: string | null; lineCount: number; interState: boolean;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; creditedPaise: number;
  debitNoteNo: string | null; debitNoteDate: string | null;
  createdBy: string; createdAt: string; approvedBy: string | null; approvedAt: string | null; dispatchedBy: string | null; dispatchedAt: string | null;
};

export type ReturnLineView = {
  id: string; itemId: string; itemCode: string; itemName: string; hsnCode: string | null; baseUom: string; pack: { uom: string; multiplier: number } | null;
  batchId: string; batchNo: string; expiryDate: string | null; storeResourceId: string; storeCode: string; storeName: string;
  reason: ReturnLineReason; qtyBase: number; ratePaise: number; taxablePaise: number; gstRateBps: number;
  cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; ledgerEntryId: string | null;
};

export type ReturnView = ReturnSummary & {
  note: string | null; vendorGstin: string | null; closeReason: string | null; cancelReason: string | null; recallNo: string | null;
  names: Record<string, string>; lines: ReturnLineView[];
  credit: {
    id: string; creditNo: string; vendorCreditNoteNo: string; creditNoteDate: string; amountPaise: number; differencePaise: number;
    differenceReason: string | null; recordedBy: string; recordedAt: string;
  } | null;
};

function summaryOf(r: ReturnRow, vendor: { code: string; legalName: string; tradeName: string | null }, lineCount: number): ReturnSummary {
  return {
    id: r.id, returnNo: r.returnNo, status: r.status as ReturnStatus, source: r.source as ReturnSource, vendorId: r.vendorId, vendorCode: vendor.code,
    vendorName: vendor.tradeName ?? vendor.legalName, recallId: r.recallId, lineCount, interState: r.interState,
    taxablePaise: r.taxablePaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise, totalPaise: r.totalPaise, creditedPaise: r.creditedPaise,
    debitNoteNo: r.debitNoteNo, debitNoteDate: r.debitNoteDate, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
    approvedBy: r.approvedBy, approvedAt: r.approvedAt?.toISOString() ?? null, dispatchedBy: r.dispatchedBy, dispatchedAt: r.dispatchedAt?.toISOString() ?? null,
  };
}

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

async function readSupplierReturn(db: Db, returnId: string): Promise<ReturnView | undefined> {
  const [row] = await db.select({ r: supplierReturns, v: vendors, recallNo: stockRecalls.recallNo }).from(supplierReturns)
    .innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId))
    .leftJoin(stockRecalls, eq(stockRecalls.id, supplierReturns.recallId))
    .where(eq(supplierReturns.id, returnId));
  if (row === undefined) return undefined;
  const lines = await db.select({ l: supplierReturnLines, code: items.code, name: items.name, baseUom: items.baseUom, batchNo: stockBatches.batchNo, expiry: stockBatches.expiryDate, storeCode: resources.code, storeName: resources.name })
    .from(supplierReturnLines)
    .innerJoin(items, eq(items.id, supplierReturnLines.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, supplierReturnLines.batchId))
    .innerJoin(resources, eq(resources.id, supplierReturnLines.storeResourceId))
    .where(eq(supplierReturnLines.returnId, returnId))
    .orderBy(asc(items.name), asc(stockBatches.batchNo), asc(resources.code));
  const packs = await packsOf(db, lines.map((l) => l.l.itemId));
  const [credit] = await db.select().from(supplierCreditNotes).where(and(eq(supplierCreditNotes.returnId, returnId), eq(supplierCreditNotes.status, "accepted")));
  const r = row.r;
  const names = await namesOf(db, [r.createdBy, r.approvedBy, r.dispatchedBy, r.closedBy, r.cancelledBy, credit?.recordedBy ?? null]);
  return {
    ...summaryOf(r, row.v, lines.length), note: r.note, vendorGstin: r.vendorGstin ?? row.v.gstin, closeReason: r.closeReason, cancelReason: r.cancelReason,
    recallNo: row.recallNo, names,
    lines: lines.map(({ l, code, name, baseUom, batchNo, expiry, storeCode, storeName }) => ({
      id: l.id, itemId: l.itemId, itemCode: code, itemName: name, hsnCode: l.hsnCode, baseUom, pack: packs.get(l.itemId) ?? null,
      batchId: l.batchId, batchNo, expiryDate: expiry, storeResourceId: l.storeResourceId, storeCode, storeName,
      reason: l.reason as ReturnLineReason, qtyBase: l.qtyBase, ratePaise: l.ratePaise, taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps,
      cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, totalPaise: l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise,
      ledgerEntryId: l.ledgerEntryId,
    })),
    credit: credit === undefined ? null : {
      id: credit.id, creditNo: credit.creditNo, vendorCreditNoteNo: credit.vendorCreditNoteNo, creditNoteDate: credit.creditNoteDate,
      amountPaise: credit.amountPaise, differencePaise: credit.differencePaise, differenceReason: credit.differenceReason,
      recordedBy: credit.recordedBy, recordedAt: credit.recordedAt.toISOString(),
    },
  };
}

export async function getSupplierReturn(db: Db, actor: Actor, returnId: string): Promise<ReturnView> {
  await requireReturnsReader(db, actor);
  const r = await readSupplierReturn(db, returnId);
  if (r === undefined) throw new MaterialsError("unknown_supplier_return", `supplier return ${returnId} not found`);
  return r;
}

export type ReturnFilter = { statuses?: readonly ReturnStatus[]; vendorId?: string; limit?: number };

export async function listSupplierReturns(db: Db, actor: Actor, filter: ReturnFilter = {}): Promise<ReturnSummary[]> {
  await requireReturnsReader(db, actor);
  const where = [
    ...(filter.statuses === undefined || filter.statuses.length === 0 ? [] : [inArray(supplierReturns.status, [...filter.statuses])]),
    ...(filter.vendorId === undefined ? [] : [eq(supplierReturns.vendorId, filter.vendorId)]),
  ];
  const rows = await db.select({
    r: supplierReturns, v: vendors,
    lines: sql<string>`(select count(*) from ${supplierReturnLines} where ${supplierReturnLines.returnId} = ${supplierReturns.id})`,
  }).from(supplierReturns).innerJoin(vendors, eq(vendors.id, supplierReturns.vendorId))
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(supplierReturns.createdAt), desc(supplierReturns.id)).limit(Math.min(filter.limit ?? 200, 1000));
  return rows.map((x) => summaryOf(x.r, x.v, Number(x.lines)));
}
