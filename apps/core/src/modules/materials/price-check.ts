import { and, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { grnLines, grns, items, users, vendors } from "../../kernel/db/schema";
import { NON_SUPPLIER_VENDOR_CODES, OPENING_STOCK_SOURCE, PRICE_CHECK_ROUNDING_PAISE, PRICE_CHECK_THRESHOLD_BPS } from "./config";
import { withMergedAliases } from "./items";
import { contractRatesFor } from "./vendor-rates";
import { supplierVendorsOnly } from "./vendors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #1061 — THE PURCHASE PRICE CHECK (spec docs/specs/1061-grn-price-check.md, ruling 0096) ═══
 *
 * Until #1061 a supplier delivery was captured with no look at what the hospital paid before: the PO receipt
 * checked quantity, the supplier bill checked the GRN, and nothing checked the rate against history. Now every
 * PAID line of a supplier GRN is compared, per base unit (a box of 100 against strips of 10), with:
 *
 *   (a) the item's last paid receipt from ANY supplier — a posted GRN line, accepted, not free, not the opening
 *       count, not the hospital's own stock vendors; and
 *   (b) this supplier's contract rate in force today (`vendor-rates.ts`).
 *
 * MORE than `PRICE_CHECK_THRESHOLD_BPS` (2%) above either is **amber**: `captureGrn` refuses the line
 * (`price_reason_required`) until a reason is given, stores the reference and the reason on the line and emits
 * `grn.price_above_reference`. A difference of `PRICE_CHECK_ROUNDING_PAISE` or less per base unit is the floor of a
 * per-unit cost and never amber. With no receipt and no contract the line is a **first purchase**. Both entry paths
 * reach `captureGrn`: the stock-entry invoice grid (`pharmacy/opening-stock.ts`) and PO receipt (`POST /materials/grns`).
 */

export const PRICE_REASON_CODES = ["mrp_revised", "scheme_changed", "urgent_buy", "other"] as const;
export type PriceReasonCode = (typeof PRICE_REASON_CODES)[number];
export type PriceReason = { code: PriceReasonCode; text?: string | null };

/** The GRN sources a price is paid on. Opening stock and donations are never checked. */
export const PRICE_CHECKED_SOURCES: readonly string[] = ["challan", "consignment_challan"];

/** One past paid receipt of an item: which GRN, when it posted (IST day), from whom, at what cost per base unit. */
export type PriceReceipt = { grnNo: string; postedOn: string; vendorId: string; vendorName: string; paisePerBase: number };
/** This supplier's contract rate in force, and what it comes to per base unit (it may fall between two paise). */
export type PriceContract = { vendorId: string; vendorName: string; uom: string; multiplier: number; ratePaise: number; paisePerBase: number };
export type PriceCheck = {
  status: "ok" | "amber" | "first";
  /** The reference the line is judged against: the one exceeded (the lower, when both are), else the last receipt. */
  refKind: "last_receipt" | "contract" | null;
  refPaisePerBase: number | null;
  /** The line against that reference, in basis points (floored); negative when it is cheaper. */
  riseBps: number | null;
  /** Newest first, at most three. */
  receipts: PriceReceipt[];
  contract: PriceContract | null;
  /** The lowest price on record (a receipt or a contract, any supplier) below this line's, when there is one. */
  cheaper: { vendorId: string; vendorName: string; paisePerBase: number } | null;
};

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const vendorName = sql<string>`coalesce(${vendors.tradeName}, ${vendors.legalName})`;

/** Is `cost` MORE than the threshold above `ref`, and by more than the rounding of one per-unit cost? */
export function isAboveReference(cost: number, ref: number, thresholdBps = PRICE_CHECK_THRESHOLD_BPS): boolean {
  const rise = cost - ref;
  return rise > PRICE_CHECK_ROUNDING_PAISE && rise * 10_000 > ref * thresholdBps;
}

/** THE JUDGEMENT, pure: one line's cost per base unit against its receipts, this supplier's contract and every price on record. */
export function judgePrice(
  costPerBase: number, receipts: readonly PriceReceipt[], contract: PriceContract | null,
  onRecord: readonly { vendorId: string; vendorName: string; paisePerBase: number }[], thresholdBps = PRICE_CHECK_THRESHOLD_BPS,
): PriceCheck {
  const refs: { kind: "last_receipt" | "contract"; perBase: number }[] = [];
  if (receipts[0] !== undefined) refs.push({ kind: "last_receipt", perBase: receipts[0].paisePerBase });
  if (contract !== null) refs.push({ kind: "contract", perBase: contract.paisePerBase });
  const lowest = [...onRecord].sort((a, b) => a.paisePerBase - b.paisePerBase)[0];
  const cheaper = lowest !== undefined && costPerBase - lowest.paisePerBase > PRICE_CHECK_ROUNDING_PAISE ? { ...lowest } : null;
  if (refs.length === 0) return { status: "first", refKind: null, refPaisePerBase: null, riseBps: null, receipts: [...receipts], contract, cheaper };
  const exceeded = refs.filter((r) => isAboveReference(costPerBase, r.perBase, thresholdBps)).sort((a, b) => a.perBase - b.perBase);
  const ref = exceeded[0] ?? refs[0]!;
  return {
    status: exceeded.length > 0 ? "amber" : "ok", refKind: ref.kind, refPaisePerBase: ref.perBase,
    riseBps: ref.perBase === 0 ? null : Math.floor(((costPerBase - ref.perBase) * 10_000) / ref.perBase),
    receipts: [...receipts], contract, cheaper,
  };
}

/**
 * Each item's last `n` PAID receipts, newest first, at cost per base unit: posted, accepted, not free, at a cost
 * above zero, from a real supplier, never the opening count (`source = 'opening_stock'`) nor a donation. Read through
 * merges, as `lastPurchaseByItem` is: a receipt booked under a duplicate since merged counts for the survivor.
 */
export async function purchaseHistoryByItem(db: Db | Tx, itemIds: readonly string[], n = 3): Promise<Map<string, PriceReceipt[]>> {
  const out = new Map<string, PriceReceipt[]>();
  if (itemIds.length === 0) return out;
  const { ids, standsFor } = await withMergedAliases(db, itemIds);
  const rows = await db.select({
    itemId: grnLines.itemId, unitCost: grnLines.unitCostPaise, grnNo: grns.grnNo, postedAt: grns.postedAt, vendorId: grns.vendorId, vendorName,
  })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(vendors, eq(vendors.id, grns.vendorId))
    .where(and(
      inArray(grnLines.itemId, ids), eq(grns.status, "posted"), eq(grnLines.freeGoods, false), sql`${grnLines.qtyAcceptedBase} > 0`,
      sql`${grnLines.unitCostPaise} > 0`, supplierVendorsOnly(), ne(grns.source, OPENING_STOCK_SOURCE), ne(grns.source, "donation"),
    ))
    .orderBy(desc(grns.postedAt), desc(grns.grnNo));
  for (const r of rows) {
    const key = standsFor.get(r.itemId) ?? r.itemId;
    const list = out.get(key) ?? [];
    if (list.length >= n) continue;
    list.push({ grnNo: r.grnNo, postedOn: r.postedAt === null ? "" : IST_DAY.format(r.postedAt), vendorId: r.vendorId, vendorName: r.vendorName, paisePerBase: r.unitCost });
    out.set(key, list);
  }
  return out;
}

/** Is this vendor a real supplier (not the hospital's own opening or trial stock)? */
export function isSupplierCode(code: string): boolean {
  return !(NON_SUPPLIER_VENDOR_CODES as readonly string[]).includes(code.trim().toUpperCase());
}

/**
 * THE CHECK FOR A DELIVERY'S LINES, in order: `null` for a line that is not checked (free goods, cost 0), else its
 * `PriceCheck`. The caller decides whether the GRN is checked at all (`PRICE_CHECKED_SOURCES`, a real supplier).
 */
export async function priceCheckLines(
  db: Db | Tx, input: { vendorId: string; lines: readonly { itemId: string; unitCostPaise: number; freeGoods?: boolean }[] }, now: Date,
): Promise<(PriceCheck | null)[]> {
  const paid = input.lines.filter((l) => !(l.freeGoods ?? false) && l.unitCostPaise > 0);
  if (paid.length === 0) return input.lines.map(() => null);
  const itemIds = [...new Set(paid.map((l) => l.itemId))];
  const [history, contracts] = await Promise.all([purchaseHistoryByItem(db, itemIds), contractRatesFor(db, itemIds, now)]);
  return input.lines.map((l) => {
    if ((l.freeGoods ?? false) || l.unitCostPaise <= 0) return null;
    const receipts = history.get(l.itemId) ?? [];
    const rates = (contracts.get(l.itemId) ?? []).map((c) => ({
      vendorId: c.vendorId, vendorName: c.vendorName, uom: c.uom, multiplier: c.multiplier, ratePaise: c.ratePaise, paisePerBase: c.ratePaise / c.multiplier,
    }));
    const mine = rates.find((c) => c.vendorId === input.vendorId) ?? null;
    const onRecord = [
      ...receipts.map((r) => ({ vendorId: r.vendorId, vendorName: r.vendorName, paisePerBase: r.paisePerBase })),
      ...rates.map((c) => ({ vendorId: c.vendorId, vendorName: c.vendorName, paisePerBase: c.paisePerBase })),
    ];
    return judgePrice(l.unitCostPaise, receipts, mine, onRecord);
  });
}

/** A reason that answers an amber line: one of the four codes, and `other` with its words. */
export function reasonAnswers(reason: PriceReason | null | undefined): reason is PriceReason {
  if (reason === null || reason === undefined) return false;
  if (!(PRICE_REASON_CODES as readonly string[]).includes(reason.code)) return false;
  return reason.code !== "other" || (reason.text ?? "").trim() !== "";
}

// ═══════════════════════════════════ the office's Purchase analysis report ═══════════════════════════════════

export type PurchaseAnalysisRow = {
  grnId: string; grnLineId: string; grnNo: string; capturedOn: string; capturedBy: string; capturedByName: string | null; status: string;
  vendorId: string; vendorName: string; itemId: string; itemCode: string; itemName: string; qtyBase: number;
  paidPaisePerBase: number; refPaisePerBase: number; refKind: string; riseBps: number;
  /** (paid − reference) per base unit × the base quantity captured. */
  extraPaise: number;
  reasonCode: string; reasonText: string | null;
};
export type PurchaseAnalysisReport = {
  from: string; to: string; rows: PurchaseAnalysisRow[];
  byVendor: { vendorId: string; vendorName: string; lines: number; extraPaise: number }[];
  totalExtraPaise: number;
};

const istDayStart = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).start;
const istDayEnd = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).end;

/**
 * #1061 — PURCHASE ANALYSIS: every GRN line captured above its reference (it carries a reason), from GRNs captured
 * in the IST days [from, to] and not cancelled, with the reference, the rate paid, the extra rupees and who; totals
 * by supplier, largest extra first. No actor: the office's wrapper gates it on the margin report's right.
 */
export async function purchaseAnalysisReport(db: Db | Tx, from: string, to: string): Promise<PurchaseAnalysisReport> {
  const rows = await db.select({
    grnId: grns.id, grnLineId: grnLines.id, grnNo: grns.grnNo, createdAt: grns.createdAt, capturedBy: grns.capturedBy, capturedByName: users.fullName, status: grns.status,
    vendorId: grns.vendorId, vendorName, itemId: grnLines.itemId, itemCode: items.code, itemName: items.name, qtyBase: grnLines.qtyBase,
    paid: grnLines.unitCostPaise, ref: grnLines.priceRefPaisePerBase, refKind: grnLines.priceRefKind,
    reasonCode: grnLines.priceReasonCode, reasonText: grnLines.priceReasonText,
  })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(vendors, eq(vendors.id, grns.vendorId))
    .innerJoin(items, eq(items.id, grnLines.itemId)).leftJoin(users, eq(users.id, grns.capturedBy))
    .where(and(
      isNotNull(grnLines.priceReasonCode), notInArray(grns.status, ["cancelled"]),
      gte(grns.createdAt, istDayStart(from)), lt(grns.createdAt, istDayEnd(to)),
    ))
    .orderBy(desc(grns.createdAt), grns.grnNo);
  const out: PurchaseAnalysisRow[] = rows.map((r) => {
    const ref = r.ref ?? 0;
    return {
      grnId: r.grnId, grnLineId: r.grnLineId, grnNo: r.grnNo, capturedOn: IST_DAY.format(r.createdAt), capturedBy: r.capturedBy, capturedByName: r.capturedByName ?? null,
      status: r.status, vendorId: r.vendorId, vendorName: r.vendorName, itemId: r.itemId, itemCode: r.itemCode, itemName: r.itemName,
      qtyBase: r.qtyBase, paidPaisePerBase: r.paid, refPaisePerBase: ref, refKind: r.refKind ?? "",
      riseBps: ref === 0 ? 0 : Math.floor(((r.paid - ref) * 10_000) / ref),
      extraPaise: Math.max(0, r.paid - ref) * r.qtyBase, reasonCode: r.reasonCode ?? "", reasonText: r.reasonText,
    };
  });
  const byVendor = new Map<string, { vendorId: string; vendorName: string; lines: number; extraPaise: number }>();
  for (const r of out) {
    const v = byVendor.get(r.vendorId) ?? { vendorId: r.vendorId, vendorName: r.vendorName, lines: 0, extraPaise: 0 };
    v.lines += 1;
    v.extraPaise += r.extraPaise;
    byVendor.set(r.vendorId, v);
  }
  return {
    from, to, rows: out,
    byVendor: [...byVendor.values()].sort((a, b) => b.extraPaise - a.extraPaise || a.vendorName.localeCompare(b.vendorName)),
    totalExtraPaise: out.reduce((n, r) => n + r.extraPaise, 0),
  };
}
