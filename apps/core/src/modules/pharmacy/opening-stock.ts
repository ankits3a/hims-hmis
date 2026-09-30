import { createHash } from "node:crypto";
import { hasPermission } from "../../kernel/auth/permissions";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import {
  activateVendor, addItemUom, addVendorDocument, captureGrn, daysBetween, findStoreByCode, getGrn, itemsByIds, listGrns,
  listVendors, nearExpiryMinDays, postGrn, registerVendor, requestNearExpiryAcceptance, runGateQc, uomsByItems,
} from "../materials";
import { OPD_PHARMACY_STORE_CODE } from "./config";
import { parseCsv } from "./csv";
import { PharmacyError } from "./errors";
import { listSaleItems } from "./sale-items";
import { setShelfLocation, shelfLocationsFor } from "./shelf-locations";
import type { Actor } from "@hmis/contracts";
import type { CsvFile } from "./csv";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE REAL SHELF, COUNTED ONCE, RECEIVED THROUGH THE REAL GATE ═══
 *
 * Owner ruling 2026-09-22: after the trial, the pharmacist fills a sheet from what is physically on the
 * shelf and this receives it. Runbook: `docs/runbooks/pharmacy-opening-stock.md`; template:
 * `docs/runbooks/pharmacy-opening-stock-template.csv`.
 *
 *   brand                  as printed on the strip — "Dolo 650", "Pan 40", or the item code. Matched to the
 *                          SHELF (active sale items) by code, full name, brand, or brand + strength; a miss
 *                          lists the three nearest names ("did you mean"), an ambiguous name lists them all.
 *   batch                  as printed.
 *   expiry                 MM/YYYY (or MM/YY) — the last day of that month, as Indian labelling means it.
 *   mrp_per_pack           rupees, as printed, e.g. 35.50.
 *   pack_size              tablets in a strip, or 1 for a bottle/tube.
 *   packs                  whole packs on the shelf (open a loose strip as its tablets with pack_size 1).
 *   rack                   where it sits; replaces the starter list's suggestion.
 *   supplier_name          optional: an ACTIVE vendor's name or code. Blank → the "OPENING STOCK" vendor.
 *   purchase_rate_per_pack optional: rupees paid per pack. Blank → cost 0 (counted and reported).
 *
 * ═══ TWO DOORS, ONE GATE ═══
 *
 * GAP CLOSURE A1 (2026-09-28) moved this out of `scripts/import-opening-stock.ts`: the owner's audit
 * found opening stock could only be loaded by an engineer. There are now two callers:
 *
 *   · the SCREEN (the office's Stock → Opening stock sheet: the grid, or its CSV upload) calls `captureOpeningStock`. It CAPTURES one GRN per
 *     vendor and stops. The pharmacist QCs and posts those GRNs in the GRN worklist like any delivery —
 *     DD8's two stages, two people, and the uploader never judges their own sheet.
 *   · the SCRIPT calls `applyOpeningStock`, which captures (or picks up what the screen captured) and then
 *     runs QC and posts as the named `--qc` pharmacist, in one transaction.
 *
 * A batch whose expiry is inside the near-expiry bound (six months, or ¾ of the item's shelf life) goes on
 * its OWN GRN, which waits for the `materials_near_expiry_acceptance` approval (the materials head decides
 * it in /approvals). Stock that has already expired is REFUSED — it is segregated, not received.
 *
 * ═══ THE LOOSE-MRP RULING — AN MRP THAT DOES NOT DIVIDE IS RECEIVED ═══
 *
 * Owner ruling 2026-09-22 (money): ₹35.50 on a strip of 15 is RECEIVED. A full strip bills at the printed
 * ₹35.50 and a loose tablet at the per-tablet share rounded DOWN (₹2.36) — `saleAmountPaise` in materials.
 * QC rule 6 already compares it exactly (`comparePackPrices`), so this planner no longer refuses it either;
 * until 2026-09-29 it did, with a stale "QC refuses it (mrp_unconvertible)" that QC had stopped saying.
 *
 * ═══ TWO SHAPES OF INPUT, ONE JUDGEMENT ═══
 *
 * The CSV sheet and the on-screen grid (2026-09-29, the office's Stock → Opening stock sheet) are both
 * turned into `OpeningInputRow`s — text cells keyed by the CSV's column names, plus the item id when the
 * grid picked one from the master — and judged by ONE function, `planOpeningRows`. There is no second
 * set of rules for the screen.
 *
 *   pack_type              optional: tablet_strip, capsule_strip, bottle, vial, ampoule, tube, pouch,
 *                          sachet, box, other. Names a NEW pack unit (`box10`); blank is a strip.
 *   free_packs             optional: packs the supplier gave free. Received as a FREE-GOODS line at cost 0.
 *   trade_discount_pct     optional: lowers the COST only — cost/unit = rate × (1 − d/100) ÷ pack size,
 *                          rounded down to the paisa. The sale price stays the MRP.
 *
 * A pack size the item does not have yet (the starter list defaults every strip to 10) is added as a
 * new unit `strip<N>` — an item-master act, so it needs `materials.items.manage`. So does creating the
 * OPENING STOCK vendor (`materials.vendors.manage`) the first time. The screen refuses a sheet that needs
 * either when the uploader does not hold it, and says which; it never borrows someone else's authority.
 *
 * ═══ ALL OR NOTHING, AND ONCE ═══
 *
 * The whole file is judged before anything is written; one bad row refuses the file. The challan number
 * carries the file's hash, so the same file twice captures nothing the second time.
 */

export const OPENING_VENDOR_CODE = "OPENING-STOCK";
const COLUMNS = [
  "brand", "batch", "expiry", "mrp_per_pack", "pack_size", "packs", "rack", "supplier_name", "purchase_rate_per_pack",
  "pack_type", "free_packs", "trade_discount_pct",
] as const;
const REQUIRED = ["brand", "batch", "expiry", "mrp_per_pack", "pack_size", "packs"] as const;
/** A hospital shelf is ~350 items × a few batches. Past this, split the sheet — the GRN takes 200 lines. */
export const OPENING_MAX_ROWS = 2000;

/**
 * What a pack is. The word names a NEW pack unit when the item has none of that size yet (`strip15`,
 * `box10`); a size the item already has is used whatever it is called. A new drug's base unit follows it too
 * (`stock-drug.ts`): a tablet strip counts tablets, a bottle counts bottles.
 */
export const PACK_TYPES = ["tablet_strip", "capsule_strip", "bottle", "vial", "ampoule", "tube", "pouch", "sachet", "box", "other"] as const;
export type PackType = (typeof PACK_TYPES)[number];
/** The word a new pack unit starts with. */
export const PACK_UOM_PREFIX: Record<PackType, string> = {
  tablet_strip: "strip", capsule_strip: "strip", bottle: "bottle", vial: "vial", ampoule: "ampoule", tube: "tube",
  pouch: "pouch", sachet: "sachet", box: "box", other: "pack",
};

export type OpeningRow = {
  line: number; brand: string; batch: string; expiryDate: string; mrpPaise: number; packSize: number; packs: number;
  /** Packs received free — a separate free-goods GRN line at cost 0. */
  freePacks: number;
  /** Rupees paid per pack before the trade discount, in paise; 0 when not given. */
  ratePaise: number;
  /** The trade discount in basis points (12.5% = 1250). Lowers the cost, never the sale price. */
  discountBps: number;
  rack: string; supplier: string; costPerBasePaise: number; itemId?: string; itemCode?: string; itemName?: string; uom?: string;
  newUom: boolean; vendorKey: string; near: boolean; reasons: string[];
};
/**
 * `captured` — on the books as a GRN, waiting for the pharmacist's QC (the screen's stopping point).
 * `awaiting_approval` — QC'd, a near-expiry approval filed and not yet decided.
 */
export type OpeningGrnState = "new" | "captured" | "posted" | "awaiting_approval" | "approved" | "rejected";
export type OpeningGrn = {
  vendorKey: string; vendorId: string | null; challanNo: string; near: boolean; rows: OpeningRow[]; state: OpeningGrnState;
  grnId?: string; grnNo?: string; approvalId?: string | null;
};
export type OpeningPlan = {
  rows: OpeningRow[]; refusals: number; grns: OpeningGrn[]; storeId: string; newUoms: number; needsVendor: boolean;
  zeroCost: number; racks: { itemId: string; rack: string }[]; units: number; fileHash: string;
};

/**
 * One row to judge: text cells under the CSV's column names, and — from the on-screen grid — the item the
 * person PICKED, which is then used instead of matching the brand text. `line` is what the person sees:
 * the sheet's line number, or the grid's row number.
 */
export type OpeningInputRow = { line: number; cells: Partial<Record<(typeof COLUMNS)[number], string>>; itemId?: string };

/** Lowercase, punctuation to single spaces — "DOLO-650" and "Dolo 650" are one name. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, "");
  for (let i = 0; i < t.length - 1; i += 1) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** Dice similarity on character bigrams — good enough to put "Dolo 65O" next to "Dolo 650". */
export function similarity(a: string, b: string): number {
  const x = bigrams(a); const y = bigrams(b);
  let inter = 0; let total = 0;
  for (const [k, n] of x) { inter += Math.min(n, y.get(k) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** Every name a pharmacist might write for this item, normalised. */
export function namesFor(item: { code: string; name: string }): string[] {
  const short = item.name.replace(/\s*\(.*$/, "");
  const after = item.name.includes(")") ? item.name.slice(item.name.indexOf(")") + 1) : "";
  const strength = /[\d.]+/.exec(after)?.[0];
  // "Crocin 500 tablet" is also "Crocin 500": a trailing dose-form word is not part of what is on the strip.
  const bare = item.name.replace(/(\s+(oral|film-coated|tablets?|capsules?|syrup|suspension|solution|drops|cream|ointment|gel|lotion|inhaler))+\s*$/i, "");
  const out = [item.code, item.name, short, bare];
  if (strength !== undefined && !norm(short).split(" ").includes(norm(strength))) out.push(`${short} ${strength}`);
  return [...new Set(out.map(norm))];
}

/** MM/YYYY or MM/YY → the last day of that month, YYYY-MM-DD; null when unreadable. */
export function expiryOf(text: string): string | null {
  const m = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (m === null) return null;
  const month = Number(m[1]);
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** "35.50" → 3550; null for anything that is not rupees with at most two decimals. */
export function rupeesToPaise(text: string): number | null {
  if (!/^\s*\d+(\.\d{1,2})?\s*$/.test(text)) return null;
  const [r, p = ""] = text.trim().split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

/** "12.5" → 1250 basis points; blank → 0; null for anything outside 0 ≤ d < 100 with at most two decimals. */
export function discountToBps(text: string): number | null {
  if (text.trim() === "") return 0;
  const paise = rupeesToPaise(text);
  return paise === null || paise >= 10_000 ? null : paise;
}

/**
 * THE COST OF ONE BASE UNIT — rate × (1 − d/100) ÷ pack size, rounded DOWN to the paisa, in integers.
 * Rounded down so the cost QC compares with the MRP is never above what was paid; QC compares it exactly
 * against the pack's MRP (`comparePackPrices`), and this planner refuses on the same comparison.
 */
export function costPerBase(ratePaise: number, discountBps: number, packSize: number): number {
  return Math.floor((ratePaise * (10_000 - discountBps)) / (10_000 * packSize));
}

/** The pack type as written — the key, or its words ("tablet strip", "Bottle"); blank is null (a strip). */
export function packTypeOf(text: string): PackType | null | undefined {
  const k = norm(text).replace(/ /g, "_");
  if (k === "") return null;
  if (k === "strip") return "tablet_strip";
  return (PACK_TYPES as readonly string[]).includes(k) ? k as PackType : undefined;
}

/** IST calendar day, `YYYY-MM-DD` — the day a challan is dated and a batch expires in. */
function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The sheet as text → its rows, refused whole when the columns are wrong or it is empty or too long. */
export function readOpeningSheet(text: string): CsvFile {
  const file = parseCsv(text);
  const missing = REQUIRED.filter((c) => !file.header.includes(c));
  if (missing.length > 0) {
    throw new PharmacyError("opening_stock_unreadable", `the sheet is missing column(s): ${missing.join(", ")} — download the template`, { missing });
  }
  const unknown = file.header.filter((h) => h !== "" && !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    throw new PharmacyError("opening_stock_unreadable", `unknown column(s): ${unknown.join(", ")} — a misspelt column would otherwise be silently empty`, { unknown });
  }
  if (file.rows.length === 0) throw new PharmacyError("opening_stock_unreadable", "the sheet has a header and no rows", { rows: 0 });
  if (file.rows.length > OPENING_MAX_ROWS) {
    throw new PharmacyError("opening_stock_unreadable", `${String(file.rows.length)} rows — split the sheet into files of ${String(OPENING_MAX_ROWS)} or fewer`, { rows: file.rows.length });
  }
  return file;
}

/** THE CSV DOOR — the sheet's header checked, then the one judgement. */
export async function planOpeningStock(db: Db, file: CsvFile, fileText: string, now: Date): Promise<OpeningPlan> {
  const missing = REQUIRED.filter((c) => !file.header.includes(c));
  if (missing.length > 0) throw new Error(`the sheet is missing column(s): ${missing.join(", ")} (template: docs/runbooks/pharmacy-opening-stock-template.csv)`);
  const unknown = file.header.filter((h) => h !== "" && !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) throw new Error(`unknown column(s): ${unknown.join(", ")} — a misspelt column would otherwise be silently empty`);
  return planOpeningRows(db, file.rows, fileText, now);
}

/**
 * THE GRID'S ROW, as the screen sends it. Numbers are sent as the person typed them (text), so a typo
 * is judged by the same reader as the sheet's — "35.555" is refused here exactly as it is in a CSV.
 */
export type OpeningGridRow = {
  itemId: string; batch: string; expiry: string; mrpPerPack: string; packSize: string; packs: string;
  freePacks?: string; ratePerPack?: string; discountPct?: string; packType?: string; rack?: string; supplier?: string;
};

/** THE GRID DOOR — the picked item and the typed cells, turned into the sheet's row and judged the same way. */
export async function planOpeningGrid(db: Db, rows: readonly OpeningGridRow[], now: Date): Promise<OpeningPlan> {
  if (rows.length === 0) throw new PharmacyError("opening_stock_unreadable", "no rows to receive", { rows: 0 });
  if (rows.length > OPENING_MAX_ROWS) {
    throw new PharmacyError("opening_stock_unreadable", `${String(rows.length)} rows — receive them in parts of ${String(OPENING_MAX_ROWS)} or fewer`, { rows: rows.length });
  }
  const input: OpeningInputRow[] = rows.map((r, i) => ({
    line: i + 1, itemId: r.itemId,
    cells: {
      brand: "", batch: r.batch, expiry: r.expiry, mrp_per_pack: r.mrpPerPack, pack_size: r.packSize, packs: r.packs,
      free_packs: r.freePacks ?? "", purchase_rate_per_pack: r.ratePerPack ?? "", trade_discount_pct: r.discountPct ?? "",
      pack_type: r.packType ?? "", rack: r.rack ?? "", supplier_name: r.supplier ?? "",
    },
  }));
  // The same grid sent twice is the same challan, so it captures once — the sheet's promise, kept by the grid.
  return planOpeningRows(db, input, JSON.stringify(rows), now);
}

/** Whole number ≥ `min` from a cell; null when it is not one. Blank reads as `blank`. */
function wholeOf(text: string | undefined, min: number, blank: number | null): number | null {
  const t = (text ?? "").trim();
  if (t === "") return blank;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/**
 * THE ONE JUDGEMENT. Every row, from a sheet or from the grid, is read and checked here and nowhere else;
 * a refused row carries its reasons and the plan is captured whole or not at all.
 */
export async function planOpeningRows(db: Db, input: readonly OpeningInputRow[], hashSource: string, now: Date): Promise<OpeningPlan> {
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `the "${OPD_PHARMACY_STORE_CODE}" store does not exist — run seed:pharmacy first`);
  const fileHash = createHash("sha256").update(hashSource).digest("hex").slice(0, 10);
  const today = istDay(now);

  const shelf = (await listSaleItems(db)).filter((s) => s.active && s.itemActive);
  const onShelf = new Set(shelf.map((s) => s.itemId));
  const items = await itemsByIds(db, shelf.map((s) => s.itemId));
  const uoms = await uomsByItems(db, shelf.map((s) => s.itemId));
  const index = new Map<string, Set<string>>();
  for (const s of shelf) for (const n of namesFor(s)) { const set = index.get(n) ?? new Set(); set.add(s.itemId); index.set(n, set); }
  const vendors = (await listVendors(db, { status: "active" }));
  const vendorByName = new Map<string, string>();
  for (const v of vendors) for (const n of [v.code, v.legalName, v.tradeName ?? ""]) if (n !== "") vendorByName.set(norm(n), v.id);
  const opening = (await listVendors(db, { search: OPENING_VENDOR_CODE })).find((v) => v.code === OPENING_VENDOR_CODE);
  const seen = new Map<string, number>();

  const rows: OpeningRow[] = input.map((r) => {
    const c = r.cells;
    const row: OpeningRow = {
      line: r.line, brand: c.brand ?? "", batch: (c.batch ?? "").trim(), expiryDate: "", mrpPaise: 0, packSize: 0, packs: 0, freePacks: 0,
      ratePaise: 0, discountBps: 0, rack: c.rack ?? "", supplier: c.supplier_name ?? "", costPerBasePaise: 0, newUom: false, vendorKey: "",
      near: false, reasons: [],
    };
    if (r.itemId !== undefined) {
      // The grid PICKED the item: no name matching, but the same shelf — an item not sold at the counter is refused.
      if (onShelf.has(r.itemId)) {
        row.itemId = r.itemId;
        row.itemCode = items.get(r.itemId)?.code;
        row.itemName = items.get(r.itemId)?.name;
        if (row.brand === "") row.brand = row.itemName ?? "";
      } else row.reasons.push("not sold at the counter yet — put it on sale (+ New drug), then enter its stock");
    } else {
      const hits = index.get(norm(row.brand));
      if (row.brand === "") row.reasons.push("brand_required");
      else if (hits === undefined) {
        const near = [...index.keys()].map((k) => ({ k, s: similarity(norm(row.brand), k) })).sort((a, b) => b.s - a.s).slice(0, 3)
          .map((x) => items.get([...index.get(x.k)!][0]!)?.name ?? x.k);
        row.reasons.push(`not on the shelf: "${row.brand}" — did you mean: ${[...new Set(near)].join(" | ")}`);
      } else if (hits.size > 1) {
        row.reasons.push(`"${row.brand}" is ambiguous — write the strength or the code: ${[...hits].map((id) => items.get(id)?.code ?? id).join(", ")}`);
      } else {
        row.itemId = [...hits][0]!;
        row.itemCode = items.get(row.itemId)?.code;
        row.itemName = items.get(row.itemId)?.name;
      }
    }
    if (row.batch === "") row.reasons.push("batch_required");
    const expiry = expiryOf(c.expiry ?? "");
    if (expiry === null) row.reasons.push(`expiry must be MM/YYYY, got "${c.expiry ?? ""}"`);
    else row.expiryDate = expiry;
    const mrp = rupeesToPaise(c.mrp_per_pack ?? "");
    if (mrp === null || mrp <= 0) row.reasons.push(`mrp_per_pack must be rupees like 35.50, got "${c.mrp_per_pack ?? ""}"`);
    else row.mrpPaise = mrp;
    const packSize = wholeOf(c.pack_size, 1, null);
    if (packSize === null) row.reasons.push(`pack_size must be a whole number ≥ 1, got "${c.pack_size ?? ""}"`);
    else row.packSize = packSize;
    const free = wholeOf(c.free_packs, 0, 0);
    if (free === null) row.reasons.push(`free_packs must be a whole number, got "${c.free_packs ?? ""}"`);
    else row.freePacks = free;
    // A row may be all free goods; otherwise at least one pack was counted.
    const packs = wholeOf(c.packs, row.freePacks > 0 ? 0 : 1, row.freePacks > 0 ? 0 : null);
    if (packs === null) row.reasons.push(`packs must be a whole number ≥ 1, got "${c.packs ?? ""}"`);
    else row.packs = packs;
    const packType = packTypeOf(c.pack_type ?? "");
    if (packType === undefined) row.reasons.push(`pack_type must be one of ${PACK_TYPES.join(", ")}, got "${c.pack_type ?? ""}"`);
    const discount = discountToBps(c.trade_discount_pct ?? "");
    if (discount === null) row.reasons.push(`trade_discount_pct must be a percentage from 0 to below 100, got "${c.trade_discount_pct ?? ""}"`);
    else row.discountBps = discount;
    const rate = (c.purchase_rate_per_pack ?? "").trim() === "" ? 0 : rupeesToPaise(c.purchase_rate_per_pack ?? "");
    if (rate === null) row.reasons.push(`purchase_rate_per_pack must be rupees, got "${c.purchase_rate_per_pack ?? ""}"`);
    else {
      row.ratePaise = rate;
      if (row.packSize > 0) row.costPerBasePaise = costPerBase(rate, row.discountBps, row.packSize);
    }
    // QC rule 6's comparison, exactly: the MRP of the pack against the cost of the units in it.
    if (mrp !== null && row.packSize > 0 && row.costPerBasePaise * row.packSize > mrp) {
      row.reasons.push("cost after discount is above MRP — QC refuses it (mrp_below_cost)");
    }

    if (row.itemId !== undefined && row.packSize > 0) {
      const item = items.get(row.itemId)!;
      const u = (uoms.get(row.itemId) ?? []).find((x) => x.toBaseMultiplier === row.packSize);
      if (u !== undefined) row.uom = u.uom;
      else { row.uom = `${PACK_UOM_PREFIX[packType ?? "tablet_strip"]}${String(row.packSize)}`; row.newUom = true; }
      if (row.expiryDate !== "") {
        const left = daysBetween(today, row.expiryDate);
        if (left <= 0) row.reasons.push(`expired ${row.expiryDate} — segregate it; expired stock is not received`);
        else row.near = left < nearExpiryMinDays(item.shelfLifeDays);
      }
      const key = `${row.itemId}|${row.batch.toLowerCase()}`;
      const prev = seen.get(key);
      if (prev !== undefined) row.reasons.push(`the same brand and batch is also on line ${String(prev)} — add the packs together`);
      seen.set(key, r.line);
    }
    if (row.supplier.trim() === "") row.vendorKey = OPENING_VENDOR_CODE;
    else {
      const id = vendorByName.get(norm(row.supplier));
      if (id === undefined) {
        const near = [...vendorByName.keys()].map((k) => ({ k, s: similarity(norm(row.supplier), k) })).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.k);
        row.reasons.push(`supplier "${row.supplier}" is not an active vendor${near.length > 0 ? ` — did you mean: ${near.join(" | ")}` : ""} (leave it blank for OPENING STOCK)`);
      } else row.vendorKey = id;
    }
    return row;
  });

  const good = rows.filter((r) => r.reasons.length === 0);
  const groups = new Map<string, OpeningRow[]>();
  for (const r of good) { const k = `${r.vendorKey}|${r.near ? "near" : "ok"}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const grns: OpeningGrn[] = [];
  for (const [k, list] of groups) {
    const [vendorKey, kind] = k.split("|") as [string, string];
    const vendorId = vendorKey === OPENING_VENDOR_CODE ? opening?.id ?? null : vendorKey;
    const near = kind === "near";
    const challanNo = `${near ? "OPENING-NEAR" : "OPENING"}/${fileHash}`;
    const g: OpeningGrn = { vendorKey, vendorId, challanNo, near, rows: list, state: "new" };
    if (vendorId !== null) {
      const existing = (await listGrns(db, { vendorId })).find((x) => x.challanNo === challanNo);
      if (existing !== undefined) {
        g.grnId = existing.id; g.grnNo = existing.grnNo; g.approvalId = existing.approvalId;
        if (existing.status === "posted") g.state = "posted";
        else if (existing.approvalId === null) g.state = "captured";
        else {
          const a = await getApproval(db, existing.approvalId);
          g.state = a?.status === "granted" ? "approved" : a?.status === "rejected" ? "rejected" : "awaiting_approval";
        }
      }
    }
    grns.push(g);
  }
  const shelfRacks = await shelfLocationsFor(db, store.id, good.map((r) => r.itemId!));
  const racks = new Map<string, string>();
  for (const r of good) if (r.rack.trim() !== "" && shelfRacks.get(r.itemId!) !== r.rack.trim()) racks.set(r.itemId!, r.rack.trim());
  const newUomKeys = new Set(good.filter((r) => r.newUom).map((r) => `${r.itemId!}|${r.uom!}`));
  return {
    rows, refusals: rows.length - good.length, grns, storeId: store.id, newUoms: newUomKeys.size, fileHash,
    needsVendor: opening === undefined && good.some((r) => r.vendorKey === OPENING_VENDOR_CODE),
    zeroCost: good.filter((r) => r.packs > 0 && r.costPerBasePaise === 0).length,
    racks: [...racks].map(([itemId, rack]) => ({ itemId, rack })),
    units: good.reduce((n, r) => n + (r.packs + r.freePacks) * r.packSize, 0),
  };
}

/**
 * The item-master and vendor acts a sheet needs before its GRNs can be captured, each with the permission
 * its own screen is gated on. The screen shows these at Check, so the uploader learns before Capture that
 * the materials head has to add `strip15` to Dolo 650 — not after.
 */
export type OpeningAuthority = { permission: "materials.items.manage" | "materials.vendors.manage" | "pharmacy.sale_items.manage"; held: boolean; why: "new_pack_sizes" | "opening_vendor" | "racks" };

export async function openingAuthority(db: Db, actor: Actor, plan: OpeningPlan): Promise<OpeningAuthority[]> {
  const out: OpeningAuthority[] = [];
  if (plan.newUoms > 0) out.push({ permission: "materials.items.manage", why: "new_pack_sizes", held: await hasPermission(db, actor.id, "materials.items.manage", "hospital") });
  if (plan.needsVendor) out.push({ permission: "materials.vendors.manage", why: "opening_vendor", held: await hasPermission(db, actor.id, "materials.vendors.manage", "hospital") });
  if (plan.racks.length > 0) out.push({ permission: "pharmacy.sale_items.manage", why: "racks", held: await hasPermission(db, actor.id, "pharmacy.sale_items.manage", "hospital") });
  return out;
}

async function ensureOpeningVendor(tx: Tx, head: Actor, now: Date): Promise<string> {
  const found = (await listVendors(tx, { search: OPENING_VENDOR_CODE })).find((v) => v.code === OPENING_VENDOR_CODE);
  if (found !== undefined) return found.id;
  const { vendorId } = await registerVendor(tx, head, {
    code: OPENING_VENDOR_CODE, legalName: "OPENING STOCK — the hospital's own shelf at go-live", tradeName: "OPENING STOCK",
    gstin: null, pan: null, paymentTermsDays: null, classFlags: {},
  });
  for (const type of ["gst_certificate", "pan"]) {
    await addVendorDocument(tx, head, vendorId, { type, number: "OPENING-STOCK — hospital's own stock, no supplier", validFrom: null, validTo: null });
  }
  await activateVendor(tx, head, vendorId, now);
  return vendorId;
}

/** New pack sizes, then the OPENING STOCK vendor, then one GRN per group still `new`. Nothing is QC'd. */
async function captureGroups(
  tx: Tx, actors: { storekeeper: Actor; head: Actor | null }, plan: OpeningPlan, now: Date,
): Promise<{ uomsAdded: number; vendorCreated: boolean; captured: { grnId: string; grnNo: string; challanNo: string; near: boolean; lines: number }[] }> {
  const today = istDay(now);
  const out = { uomsAdded: 0, vendorCreated: false, captured: [] as { grnId: string; grnNo: string; challanNo: string; near: boolean; lines: number }[] };
  const added = new Set<string>();
  for (const r of plan.rows) {
    const key = `${r.itemId!}|${r.uom!}`;
    if (!r.newUom || added.has(key)) continue;
    await addItemUom(tx, actors.head!, r.itemId!, { uom: r.uom!, toBaseMultiplier: r.packSize, isPurchaseUom: true, isIssueUom: true });
    added.add(key); out.uomsAdded += 1;
  }
  for (const g of plan.grns) {
    if (g.vendorId === null) { g.vendorId = await ensureOpeningVendor(tx, actors.head!, now); out.vendorCreated = true; }
    if (g.state !== "new") continue;
    const { grnId, grnNo } = await captureGrn(tx, actors.storekeeper, {
      vendorId: g.vendorId, source: "challan", storeResourceId: plan.storeId, challanNo: g.challanNo, challanDate: today, now, serviceDate: today,
      // The paid packs, then the free ones as a FREE-GOODS line at cost 0 — same batch, same MRP, so they
      // land on one pile, whose purchase price is the paid line's (it is posted first).
      lines: g.rows.flatMap((r) => [
        ...(r.packs > 0 ? [{
          itemId: r.itemId!, uom: r.uom!, qtyInUom: r.packs, batchNo: r.batch, expiryDate: r.expiryDate,
          mrpPaise: r.mrpPaise, mrpUom: r.uom!, unitCostPaise: r.costPerBasePaise,
        }] : []),
        ...(r.freePacks > 0 ? [{
          itemId: r.itemId!, uom: r.uom!, qtyInUom: r.freePacks, batchNo: r.batch, expiryDate: r.expiryDate,
          mrpPaise: r.mrpPaise, mrpUom: r.uom!, unitCostPaise: 0, freeGoods: true,
        }] : []),
      ]),
    });
    g.grnId = grnId; g.grnNo = grnNo; g.state = "captured";
    out.captured.push({ grnId, grnNo, challanNo: g.challanNo, near: g.near, lines: g.rows.length });
  }
  return out;
}

/**
 * THE SCREEN'S ACT — capture the sheet as GRNs for the pharmacist to QC, and stop.
 *
 * Refused whole when a row was refused, or when the sheet needs an item-master or vendor act the uploader
 * does not hold. Racks are set only by someone who holds `pharmacy.sale_items.manage` (the shelf-location
 * screen's permission); otherwise they are left for that person, and the result says how many.
 */
export async function captureOpeningStock(
  db: Db, actor: Actor, plan: OpeningPlan, now: Date = new Date(),
): Promise<{ captured: { grnId: string; grnNo: string; challanNo: string; near: boolean; lines: number }[]; alreadyOnBooks: number; uomsAdded: number; vendorCreated: boolean; racksSet: number; racksLeft: number }> {
  if (plan.refusals > 0) {
    throw new PharmacyError("opening_stock_refused", `${String(plan.refusals)} row(s) were refused — fix them; the sheet is received whole or not at all`, { refusals: plan.refusals });
  }
  const authority = await openingAuthority(db, actor, plan);
  const lacking = authority.filter((a) => !a.held && a.why !== "racks");
  if (lacking.length > 0) {
    throw new PharmacyError("permission_denied", `this sheet needs ${lacking.map((a) => a.permission).join(" and ")} — ask the materials head to upload it, or to add the pack sizes first`, { lacking: lacking.map((a) => a.permission) });
  }
  const racksAllowed = authority.find((a) => a.why === "racks")?.held === true;
  return withTx(db, async (tx) => {
    const alreadyOnBooks = plan.grns.filter((g) => g.state !== "new").length;
    const done = await captureGroups(tx, { storekeeper: actor, head: actor }, plan, now);
    let racksSet = 0;
    if (racksAllowed) {
      for (const r of plan.racks) {
        await setShelfLocation(tx as unknown as Db, actor, { storeResourceId: plan.storeId, itemId: r.itemId, location: r.rack }, now);
        racksSet += 1;
      }
    }
    return { ...done, alreadyOnBooks, racksSet, racksLeft: plan.racks.length - racksSet };
  });
}

/** THE SCRIPT'S ACT — capture (or pick up what the screen captured), QC as `qc`, post, set racks. One transaction. */
export async function applyOpeningStock(
  db: Db, actors: { storekeeper: Actor; qc: Actor; head: Actor | null }, plan: OpeningPlan, now: Date = new Date(),
): Promise<{ posted: number; awaiting: number; unitsPosted: number; uomsAdded: number; racksSet: number; vendorCreated: boolean }> {
  if (plan.refusals > 0) throw new Error(`refusing to apply: ${String(plan.refusals)} row(s) were refused`);
  if ((plan.newUoms > 0 || plan.needsVendor) && actors.head === null) {
    throw new Error("--head <materials_head> is needed: this sheet adds pack sizes and/or creates the OPENING STOCK vendor");
  }
  return withTx(db, async (tx) => {
    const out = { posted: 0, awaiting: 0, unitsPosted: 0, uomsAdded: 0, racksSet: 0, vendorCreated: false };
    const captured = await captureGroups(tx, { storekeeper: actors.storekeeper, head: actors.head }, plan, now);
    out.uomsAdded = captured.uomsAdded; out.vendorCreated = captured.vendorCreated;
    for (const g of plan.grns) {
      if (g.state === "posted" || g.state === "rejected") continue;
      if (g.state === "awaiting_approval") { out.awaiting += 1; continue; }
      if (g.state === "captured") {
        const qc = await runGateQc(tx, actors.qc, g.grnId!);
        const bad = qc.verdicts.filter((v) => v.verdict === "reject");
        if (bad.length > 0) throw new Error(`${g.challanNo}: QC rejected ${String(bad.length)} line(s) (${[...new Set(bad.map((b) => b.rule ?? "?"))].join(", ")}) — NOTHING was written`);
        if (g.near) {
          await requestNearExpiryAcceptance(tx, actors.qc, g.grnId!, `opening stock: ${String(g.rows.length)} short-dated batch(es) already on the shelf at go-live`);
          out.awaiting += 1;
          continue;
        }
      }
      const posted = await postGrn(tx, actors.qc, g.grnId!, now);
      out.posted += 1;
      const grn = await getGrn(tx, g.grnId!);
      out.unitsPosted += (grn?.lines ?? []).reduce((n, l) => n + (l.qtyAcceptedBase ?? 0), 0);
      if (posted.ledgerEntryIds.length === 0) throw new Error(`${g.challanNo} posted no stock — NOTHING was written`);
    }
    for (const r of plan.racks) {
      await setShelfLocation(tx as unknown as Db, actors.qc, { storeResourceId: plan.storeId, itemId: r.itemId, location: r.rack }, now);
      out.racksSet += 1;
    }
    return out;
  });
}
