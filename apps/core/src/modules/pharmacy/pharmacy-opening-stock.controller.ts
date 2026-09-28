import { Body, Controller, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed, toHttp } from "./pharmacy-http";
import { captureOpeningStock, openingAuthority, planOpeningStock, readOpeningSheet } from "./opening-stock";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OpeningAuthority, OpeningGrnState, OpeningPlan } from "./opening-stock";

/** The sheet as the pharmacist saved it. ~2,000 rows of nine short columns fit well inside this. */
const sheetBody = z.object({ content: z.string().min(1).max(990_000) });

export type OpeningCheckView = {
  fileHash: string;
  rows: {
    line: number; brand: string; itemCode: string | null; itemName: string | null; batch: string; expiryDate: string;
    packs: number; packSize: number; uom: string | null; newUom: boolean; near: boolean; mrpPaise: number;
    costPerBasePaise: number; rack: string; reasons: string[];
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
    const b = parsed(sheetBody, body);
    try {
      const plan = await planOpeningStock(this.db, readOpeningSheet(b.content), b.content, new Date());
      return view(plan, await openingAuthority(this.db, actor, plan));
    } catch (e) {
      return toHttp(e);
    }
  }

  /** Judge it again (never trust a Check the client may have edited since) and capture it as GRNs. */
  @RequirePermission("materials.grn.capture", "hospital")
  @Post("capture")
  async capture(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<Awaited<ReturnType<typeof captureOpeningStock>>> {
    const b = parsed(sheetBody, body);
    try {
      const now = new Date();
      const plan = await planOpeningStock(this.db, readOpeningSheet(b.content), b.content, now);
      return await captureOpeningStock(this.db, actor, plan, now);
    } catch (e) {
      return toHttp(e);
    }
  }
}
