import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { hasPermission } from "../../kernel/auth/permissions";
import { SodViolationError } from "../../kernel/auth/sod";
import { PRICE_REASON_CODES, assertNotPoApprover } from "../materials";
import type { PriceCheck } from "../materials";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { httpError, idSchema, parsed, toHttp } from "./pharmacy-http";
import {
  PACK_TYPES, captureOpeningStock, captureSupplierInvoice, invoiceStores, openingAuthority, planOpeningGrid, planOpeningStock,
  planSupplierInvoice, readOpeningSheet,
} from "./opening-stock";
import { createStockDrug, stockEntryItems, stockEntryMedicine, stockEntrySuppliers } from "./stock-drug";
import type { StockEntryItem } from "./stock-drug";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { InvoicePlan, OpeningAuthority, OpeningGrnState, OpeningPlan, OpeningRow } from "./opening-stock";
import { importPriceList, matchPriceList } from "./price-list-import";
import type { ImportResult, MatchedRow } from "./price-list-import";

/** The sheet as the pharmacist saved it. ~2,000 rows of nine short columns fit well inside this. */
const sheetBody = z.object({ content: z.string().min(1).max(990_000) });
/**
 * The on-screen grid's rows (2026-09-29): the picked item and the cells as typed. Text, not numbers, so the
 * planner reads a typo exactly as it reads one in a CSV (`planOpeningGrid`).
 */
const cell = z.string().max(64);
const gridRow = z.object({
  itemId: idSchema, batch: cell, expiry: cell, mrpPerPack: cell, packSize: cell, packs: cell,
  freePacks: cell.optional(), ratePerPack: cell.optional(), discountPct: cell.optional(), packType: cell.optional(),
  boxes: cell.optional(), packsPerBox: cell.optional(),
  rack: z.string().max(200).optional(), supplier: z.string().max(200).optional(),
});
const gridBody = z.object({ rows: z.array(gridRow).min(1).max(2000) });
/** #1047 — the grid in "Supplier invoice" mode: the invoice's header and its rows (rack and supplier are the opening count's). */
const invoiceBody = z.object({
  header: z.object({
    vendorId: z.string().max(64).nullable(), invoiceNo: z.string().max(64), invoiceDate: z.string().max(10),
    purchaseOrderId: z.string().max(64).nullish(), storeResourceId: z.string().max(64).nullable(), rateIncludesGst: z.boolean().optional(),
  }),
  rows: z.array(gridRow.omit({ rack: true, supplier: true }).extend({
    /** #1061 — the row's answer to an amber price (`captureGrn` judges whether it answers). */
    priceReason: z.enum(PRICE_REASON_CODES).optional(), priceReasonText: z.string().max(200).optional(),
  })).min(1).max(2000),
});
/** Either a sheet or the grid — one route, one judgement. */
const entryBody = z.union([sheetBody, gridBody]);
const newDrugBody = z.object({
  brandName: z.string().trim().min(1).max(120), strength: z.string().trim().max(60), medicineId: idSchema,
  form: z.string().trim().max(60), packType: z.enum(PACK_TYPES), packSize: z.number().int().min(1).max(1000),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/), gstRateBps: z.number().int().min(0).max(2800),
  schedule: z.enum(["H", "H1", "X", "OTC"]).nullable(), mrpPerPackPaise: z.number().int().min(1).max(100_000_000),
  storage: z.enum(["ambient", "cold_2_8"]), manufacturer: z.string().trim().max(200).nullable().optional(),
});

type RowView = {
  line: number; brand: string; itemCode: string | null; itemName: string | null; batch: string; expiryDate: string;
  packs: number; packSize: number; uom: string | null; newUom: boolean; near: boolean; mrpPaise: number;
  costPerBasePaise: number; rack: string; reasons: string[];
  freePacks: number; ratePaise: number; discountBps: number;
  /** #1047 / 0093 — the cost is the estimate (no rate given). */
  estimatedCost: boolean;
  /** #1061 — the invoice mode's price check of a paid row; null when not checked (opening stock, free, no supplier yet). */
  priceCheck: PriceCheck | null;
};

export type OpeningCheckView = {
  fileHash: string;
  rows: RowView[];
  grns: { challanNo: string; near: boolean; lines: number; state: OpeningGrnState; grnNo: string | null }[];
  refusals: number; units: number; newUoms: number; needsVendor: boolean; zeroCost: number; racks: number;
  /** #1047 — rows valued at the estimate. */
  estimated: number;
  authority: OpeningAuthority[];
};

/** #1047 — the invoice mode's check: the header's reasons, the rows (as the opening check shows them), the totals. */
export type InvoiceCheckView = {
  headerReasons: string[]; rows: RowView[]; refusals: number; units: number; newUoms: number; costPaise: number;
  duplicateOf: { grnId: string; grnNo: string } | null;
  authority: OpeningAuthority[];
  /** #1061 — the supplier's accepted credit notes not yet set off. */
  unusedCreditPaise: number;
};

function rowView(r: OpeningRow): RowView {
  return {
    line: r.line, brand: r.brand, itemCode: r.itemCode ?? null, itemName: r.itemName ?? null, batch: r.batch, expiryDate: r.expiryDate,
    packs: r.packs, packSize: r.packSize, uom: r.uom ?? null, newUom: r.newUom, near: r.near, mrpPaise: r.mrpPaise,
    costPerBasePaise: r.costPerBasePaise, rack: r.rack, reasons: r.reasons,
    freePacks: r.freePacks, ratePaise: r.ratePaise, discountBps: r.discountBps, estimatedCost: r.estimatedCost,
    priceCheck: r.priceCheck ?? null,
  };
}

function view(plan: OpeningPlan, authority: OpeningAuthority[]): OpeningCheckView {
  return {
    fileHash: plan.fileHash,
    rows: plan.rows.map(rowView),
    grns: plan.grns.map((g) => ({ challanNo: g.challanNo, near: g.near, lines: g.rows.length, state: g.state, grnNo: g.grnNo ?? null })),
    refusals: plan.refusals, units: plan.units, newUoms: plan.newUoms, needsVendor: plan.needsVendor, zeroCost: plan.zeroCost,
    racks: plan.racks.length, estimated: plan.estimated, authority,
  };
}

async function invoiceView(db: Db, actor: Actor, plan: InvoicePlan): Promise<InvoiceCheckView> {
  const authority: OpeningAuthority[] = plan.newUoms === 0 ? [] : [{
    permission: "materials.items.manage", why: "new_pack_sizes", held: await hasPermission(db, actor.id, "materials.items.manage", "hospital"),
  }];
  return {
    headerReasons: plan.headerReasons, rows: plan.rows.map(rowView), refusals: plan.refusals, units: plan.units, newUoms: plan.newUoms,
    costPaise: plan.costPaise, duplicateOf: plan.duplicateOf, authority, unusedCreditPaise: plan.unusedCreditPaise,
  };
}

/**
 * GAP CLOSURE A1 — the opening-stock sheet from a screen (`opening-stock.ts` holds the why).
 *
 * Both routes are gated on `materials.grn.capture`: uploading the sheet IS capturing deliveries, the
 * storekeeper's act. QC and posting stay on the existing `grns/:id/qc` and `grns/:id/post` routes under
 * `materials.grn.qc`, so the person who uploads is never the person who passes the stock.
 */
@Controller("pharmacy/opening-stock")
export class PharmacyOpeningStockController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Read the sheet and judge every row. Writes nothing. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Post("check")
  async check(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<OpeningCheckView> {
    const b = parsed(entryBody, body);
    try {
      const plan = await this.plan(b, new Date());
      return view(plan, await openingAuthority(this.db, actor, plan));
    } catch (e) {
      return toHttp(e);
    }
  }

  /** Judge it again (never trust a Check the client may have edited since) and capture it as GRNs. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Post("capture")
  async capture(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<Awaited<ReturnType<typeof captureOpeningStock>>> {
    const b = parsed(entryBody, body);
    try {
      const now = new Date();
      const plan = await this.plan(b, now);
      return await captureOpeningStock(this.db, actor, plan, now);
    } catch (e) {
      return toHttp(e);
    }
  }

  /** #1047 — a supplier invoice typed in the grid, judged: the header and every row. Writes nothing. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Post("invoice/check")
  async invoiceCheck(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<InvoiceCheckView> {
    const b = parsed(invoiceBody, body);
    try {
      return await invoiceView(this.db, actor, await planSupplierInvoice(this.db, b.header, b.rows, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  /** #1047 — judged again and captured as ONE GRN for the pharmacist's QC; the bill draft will carry the invoice number and date. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Post("invoice/capture")
  async invoiceCapture(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<Awaited<ReturnType<typeof captureSupplierInvoice>>> {
    const b = parsed(invoiceBody, body);
    try {
      // The SoD engine first, on `db` (as `POST /materials/grns`), so an approver's attempt to receive is recorded.
      if (b.header.purchaseOrderId != null) await assertNotPoApprover(this.db, actor, b.header.purchaseOrderId);
      return await captureSupplierInvoice(this.db, actor, b.header, b.rows, new Date());
    } catch (e) {
      if (e instanceof SodViolationError) throw httpError(403, e.message, "sod_violation", { pairKey: e.pairKey });
      return toHttp(e);
    }
  }

  /** #1047 — the stores a supplier invoice is received into from the grid. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Get("invoice/stores")
  async invoiceStores(): Promise<{ stores: { id: string; code: string; name: string }[] }> {
    return { stores: await invoiceStores(this.db) };
  }

  private plan(b: z.infer<typeof entryBody>, now: Date): Promise<OpeningPlan> {
    return "content" in b
      ? planOpeningStock(this.db, readOpeningSheet(b.content), b.content, now)
      : planOpeningGrid(this.db, b.rows, now);
  }

  /** The grid's brand search over the item master: strength, form, packs, GST, rack, MRP on file, on sale or not. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Get("items")
  async items(@Query("search") search?: string): Promise<{ items: StockEntryItem[] }> {
    return { items: await stockEntryItems(this.db, (search ?? "").slice(0, 100)) };
  }

  /** The active suppliers a row may name. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Get("suppliers")
  async suppliers(): Promise<{ suppliers: { id: string; code: string; name: string }[] }> {
    return { suppliers: await stockEntrySuppliers(this.db) };
  }

  /** The formulary medicine the new-drug sheet picked: its form, strength and schedule (the sheet's defaults). */
  @RequirePermission("materials.items.manage", "hospital")
  @Get("medicines/:id")
  async medicine(@Param("id") medicineId: string): Promise<Awaited<ReturnType<typeof stockEntryMedicine>>> {
    try {
      return await stockEntryMedicine(this.db, medicineId);
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * A NEW DRUG in one transaction — item, pack unit, MRP, sale registration (and its schedule when changed).
   * Gated on the item master's permission; `createStockDrug` asks for the sale-item (and formulary) one too.
   */
  /** Owner 2026-10-04 — a vendor's price list: each row matched to the catalogue (writes nothing). */
  @RequirePermission("materials.items.manage", "hospital")
  @Post("price-list/match")
  async priceListMatch(@Body() body: unknown): Promise<{ rows: MatchedRow[] }> {
    const b = parsed(z.object({ rows: z.array(z.object({
      manufacturer: z.string().max(200).optional(), brand: z.string().max(200), composition: z.string().max(500).optional(),
      pack: z.string().max(100).optional(), mrp: z.string().max(40).optional(), gst: z.string().max(20).optional(), hsn: z.string().max(20).optional(),
    })).min(1).max(1000) }), body);
    try {
      return { rows: await matchPriceList(this.db, b.rows) };
    } catch (e) {
      return toHttp(e);
    }
  }

  /** Owner 2026-10-04 — the ticked rows of a price list made into items, each through `createStockDrug`. */
  @RequirePermission("materials.items.manage", "hospital")
  @Post("price-list/import")
  async priceListImport(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ results: ImportResult[] }> {
    const b = parsed(z.object({ rows: z.array(z.object({
      line: z.number().int().min(1), medicineId: idSchema, brand: z.string().max(200), packType: z.enum(PACK_TYPES), packSize: z.number().int().min(1).max(1000),
      gstRateBps: z.number().int().min(0).max(2800), hsnCode: z.string().trim().regex(/^\d{4,8}$/), mrpPerPackPaise: z.number().int().min(1).max(100_000_000),
      storage: z.enum(["ambient", "cold_2_8"]), twin: z.boolean().optional(), variant: z.string().trim().max(40).nullable().optional(),
      manufacturer: z.string().trim().max(200).nullable().optional(),
    })).min(1).max(1000) }), body);
    try {
      return { results: await importPriceList(this.db, actor, b.rows) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Post("new-drug")
  async newDrug(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<Awaited<ReturnType<typeof createStockDrug>>> {
    const b = parsed(newDrugBody, body);
    try {
      return await createStockDrug(this.db, actor, b);
    } catch (e) {
      return toHttp(e);
    }
  }
}
