import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import { listSaleItems, registerSaleItem, saleItemCandidates, setSaleItemActive } from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { SaleItemView } from "./sale-items";

const registerBody = z.object({ itemId: idSchema });
const activeBody = z.object({ active: z.boolean() });

/**
 * PLAN 16c T2 — the sale-items admin surface. Every route is gated by `@RequirePermission` and
 * carries no check of its own (Plan 13 T5's recorded rule); errors cross the wire as codes.
 */
@Controller("pharmacy/sale-items")
export class PharmacyItemsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get()
  async list(@Query("search") search?: string): Promise<{ items: SaleItemView[] }> {
    return { items: await listSaleItems(this.db, { ...(search === undefined ? {} : { search }) }) };
  }

  @RequirePermission("pharmacy.sale_items.manage", "hospital")
  @Get("candidates")
  async candidates(@Query("search") search?: string): Promise<{ items: { id: string; code: string; name: string; baseUom: string; gstRateBps: number | null }[] }> {
    const rows = await saleItemCandidates(this.db, { ...(search === undefined ? {} : { search }) });
    return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, baseUom: r.baseUom, gstRateBps: r.gstRateBps })) };
  }

  @RequirePermission("pharmacy.sale_items.manage", "hospital")
  @Post()
  async register(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ itemId: string; serviceId: string; serviceCode: string; category: string }> {
    const { itemId } = parsed(registerBody, body);
    try {
      return await withTx(this.db, (tx) => registerSaleItem(tx, actor, itemId));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.sale_items.manage", "hospital")
  @Patch(":itemId")
  async setActive(@CurrentActor() actor: Actor, @Param("itemId") itemId: string, @Body() body: unknown): Promise<{ ok: true }> {
    const { active } = parsed(activeBody, body);
    try {
      await withTx(this.db, (tx) => setSaleItemActive(tx, actor, itemId, active));
      return { ok: true };
    } catch (e) {
      return toHttp(e);
    }
  }
}
