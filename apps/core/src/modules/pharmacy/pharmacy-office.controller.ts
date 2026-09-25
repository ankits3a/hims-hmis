import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { httpError, idSchema, parsed, toHttp } from "./pharmacy-http";
import { officeBillDraft, officePay, officeToday, purchaseOrderDocument } from "./office";
import { draftPurchaseOrders, planPurchaseDrafts } from "./purchase-drafts";
import type { OfficePay, OfficeToday } from "./office";
import type { BillDraft } from "../materials";
import type { PurchasePlan } from "./purchase-drafts";
import type { PoView } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";

/**
 * PARITY P2 — `/pharmacy/office`'s routes. The office FEDERATES: the order lifecycle itself is
 * `materials.controller.ts`'s (`/materials/purchase-orders/*`); these are the office's own reads, the
 * agent's plan and the person's "make the drafts", and the order's printable page.
 *
 * Guarded on `materials.po.raise`, the grant of the people who buy (materials_head, the pharmacist);
 * the paper on `materials.stock.read`, the grant that reads an order.
 */
const assignBody = z.object({
  assign: z.array(z.object({ itemId: idSchema, vendorId: idSchema, ratePaise: z.number().int().nonnegative().optional() })).max(200).optional(),
});

function officeHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw httpError(403, e.message, "sod_violation", { pairKey: e.pairKey });
  toHttp(e);
}

@Controller("pharmacy/office")
export class PharmacyOfficeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("materials.po.raise", "hospital")
  @Get("today")
  async today(@CurrentActor() actor: Actor): Promise<OfficeToday> {
    try {
      return await officeToday(this.db, actor, new Date());
    } catch (e) { officeHttp(e); }
  }

  @RequirePermission("materials.po.raise", "hospital")
  @Get("plan")
  async plan(): Promise<PurchasePlan> {
    try {
      return await planPurchaseDrafts(this.db, new Date());
    } catch (e) { officeHttp(e); }
  }

  /** The person's press of "make the drafts": DRAFT orders only, one per vendor. */
  @RequirePermission("materials.po.raise", "hospital")
  @Post("draft-orders")
  async draft(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ drafts: PoView[] }> {
    const b = parsed(assignBody, body ?? {});
    try {
      return { drafts: await draftPurchaseOrders(this.db, actor, new Date(), b.assign ?? []) };
    } catch (e) { officeHttp(e); }
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("purchase-orders/:id/document")
  async document(@CurrentActor() actor: Actor, @Param("id") poId: string): Promise<RenderedDocument> {
    try {
      return await purchaseOrderDocument(this.db, actor, poId);
    } catch (e) { officeHttp(e); }
  }

  /** PARITY P3 — the pay side of the office: bills to match, held, due, overdue, runs, the agent's plan. */
  @RequirePermission("materials.bills.manage", "hospital")
  @Get("pay")
  async pay(@CurrentActor() actor: Actor): Promise<OfficePay> {
    try {
      return await officePay(this.db, actor, new Date());
    } catch (e) { officeHttp(e); }
  }

  /** PARITY P3 — the agent's prefill of a bill from a posted GRN (IGST when the vendor is out of state). */
  @RequirePermission("materials.bills.manage", "hospital")
  @Get("bill-draft/:grnId")
  async billDraft(@CurrentActor() actor: Actor, @Param("grnId") grnId: string): Promise<BillDraft> {
    try {
      return await officeBillDraft(this.db, actor, grnId);
    } catch (e) { officeHttp(e); }
  }
}
