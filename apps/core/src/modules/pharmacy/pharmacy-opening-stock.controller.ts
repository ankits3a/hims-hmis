import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import { PACK_TYPES, captureOpeningStock, openingAuthority, planOpeningGrid, planOpeningStock, readOpeningSheet } from "./opening-stock";
import { createStockDrug, stockEntryItems, stockEntryMedicine, stockEntrySuppliers } from "./stock-drug";
import type { StockEntryItem } from "./stock-drug";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OpeningAuthority, OpeningGrnState, OpeningPlan } from "./opening-stock";

/** The sheet as the pharmacist saved it. ~2,000 rows of nine short columns fit well inside this. */
const sheetBody = z.object({ content: z.string().min(1).max(990_000) });
/**
 * The on-screen grid's rows (2026-09-29): the picked item and the cells as typed. Text, not numbers, so the
 * planner reads a typo exactly as it reads one in a CSV (`planOpeningGrid`).
 */
const cell = z.string().max(64);
const gridBody = z.object({
  rows: z.array(z.object({
    itemId: idSchema, batch: cell, expiry: cell, mrpPerPack: cell, packSize: cell, packs: cell,
    freePacks: cell.optional(), ratePerPack: cell.optional(), discountPct: cell.optional(), packType: cell.optional(),
    rack: z.string().max(200).optional(), supplier: z.string().max(200).optional(),
  })).min(1).max(2000),
});
/** Either a sheet or the grid — one route, one judgement. */
const entryBody = z.union([sheetBody, gridBody]);
const newDrugBody = z.object({
  brandName: z.string().trim().min(1).max(120), strength: z.string().trim().max(60), medicineId: idSchema,
  form: z.string().trim().max(60), packType: z.enum(PACK_TYPES), packSize: z.number().int().min(1).max(1000),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/), gstRateBps: z.number().int().min(0).max(2800),
  schedule: z.enum(["H", "H1", "X", "OTC"]).nullable(), mrpPerPackPaise: z.number().int().min(1).max(100_000_000),
  storage: z.enum(["ambient", "cold_2_8"]),
});

export type OpeningCheckView = {
  fileHash: string;
  rows: {
    line: number; brand: string; itemCode: string | null; itemName: string | null; batch: string; expiryDate: string;
    packs: number; packSize: number; uom: string | null; newUom: boolean; near: boolean; mrpPaise: number;
    costPerBasePaise: number; rack: string; reasons: string[];
    freePacks: number; ratePaise: number; discountBps: number;
  }[];
  grns: { challanNo: string; near: boolean; lines: number; state: OpeningGrnState; grnNo: string | null }[];
  refusals: number; units: number; newUoms: number; needsVendor: boolean; zeroCost: number; racks: number;
  authority: OpeningAuthority[];
};

function view(plan: OpeningPlan, authority: OpeningAuthority[]): OpeningCheckView {
  return {
    fileHash: plan.fileHash,
    rows: plan.rows.map((r) => ({
      line: r.line, brand: r.brand, itemCode: r.itemCode ?? null, itemName: r.itemName ?? null, batch: r.batch, expiryDate: r.expiryDate,
      packs: r.packs, packSize: r.packSize, uom: r.uom ?? null, newUom: r.newUom, near: r.near, mrpPaise: r.mrpPaise,
      costPerBasePaise: r.costPerBasePaise, rack: r.rack, reasons: r.reasons,
      freePacks: r.freePacks, ratePaise: r.ratePaise, discountBps: r.discountBps,
    })),
    grns: plan.grns.map((g) => ({ challanNo: g.challanNo, near: g.near, lines: g.rows.length, state: g.state, grnNo: g.grnNo ?? null })),
    refusals: plan.refusals, units: plan.units, newUoms: plan.newUoms, needsVendor: plan.needsVendor, zeroCost: plan.zeroCost,
    racks: plan.racks.length, authority,
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
