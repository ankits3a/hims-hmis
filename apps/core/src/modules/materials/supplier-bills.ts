import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  grnLines, grns, itemUoms, items, purchaseOrderLines, purchaseOrders, supplierBillLines, supplierBills, supplierCreditNotes,
  supplierPaymentRunLines, supplierPaymentRuns, supplierPayments, supplierReturns, users, vendors,
} from "../../kernel/db/schema";
import {
  BILL_MATCH_TOLERANCE_BPS, BILL_MATCH_TOLERANCE_MIN_PAISE, DEFAULT_SUPPLIER_TERMS_DAYS, MSME_MAX_PAYMENT_DAYS,
} from "./config";
import { MaterialsError } from "./errors";
import { supplierBillAccepted, supplierBillCancelled, supplierBillDrafted, supplierBillMatched, supplierBillUpdated } from "./events";
import { istDay } from "./grn";
import { lineGstPaise } from "./purchase-orders";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P3 — THE SUPPLIER'S BILL, MATCHED THREE WAYS, AND WHAT WE OWE ═══
 *
 * Plan `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md`, P3. OUR APP is the
 * payables book of record (owner, 2026-09-24): every bill gets our own voucher number (`MSB…`) and
 * date, so P5's Tally export has a stable key for each.
 *
 *   draft ─match→ matched ─accept→ accepted → part_paid → paid          (payments.ts moves the last two)
 *            └──→ held_for_match ─accept the difference, with a reason→ accepted
 *
 * - **The agent prefills, the person confirms.** `billDraftFromGrn` turns a posted GRN into a bill:
 *   the quantity the gate ACCEPTED (free goods apart), the PO's rate and GST. The person types the
 *   vendor's bill number and date and any line that differs.
 * - **The match.** Each line's taxable value against GRN-accepted × PO rate, and the bill total
 *   against the expected total, may differ by `BILL_MATCH_TOLERANCE_BPS` (1%) or
 *   `BILL_MATCH_TOLERANCE_MIN_PAISE` (₹10), whichever is larger. A GST rate other than the order's,
 *   more billed than received, or an item the GRN did not accept holds the bill whatever the value.
 *   Held bills need `materials.bills.accept_difference` (the materials head), a reason, and a person
 *   other than whoever entered the bill.
 * - **Due.** A vendor with `msme_class` is due `min(terms, 45)` days after the day the goods were
 *   accepted (MSMED Act s.15; the earliest linked GRN's posting day); any other vendor
 *   `payment_terms_days` (default 30) after the bill date. Stamped once, at acceptance.
 * - **Duplicates.** One live bill per vendor, bill number (spaces, `-`, `/`, `.` ignored, case
 *   ignored) and Indian financial year — in the act, and by a partial unique index.
 */

const BILLS_MANAGE = "materials.bills.manage";
const BILLS_ACCEPT_DIFFERENCE = "materials.bills.accept_difference";
const PAYABLES_READERS = [BILLS_MANAGE, BILLS_ACCEPT_DIFFERENCE, "materials.payments.prepare", "materials.payments.record", "approvals.requests.decide"];

export type BillStatus = "draft" | "matched" | "held_for_match" | "accepted" | "part_paid" | "paid" | "cancelled";
export const PAYABLE_BILL_STATUSES: readonly BillStatus[] = ["accepted", "part_paid"];
const EDITABLE: readonly BillStatus[] = ["draft", "matched", "held_for_match"];

export type BillMismatch = "not_received" | "qty_over" | "qty_under" | "rate" | "gst_rate" | "value";
/** Reasons that hold a bill by themselves; `qty_under` and `rate` only inform unless the value moves. */
const HOLDING: readonly BillMismatch[] = ["not_received", "qty_over", "gst_rate", "value"];

export type BillLineInput = {
  grnId: string;
  itemId: string;
  /** The pack billed. Defaults to the item's purchase pack. */
  uom?: string | null;
  qtyPacks: number;
  /** Rate per pack before GST. */
  ratePaise: number;
  gstRateBps: number;
};

export type BillInput = {
  vendorId: string;
  vendorBillNo: string;
  billDate: string;
  interState?: boolean;
  roundOffPaise?: number;
  note?: string | null;
  lines: BillLineInput[];
};

export type BillLineView = {
  id: string; grnId: string; grnNo: string; itemId: string; itemCode: string; itemName: string; uom: string; multiplier: number;
  qtyPacks: number; ratePaise: number; taxablePaise: number; gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  totalPaise: number; expectedBase: number; expectedPacks: number; expectedRatePaise: number; expectedTaxablePaise: number;
  expectedGstRateBps: number; differencePaise: number; mismatch: BillMismatch[]; out: boolean;
};

export type BillSummary = {
  id: string; billNo: string; status: BillStatus; vendorId: string; vendorCode: string; vendorName: string; msme: boolean;
  vendorBillNo: string; billDate: string; fy: string; purchaseOrderId: string | null; interState: boolean;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number;
  expectedTotalPaise: number; paidPaise: number; outstandingPaise: number; heldReason: string | null;
  acceptanceDate: string | null; dueDate: string | null; differenceReason: string | null;
  createdBy: string; createdAt: string; acceptedBy: string | null; acceptedAt: string | null;
};

export type BillView = BillSummary & {
  note: string | null; poNo: string | null; cancelReason: string | null; differenceAcceptedBy: string | null;
  names: Record<string, string>; lines: BillLineView[];
  /** GRN items accepted but not on the bill — counted in the expected total. */
  unbilled: { grnId: string; grnNo: string; itemId: string; itemCode: string; itemName: string; expectedBase: number; expectedTaxablePaise: number }[];
  /** Recorded payments against this bill; `creditPaise` is the vendor credit set off on the same voucher (P4). */
  payments: { paymentId: string; paymentNo: string; runNo: string; mode: string; reference: string | null; paidOn: string; paidPaise: number; creditPaise: number }[];
};

// ═══════════════════════════════════ small pure pieces ═══════════════════════════════════

/** The most a matched amount may differ from what was expected: 1% of it or ₹10, whichever is larger. */
export function matchTolerancePaise(expectedPaise: number): number {
  return Math.max(Math.floor((Math.abs(expectedPaise) * BILL_MATCH_TOLERANCE_BPS) / 10_000), BILL_MATCH_TOLERANCE_MIN_PAISE);
}

export function withinMatch(actualPaise: number, expectedPaise: number): boolean {
  return Math.abs(actualPaise - expectedPaise) <= matchTolerancePaise(expectedPaise);
}

/** The Indian financial year of a date: April to March, `2026-27`. */
export function financialYearOf(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start)}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A vendor's bill number as the duplicate check compares it: case, spaces, `-`, `/` and `.` ignored. */
export function vendorBillKey(no: string): string {
  return no.toUpperCase().replace(/[\s\-/.]/g, "");
}

export function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * When a bill falls due. MSME (any `msme_class`): the day of acceptance + min(terms, 45) — MSMED Act
 * s.15, the Act's ceiling whatever was agreed. Anyone else: the bill date + terms (default 30).
 */
export function dueDateFor(input: { msme: boolean; termsDays: number | null; billDate: string; acceptanceDate: string }): string {
  if (input.msme) return addDays(input.acceptanceDate, Math.min(input.termsDays ?? MSME_MAX_PAYMENT_DAYS, MSME_MAX_PAYMENT_DAYS));
  return addDays(input.billDate, input.termsDays ?? DEFAULT_SUPPLIER_TERMS_DAYS);
}

/** CGST + SGST halves (SGST takes the odd paisa) or IGST whole. */
function splitGst(gst: number, interState: boolean): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (interState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: gst };
  const c = Math.floor(gst / 2);
  return { cgstPaise: c, sgstPaise: gst - c, igstPaise: 0 };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const isMsme = (v: { msmeClass: string | null }): boolean => v.msmeClass !== null && v.msmeClass.trim() !== "";

// ═══════════════════════════════════ who may ═══════════════════════════════════

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

/** Payables are read by whoever enters bills, prepares or records payments, or authorises them. */
export async function requirePayablesReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user") {
    for (const p of PAYABLES_READERS) if (await hasPermission(db, actor.id, p, "hospital")) return;
  }
  throw new MaterialsError("permission_denied", `reading supplier bills needs one of ${PAYABLES_READERS.join(", ")}`);
}

// ═══════════════════════════════════ what the GRN says ═══════════════════════════════════

type Expectation = {
  grnId: string; grnNo: string; itemId: string; acceptedBase: number;
  /** Rate per BASE unit, as a fraction: `ratePaise / multiplier` of the PO line, or the GRN's own unit cost. */
  rate: { paise: number; per: number };
  gstRateBps: number;
};

type GrnRow = typeof grns.$inferSelect;

/**
 * For each GRN: every item it ACCEPTED (paid quantity only), the rate it should be billed at (the PO
 * line's, else the GRN's recorded cost) and the GST rate (the PO line's, else the item's).
 */
async function expectationsOf(db: Db | Tx, grnRows: readonly GrnRow[]): Promise<Map<string, Expectation>> {
  const out = new Map<string, Expectation>();
  if (grnRows.length === 0) return out;
  const ids = grnRows.map((g) => g.id);
  const lines = await db.select({ l: grnLines, gst: items.gstRateBps }).from(grnLines)
    .innerJoin(items, eq(items.id, grnLines.itemId))
    .where(and(inArray(grnLines.grnId, ids), eq(grnLines.freeGoods, false)));
  const poIds = [...new Set(grnRows.map((g) => g.purchaseOrderId).filter((p): p is string => p !== null))];
  const poLines = poIds.length === 0 ? [] : await db.select().from(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, poIds));
  const byGrn = new Map(grnRows.map((g) => [g.id, g]));
  const cost = new Map<string, { base: number; paise: number }>();
  for (const { l, gst } of lines) {
    const k = `${l.grnId}|${l.itemId}`;
    const g = byGrn.get(l.grnId)!;
    const cur = out.get(k);
    const c = cost.get(k) ?? { base: 0, paise: 0 };
    c.base += l.qtyAcceptedBase;
    c.paise += l.qtyAcceptedBase * l.unitCostPaise;
    cost.set(k, c);
    const pl = g.purchaseOrderId === null ? undefined : poLines.find((p) => p.purchaseOrderId === g.purchaseOrderId && p.itemId === l.itemId);
    out.set(k, {
      grnId: l.grnId, grnNo: g.grnNo, itemId: l.itemId, acceptedBase: (cur?.acceptedBase ?? 0) + l.qtyAcceptedBase,
      rate: pl !== undefined ? { paise: pl.ratePaise, per: pl.multiplier } : { paise: 0, per: 1 },
      gstRateBps: pl?.gstRateBps ?? gst ?? 0,
    });
  }
  // Without a PO line the GRN's own weighted cost per base unit is the yardstick.
  for (const [k, e] of out) {
    if (e.rate.paise === 0 && e.rate.per === 1) {
      const c = cost.get(k)!;
      e.rate = c.base === 0 ? { paise: 0, per: 1 } : { paise: c.paise, per: c.base };
    }
  }
  return out;
}

/** Expected taxable value of `base` units at a per-base rate, rounded to the paisa. */
const valueAt = (base: number, rate: { paise: number; per: number }): number => Math.round((base * rate.paise) / rate.per);

/** The expected rate PER PACK of `multiplier` base units. */
const packRate = (multiplier: number, rate: { paise: number; per: number }): number => Math.round((multiplier * rate.paise) / rate.per);

// ═══════════════════════════════════ lines ═══════════════════════════════════

type ResolvedLine = {
  grnId: string; itemId: string; uom: string; multiplier: number; qtyPacks: number; ratePaise: number; taxablePaise: number;
  gstRateBps: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
  expectedBase: number; expectedRatePaise: number; expectedTaxablePaise: number; expectedGstRateBps: number;
  mismatch: BillMismatch[];
};

const MAX_LINES = 300;
const MAX_PACKS = 1_000_000;
const MAX_RATE_PAISE = 1_000_000_000;
const MAX_TEXT = 500;

/** Which mismatches a line carries, and whether any of them holds the bill. */
export function lineMismatches(l: {
  qtyPacks: number; multiplier: number; ratePaise: number; taxablePaise: number; gstRateBps: number;
  expectedBase: number; expectedRatePaise: number; expectedTaxablePaise: number; expectedGstRateBps: number;
}): { reasons: BillMismatch[]; out: boolean } {
  const reasons: BillMismatch[] = [];
  const billedBase = l.qtyPacks * l.multiplier;
  if (l.expectedBase === 0) reasons.push("not_received");
  else if (billedBase > l.expectedBase) reasons.push("qty_over");
  else if (billedBase < l.expectedBase) reasons.push("qty_under");
  if (l.expectedBase > 0 && l.ratePaise !== l.expectedRatePaise) reasons.push("rate");
  if (l.gstRateBps !== l.expectedGstRateBps) reasons.push("gst_rate");
  if (!withinMatch(l.taxablePaise, l.expectedTaxablePaise)) reasons.push("value");
  return { reasons, out: reasons.some((r) => HOLDING.includes(r)) };
}

async function lockGrns(tx: Tx, vendorId: string, grnIds: readonly string[], exceptBillId: string | null): Promise<GrnRow[]> {
  const rows = await tx.select().from(grns).where(inArray(grns.id, [...grnIds])).for("update");
  for (const id of grnIds) {
    const g = rows.find((r) => r.id === id);
    if (g === undefined) throw new MaterialsError("unknown_document", `GRN ${id} not found`);
    if (g.vendorId !== vendorId) throw new MaterialsError("bill_invalid", `GRN ${g.grnNo} is another vendor's`, { grnNo: g.grnNo });
    if (g.status !== "posted") throw new MaterialsError("bill_invalid", `GRN ${g.grnNo} is ${g.status}; only a posted GRN is billed`, { grnNo: g.grnNo });
    if (g.source !== "challan") {
      throw new MaterialsError("bill_invalid", `GRN ${g.grnNo} is a ${g.source}; consignment is billed on use and a donation never`, { grnNo: g.grnNo });
    }
  }
  const taken = await tx.select({ grnId: supplierBillLines.grnId, billNo: supplierBills.billNo }).from(supplierBillLines)
    .innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(
      inArray(supplierBillLines.grnId, [...grnIds]), ne(supplierBills.status, "cancelled"),
      ...(exceptBillId === null ? [] : [ne(supplierBills.id, exceptBillId)]),
    )).limit(1);
  if (taken[0] !== undefined) {
    const g = rows.find((r) => r.id === taken[0]!.grnId)!;
    throw new MaterialsError("grn_already_billed", `GRN ${g.grnNo} is already on bill ${taken[0].billNo}`, { grnNo: g.grnNo, billNo: taken[0].billNo });
  }
  return rows;
}

async function resolveLines(tx: Tx, vendorId: string, input: readonly BillLineInput[], interState: boolean, exceptBillId: string | null): Promise<{
  lines: ResolvedLine[]; grnRows: GrnRow[]; expectations: Map<string, Expectation>;
}> {
  if (input.length === 0) throw new MaterialsError("bill_invalid", "a bill carries at least one line");
  if (input.length > MAX_LINES) throw new MaterialsError("bill_invalid", `a bill carries at most ${String(MAX_LINES)} lines`);
  const keys = new Set(input.map((l) => `${l.grnId}|${l.itemId}`));
  if (keys.size !== input.length) throw new MaterialsError("bill_invalid", "an item appears twice for one GRN — put it on one line");
  const grnIds = [...new Set(input.map((l) => l.grnId))];
  const grnRows = await lockGrns(tx, vendorId, grnIds, exceptBillId);
  const expectations = await expectationsOf(tx, grnRows);
  const itemIds = [...new Set(input.map((l) => l.itemId))];
  const found = await tx.select().from(items).where(inArray(items.id, itemIds));
  const packs = await tx.select().from(itemUoms).where(inArray(itemUoms.itemId, itemIds));
  const lines = input.map((l): ResolvedLine => {
    const item = found.find((i) => i.id === l.itemId);
    if (item === undefined) throw new MaterialsError("unknown_item", `item ${l.itemId} not found`, { itemId: l.itemId });
    const mine = packs.filter((p) => p.itemId === l.itemId);
    const wanted = l.uom?.trim().toLowerCase();
    const pack = wanted !== undefined && wanted !== ""
      ? mine.find((p) => p.uom.toLowerCase() === wanted)
      : mine.find((p) => p.isPurchaseUom) ?? [...mine].sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier)[0];
    const multiplier = pack?.toBaseMultiplier ?? (wanted === undefined || wanted === "" || wanted === item.baseUom.toLowerCase() ? 1 : null);
    if (multiplier === null) throw new MaterialsError("bill_invalid", `item ${item.code} has no pack "${l.uom ?? ""}"`, { itemId: l.itemId });
    const okInt = (n: number, lo: number, hi: number): boolean => Number.isSafeInteger(n) && n >= lo && n <= hi;
    if (!okInt(l.qtyPacks, 0, MAX_PACKS) || !okInt(l.ratePaise, 0, MAX_RATE_PAISE) || !okInt(l.gstRateBps, 0, 2_800)) {
      throw new MaterialsError("bill_invalid", `line for ${item.code}: quantity, rate or GST is out of range`, { itemId: l.itemId });
    }
    const e = expectations.get(`${l.grnId}|${l.itemId}`);
    const expectedBase = e?.acceptedBase ?? 0;
    const rate = e?.rate ?? { paise: 0, per: 1 };
    const taxablePaise = l.qtyPacks * l.ratePaise;
    const split = splitGst(lineGstPaise(taxablePaise, l.gstRateBps), interState);
    const resolved = {
      grnId: l.grnId, itemId: l.itemId, uom: pack?.uom ?? item.baseUom, multiplier, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise,
      taxablePaise, gstRateBps: l.gstRateBps, ...split,
      expectedBase, expectedRatePaise: packRate(multiplier, rate), expectedTaxablePaise: valueAt(expectedBase, rate),
      expectedGstRateBps: e?.gstRateBps ?? item.gstRateBps ?? 0,
    };
    return { ...resolved, mismatch: lineMismatches(resolved).reasons };
  });
  return { lines, grnRows, expectations };
}

function totalsOf(lines: readonly ResolvedLine[], roundOffPaise: number): {
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; roundOffPaise: number; totalPaise: number;
} {
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise"): number => lines.reduce((s, l) => s + l[k], 0);
  const t = { taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise") };
  return { ...t, roundOffPaise, totalPaise: t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise + roundOffPaise };
}

/** What the GRNs received would have cost at the PO's rate, GST included — every accepted item, billed or not. */
function expectedTotalOf(expectations: Map<string, Expectation>): number {
  let total = 0;
  for (const e of expectations.values()) {
    const taxable = valueAt(e.acceptedBase, e.rate);
    total += taxable + lineGstPaise(taxable, e.gstRateBps);
  }
  return total;
}

async function insertLines(tx: Tx, billId: string, lines: readonly ResolvedLine[]): Promise<void> {
  await tx.insert(supplierBillLines).values(lines.map((l) => ({
    id: newId(), billId, grnId: l.grnId, itemId: l.itemId, uom: l.uom, multiplier: l.multiplier, qtyPacks: l.qtyPacks,
    ratePaise: l.ratePaise, taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise,
    igstPaise: l.igstPaise, expectedBase: l.expectedBase, expectedRatePaise: l.expectedRatePaise,
    expectedTaxablePaise: l.expectedTaxablePaise, expectedGstRateBps: l.expectedGstRateBps,
    mismatch: l.mismatch.length === 0 ? null : l.mismatch.join(","),
  })));
}

function cleanText(v: string | null | undefined, what: string): string | null {
  const t = v?.trim() ?? "";
  if (t.length > MAX_TEXT) throw new MaterialsError("bill_invalid", `${what} is longer than ${String(MAX_TEXT)} characters`);
  return t === "" ? null : t;
}

function cleanHeader(input: Pick<BillInput, "vendorBillNo" | "billDate" | "roundOffPaise">, now: Date): { vendorBillNo: string; key: string; billDate: string; fy: string; roundOffPaise: number } {
  const no = input.vendorBillNo.trim();
  const key = vendorBillKey(no);
  if (key === "" || no.length > 64) throw new MaterialsError("bill_invalid", "the vendor's bill number is empty or longer than 64 characters");
  if (!isIsoDate(input.billDate)) throw new MaterialsError("bill_invalid", `bill date "${input.billDate}" is not a calendar date`);
  if (input.billDate > istDay(now)) throw new MaterialsError("bill_invalid", `bill date ${input.billDate} is in the future`);
  const roundOffPaise = input.roundOffPaise ?? 0;
  if (!Number.isSafeInteger(roundOffPaise) || Math.abs(roundOffPaise) > 99) {
    throw new MaterialsError("bill_invalid", "round-off is at most 99 paise either way");
  }
  return { vendorBillNo: no, key, billDate: input.billDate, fy: financialYearOf(input.billDate), roundOffPaise };
}

async function assertNotDuplicate(tx: Tx, vendorId: string, key: string, fy: string, exceptBillId: string | null): Promise<void> {
  const dup = await tx.select({ billNo: supplierBills.billNo, vendorBillNo: supplierBills.vendorBillNo }).from(supplierBills)
    .where(and(
      eq(supplierBills.vendorId, vendorId), eq(supplierBills.vendorBillKey, key), eq(supplierBills.fy, fy), ne(supplierBills.status, "cancelled"),
      ...(exceptBillId === null ? [] : [ne(supplierBills.id, exceptBillId)]),
    )).limit(1);
  if (dup[0] !== undefined) {
    throw new MaterialsError("duplicate_bill", `this vendor's bill ${dup[0].vendorBillNo} is already booked as ${dup[0].billNo} in FY ${fy}`, {
      billNo: dup[0].billNo, fy,
    });
  }
}

/** The one PO every GRN on the bill was received against, when there is exactly one. */
const poOf = (grnRows: readonly GrnRow[]): string | null => {
  const pos = [...new Set(grnRows.map((g) => g.purchaseOrderId))];
  return pos.length === 1 ? pos[0]! : null;
};

type BillRow = typeof supplierBills.$inferSelect;

async function lockBill(tx: Tx, billId: string): Promise<BillRow> {
  const [row] = await tx.select().from(supplierBills).where(eq(supplierBills.id, billId)).for("update");
  if (row === undefined) throw new MaterialsError("unknown_supplier_bill", `supplier bill ${billId} not found`);
  return row;
}

function wrongStatus(b: BillRow, act: string, need: readonly string[]): MaterialsError {
  return new MaterialsError("bill_wrong_status", `bill ${b.billNo} is ${b.status}; ${act} needs it ${need.join(" or ")}`, { status: b.status, billNo: b.billNo });
}

const header = (b: Pick<BillRow, "id" | "billNo" | "vendorId" | "vendorBillNo" | "totalPaise">): { billId: string; billNo: string; vendorId: string; vendorBillNo: string; totalPaise: number } =>
  ({ billId: b.id, billNo: b.billNo, vendorId: b.vendorId, vendorBillNo: b.vendorBillNo, totalPaise: b.totalPaise });

/** Postgres' unique violation on the vendor / bill number / FY index, answered as the act would have. */
function isDuplicateIndex(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err.code ?? err.cause?.code;
  const constraint = err.constraint ?? err.cause?.constraint;
  return code === "23505" && constraint === "supplier_bills_vendor_key_fy_ux";
}

// ═══════════════════════════════════ enter, edit ═══════════════════════════════════

export async function createSupplierBill(
  db: Db, actor: Actor, input: BillInput, opts: { source?: "manual" | "agent"; now?: Date } = {},
): Promise<BillView> {
  await requirePerm(db, actor, BILLS_MANAGE, "entering a supplier bill");
  const now = opts.now ?? new Date();
  let billId: string;
  try {
    billId = await withTx(db, async (tx) => {
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, input.vendorId));
      if (vendor === undefined) throw new MaterialsError("unknown_vendor", `vendor ${input.vendorId} not found`);
      const h = cleanHeader(input, now);
      await assertNotDuplicate(tx, input.vendorId, h.key, h.fy, null);
      const interState = input.interState ?? false;
      const { lines, grnRows, expectations } = await resolveLines(tx, input.vendorId, input.lines, interState, null);
      const id = newId();
      const billNo = await nextEpisodeNo(tx, "supplier_bill", istDay(now));
      const totals = totalsOf(lines, h.roundOffPaise);
      await tx.insert(supplierBills).values({
        id, billNo, vendorId: input.vendorId, vendorBillNo: h.vendorBillNo, vendorBillKey: h.key, billDate: h.billDate, fy: h.fy,
        purchaseOrderId: poOf(grnRows), status: "draft", interState, ...totals, expectedTotalPaise: expectedTotalOf(expectations),
        msme: isMsme(vendor), termsDays: vendor.paymentTermsDays, note: cleanText(input.note, "the note"),
        createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
      });
      await insertLines(tx, id, lines);
      await appendEvent(tx, supplierBillDrafted.make({
        occurredAt: now, actor, correlationId: id,
        payload: {
          billId: id, billNo, vendorId: input.vendorId, vendorBillNo: h.vendorBillNo, totalPaise: totals.totalPaise,
          grnIds: grnRows.map((g) => g.id), lines: lines.length, source: opts.source ?? "manual",
        },
      }));
      return id;
    });
  } catch (e) {
    if (isDuplicateIndex(e)) throw new MaterialsError("duplicate_bill", "this vendor's bill number is already booked in this financial year");
    throw e;
  }
  return (await readSupplierBill(db, billId))!;
}

/** Header and, when given, the whole set of lines. A matched or held bill edited goes back to draft. */
export async function updateSupplierBill(
  db: Db, actor: Actor, billId: string, patch: Partial<BillInput>, now: Date = new Date(),
): Promise<BillView> {
  await requirePerm(db, actor, BILLS_MANAGE, "editing a supplier bill");
  try {
    await withTx(db, async (tx) => {
      const b = await lockBill(tx, billId);
      if (!EDITABLE.includes(b.status as BillStatus)) throw wrongStatus(b, "editing", EDITABLE);
      if (patch.vendorId !== undefined && patch.vendorId !== b.vendorId) throw new MaterialsError("bill_invalid", "a bill's vendor does not change — cancel it and enter it again");
      const h = cleanHeader({
        vendorBillNo: patch.vendorBillNo ?? b.vendorBillNo, billDate: patch.billDate ?? b.billDate, roundOffPaise: patch.roundOffPaise ?? b.roundOffPaise,
      }, now);
      await assertNotDuplicate(tx, b.vendorId, h.key, h.fy, billId);
      const interState = patch.interState ?? b.interState;
      const inputLines: BillLineInput[] = patch.lines ?? (await tx.select().from(supplierBillLines).where(eq(supplierBillLines.billId, billId)))
        .map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps }));
      const { lines, grnRows, expectations } = await resolveLines(tx, b.vendorId, inputLines, interState, billId);
      await tx.delete(supplierBillLines).where(eq(supplierBillLines.billId, billId));
      await insertLines(tx, billId, lines);
      const totals = totalsOf(lines, h.roundOffPaise);
      const [after] = await tx.update(supplierBills).set({
        vendorBillNo: h.vendorBillNo, vendorBillKey: h.key, billDate: h.billDate, fy: h.fy, interState, ...totals,
        purchaseOrderId: poOf(grnRows), expectedTotalPaise: expectedTotalOf(expectations), status: "draft", heldReason: null, matchedAt: null,
        ...(patch.note !== undefined ? { note: cleanText(patch.note, "the note") } : {}),
        updatedBy: actor.id, updatedAt: now,
      }).where(eq(supplierBills.id, billId)).returning();
      await appendEvent(tx, supplierBillUpdated.make({ occurredAt: now, actor, correlationId: billId, payload: { ...header(after!), lines: lines.length } }));
    });
  } catch (e) {
    if (isDuplicateIndex(e)) throw new MaterialsError("duplicate_bill", "this vendor's bill number is already booked in this financial year");
    throw e;
  }
  return (await readSupplierBill(db, billId))!;
}

// ═══════════════════════════════════ the match, acceptance ═══════════════════════════════════

/**
 * Draft → matched or held_for_match. Re-reads the GRNs (the draft's copy of them has an age), so a
 * line's expectation is always what the gate accepted at the moment of the match.
 */
export async function matchSupplierBill(db: Db, actor: Actor, billId: string, now: Date = new Date()): Promise<BillView> {
  await requirePerm(db, actor, BILLS_MANAGE, "matching a supplier bill");
  await withTx(db, async (tx) => {
    const b = await lockBill(tx, billId);
    if (b.status !== "draft") throw wrongStatus(b, "matching", ["draft"]);
    const current = await tx.select().from(supplierBillLines).where(eq(supplierBillLines.billId, billId));
    const { lines, expectations } = await resolveLines(tx, b.vendorId, current.map((l) => ({
      grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps,
    })), b.interState, billId);
    await tx.delete(supplierBillLines).where(eq(supplierBillLines.billId, billId));
    await insertLines(tx, billId, lines);
    const expectedTotalPaise = expectedTotalOf(expectations);
    const out = lines.filter((l) => lineMismatches(l).out);
    const billed = new Set(lines.map((l) => `${l.grnId}|${l.itemId}`));
    const unbilled = [...expectations.values()].filter((e) => e.acceptedBase > 0 && !billed.has(`${e.grnId}|${e.itemId}`));
    const totalOk = withinMatch(b.totalPaise, expectedTotalPaise);
    const held = out.length > 0 || !totalOk || unbilled.length > 0;
    const reasons = [
      ...(out.length > 0 ? [`${String(out.length)} line(s) outside the match`] : []),
      ...(unbilled.length > 0 ? [`${String(unbilled.length)} received item(s) not billed`] : []),
      ...(!totalOk ? [`total ₹${(b.totalPaise / 100).toFixed(2)} against ₹${(expectedTotalPaise / 100).toFixed(2)} expected`] : []),
    ];
    const [after] = await tx.update(supplierBills).set({
      status: held ? "held_for_match" : "matched", expectedTotalPaise, heldReason: held ? reasons.join("; ") : null, matchedAt: now,
      updatedBy: actor.id, updatedAt: now,
    }).where(eq(supplierBills.id, billId)).returning();
    await appendEvent(tx, supplierBillMatched.make({
      occurredAt: now, actor, correlationId: billId,
      payload: {
        ...header(after!), expectedTotalPaise, outcome: held ? "held_for_match" : "matched",
        mismatches: [
          ...out.map((l) => ({ itemId: l.itemId, grnId: l.grnId, reasons: l.mismatch })),
          ...unbilled.map((e) => ({ itemId: e.itemId, grnId: e.grnId, reasons: ["not_billed"] })),
        ],
      },
    }));
  });
  return (await readSupplierBill(db, billId))!;
}

/** The earliest posting day (IST) of the bill's GRNs — the MSME Act's day of acceptance. */
async function acceptanceDayOf(tx: Tx, billId: string): Promise<string> {
  const rows = await tx.select({ postedAt: grns.postedAt }).from(grns)
    .innerJoin(supplierBillLines, eq(supplierBillLines.grnId, grns.id))
    .where(eq(supplierBillLines.billId, billId));
  const days = rows.map((r) => (r.postedAt === null ? null : istDay(r.postedAt))).filter((d): d is string => d !== null).sort();
  if (days[0] === undefined) throw new MaterialsError("bill_invalid", "the bill names no posted GRN");
  return days[0];
}

async function book(tx: Tx, actor: Actor, b: BillRow, now: Date, difference: { reason: string } | null): Promise<void> {
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, b.vendorId));
  const msme = isMsme(vendor!);
  const acceptanceDate = await acceptanceDayOf(tx, b.id);
  const dueDate = dueDateFor({ msme, termsDays: vendor!.paymentTermsDays, billDate: b.billDate, acceptanceDate });
  await tx.update(supplierBills).set({
    status: "accepted", acceptedBy: actor.id, acceptedAt: now, acceptanceDate, dueDate, msme, termsDays: vendor!.paymentTermsDays,
    ...(difference === null ? {} : { differenceAcceptedBy: actor.id, differenceReason: difference.reason }),
    updatedBy: actor.id, updatedAt: now,
  }).where(eq(supplierBills.id, b.id));
  await appendEvent(tx, supplierBillAccepted.make({
    occurredAt: now, actor, correlationId: b.id,
    payload: { ...header(b), dueDate, msme, differenceReason: difference?.reason ?? null, differencePaise: b.totalPaise - b.expectedTotalPaise },
  }));
}

/** Matched → accepted: now a payable, due by `dueDateFor`. */
export async function acceptSupplierBill(db: Db, actor: Actor, billId: string, now: Date = new Date()): Promise<BillView> {
  await requirePerm(db, actor, BILLS_MANAGE, "accepting a supplier bill");
  await withTx(db, async (tx) => {
    const b = await lockBill(tx, billId);
    if (b.status !== "matched") throw wrongStatus(b, "accepting", ["matched"]);
    await book(tx, actor, b, now, null);
  });
  return (await readSupplierBill(db, billId))!;
}

/**
 * Held → accepted, the difference accepted with a reason: `materials.bills.accept_difference` (the
 * materials head), and never by whoever entered the bill — the maker is not the checker.
 */
export async function acceptBillDifference(db: Db, actor: Actor, billId: string, reason: string, now: Date = new Date()): Promise<BillView> {
  await requirePerm(db, actor, BILLS_ACCEPT_DIFFERENCE, "accepting a bill's difference");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the difference is accepted");
  await withTx(db, async (tx) => {
    const b = await lockBill(tx, billId);
    if (b.status !== "held_for_match") throw wrongStatus(b, "accepting a difference", ["held_for_match"]);
    if (b.createdBy === actor.id) {
      throw new MaterialsError("bill_self_accept", `you entered bill ${b.billNo}; somebody else accepts its difference`, { billNo: b.billNo });
    }
    await book(tx, actor, b, now, { reason: why.slice(0, MAX_TEXT) });
  });
  return (await readSupplierBill(db, billId))!;
}

/** Cancel a bill nothing has been paid on and no open run carries. */
export async function cancelSupplierBill(db: Db, actor: Actor, billId: string, reason: string, now: Date = new Date()): Promise<BillView> {
  await requirePerm(db, actor, BILLS_MANAGE, "cancelling a supplier bill");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the bill is cancelled");
  await withTx(db, async (tx) => {
    const b = await lockBill(tx, billId);
    const cancellable = ["draft", "matched", "held_for_match", "accepted"];
    if (!cancellable.includes(b.status) || b.paidPaise > 0) throw wrongStatus(b, "cancelling", cancellable);
    const onRun = await tx.select({ runNo: supplierPaymentRuns.runNo }).from(supplierPaymentRunLines)
      .innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPaymentRunLines.runId))
      .where(and(eq(supplierPaymentRunLines.billId, billId), inArray(supplierPaymentRuns.status, ["draft", "pending_authorisation", "authorised"])))
      .limit(1);
    if (onRun[0] !== undefined) {
      throw new MaterialsError("bill_wrong_status", `bill ${b.billNo} is on payment run ${onRun[0].runNo}; take it off the run first`, { runNo: onRun[0].runNo });
    }
    await tx.update(supplierBills).set({
      status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: why.slice(0, MAX_TEXT), updatedBy: actor.id, updatedAt: now,
    }).where(eq(supplierBills.id, billId));
    await appendEvent(tx, supplierBillCancelled.make({
      occurredAt: now, actor, correlationId: billId, payload: { ...header(b), reason: why.slice(0, MAX_TEXT), fromStatus: b.status },
    }));
  });
  return (await readSupplierBill(db, billId))!;
}

// ═══════════════════════════════════ the agent's prefill ═══════════════════════════════════

export type BillDraft = {
  vendorId: string; vendorName: string; vendorGstin: string | null; msme: boolean; grnId: string; grnNo: string;
  purchaseOrderId: string | null; poNo: string | null; vendorBillNo: string; billDate: string; interState: boolean;
  lines: (BillLineInput & { itemCode: string; itemName: string; uom: string; multiplier: number; expectedBase: number })[];
  expectedTotalPaise: number;
};

/**
 * What a bill for this GRN would say if the vendor billed exactly what the gate accepted at the PO's
 * rate: the agent's prefill. `interState` is the caller's (it knows the hospital's GSTIN state); the
 * vendor's bill number and date are the challan's invoice number and date until a person types them.
 * Writes nothing.
 */
export async function billDraftFromGrn(db: Db, actor: Actor, grnId: string, opts: { hospitalStateCode?: string | null } = {}): Promise<BillDraft> {
  await requirePerm(db, actor, BILLS_MANAGE, "drafting a supplier bill");
  const [g] = await db.select().from(grns).where(eq(grns.id, grnId));
  if (g === undefined) throw new MaterialsError("unknown_document", `GRN ${grnId} not found`);
  if (g.status !== "posted" || g.source !== "challan") {
    throw new MaterialsError("bill_invalid", `GRN ${g.grnNo} is ${g.status} (${g.source}); only a posted challan is billed`, { grnNo: g.grnNo });
  }
  const taken = await db.select({ billNo: supplierBills.billNo }).from(supplierBillLines)
    .innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId))
    .where(and(eq(supplierBillLines.grnId, grnId), ne(supplierBills.status, "cancelled"))).limit(1);
  if (taken[0] !== undefined) throw new MaterialsError("grn_already_billed", `GRN ${g.grnNo} is already on bill ${taken[0].billNo}`, { billNo: taken[0].billNo });
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, g.vendorId));
  const expectations = await expectationsOf(db, [g]);
  const itemIds = [...new Set([...expectations.values()].map((e) => e.itemId))];
  const its = itemIds.length === 0 ? [] : await db.select().from(items).where(inArray(items.id, itemIds));
  const packs = itemIds.length === 0 ? [] : await db.select().from(itemUoms).where(inArray(itemUoms.itemId, itemIds));
  const po = g.purchaseOrderId === null ? undefined : (await db.select({ poNo: purchaseOrders.poNo }).from(purchaseOrders).where(eq(purchaseOrders.id, g.purchaseOrderId)))[0];
  const poLines = g.purchaseOrderId === null ? [] : await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, g.purchaseOrderId));
  const vendorState = vendor!.gstin?.slice(0, 2) ?? null;
  const interState = vendorState !== null && opts.hospitalStateCode != null && vendorState !== opts.hospitalStateCode;
  const lines = [...expectations.values()].filter((e) => e.acceptedBase > 0).map((e) => {
    const item = its.find((i) => i.id === e.itemId)!;
    const mine = packs.filter((p) => p.itemId === e.itemId);
    const pl = poLines.find((p) => p.itemId === e.itemId);
    // The PO's pack when the order named one, else the item's purchase pack; a quantity that is not a
    // whole number of packs is billed in base units, as a vendor would.
    const pack = mine.find((p) => p.uom === pl?.uom) ?? mine.find((p) => p.isPurchaseUom) ?? mine.find((p) => p.toBaseMultiplier === 1);
    const whole = pack !== undefined && e.acceptedBase % pack.toBaseMultiplier === 0;
    const uom = whole ? pack.uom : item.baseUom;
    const multiplier = whole ? pack.toBaseMultiplier : 1;
    return {
      grnId: g.id, itemId: e.itemId, itemCode: item.code, itemName: item.name, uom, multiplier,
      qtyPacks: e.acceptedBase / multiplier, ratePaise: packRate(multiplier, e.rate), gstRateBps: e.gstRateBps, expectedBase: e.acceptedBase,
    };
  }).sort((a, b) => a.itemName.localeCompare(b.itemName));
  return {
    vendorId: g.vendorId, vendorName: vendor!.tradeName ?? vendor!.legalName, vendorGstin: vendor!.gstin, msme: isMsme(vendor!),
    grnId: g.id, grnNo: g.grnNo, purchaseOrderId: g.purchaseOrderId, poNo: po?.poNo ?? null,
    vendorBillNo: g.invoiceNo ?? "", billDate: g.challanDate, interState, lines, expectedTotalPaise: expectedTotalOf(expectations),
  };
}

export type UnbilledGrn = { grnId: string; grnNo: string; vendorId: string; vendorName: string; postedAt: string; invoiceNo: string | null; poNo: string | null };

/** Posted challans no live bill names yet — the office's "bills to match" card. Oldest first. */
export async function unbilledGrns(db: Db, actor: Actor, limit = 200): Promise<UnbilledGrn[]> {
  await requirePayablesReader(db, actor);
  const billed = db.select({ grnId: supplierBillLines.grnId }).from(supplierBillLines)
    .innerJoin(supplierBills, eq(supplierBills.id, supplierBillLines.billId)).where(ne(supplierBills.status, "cancelled"));
  const rows = await db.select({ g: grns, vendorName: sql<string>`coalesce(${vendors.tradeName}, ${vendors.legalName})`, poNo: purchaseOrders.poNo })
    .from(grns).innerJoin(vendors, eq(vendors.id, grns.vendorId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, grns.purchaseOrderId))
    .where(and(eq(grns.status, "posted"), eq(grns.source, "challan"), notInArray(grns.id, billed)))
    .orderBy(asc(grns.postedAt), asc(grns.grnNo)).limit(Math.min(limit, 500));
  return rows.map((r) => ({
    grnId: r.g.id, grnNo: r.g.grnNo, vendorId: r.g.vendorId, vendorName: r.vendorName, postedAt: r.g.postedAt?.toISOString() ?? "",
    invoiceNo: r.g.invoiceNo, poNo: r.poNo,
  }));
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

function summaryOf(b: BillRow, vendor: { code: string; legalName: string; tradeName: string | null }): BillSummary {
  return {
    id: b.id, billNo: b.billNo, status: b.status as BillStatus, vendorId: b.vendorId, vendorCode: vendor.code,
    vendorName: vendor.tradeName ?? vendor.legalName, msme: b.msme, vendorBillNo: b.vendorBillNo, billDate: b.billDate, fy: b.fy,
    purchaseOrderId: b.purchaseOrderId, interState: b.interState, taxablePaise: b.taxablePaise, cgstPaise: b.cgstPaise,
    sgstPaise: b.sgstPaise, igstPaise: b.igstPaise, roundOffPaise: b.roundOffPaise, totalPaise: b.totalPaise,
    expectedTotalPaise: b.expectedTotalPaise, paidPaise: b.paidPaise,
    outstandingPaise: b.status === "cancelled" ? 0 : b.totalPaise - b.paidPaise, heldReason: b.heldReason,
    acceptanceDate: b.acceptanceDate, dueDate: b.dueDate, differenceReason: b.differenceReason,
    createdBy: b.createdBy, createdAt: b.createdAt.toISOString(), acceptedBy: b.acceptedBy, acceptedAt: b.acceptedAt?.toISOString() ?? null,
  };
}

async function readSupplierBill(db: Db, billId: string): Promise<BillView | undefined> {
  const [row] = await db.select({ b: supplierBills, vendor: vendors, poNo: purchaseOrders.poNo }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, supplierBills.purchaseOrderId))
    .where(eq(supplierBills.id, billId));
  if (row === undefined) return undefined;
  const lines = await db.select({ l: supplierBillLines, code: items.code, name: items.name, grnNo: grns.grnNo }).from(supplierBillLines)
    .innerJoin(items, eq(items.id, supplierBillLines.itemId)).innerJoin(grns, eq(grns.id, supplierBillLines.grnId))
    .where(eq(supplierBillLines.billId, billId)).orderBy(asc(grns.grnNo), asc(items.name));
  const grnIds = [...new Set(lines.map((l) => l.l.grnId))];
  const grnRows = grnIds.length === 0 ? [] : await db.select().from(grns).where(inArray(grns.id, grnIds));
  const expectations = await expectationsOf(db, grnRows);
  const billed = new Set(lines.map((l) => `${l.l.grnId}|${l.l.itemId}`));
  const missing = [...expectations.values()].filter((e) => e.acceptedBase > 0 && !billed.has(`${e.grnId}|${e.itemId}`));
  const missingItems = missing.length === 0 ? [] : await db.select().from(items).where(inArray(items.id, missing.map((m) => m.itemId)));
  const payments = await db.select({ p: supplierPayments, runNo: supplierPaymentRuns.runNo, paid: supplierPaymentRunLines.payPaise, credit: supplierPaymentRunLines.creditPaise })
    .from(supplierPaymentRunLines)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRunLines.paymentId))
    .innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPaymentRunLines.runId))
    .where(eq(supplierPaymentRunLines.billId, billId)).orderBy(asc(supplierPayments.paidOn), asc(supplierPayments.paymentNo));
  const names = await namesOf(db, [row.b.createdBy, row.b.acceptedBy, row.b.differenceAcceptedBy, row.b.cancelledBy]);
  return {
    ...summaryOf(row.b, row.vendor), note: row.b.note, poNo: row.poNo, cancelReason: row.b.cancelReason,
    differenceAcceptedBy: row.b.differenceAcceptedBy, names,
    lines: lines.map(({ l, code, name, grnNo }) => {
      const m = lineMismatches(l);
      return {
        id: l.id, grnId: l.grnId, grnNo, itemId: l.itemId, itemCode: code, itemName: name, uom: l.uom, multiplier: l.multiplier,
        qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, taxablePaise: l.taxablePaise, gstRateBps: l.gstRateBps, cgstPaise: l.cgstPaise,
        sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, totalPaise: l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise,
        expectedBase: l.expectedBase, expectedPacks: l.expectedBase / l.multiplier, expectedRatePaise: l.expectedRatePaise,
        expectedTaxablePaise: l.expectedTaxablePaise, expectedGstRateBps: l.expectedGstRateBps,
        differencePaise: l.taxablePaise - l.expectedTaxablePaise, mismatch: m.reasons, out: m.out,
      };
    }),
    unbilled: missing.map((e) => {
      const it = missingItems.find((i) => i.id === e.itemId);
      return {
        grnId: e.grnId, grnNo: e.grnNo, itemId: e.itemId, itemCode: it?.code ?? "", itemName: it?.name ?? "",
        expectedBase: e.acceptedBase, expectedTaxablePaise: valueAt(e.acceptedBase, e.rate),
      };
    }),
    payments: payments.map(({ p, runNo, paid, credit }) => ({
      paymentId: p.id, paymentNo: p.paymentNo, runNo, mode: p.mode, reference: p.reference, paidOn: p.paidOn, paidPaise: paid, creditPaise: credit,
    })),
  };
}

export async function getSupplierBill(db: Db, actor: Actor, billId: string): Promise<BillView> {
  await requirePayablesReader(db, actor);
  const b = await readSupplierBill(db, billId);
  if (b === undefined) throw new MaterialsError("unknown_supplier_bill", `supplier bill ${billId} not found`);
  return b;
}

export type BillFilter = { statuses?: readonly BillStatus[]; vendorId?: string; limit?: number };

export async function listSupplierBills(db: Db, actor: Actor, filter: BillFilter = {}): Promise<BillSummary[]> {
  await requirePayablesReader(db, actor);
  const where = [
    ...(filter.statuses === undefined || filter.statuses.length === 0 ? [] : [inArray(supplierBills.status, [...filter.statuses])]),
    ...(filter.vendorId === undefined ? [] : [eq(supplierBills.vendorId, filter.vendorId)]),
  ];
  const rows = await db.select({ b: supplierBills, vendor: vendors }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(supplierBills.createdAt), desc(supplierBills.id)).limit(Math.min(filter.limit ?? 200, 1000));
  return rows.map((r) => summaryOf(r.b, r.vendor));
}

// ═══════════════════════════════════ payables, ageing, ledger ═══════════════════════════════════

export type AgeBucket = "0_30" | "31_60" | "61_90" | "90_plus";
export const AGE_BUCKETS: readonly AgeBucket[] = ["0_30", "31_60", "61_90", "90_plus"];

/** The ageing bucket of a bill `age` days after its bill date. */
export function ageBucketOf(ageDays: number): AgeBucket {
  if (ageDays <= 30) return "0_30";
  if (ageDays <= 60) return "31_60";
  if (ageDays <= 90) return "61_90";
  return "90_plus";
}

export type PayableRow = BillSummary & { ageDays: number; bucket: AgeBucket; overdueDays: number; reservedPaise: number };

export type SupplierSummaryRow = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean; phone: string | null; gstin: string | null;
  totalPaise: number; paidPaise: number; remainingPaise: number; overduePaise: number; buckets: Record<AgeBucket, number>;
  /**
   * PARITY P4 — the vendor's accepted credit not yet set against a paid bill (`accepted − applied`,
   * what open runs hold included), and what the hospital owes net of it: `remaining − credit`,
   * which is the supplier ledger's closing balance.
   */
  creditPaise: number;
  netPaise: number;
};

export type Payables = {
  asOf: string;
  bills: PayableRow[];
  suppliers: SupplierSummaryRow[];
  buckets: Record<AgeBucket, number>;
  totalOutstandingPaise: number;
  overduePaise: number;
};

/**
 * What each open run reserves against each bill: pay + credit on runs not yet paid, cancelled runs
 * aside. (Parity P4: a line's credit settles the bill as surely as its payment, so it is held too.)
 */
export async function reservedByBill(db: Db | Tx, billIds: readonly string[], exceptRunId?: string): Promise<Map<string, number>> {
  if (billIds.length === 0) return new Map();
  const rows = await db.select({ billId: supplierPaymentRunLines.billId, paise: sql<string>`sum(${supplierPaymentRunLines.payPaise} + ${supplierPaymentRunLines.creditPaise})` })
    .from(supplierPaymentRunLines).innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPaymentRunLines.runId))
    .where(and(
      inArray(supplierPaymentRunLines.billId, [...billIds]), isNull(supplierPaymentRunLines.paymentId),
      inArray(supplierPaymentRuns.status, ["draft", "pending_authorisation", "authorised"]),
      ...(exceptRunId === undefined ? [] : [ne(supplierPaymentRuns.id, exceptRunId)]),
    ))
    .groupBy(supplierPaymentRunLines.billId);
  return new Map(rows.map((r) => [r.billId, Number(r.paise)]));
}

// ═══════════════════════════════════ the vendor's credit (parity P4) ═══════════════════════════════════

export type VendorCredit = {
  /** Every accepted vendor credit note, summed. */
  acceptedPaise: number;
  /** Set against bills on recorded payments. */
  appliedPaise: number;
  /** Held by run lines not yet paid, on runs not cancelled. */
  reservedPaise: number;
  /** What a new run may still spend: `accepted − applied − reserved`. */
  availablePaise: number;
};

/**
 * PARITY P4 — THE VENDOR'S CREDIT, AS THE PAYMENT RUN SPENDS IT. An accepted credit note (the
 * vendor's answer to our debit note, `supplier-returns.ts`) is one pool per vendor; a run line's
 * `credit_paise` spends it — reserved while the run is open, applied once the vendor's payment is
 * recorded, released if the run is cancelled. Keyed by vendor; a vendor with none is absent.
 * `exceptRunId` leaves that run's own lines out (editing a draft re-spends what it held).
 */
export async function vendorCredits(db: Db | Tx, vendorIds?: readonly string[], exceptRunId?: string): Promise<Map<string, VendorCredit>> {
  const only = vendorIds === undefined ? [] : [...new Set(vendorIds)];
  if (vendorIds !== undefined && only.length === 0) return new Map();
  const accepted = await db.select({ vendorId: supplierCreditNotes.vendorId, paise: sql<string>`sum(${supplierCreditNotes.amountPaise})` })
    .from(supplierCreditNotes)
    .where(and(eq(supplierCreditNotes.status, "accepted"), ...(vendorIds === undefined ? [] : [inArray(supplierCreditNotes.vendorId, only)])))
    .groupBy(supplierCreditNotes.vendorId);
  const spent = await db.select({
    vendorId: supplierPaymentRunLines.vendorId,
    applied: sql<string>`coalesce(sum(${supplierPaymentRunLines.creditPaise}) filter (where ${supplierPaymentRunLines.paymentId} is not null), 0)`,
    reserved: sql<string>`coalesce(sum(${supplierPaymentRunLines.creditPaise}) filter (where ${supplierPaymentRunLines.paymentId} is null), 0)`,
  }).from(supplierPaymentRunLines).innerJoin(supplierPaymentRuns, eq(supplierPaymentRuns.id, supplierPaymentRunLines.runId))
    .where(and(
      sql`${supplierPaymentRunLines.creditPaise} > 0`, ne(supplierPaymentRuns.status, "cancelled"),
      ...(vendorIds === undefined ? [] : [inArray(supplierPaymentRunLines.vendorId, only)]),
      ...(exceptRunId === undefined ? [] : [ne(supplierPaymentRuns.id, exceptRunId)]),
    ))
    .groupBy(supplierPaymentRunLines.vendorId);
  const out = new Map<string, VendorCredit>();
  const get = (v: string): VendorCredit => out.get(v) ?? { acceptedPaise: 0, appliedPaise: 0, reservedPaise: 0, availablePaise: 0 };
  for (const a of accepted) out.set(a.vendorId, { ...get(a.vendorId), acceptedPaise: Number(a.paise) });
  for (const x of spent) out.set(x.vendorId, { ...get(x.vendorId), appliedPaise: Number(x.applied), reservedPaise: Number(x.reserved) });
  for (const c of out.values()) c.availablePaise = c.acceptedPaise - c.appliedPaise - c.reservedPaise;
  return out;
}

/**
 * Every accepted and part-paid bill: outstanding, due, days overdue and its ageing bucket (by bill
 * date, the Healthray and the accountant's convention), and the Supplier Summary — per vendor, the
 * total booked, paid and remaining (paid-in-full bills included, so "total" is the vendor's book).
 */
export async function payables(db: Db, actor: Actor, now: Date = new Date(), filter: { vendorId?: string } = {}): Promise<Payables> {
  await requirePayablesReader(db, actor);
  const today = istDay(now);
  const rows = await db.select({ b: supplierBills, vendor: vendors }).from(supplierBills)
    .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
    .where(and(
      inArray(supplierBills.status, ["accepted", "part_paid", "paid"]),
      ...(filter.vendorId === undefined ? [] : [eq(supplierBills.vendorId, filter.vendorId)]),
    ))
    .orderBy(asc(supplierBills.dueDate), asc(supplierBills.billNo));
  const open = rows.filter((r) => r.b.status !== "paid");
  const reserved = await reservedByBill(db, open.map((r) => r.b.id));
  const buckets: Record<AgeBucket, number> = { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
  const bySupplier = new Map<string, SupplierSummaryRow>();
  const bills: PayableRow[] = [];
  let overduePaise = 0;
  for (const { b, vendor } of rows) {
    const s = bySupplier.get(b.vendorId) ?? {
      vendorId: b.vendorId, vendorCode: vendor.code, vendorName: vendor.tradeName ?? vendor.legalName, msme: isMsme(vendor),
      phone: null, gstin: vendor.gstin, totalPaise: 0, paidPaise: 0, remainingPaise: 0, overduePaise: 0,
      buckets: { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 }, creditPaise: 0, netPaise: 0,
    };
    s.totalPaise += b.totalPaise;
    s.paidPaise += b.paidPaise;
    bySupplier.set(b.vendorId, s);
    if (b.status === "paid") continue;
    const outstanding = b.totalPaise - b.paidPaise;
    const ageDays = daysBetween(b.billDate, today);
    const bucket = ageBucketOf(ageDays);
    const overdueDays = b.dueDate === null ? 0 : Math.max(0, daysBetween(b.dueDate, today));
    buckets[bucket] += outstanding;
    s.buckets[bucket] += outstanding;
    s.remainingPaise += outstanding;
    if (overdueDays > 0) { s.overduePaise += outstanding; overduePaise += outstanding; }
    bills.push({ ...summaryOf(b, vendor), ageDays, bucket, overdueDays, reservedPaise: reserved.get(b.id) ?? 0 });
  }
  // PARITY P4 — each vendor's unapplied credit, and what is owed net of it (the ledger's balance).
  const credits = await vendorCredits(db, filter.vendorId === undefined ? undefined : [filter.vendorId]);
  for (const [vendorId, c] of credits) {
    const unapplied = c.acceptedPaise - c.appliedPaise;
    if (unapplied === 0) continue;
    let s = bySupplier.get(vendorId);
    if (s === undefined) {
      const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
      if (vendor === undefined) continue;
      s = {
        vendorId, vendorCode: vendor.code, vendorName: vendor.tradeName ?? vendor.legalName, msme: isMsme(vendor), phone: null, gstin: vendor.gstin,
        totalPaise: 0, paidPaise: 0, remainingPaise: 0, overduePaise: 0, buckets: { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 }, creditPaise: 0, netPaise: 0,
      };
      bySupplier.set(vendorId, s);
    }
    s.creditPaise = unapplied;
  }
  for (const s of bySupplier.values()) s.netPaise = s.remainingPaise - s.creditPaise;
  const suppliers = [...bySupplier.values()].sort((a, b) => b.remainingPaise - a.remainingPaise || a.vendorName.localeCompare(b.vendorName));
  return { asOf: today, bills, suppliers, buckets, totalOutstandingPaise: bills.reduce((s, b) => s + b.outstandingPaise, 0), overduePaise };
}

export type LedgerEntry = {
  date: string; kind: "bill" | "payment" | "debit_note" | "credit_note"; voucherNo: string; reference: string;
  /** What we owe the vendor goes up (a bill) … */
  creditPaise: number;
  /** … or down (a payment, or the vendor's accepted credit note). */
  debitPaise: number;
  /**
   * PARITY P4 — our DEBIT NOTE's amount on a `debit_note` row: the claim the goods went back with. It
   * does not move the balance; the vendor's credit note, when accepted, does (a `credit_note` row,
   * possibly for less). So the balance is always what the payables book says is owed.
   */
  memoPaise: number;
  balancePaise: number;
  id: string;
};

export type SupplierLedger = {
  vendorId: string; vendorCode: string; vendorName: string; msme: boolean; from: string | null; to: string | null;
  openingPaise: number; entries: LedgerEntry[]; closingPaise: number; billedPaise: number; paidPaise: number;
  /** PARITY P4 — the vendor's accepted credit notes in the window. */
  creditedPaise: number;
};

const LEDGER_KIND_ORDER: Record<LedgerEntry["kind"], number> = { bill: 0, debit_note: 1, credit_note: 2, payment: 3 };

/**
 * One vendor's account, oldest first: each accepted bill on its bill date (credit), each payment on
 * the day it was paid (debit), each debit note we issued on its date (a memo, no balance effect) and
 * each accepted vendor credit note on its date (debit), and the running balance we owe. Before `from`
 * everything folds into the opening balance. Balance = bills − payments − credits, always.
 */
export async function supplierLedger(db: Db, actor: Actor, vendorId: string, range: { from?: string | null; to?: string | null } = {}): Promise<SupplierLedger> {
  await requirePayablesReader(db, actor);
  const from = range.from ?? null;
  const to = range.to ?? null;
  for (const d of [from, to]) if (d !== null && !isIsoDate(d)) throw new MaterialsError("bill_invalid", `"${d}" is not a calendar date`);
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
  if (vendor === undefined) throw new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`);
  const bills = await db.select().from(supplierBills)
    .where(and(eq(supplierBills.vendorId, vendorId), inArray(supplierBills.status, ["accepted", "part_paid", "paid"]), ...(to === null ? [] : [lte(supplierBills.billDate, to)])));
  const pays = await db.select().from(supplierPayments)
    .where(and(eq(supplierPayments.vendorId, vendorId), ...(to === null ? [] : [lte(supplierPayments.paidOn, to)])));
  const debitNotes = await db.select().from(supplierReturns)
    .where(and(eq(supplierReturns.vendorId, vendorId), isNotNull(supplierReturns.debitNoteNo), ...(to === null ? [] : [lte(supplierReturns.debitNoteDate, to)])));
  const credits = await db.select({ c: supplierCreditNotes, returnNo: supplierReturns.returnNo, debitNoteNo: supplierReturns.debitNoteNo })
    .from(supplierCreditNotes).innerJoin(supplierReturns, eq(supplierReturns.id, supplierCreditNotes.returnId))
    .where(and(eq(supplierCreditNotes.vendorId, vendorId), eq(supplierCreditNotes.status, "accepted"), ...(to === null ? [] : [lte(supplierCreditNotes.creditNoteDate, to)])));
  const all: Omit<LedgerEntry, "balancePaise">[] = [
    ...bills.map((b) => ({ date: b.billDate, kind: "bill" as const, voucherNo: b.billNo, reference: b.vendorBillNo, creditPaise: b.totalPaise, debitPaise: 0, memoPaise: 0, id: b.id })),
    ...pays.map((p) => ({ date: p.paidOn, kind: "payment" as const, voucherNo: p.paymentNo, reference: `${p.mode.toUpperCase()}${p.reference === null ? "" : ` ${p.reference}`}`, creditPaise: 0, debitPaise: p.amountPaise, memoPaise: 0, id: p.id })),
    ...debitNotes.map((r) => ({ date: r.debitNoteDate!, kind: "debit_note" as const, voucherNo: r.debitNoteNo!, reference: r.returnNo, creditPaise: 0, debitPaise: 0, memoPaise: r.totalPaise, id: r.id })),
    ...credits.map(({ c, debitNoteNo }) => ({
      date: c.creditNoteDate, kind: "credit_note" as const, voucherNo: c.creditNo, reference: `${c.vendorCreditNoteNo}${debitNoteNo === null ? "" : ` · ${debitNoteNo}`}`,
      creditPaise: 0, debitPaise: c.amountPaise, memoPaise: 0, id: c.id,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || LEDGER_KIND_ORDER[a.kind] - LEDGER_KIND_ORDER[b.kind] || a.voucherNo.localeCompare(b.voucherNo));
  let balance = 0;
  let openingPaise = 0;
  const entries: LedgerEntry[] = [];
  for (const e of all) {
    balance += e.creditPaise - e.debitPaise;
    if (from !== null && e.date < from) { openingPaise = balance; continue; }
    entries.push({ ...e, balancePaise: balance });
  }
  return {
    vendorId, vendorCode: vendor.code, vendorName: vendor.tradeName ?? vendor.legalName, msme: isMsme(vendor), from, to,
    openingPaise, entries, closingPaise: balance,
    billedPaise: entries.reduce((s, e) => s + e.creditPaise, 0),
    paidPaise: entries.filter((e) => e.kind === "payment").reduce((s, e) => s + e.debitPaise, 0),
    creditedPaise: entries.filter((e) => e.kind === "credit_note").reduce((s, e) => s + e.debitPaise, 0),
  };
}

/** Accepted bills due on or before `until` (IST date), for the office cards and the run's draft. */
export async function billsDueBy(db: Db | Tx, until: string): Promise<BillRow[]> {
  return db.select().from(supplierBills)
    .where(and(inArray(supplierBills.status, ["accepted", "part_paid"]), lte(supplierBills.dueDate, until)))
    .orderBy(asc(supplierBills.dueDate), asc(supplierBills.billNo));
}

/** Bills whose due date falls in [from, to]. */
export async function billsDueBetween(db: Db | Tx, from: string, to: string): Promise<BillRow[]> {
  return db.select().from(supplierBills)
    .where(and(inArray(supplierBills.status, ["accepted", "part_paid"]), gte(supplierBills.dueDate, from), lte(supplierBills.dueDate, to)))
    .orderBy(asc(supplierBills.dueDate));
}
